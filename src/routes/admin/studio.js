import { Router } from "express";
import { z } from "zod";
import { Frame, Room, Screen, Setting } from "../../models/index.js";
import { admin } from "../../middleware/auth.js";
import { hashImage, frameThumbUrl } from "../../services/frame-image.js";
import { withFrameCatalogLock } from "../../services/frame-order.js";
import { fail, id } from "../validation.js";

export const studioRouter = Router();

// ─── Thiết lập → Màn hình chờ ────────────────────────────────────────────
// Ảnh màn hình chờ: JPG/PNG/WebP đã thu nhỏ ở trình duyệt, hoặc GIF động giữ nguyên (≤ 3 MB).
const screenImage = z
  .string()
  .max(4_200_000, "Ảnh màn hình chờ quá lớn. Vui lòng chọn ảnh dưới 3 MB.")
  .regex(
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/,
    "Ảnh màn hình chờ phải là ảnh JPG, PNG, WebP hoặc GIF.",
  );
const screenSchema = z.object({
  name: z.string().trim().max(100).default(""),
  rooms: z.array(id).max(200).default([]),
  title: z.string().trim().max(60).default(""),
  subtitle: z.string().trim().max(120).default(""),
  interval: z.number().int().min(2).max(60).default(6),
  // Ảnh giữ lại ({ _id }) hoặc ảnh mới ({ data }), theo đúng thứ tự phát.
  images: z
    .array(z.union([z.object({ _id: id }), z.object({ data: screenImage })]))
    .max(6, "Mỗi màn hình chờ tối đa 6 ảnh."),
  active: z.boolean().default(true),
});
export const screenImageUrl = (screen, image) =>
  `/api/screens/${screen._id}/images/${image._id}?v=${image.hash}`;
export const screenListItem = (screen) => ({
  ...screen,
  rooms: (screen.rooms || []).map(String),
  images: (screen.images || []).map((image) => ({
    _id: image._id,
    url: screenImageUrl(screen, image),
  })),
});

