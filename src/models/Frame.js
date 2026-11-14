import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const frameSchema = new mongoose.Schema(
  {
    name: String,
    themeName: { type: String, default: "" },
    order: { type: Number, default: 0 },
    printSize: { type: String, enum: ["full", "strip", "instax", "large"], default: "full" },
    image: String,
    // Ảnh xem nhanh (WebP, cạnh dài 720 px) cho danh sách / bộ chọn chủ đề — khách lướt chọn khung
    // không phải tải ảnh khung gốc (vài MB mỗi khung). Ghép ảnh và in luôn dùng `image`.
    thumb: String,
    // Mã nội dung ảnh (sha1 rút gọn): đổi khi và chỉ khi đổi ảnh, dùng làm ?v= cho cache trình duyệt.
    imageHash: String,
    // Vùng trên khung (tỉ lệ 0–1): "photo" = ô đặt ảnh, `photo` là số thứ tự ảnh (các vùng cùng số
    // in cùng một ảnh — vd. 2 dải giống nhau trên khung nhỏ); "qr" = mã QR album; "date" = ngày in.
    slots: [{
      _id: false,
      x: Number,
      y: Number,
      w: Number,
      h: Number,
      kind: { type: String, enum: ["photo", "qr", "date"], default: "photo" },
      photo: Number,
      // Ô xoay (độ, quanh tâm ô) — khung chép từ Selfbooth có ô nghiêng.
      angle: { type: Number, min: -180, max: 180 },
    }],
    // Khung phủ cả tờ 10 × 15 cm (1200 × 1800 hoặc 1800 × 1200): khung nhỏ là 2 dải trên một tờ, máy
    // in cắt đôi. Khung cũ (false): khung nhỏ là một dải, khi in ghép 2 dải lên một tờ.
    sheet: { type: Boolean, default: false },
    dateColor: { type: String, default: "#2f1a12" },
    // Số lượng ảnh được chụp gợi ý cho khung (thông tin cho quản trị, như Snapbox).
    shots: { type: Number, default: 0 },
    // Khung chép từ nơi khác, vd. "selfbooth:<mã khung>" (Khung ảnh → Chép khung từ Selfbooth): không chép
    // trùng lần hai.
    source: String,
    active: Boolean,
  },
  { timestamps: true },
);

frameSchema.index({ active: 1, themeName: 1, order: 1 });

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, frameSchema);

export default mongoose.model("Frame", frameSchema, "frames");
