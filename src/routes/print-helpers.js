import { Booking } from "../models/index.js";
import { printExpiry } from "../services/media.js";
import { printExtension } from "../services/print-image.js";

export const quotaMessage = (quota, used) =>
  used < quota
    ? `Vé của bạn còn ${quota - used}/${quota} tờ in. Hãy bỏ bớt tờ, hoặc mua thêm tờ in tại quầy.`
    : `Vé đã dùng hết ${quota} tờ in. Muốn in thêm, bạn mua thêm tờ tại quầy nhé.`;
// Giữ chỗ n tờ in trong một lệnh ghi duy nhất: 2 lần bấm "Gửi in" cùng lúc không vượt số tờ của vé.
export const reserveSheets = (b, n, frameName = "") =>
  Booking.findOneAndUpdate(
    {
      _id: b._id,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$printSheets", 0] }, n] },
          { $ifNull: ["$prints", 1] },
        ],
      },
    },
    { $inc: { printSheets: n }, ...(frameName && { $set: { frameName } }) },
    { new: true },
  );
export const releaseSheets = (bookingId, n) =>
  Booking.updateOne({ _id: bookingId }, [
    {
      $set: {
        printSheets: {
          $max: [0, { $subtract: [{ $ifNull: ["$printSheets", 0] }, n] }],
        },
      },
    },
  ]);

export const publicJob = (job, accessToken) => ({
  _id: job._id,
  code: job.code,
  name: job.name,
  roomName: job.roomName,
  copies: job.copies,
  frameName: job.frameName,
  printSize: job.printSize || "full",
  sheetCount: job.sheets?.length || 1,
  // Định dạng tờ in (png / jpg): nút "Tải ảnh final" ghi đúng loại tệp.
  format: printExtension(job.sheets?.[0]?.file || job.file || ""),
  spoolStatus: job.spoolStatus,
  spoolMessage: job.spoolMessage,
  width: job.width,
  height: job.height,
  status: job.status,
  createdAt: job.createdAt,
  // Lệnh in lưu 3 ngày kể từ lúc gửi rồi tự xóa cùng file tờ in.
  expiresAt: printExpiry(job),
  operatorPrint: Boolean(job.operatorPrint),
  printedAt: job.printedAt,
  printedBy: job.printedBy,
  image: accessToken ? `/api/albums/${accessToken}/prints/${job._id}` : "",
});
