import { Router } from "express";
import mongoose from "mongoose";
import swaggerUi from "swagger-ui-express";
import { config } from "../config.js";
import { openapi } from "../openapi.js";
import { Room, Package, Frame, Screen, Setting, Sticker } from "../models/index.js";
import { captureStatus } from "../services/capture.js";
import { id } from "./validation.js";
import {
  ensureFrameThumb,
  ensureStickerThumb,
  FRAME_LIST_FIELDS,
  frameListItem,
  hashImage,
  STICKER_LIST_FIELDS,
  stickerListItem,
} from "../services/frame-image.js";
import { catalogCache } from "../services/read-cache.js";
import { screenListItem } from "./admin/studio.js";
import { polaroidPackage } from "../polaroid-layouts.js";

export const publicRouter = Router();

// Thử API trên trình duyệt: /api/docs (Swagger UI), tài liệu gốc ở /api/openapi.json. Ẩn mặc định
// (trả 404 như đường dẫn không tồn tại); chỉ mở khi đặt API_DOCS=true (config.apiDocs).
const docsRouter = Router();
docsRouter.get("/openapi.json", (req, res) => res.json(openapi));
docsRouter.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapi, {
    customSiteTitle: "NXC Photobooth API",
    swaggerOptions: {
      docExpansion: "none",
      filter: true,
      tryItOutEnabled: true,
      displayRequestDuration: true,
      persistAuthorization: true,
    },
  }),
);
publicRouter.use((req, res, next) => (config.apiDocs ? docsRouter(req, res, next) : next()));
publicRouter.get("/health", async (req, res) => {
  // ?db=1: also time one database round trip (Server-Timing: db) to see how far it is.
  if (req.query.db === "1" && mongoose.connection.readyState === 1) {
    const started = performance.now();
    await mongoose.connection.db.admin().ping().catch(() => {});
    res.set("Server-Timing", `db;dur=${(performance.now() - started).toFixed(0)}`);
  }
  res
    .set("X-Photo-Upload", "binary-v1")
    .set("X-Photo-Quality", "original-jpeg-lossless-print-v1")
    .set("X-Photo-Pipeline", "original-preview-overlap-v1")
    .set("X-Photo-Delivery", "private-r2-direct-v1")
    .set("X-Photo-Queue", "bounded-parallel-v1")
    .set("X-Photo-Preview", "1600-v1")
    // Trình duyệt dò lại máy chủ bằng địa chỉ này khi mất kết nối: không được trả bản lưu sẵn.
    .set("Cache-Control", "no-store")
    .set(mongoose.connection.readyState === 1 ? {} : { "Retry-After": "5" })
    .status(mongoose.connection.readyState === 1 ? 200 : 503)
    .json({ ok: mongoose.connection.readyState === 1 });
});
// Ảnh khung và mã QR lưu trong DB dạng data URL (base64). Nhét thẳng vào /catalog thì mỗi lần mở
// trang phải tải gần 1 MB; tách thành địa chỉ ảnh riêng. Đổi ảnh thì đổi `v` nên trình duyệt giữ
// bản cũ vĩnh viễn, không phải tải lại.
const DATA_IMAGE_HEAD = /^data:(image\/(?:png|jpe?g|gif|webp));base64$/;
function sendDataImage(req, res, dataUrl) {
  const text = typeof dataUrl === "string" ? dataUrl : "";
  const comma = text.indexOf(",");
  const head = comma > 0 && DATA_IMAGE_HEAD.exec(text.slice(0, comma));
  if (!head) return false;
  res
    .set(
      "Cache-Control",
      req.query.v ? "public, max-age=31536000, immutable" : "no-cache",
    )
    .type(head[1] === "image/jpg" ? "image/jpeg" : head[1])
    .send(Buffer.from(text.slice(comma + 1), "base64"));
  return true;
}
// Cả khung đang tắt cũng có ảnh (trang quản trị xem danh sách khung đã tắt).
// ?size=thumb: ảnh xem nhanh WebP (bộ chọn chủ đề, danh sách khung); chưa có thì tạo một lần.
publicRouter.get("/frames/:id/image", async (req, res) => {
  const frameId = id.parse(req.params.id);
  if (req.query.size === "thumb") {
    const thumb = await ensureFrameThumb(frameId).catch(() => null);
    if (thumb && sendDataImage(req, res, thumb)) return;
  }
  const frame = await Frame.findById(frameId)
    .select("image")
    .lean();
  if (!sendDataImage(req, res, frame?.image))
    res.status(404).json({ message: "Không tìm thấy ảnh khung." });
});
publicRouter.get("/stickers/:id/image", async (req, res) => {
  const stickerId = id.parse(req.params.id);
  if (req.query.size === "thumb") {
    const thumb = await ensureStickerThumb(stickerId).catch(() => null);
    if (thumb && sendDataImage(req, res, thumb)) return;
  }
  const sticker = await Sticker.findById(stickerId).select("image").lean();
  if (!sendDataImage(req, res, sticker?.image))
    res.status(404).json({ message: "Không tìm thấy ảnh nhãn dán." });
});
publicRouter.get("/screens/:id/images/:imageId", async (req, res) => {
  const imageId = id.parse(req.params.imageId);
  const screen = await Screen.findOne(
    { _id: id.parse(req.params.id) },
    { images: { $elemMatch: { _id: imageId } } },
  ).lean();
  if (!sendDataImage(req, res, screen?.images?.[0]?.data))
    res.status(404).json({ message: "Không tìm thấy ảnh màn hình chờ." });
});
publicRouter.get("/studio/kiosk-idle", async (req, res) => {
  const setting = await Setting.findOne({ key: "studio" }).lean();
  if (!sendDataImage(req, res, setting?.value?.kiosk?.idleImage))
    res.status(404).json({ message: "Chưa có ảnh màn hình chờ." });
});
publicRouter.get("/studio/qr", async (req, res) => {
  const setting = await Setting.findOne({ key: "studio" }).lean();
  if (!sendDataImage(req, res, setting?.value?.bankQrImage))
    res.status(404).json({ message: "Chưa có ảnh QR chuyển khoản." });
});
publicRouter.get("/catalog", async (req, res) => {
  // Every page load asks for the catalog; it changes only when an admin edits it (cache cleared).
  res.json({ ...await catalogCache.get("catalog", buildCatalog), printCapabilities: { dnpSheetScale: 2, dnpDirectPrint: true } });
});
async function buildCatalog() {
  const [rooms, packages, frames, setting, stickers, screens] = await Promise.all([
    Room.find({ active: true }).select("-lastSeenAt").lean(),
    Package.find({ active: true }).sort({ price: 1 }).lean(),
    Frame.find({ active: true, "slots.0": { $exists: true } })
      .select(FRAME_LIST_FIELDS)
      .lean(),
    Setting.findOne({ key: "studio" }).lean(),
    Sticker.find({ active: true }).select(STICKER_LIST_FIELDS).sort({ order: 1, createdAt: 1 }).lean(),
    Screen.find({ active: true }).select("-images.data").lean(),
  ]);
  const settings = { ...setting?.value };
  if (settings.bankQrImage?.startsWith("data:"))
    settings.bankQrImage = `/api/studio/qr?v=${hashImage(settings.bankQrImage)}`;
  if (settings.kiosk?.idleImage?.startsWith("data:"))
    settings.kiosk = { ...settings.kiosk,
      idleImage: `/api/studio/kiosk-idle?v=${hashImage(settings.kiosk.idleImage)}` };
  // Chủ đề đang tắt (Thiết lập → Chủ đề): khách không thấy các khung của chủ đề đó.
  const hidden = new Set((settings.themes || []).filter((t) => t.active === false).map((t) => t.name));
  return {
    rooms,
    packages: packages.map(polaroidPackage),
    frames: frames.filter((f) => !hidden.has(f.themeName?.trim())).map(frameListItem),
    screens: screens.map(screenListItem),
    stickers: stickers.map(stickerListItem),
    settings,
    devices: captureStatus(),
  };
}
