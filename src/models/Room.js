import mongoose from "mongoose";
import { catalogCache, clearOnWrite } from "../services/read-cache.js";

const roomSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    branch: String,
    machineCode: { type: String, default: "" },
    model: { type: String, default: "" },
    importedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    // Chế độ lật ảnh của máy chụp: "device" = theo cài đặt trên máy, "on"/"off" = quản trị đặt từ xa.
    flip: { type: String, enum: ["device", "on", "off"], default: "device" },
    // Lần cuối máy chụp báo còn mở (POST /kiosk/ping): bảng Quản lý máy hiện Online / Offline.
    lastSeenAt: { type: Date, default: null },
    // Loại hình chụp của phòng (chọn khi Cài máy chụp): "photobooth" = khách chọn Nhập mã (chuyển
    // khoản ở quầy) hoặc Tiền mặt (đút tiền) rồi chụp, in DNP; "polaroid" = khách chọn layout rồi
    // chụp bằng dây bấm, trả tiền ở quầy, in Instax Wide.
    kind: { type: String, enum: ["photobooth", "polaroid"], default: "photobooth" },
    // Cũ (trước khi chia photobooth / polaroid): phòng nhập mã / phòng đút tiền. Không còn dùng.
    payment: { type: String, enum: ["counter", "cash"], default: "counter" },
    // Chế độ thử: máy chụp có nút bỏ qua bước trả tiền (chưa lắp máy nhận tiền). Không tính doanh thu.
    paymentTest: { type: Boolean, default: false },
    active: Boolean,
  },
  { timestamps: true },
);

// /api/catalog is cached in memory; any change here refreshes it.
clearOnWrite(catalogCache, roomSchema);

export default mongoose.model("Room", roomSchema, "rooms");
