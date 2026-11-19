// 19/11 chủ tiệm: "không làm Polaroid nữa" — phòng thứ hai chỉ còn Selfbooth in tờ 20 × 30 ở máy DNP DS820. Gói và
// khung khổ Instax còn sót (tạo trước 14/11) được đổi sang 20 × 30 khi máy chủ khởi động, để trang quản trị và album
// không còn phần Instax. Chạy lại nhiều lần không sao (chỉ đổi những gì còn là Instax). Vé cũ khổ Instax giữ nguyên.
import { Frame, Package } from "../models/index.js";
import { POLAROID_SIZE } from "../print-sizes.js";

export async function retireInstax() {
  const [packages, frames] = await Promise.all([
    Package.updateMany({ printSize: "instax" }, { $set: { printSize: POLAROID_SIZE } }),
    Frame.updateMany({ printSize: "instax" }, { $set: { printSize: POLAROID_SIZE } }),
  ]);
  return { packages: packages.modifiedCount || 0, frames: frames.modifiedCount || 0 };
}
