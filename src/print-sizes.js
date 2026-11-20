// Khổ in của vé / gói / khung / lệnh in.
// - full: tờ 10 × 15 nguyên tờ (máy DNP DS-RX1 của phòng Photobooth)
// - strip: tờ 10 × 15 cắt đôi thành 2 dải 5 × 15 (DS-RX1)
// - large: tờ 20 × 30 cm (8 × 12 inch) máy DNP DS820 — phòng Selfbooth chạy như web Selfbooth.
export const PRINT_SIZES = ["full", "strip", "large"];

// Khổ của phòng Selfbooth: khách chọn ảnh, bộ khung và gửi in trên điện thoại.
export const isSelfboothSize = (printSize) => printSize === "large";
// Khổ của gói / khung phòng Selfbooth.
export const SELFBOOTH_SIZE = "large";
// Tờ 20 × 30 cm ở 300 điểm / inch (như Selfbooth).
export const LARGE_SHEET = { width: 2400, height: 3600 };
