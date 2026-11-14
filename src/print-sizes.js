// Khổ in của vé / gói / khung / lệnh in.
// - full: tờ 10 × 15 nguyên tờ (máy DNP DS-RX1 của phòng Photobooth)
// - strip: tờ 10 × 15 cắt đôi thành 2 dải 5 × 15 (DS-RX1)
// - instax: thẻ Instax Wide (phòng Polaroid trước 14/11, còn cho vé / gói cũ)
// - large: tờ 20 × 30 cm (8 × 12 inch) máy DNP DS820 — phòng Polaroid chạy như web Selfbooth (14/11).
export const PRINT_SIZES = ["full", "strip", "instax", "large"];

// Khổ của phòng Polaroid / Selfbooth: khách chọn ảnh, bộ khung và gửi in trên điện thoại.
export const isPolaroidSize = (printSize) => printSize === "instax" || printSize === "large";
// Khổ mới cho gói / khung Polaroid tạo từ 14/11.
export const POLAROID_SIZE = "large";
// Tờ 20 × 30 cm ở 300 điểm / inch (như Selfbooth).
export const LARGE_SHEET = { width: 2400, height: 3600 };
