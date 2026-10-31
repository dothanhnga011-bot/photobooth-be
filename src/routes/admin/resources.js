import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { User, Room, Package, Frame, Sticker } from "../../models/index.js";
import { admin, isAdmin, staffBranch, STAFF_PERMISSIONS } from "../../middleware/auth.js";
import { fail, id, text, priceVND } from "../validation.js";
import { INSTAX_SHEETS, leastSheets } from "../print-count.js";
import { moveFrame, withFrameCatalogLock } from "../../services/frame-order.js";
import {
  FRAME_LIST_FIELDS,
  frameListItem,
  hashImage,
  makeFrameThumb,
  makeStickerThumb,
  STICKER_LIST_FIELDS,
  stickerListItem,
} from "../../services/frame-image.js";

export const resourcesRouter = Router();

// Danh sách khung không kèm ảnh base64 (mỗi lần tải lại cả trăm KB tới vài MB): chỉ trả địa chỉ
// ảnh để cache; mở sửa khung thì lấy đủ ảnh của đúng khung đó ở đây.
// Xoá hẳn một phòng đã ngừng sử dụng (Quản lý máy → phòng đã tắt → Xoá hẳn). Phòng đang chạy phải
// ngừng sử dụng trước để không xoá nhầm phòng đang có khách. Đơn hàng cũ vẫn giữ tên phòng
// (roomName); liên kết máy chụp của phòng không mở được nữa.
resourcesRouter.delete("/rooms/:id/permanent", admin, async (req, res) => {
  const room = await Room.findById(id.parse(req.params.id)).select("active").lean();
  if (!room) fail(404, "Không tìm thấy phòng.");
  if (room.active) fail(409, "Ngừng sử dụng phòng trước rồi mới xoá hẳn.");
  await Room.deleteOne({ _id: room._id });
  res.json({ ok: true });
});
resourcesRouter.get("/frames/:id", admin, async (req, res) => {
  const frame = await Frame.findById(id.parse(req.params.id)).select("-thumb");
  if (!frame) fail(404, "Không tìm thấy dữ liệu.");
  res.json(frame);
});
resourcesRouter.post("/frames/:id/move", admin, async (req, res) => {
  const d = z
    .object({
      direction: z.enum(["up", "down"]),
      expectedIds: z.array(id).min(1).max(1000),
    })
    .parse(req.body);
  res.json(
    await withFrameCatalogLock(() =>
      moveFrame(id.parse(req.params.id), d.direction, d.expectedIds),
    ),
  );
});

