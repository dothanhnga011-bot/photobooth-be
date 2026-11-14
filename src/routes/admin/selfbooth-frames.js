// Chép khung từ web Selfbooth của tiệm (14/11 chủ tiệm cho phép đọc khung bên Selfbooth). Đọc danh sách
// khung công khai của web đó (/api/catalog, /api/frames/:id/image), quản trị chọn khung rồi chép sang:
// giữ ảnh, tên, chủ đề, thứ tự và các ô (cả ô xoay). Khung chép sang in ở máy Instax Wide của phòng
// Polaroid: khung dọc 2 : 3 (20 × 30 / 10 × 15) được máy chụp xoay cho vừa tấm Instax.
import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { Frame, Setting } from "../../models/index.js";
import { admin } from "../../middleware/auth.js";
import { fail } from "../validation.js";
import { hashImage, makeFrameThumb } from "../../services/frame-image.js";
import { withFrameCatalogLock } from "../../services/frame-order.js";
import { frameInput } from "./resources.js";

export const selfboothFramesRouter = Router();

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const sourceOf = (frameId) => `selfbooth:${frameId}`;

// Máy chủ Selfbooth (gói miễn phí) có thể đang ngủ: lần gọi đầu chờ tới 90 giây.
async function selfbooth(path, { timeout = 90_000 } = {}) {
  let res;
  try {
    res = await fetch(`${config.selfboothApi}${path}`, { signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    fail(502, error.name === "TimeoutError"
      ? "Web Selfbooth chưa trả lời (máy chủ có thể đang khởi động). Đợi 1 phút rồi thử lại."
      : "Không kết nối được tới web Selfbooth.");
  }
  if (!res.ok) fail(502, `Web Selfbooth trả lỗi ${res.status}.`);
  return res;
}

async function selfboothCatalog() {
  const catalog = await (await selfbooth("/api/catalog")).json().catch(() => null);
  if (!Array.isArray(catalog?.frames)) fail(502, "Web Selfbooth không trả danh sách khung.");
  return catalog.frames
    .filter((frame) => /^[a-f\d]{24}$/i.test(String(frame._id)) && Array.isArray(frame.slots) && frame.slots.length)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a._id).localeCompare(String(b._id)));
}

const imageUrl = (frame, kind = "image") =>
  `${config.selfboothApi}/api/frames/${frame._id}/${kind}${frame.imageHash ? `?v=${encodeURIComponent(frame.imageHash)}` : ""}`;

// Danh sách khung bên Selfbooth, kèm khung nào đã chép sang.
selfboothFramesRouter.get("/", admin, async (req, res) => {
  const frames = await selfboothCatalog();
  const copied = new Set((await Frame.find({ source: { $in: frames.map((f) => sourceOf(f._id)) } })
    .select("source").lean()).map((f) => f.source));
  res.json({
    source: config.selfboothApi,
    frames: frames.map((frame) => ({
      id: String(frame._id),
      name: frame.name?.trim() || "Khung chưa đặt tên",
      themeName: frame.themeName?.trim() || "",
      printSize: frame.printSize || "full",
      slots: frame.slots.length,
      angled: frame.slots.some((slot) => slot.angle),
      preview: imageUrl(frame, "preview"),
      copied: copied.has(sourceOf(frame._id)),
    })),
  });
});

// Tên chủ đề bên mình cho khung chép sang: giữ tên Selfbooth; trùng chủ đề Photobooth (khung 10 × 15)
// thì thêm "(Selfbooth)" để khung Instax không lẫn vào bộ của phòng Photobooth.
async function themeFor(name) {
  if (!name) return "";
  const stored = (await Setting.findOne({ key: "studio" }).lean())?.value?.themes || [];
  const photobooth = stored.some((theme) => theme.name === name && theme.kind === "photobooth") ||
    await Frame.exists({ themeName: name, printSize: { $ne: "instax" } });
  return photobooth ? `${name} (Selfbooth)`.slice(0, 100) : name;
}

async function frameImage(frame) {
  const res = await selfbooth(`/api/frames/${frame._id}/image`, { timeout: 60_000 });
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) fail(502, `Ảnh khung “${frame.name}” không phải PNG / JPG / WebP.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) fail(502, `Ảnh khung “${frame.name}” trống.`);
  if (bytes.length > MAX_IMAGE_BYTES) fail(413, `Ảnh khung “${frame.name}” quá lớn (trên 10 MB).`);
  return `data:${type};base64,${bytes.toString("base64")}`;
}

// Chép các khung đã chọn (khung đã chép trước đó thì bỏ qua).
selfboothFramesRouter.post("/", admin, async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(30) }).parse(req.body);
  const wanted = new Set(ids.map((value) => value.toLowerCase()));
  const frames = (await selfboothCatalog()).filter((frame) => wanted.has(String(frame._id).toLowerCase()));
  if (!frames.length) fail(404, "Không còn khung nào trong số đã chọn trên web Selfbooth.");
  const created = [], skipped = [];
  for (const frame of frames) {
    const source = sourceOf(frame._id);
    if (await Frame.exists({ source })) { skipped.push(frame.name); continue; }
    const input = frameInput.parse({
      name: frame.name?.trim() || "Khung Selfbooth",
      themeName: await themeFor(frame.themeName?.trim() || ""),
      order: Math.max(0, Math.min(999, Math.round(Number(frame.order) || 0))),
      printSize: "instax",
      image: await frameImage(frame),
      slots: frame.slots.map((slot) => ({
        x: slot.x, y: slot.y, w: slot.w, h: slot.h, kind: "photo",
        ...(slot.angle ? { angle: Math.round(slot.angle * 10) / 10 } : {}),
      })),
      sheet: false,
      active: true,
    });
    input.imageHash = hashImage(input.image);
    const thumb = await makeFrameThumb(input.image).catch(() => null);
    if (thumb) input.thumb = thumb;
    input.source = source;
    await withFrameCatalogLock(() => Frame.create(input));
    created.push(input.name);
  }
  res.status(created.length ? 201 : 200).json({ created, skipped });
});
