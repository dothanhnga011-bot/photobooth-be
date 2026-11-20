// Khổ in đã bỏ (19/11 chủ tiệm: web chỉ in ra DNP — tờ 10 × 15 ở phòng Photobooth, tờ 20 × 30 ở phòng
// Selfbooth). Gói, khung, vé và lệnh in còn ghi một khổ không còn trong PRINT_SIZES được đổi sang tờ 20 × 30
// khi máy chủ khởi động. Lệnh in cũ đang chờ thì dừng để nhân viên xem lại (ảnh cũ không đúng tờ 20 × 30).
// Giá in thêm cũ của phòng thứ hai chuyển sang giá in thêm tờ 20 × 30. Chạy lại nhiều lần không sao.
import { Booking, Frame, Package, PrintJob, Setting } from "../models/index.js";
import { SELFBOOTH_SIZE, PRINT_SIZES } from "../print-sizes.js";

const legacy = { printSize: { $exists: true, $nin: [...PRINT_SIZES, null] } };
// Tên cũ của giá in thêm phòng thứ hai, chỉ để đổi tên trường đã lưu.
const OLD_EXTRA_PRICE = "value.extraInstaxPrice";

export async function migrateLegacyPrintData() {
  const stopped = await PrintJob.collection.updateMany(
    { ...legacy, spoolStatus: { $in: ["queued", "sending"] } },
    { $set: { spoolStatus: "failed", spoolMessage: "Khổ in cũ đã bỏ: kiểm tra lại rồi in từ Đơn hàng nếu cần." } },
  );
  const [packages, frames, bookings, printJobs] = await Promise.all([Package, Frame, Booking, PrintJob]
    .map((model) => model.collection.updateMany(legacy, { $set: { printSize: SELFBOOTH_SIZE } })));
  const price = await Setting.collection.updateOne(
    { key: "studio", [OLD_EXTRA_PRICE]: { $exists: true } },
    { $rename: { [OLD_EXTRA_PRICE]: "value.extraSelfboothPrice" } },
  );
  return {
    packages: packages.modifiedCount, frames: frames.modifiedCount, bookings: bookings.modifiedCount,
    printJobs: printJobs.modifiedCount, stoppedPrints: stopped.modifiedCount, extraPrice: price.modifiedCount,
  };
}
