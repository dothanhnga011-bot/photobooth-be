// Số tờ in của gói: gói lưu số tờ 10 × 15 cm; khổ nhỏ (strip) một tờ cắt đôi thành 2 tờ nhỏ;
// khổ Instax mỗi tấm là một thẻ Instax Wide.
// Khách in tối thiểu 2 tờ: khổ nhỏ ít nhất 1 tờ 10 × 15, khổ to 2 tờ, Instax 2 tấm.
// Máy chụp tính giống hệt (photobooth-fe/src/kiosk/print-count.js).
export const MIN_PIECES = 2;
export const piecesPerSheet = (printSize) => (printSize === "strip" ? 2 : 1);
export const leastSheets = (printSize) => Math.ceil(MIN_PIECES / piecesPerSheet(printSize));
// Gói cũ kèm ít hơn mức tối thiểu: phần thiếu tính như tờ in thêm.
export const minSheets = (pack) =>
  Math.max(Number(pack.prints) || 0, leastSheets(pack.printSize || "full"));
// Giá một tờ in thêm theo khổ (Cài đặt → Khổ ảnh & bảng giá): phim Instax có giá riêng.
export const extraPriceFor = (printSize, settings) =>
  printSize === "instax" ? settings?.extraInstaxPrice : settings?.extraPrintPrice;
export const saleTotal = (pack, sheets, extraPrice) =>
  (Number(pack.price) || 0) +
  Math.max(0, sheets - (Number(pack.prints) || 0)) * (Number(extraPrice) || 0);