// Cấu hình chung luôn có: lần đầu lấy từ màn hình chờ cũ (Setting studio.kiosk).
async function ensureDefaultScreen() {
  const existing = await Screen.findOne({ isDefault: true }).select("_id").lean();
  if (existing) return;
  const kiosk = (await Setting.findOne({ key: "studio" }).lean())?.value?.kiosk || {};
  try {
    await Screen.create({
      name: "Cấu hình chung",
      isDefault: true,
      title: kiosk.idleTitle || "",
      subtitle: kiosk.idleSubtitle || "",
      images: kiosk.idleImage ? [{ data: kiosk.idleImage, hash: hashImage(kiosk.idleImage) }] : [],
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}
const listScreens = async () =>
  (await Screen.find().select("-images.data").sort({ isDefault: -1, createdAt: 1 }).lean())
    .map(screenListItem);

studioRouter.get("/screens", admin, async (req, res) => {
  await ensureDefaultScreen();
  res.json(await listScreens());
});
async function saveScreen(req, res) {
  const d = screenSchema.parse(req.body);
  const current = req.params.id ? await Screen.findById(id.parse(req.params.id)).lean() : null;
  if (req.params.id && !current) fail(404, "Không tìm thấy màn hình chờ.");
  const isDefault = Boolean(current?.isDefault);
  if (!isDefault && !d.rooms.length) fail(400, "Vui lòng chọn máy muốn cấu hình.");
  if (!isDefault && !d.name) fail(400, "Vui lòng nhập tên cấu hình.");
  if (d.rooms.length && (await Room.countDocuments({ _id: { $in: d.rooms } })) !== d.rooms.length)
    fail(400, "Có máy không còn tồn tại. Vui lòng tải lại trang.");
  const kept = new Map((current?.images || []).map((image) => [String(image._id), image]));
  const images = d.images.map((image) => {
    if (image.data) return { data: image.data, hash: hashImage(image.data) };
    const old = kept.get(image._id);
    if (!old) fail(409, "Ảnh màn hình chờ vừa thay đổi. Vui lòng tải lại trang.");
    return old;
  });
  const values = {
    name: isDefault ? current.name || "Cấu hình chung" : d.name,
    rooms: isDefault ? [] : d.rooms,
    title: d.title,
    subtitle: d.subtitle,
    interval: d.interval,
    images,
    active: isDefault ? true : d.active,
  };
  const saved = current
    ? await Screen.findByIdAndUpdate(current._id, { $set: values }, { new: true })
    : await Screen.create(values);
  // Một máy chỉ theo một cấu hình riêng: máy vừa chọn được gỡ khỏi cấu hình riêng khác.
  if (values.rooms.length)
    await Screen.updateMany(
      { _id: { $ne: saved._id }, rooms: { $in: values.rooms } },
      { $pull: { rooms: { $in: values.rooms } } },
    );
  res.json(await listScreens());
}
studioRouter.post("/screens", admin, saveScreen);
studioRouter.put("/screens/:id", admin, saveScreen);
studioRouter.delete("/screens/:id", admin, async (req, res) => {
  const screen = await Screen.findById(id.parse(req.params.id)).select("isDefault").lean();
  if (!screen) fail(404, "Không tìm thấy màn hình chờ.");
  if (screen.isDefault) fail(409, "Không xóa được cấu hình chung.");
  await Screen.deleteOne({ _id: screen._id });
  res.json(await listScreens());
});

// ─── Thiết lập → Chủ đề ──────────────────────────────────────────────────
// Chủ đề = các khung cùng “tên bộ chủ đề” (khách chọn cả bộ để ghép). Thông tin riêng của chủ đề
// (bật / tắt, thứ tự hiện cho khách, chủ đề chưa có khung, loại hình chụp) lưu ở Setting studio.themes.
// kind: chủ đề của phòng Photobooth (khung 10 × 15) hay phòng Polaroid (khung Instax); chủ đề cũ chưa
// lưu loại thì theo khung trong chủ đề.
const themeName = z.string().trim().min(1, "Vui lòng nhập tên chủ đề.").max(100);
const themeKind = z.enum(["photobooth", "polaroid"]);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameName = (name) => new RegExp(`^\\s*${escape(name)}\\s*$`);
const storedThemes = async () =>
  (await Setting.findOne({ key: "studio" }).lean())?.value?.themes || [];
const saveThemes = (themes) =>
  Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: { "value.themes": themes } },
    { upsert: true, new: true },
  );

async function listThemes() {
  const [stored, groups] = await Promise.all([
    storedThemes(),
    Frame.aggregate([
      { $match: { themeName: { $type: "string" } } },
      { $set: { theme: { $trim: { input: "$themeName" } } } },
      { $match: { theme: { $ne: "" } } },
      { $sort: { order: 1, _id: 1 } },
      {
        $group: {
          _id: "$theme",
          frames: { $sum: 1 },
          activeFrames: { $sum: { $cond: ["$active", 1, 0] } },
          // Số ảnh ghép: vùng ảnh khác số (bản sao cùng số, QR, ngày in không tính); khung cũ chưa
          // đánh số thì mỗi ô là một ảnh.
          slots: {
            $sum: {
              $size: {
                $setUnion: [
                  {
                    $map: {
                      input: {
                        $filter: {
                          input: { $ifNull: ["$slots", []] },
                          as: "s",
                          cond: { $eq: [{ $ifNull: ["$$s.kind", "photo"] }, "photo"] },
                        },
                      },
                      as: "s",
                      in: { $ifNull: ["$$s.photo", { x: "$$s.x", y: "$$s.y" }] },
                    },
                  },
                ],
              },
            },
          },
          sizes: { $addToSet: "$printSize" },
          createdAt: { $min: "$createdAt" },
          previews: {
            $push: { _id: "$_id", imageHash: "$imageHash", updatedAt: "$updatedAt", createdAt: "$createdAt" },
          },
        },
      },
    ]),
  ]);
  const byName = new Map(stored.map((theme, index) => [theme.name, { ...theme, index }]));
  const names = [...new Set([...stored.map((t) => t.name), ...groups.map((g) => g._id)])];
  return names
    .map((name) => {
      const group = groups.find((g) => g._id === name);
      const meta = byName.get(name);
      return {
        name,
        kind: meta?.kind || (group?.sizes?.includes("instax") ? "polaroid" : "photobooth"),
        active: meta?.active ?? true,
        order: meta ? meta.index : stored.length + names.indexOf(name),
        frames: group?.frames || 0,
        activeFrames: group?.activeFrames || 0,
        slots: group?.slots || 0,
        sizes: group?.sizes || [],
        createdAt: group?.createdAt || meta?.createdAt || null,
        previews: (group?.previews || []).slice(0, 4).map(frameThumbUrl),
      };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "vi"));
}
// Lưu thứ tự + trạng thái của mọi chủ đề đang có, theo thứ tự đã sắp.
const persist = (themes) =>
  saveThemes(
    themes.map(({ name, kind, active, createdAt }) => ({ name, kind, active, createdAt: createdAt || new Date() })),
  );

studioRouter.get("/themes", admin, async (req, res) => res.json(await listThemes()));
studioRouter.post("/themes", admin, async (req, res) => {
  const name = themeName.parse(req.body.name);
  const kind = themeKind.default("photobooth").parse(req.body.kind);
  const themes = await listThemes();
  if (themes.some((t) => t.name.toLocaleLowerCase("vi") === name.toLocaleLowerCase("vi")))
    fail(409, `Đã có chủ đề “${name}”.`);
  await persist([...themes, { name, kind, active: true, createdAt: new Date() }]);
  res.status(201).json(await listThemes());
});
// Đổi tên (đổi luôn tên bộ của mọi khung trong chủ đề) và / hoặc bật / tắt hiển thị với khách.
studioRouter.put("/themes", admin, async (req, res) => {
  const d = z
    .object({ name: themeName, newName: themeName.optional(), active: z.boolean().optional() })
    .parse(req.body);
  const themes = await listThemes();
  const theme = themes.find((t) => t.name === d.name);
  if (!theme) fail(404, "Không tìm thấy chủ đề.");
  if (d.newName && d.newName !== d.name) {
    if (themes.some((t) => t !== theme && t.name.toLocaleLowerCase("vi") === d.newName.toLocaleLowerCase("vi")))
      fail(409, `Đã có chủ đề “${d.newName}”. Vui lòng đặt tên khác.`);
    await withFrameCatalogLock(() =>
      Frame.updateMany({ themeName: sameName(d.name) }, { $set: { themeName: d.newName } }),
    );
    theme.name = d.newName;
  }
  if (d.active !== undefined) theme.active = d.active;
  await persist(themes);
  res.json(await listThemes());
});
// Thứ tự chủ đề khách thấy khi chọn bộ khung.
studioRouter.put("/themes/order", admin, async (req, res) => {
  const names = z.array(themeName).max(500).parse(req.body.names);
  const themes = await listThemes();
  if (names.length !== themes.length || themes.some((t) => !names.includes(t.name)))
    fail(409, "Danh sách chủ đề vừa thay đổi. Vui lòng tải lại trang.");
  await persist(names.map((name) => themes.find((t) => t.name === name)));
  res.json(await listThemes());
});
// Xóa chủ đề: các khung trong chủ đề thành khung lẻ (không xóa khung).
studioRouter.delete("/themes/:name", admin, async (req, res) => {
  const name = themeName.parse(req.params.name);
  const themes = await listThemes();
  if (!themes.some((t) => t.name === name)) fail(404, "Không tìm thấy chủ đề.");
  await withFrameCatalogLock(() =>
    Frame.updateMany({ themeName: sameName(name) }, { $set: { themeName: "" } }),
  );
  await persist(themes.filter((t) => t.name !== name));
  res.json(await listThemes());
});
