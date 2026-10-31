import { Router } from "express";
import { z } from "zod";
import { Setting } from "../../models/index.js";
import { admin } from "../../middleware/auth.js";
import { text, priceVND } from "../validation.js";

export const settingsRouter = Router();

settingsRouter.get("/", admin, async (req, res) =>
  res.json((await Setting.findOne({ key: "studio" }))?.value || {}),
);

// Only the extra-sheet prices (admins only): a 10 × 15 sheet and an Instax Wide print. The rest of
// the studio settings are left exactly as they are.
settingsRouter.put("/extra-print-price", admin, async (req, res) => {
  const prices = z
    .object({
      extraPrintPrice: priceVND(10_000_000).optional(),
      extraInstaxPrice: priceVND(10_000_000).optional(),
    })
    .refine((v) => v.extraPrintPrice !== undefined || v.extraInstaxPrice !== undefined, "Vui lòng nhập giá in thêm.")
    .parse(req.body);
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: Object.fromEntries(Object.entries(prices).filter(([, v]) => v !== undefined)
      .map(([key, v]) => [`value.${key}`, v])) },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});

// Màn hình chờ của máy chụp (Tap to start): tiêu đề, dòng phụ và ảnh nền tùy chọn.
settingsRouter.put("/kiosk", admin, async (req, res) => {
  const kiosk = z
    .object({
      idleTitle: z.string().trim().max(60).default(""),
      idleSubtitle: z.string().trim().max(120).default(""),
      idleImage: z
        .string()
        .max(4_200_000, "Ảnh nền quá lớn. Vui lòng chọn ảnh dưới 3 MB.")
        .refine(
          (v) => v === "" || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v),
          "Ảnh nền phải là ảnh PNG, JPG hoặc WebP.",
        )
        .default(""),
    })
    .parse(req.body);
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: { "value.kiosk": kiosk } },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});

// Các bộ lọc màu được bật cho khách. Công thức xử lý ảnh nằm trong ứng dụng;
// quản trị viên chỉ bật/tắt để ảnh xem trước và ảnh xuất luôn giống nhau.
settingsRouter.put("/filters", admin, async (req, res) => {
  const enabledFilters = z
    .array(z.enum(["original", "soft", "warm", "film", "mono", "vintage", "retro"]))
    .min(1, "Cần bật ít nhất một bộ lọc.")
    .transform((items) => [...new Set(["original", ...items])])
    .parse(req.body.enabledFilters);
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: { "value.enabledFilters": enabledFilters } },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});

// Bộ lọc màu do tiệm tự tạo (Thiết lập → Quản lý filter): các chỉ số như CSS filter, tính bằng %
// (100 = giữ nguyên; xoay màu tính bằng độ). Ảnh xem trước và ảnh in dùng cùng công thức.
settingsRouter.put("/custom-filters", admin, async (req, res) => {
  const percent = (min, max, fallback) => z.number().int().min(min).max(max).default(fallback);
  const customFilters = z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9]{6,16}$/),
        name: z.string().trim().min(1, "Vui lòng nhập tên filter.").max(40),
        brightness: percent(50, 150, 100),
        contrast: percent(50, 200, 100),
        saturate: percent(0, 200, 100),
        sepia: percent(0, 100, 0),
        hueRotate: percent(-180, 180, 0),
        active: z.boolean().default(true),
      }),
    )
    .max(30, "Tối đa 30 filter.")
    .refine((items) => new Set(items.map((f) => f.id)).size === items.length, "Mã filter bị trùng.")
    .parse(req.body.customFilters);
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: { "value.customFilters": customFilters } },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});

// Chữ trên màn hình máy chụp (Thiết lập → Chữ trên máy chụp): mỗi khóa là một dòng chữ; để trống
// là dùng chữ mặc định của máy chụp.
settingsRouter.put("/kiosk-texts", admin, async (req, res) => {
  const kioskTexts = z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9.]{1,40}$/), z.string().trim().max(200))
    .refine((value) => Object.keys(value).length <= 80, "Quá nhiều dòng chữ.")
    .transform((value) => Object.fromEntries(Object.entries(value).filter(([, text]) => text)))
    .parse(req.body.kioskTexts);
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: { "value.kioskTexts": kioskTexts } },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});

settingsRouter.put("/", admin, async (req, res) => {
  const value = z
    .object({
      name: text,
      address: text,
      phone: z
        .string()
        .trim()
        .regex(/^[+\d][\d .-]{6,18}$/, "Số điện thoại không hợp lệ."),
      bank: z.string().trim().max(100),
      bankAccount: z
        .string()
        .trim()
        .regex(/^$|^[\d ]{6,30}$/, "Số tài khoản chỉ gồm chữ số (6–30 số)."),
      bankOwner: z.string().trim().max(100),
      bankQrImage: z
        .string()
        .max(2_100_000, "Ảnh QR quá lớn. Vui lòng chọn ảnh dưới 1,5 MB.")
        .refine(
          (v) =>
            v === "" ||
            /^https?:\/\//.test(v) ||
            /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(v),
          "Ảnh QR phải là URL hoặc ảnh base64 hợp lệ",
        )
        .optional()
        .default(""),
      // Giá bán thêm 1 tờ in 15 × 10 cm tại quầy (0 = chưa bán lẻ).
      extraPrintPrice: priceVND(10_000_000).optional(),
      extraInstaxPrice: priceVND(10_000_000).optional(),
    })
    // Thông tin chuyển khoản: nhập thì nhập đủ cả 3 ô.
    .refine(
      (v) =>
        [v.bank, v.bankAccount, v.bankOwner].every(Boolean) ||
        ![v.bank, v.bankAccount, v.bankOwner].some(Boolean),
      "Vui lòng nhập đủ tên ngân hàng, số tài khoản và chủ tài khoản.",
    )
    .parse(req.body);
  // Ghi từng mục: không xóa mất cài đặt lưu ở chỗ khác (giá in thêm, màn hình chờ kiosk).
  const saved = await Setting.findOneAndUpdate(
    { key: "studio" },
    { $set: Object.fromEntries(Object.entries(value).map(([key, v]) => [`value.${key}`, v])) },
    { upsert: true, new: true },
  );
  res.json(saved.value);
});
