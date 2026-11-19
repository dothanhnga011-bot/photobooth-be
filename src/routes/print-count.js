import { isPolaroidSize } from "../print-sizes.js";
// Số tờ in của gói: gói lưu số tờ 10 × 15 cm; khổ nhỏ (strip) một tờ cắt đôi thành 2 tờ nhỏ;
// gói Selfbooth mỗi tờ là một tờ 20 × 30.
// Khách in tối thiểu 2 tờ: khổ nhỏ ít nhất 1 tờ 10 × 15, khổ to 2 tờ. Gói Selfbooth kèm ít nhất 1 tờ 20 × 30.
// Máy chụp tính giống hệt (photobooth-fe/src/kiosk/print-count.js).
export const MIN_PIECES = 2;
export const SELFBOOTH_MIN_SHEETS = 1;
export const piecesPerSheet = (printSize) => (printSize === "strip" ? 2 : 1);
export const leastSheets = (printSize) =>
  isPolaroidSize(printSize) ? SELFBOOTH_MIN_SHEETS : Math.ceil(MIN_PIECES / piecesPerSheet(printSize));
// Gói cũ kèm ít hơn mức tối thiểu: phần thiếu tính như tờ in thêm.
export const minSheets = (pack) =>
  Math.max(Number(pack.prints) || 0, leastSheets(pack.printSize || "full"));
// Giá một tờ in thêm theo khổ (Cài đặt → Khổ ảnh & bảng giá): tờ 20 × 30 của Selfbooth có giá riêng.
export const extraPriceFor = (printSize, settings) =>
  isPolaroidSize(printSize) ? settings?.extraSelfboothPrice : settings?.extraPrintPrice;
export const saleTotal = (pack, sheets, extraPrice) =>
  (Number(pack.price) || 0) +
  Math.max(0, sheets - (Number(pack.prints) || 0)) * (Number(extraPrice) || 0);
