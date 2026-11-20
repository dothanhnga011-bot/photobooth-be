import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const packageSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    price: Number,
    duration: Number,
    shots: Number,
    prints: Number,
    // Cũ: đếm ngược khi phòng Selfbooth tự chụp. Giờ mọi phòng chụp bằng dây bấm, không còn dùng.
    countdownSeconds: { type: Number, default: 10 },
    // Số ảnh khách chọn để ghép khung trên máy chụp (vd. gói 70k chọn 4 tấm).
    selectCount: { type: Number, default: 4 },
    // full: 10 × 15 nguyên tờ · strip: 1 tờ cắt đôi · large: gói phòng Selfbooth, tờ 20 × 30 máy DNP DS820.
    printSize: { type: String, enum: ["full", "strip", "large"], default: "full" },
    // Chi nhánh được bán gói này; để trống = mọi chi nhánh (cấu hình chung).
    branches: { type: [String], default: [] },
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, packageSchema);

export default mongoose.model("Package", packageSchema, "packages");