const active = z.boolean();
const resources = {
  rooms: [
    Room,
    z.object({
      name: text,
      description: z.string().max(1000),
      branch: text,
      machineCode: z.string().trim().max(100).default(""),
      model: z.string().trim().max(100).default(""),
      importedAt: z.string().date().or(z.literal("")).nullable().default(null),
      expiresAt: z.string().date().or(z.literal("")).nullable().default(null),
      flip: z.enum(["device", "on", "off"]).default("device"),
      // Loại phòng chọn lúc thêm phòng; sửa phòng không gửi thì giữ nguyên.
      kind: z.enum(["photobooth", "polaroid"]).optional(),
      payment: z.enum(["counter", "cash"]).optional(),
      paymentTest: z.boolean().optional(),
      active,
    }),
  ],
  packages: [
    Package,
    z.object({
      name: text,
      description: z.string().max(1000),
      price: priceVND(100_000_000),
      duration: z.number().int().min(1).max(30),
      shots: z.number().int().min(0).max(40).default(12),
      countdownSeconds: z.number().int().min(1).max(30).default(10),
      selectCount: z.number().int().min(1).max(12).default(4),
      printSize: z.enum(["full", "strip", "instax"]).default("full"),
      prints: z.number().int().min(0).max(20).optional(),
      branches: z
        .array(z.string().trim().min(1).max(200))
        .max(50)
        .default([])
        .transform((items) => [...new Set(items)]),
      active,
    }).superRefine((pack, ctx) => {
      // Layout Polaroid (khổ Instax): luôn in 1 tấm, chụp không giới hạn trong thời gian chụp.
      if (pack.printSize === "instax") return;
      if (pack.shots < 1)
        ctx.addIssue({ code: "custom", path: ["shots"], message: "phải từ 1 trở lên" });
      // Khách in tối thiểu 2 tờ: khổ nhỏ 1 tờ 10 × 15 cắt đôi, khổ to 2 tờ.
      if (!(pack.prints >= leastSheets(pack.printSize)))
        ctx.addIssue({
          code: "custom",
          path: ["prints"],
          message: pack.printSize === "strip"
            ? "khổ nhỏ kèm ít nhất 1 tờ 10 × 15 (cắt đôi = 2 tờ nhỏ)"
            : "khổ to kèm ít nhất 2 tờ",
        });
    }).transform((pack) => (pack.printSize === "instax" ? { ...pack, prints: INSTAX_SHEETS, shots: 0 } : pack)),
  ],
  frames: [
    Frame,
    // Khung chỉ tạo bằng cách import ảnh (PNG/JPG) kèm vị trí các ô đặt ảnh, tỉ lệ 0–1.
    z.object({
      name: text,
      themeName: z.string().trim().max(100).default(""),
      order: z.number().int().min(0).max(999).default(0),
      printSize: z.enum(["full", "strip", "instax"]).default("full"),
      // PNG tối đa 10 MB (≈ 13,4 triệu ký tự base64).
      image: z
        .string({ error: "Vui lòng import ảnh khung." })
        .max(14_000_000, "Ảnh khung quá lớn (tối đa 10 MB).")
        .regex(
          /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
          "Vui lòng import ảnh khung (PNG/JPG).",
        ),
      slots: z
        .array(
          z.object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            w: z.number().gt(0).max(1),
            h: z.number().gt(0).max(1),
            kind: z.enum(["photo", "qr", "date"]).default("photo"),
            photo: z.number().int().min(1).max(40).optional(),
          }),
        )
        .max(60, "Mỗi khung hỗ trợ tối đa 60 vùng.")
        .refine(
          (slots) => slots.some((s) => s.kind === "photo"),
          "Khung cần ít nhất 1 vùng ảnh.",
        )
        // Khung cũ không có số ảnh: vùng ảnh thứ n là ảnh số n.
        .transform((slots) => {
          let next = 0;
          return slots.map((s) => s.kind === "photo"
            ? { ...s, photo: s.photo ?? ++next }
            : { x: s.x, y: s.y, w: s.w, h: s.h, kind: s.kind });
        })
        .refine(
          (slots) => Math.max(...slots.map((s) => s.photo || 0)) <= 40,
          "Mỗi khung hỗ trợ tối đa 40 ô ảnh.",
        ),
      sheet: z.boolean().default(false),
      dateColor: z.string().regex(/^#[0-9a-f]{6}$/i, "Màu chữ ngày in không hợp lệ.").default("#2f1a12"),
      shots: z.number().int().min(0).max(40).default(0),
      active,
    }),
  ],
  stickers: [
    Sticker,
    z.object({
      name: text,
      order: z.number().int().min(0).max(999).default(0),
      image: z
        .string({ error: "Vui lòng chọn ảnh nhãn dán." })
        .max(700_000, "Ảnh nhãn dán quá lớn (tối đa khoảng 500 KB).")
        .regex(
          /^data:image\/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
          "Nhãn dán cần là ảnh PNG hoặc WebP (nên có nền trong suốt).",
        ),
      active,
    }),
  ],
  users: [
    User,
    z.object({
      name: text,
      email: z.email().transform((v) => v.toLowerCase()),
      password: z.string().min(10).max(128).optional(),
      role: z.enum(["admin", "staff"]),
      branch: z.string().trim().max(200).default(""),
      permissions: z
        .array(z.enum(STAFF_PERMISSIONS))
        .max(STAFF_PERMISSIONS.length)
        .optional()
        .transform((items) => items && [...new Set(items)]),
      active,
    }).refine((user) => user.role !== "staff" || Boolean(user.branch), {
      message: "Nhân viên cần được gán chi nhánh.", path: ["branch"],
    }),
  ],
};
for (const [route, [Model, schema]] of Object.entries(resources)) {
  // adminRouter đã kiểm tra phiên: lễ tân chỉ xem phòng đang hoạt động để mở kiosk.
  resourcesRouter.get(
    `/${route}`,
    ...(route === "rooms" ? [] : [admin]),
    async (req, res) => {
      const query = Model.find(
        route === "rooms" && !isAdmin(req) ? { active: true, branch: staffBranch(req) } : {},
      ).sort({ createdAt: -1 });
      res.json(
        route === "frames"
          ? (await query.select(FRAME_LIST_FIELDS).lean()).map(frameListItem)
          : route === "stickers"
            ? (await query.select(STICKER_LIST_FIELDS).lean()).map(stickerListItem)
            : await query,
      );
    },
  );
  const save = async (req, res) => {
    const d = schema.parse(req.body);
    if (route === "users") {
      if (!req.params.id && !d.password)
        fail(400, "Vui lòng nhập mật khẩu (ít nhất 10 ký tự).");
      // Quản trị viên không tự sửa / tự ngừng tài khoản đang đăng nhập (tránh tự khóa mình);
      // đổi mật khẩu dùng “Đổi mật khẩu”, đổi tên / email nhờ quản trị viên khác.
      if (req.params.id === String(req.user._id))
        fail(
          403,
          "Không thể tự sửa tài khoản đang đăng nhập. Đổi mật khẩu ở mục “Đổi mật khẩu”; đổi tên / email nhờ quản trị viên khác.",
        );
      if (d.password) d.password = await bcrypt.hash(d.password, 12);
      // Không gửi phân quyền thì giữ nguyên quyền đang lưu.
      if (d.permissions === undefined) delete d.permissions;
    }
    // Phòng / gói đang dùng không được trùng tên (không phân biệt hoa thường): dễ nhầm ở quầy
    // và bảng phòng.
    if ((route === "rooms" || route === "packages") && d.active) {
      const clash = await Model.findOne({
        ...(req.params.id && { _id: { $ne: id.parse(req.params.id) } }),
        active: true,
        name: new RegExp(
          `^${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i",
        ),
      }).lean();
      if (clash)
        fail(
          409,
          `Đã có ${route === "rooms" ? "phòng" : "gói chụp"} tên “${clash.name}”. Vui lòng đặt tên khác.`,
        );
    }
    if (route === "frames" || route === "stickers") d.imageHash = hashImage(d.image);
    const changes = { $set: d };
    if (route === "frames" || route === "stickers") {
      // Ảnh xem nhanh tạo lại theo ảnh mới; lỗi thì để trống, lần đầu có người xem sẽ tạo.
      const thumb = await (route === "frames" ? makeFrameThumb : makeStickerThumb)(d.image).catch(() => null);
      if (thumb) d.thumb = thumb;
      else changes.$unset = { thumb: 1 };
    }
    if (route === "users" && d.password) changes.$inc = { sessionVersion: 1 };
    const write = () =>
      req.params.id
        ? Model.findByIdAndUpdate(id.parse(req.params.id), changes, {
            new: true,
          })
        : Model.create(d);
    const result =
      route === "frames" ? await withFrameCatalogLock(write) : await write();
    if (!result) fail(404, "Không tìm thấy dữ liệu.");
    const out = result.toObject();
    delete out.password;
    delete out.thumb;
    res.json(out);
  };
  resourcesRouter.post(`/${route}`, admin, save);
  resourcesRouter.put(`/${route}/:id`, admin, save);
  resourcesRouter.delete(`/${route}/:id`, admin, async (req, res) => {
    if (route === "users" && String(req.user._id) === req.params.id)
      fail(403, "Không thể tự ngừng hoạt động tài khoản đang đăng nhập.");
    if (route === "stickers") {
      // Sticker đã dán được in thẳng vào ảnh nên xóa hẳn không ảnh hưởng vé cũ.
      if (!(await Sticker.findByIdAndDelete(id.parse(req.params.id))))
        fail(404, "Không tìm thấy dữ liệu.");
      return res.json({ ok: true });
    }
    if (route === "frames") {
      // Khung không gắn với vé nào nên xóa hẳn.
      const removed = await withFrameCatalogLock(() =>
        Frame.findByIdAndDelete(id.parse(req.params.id)),
      );
      if (!removed) fail(404, "Không tìm thấy dữ liệu.");
      return res.json({ ok: true });
    }
    const result = await Model.findByIdAndUpdate(
      id.parse(req.params.id),
      { active: false },
      { new: true },
    );
    if (!result) fail(404, "Không tìm thấy dữ liệu.");
    res.json({ ok: true });
  });
}
