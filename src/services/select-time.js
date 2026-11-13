// Thời gian khách chọn / chỉnh ảnh (Quản trị → Chữ trên máy chụp → Thời gian chọn ảnh, settings.selectSeconds,
// 30–900 giây). Dùng chung cho màn chọn ảnh ở máy chụp phòng PTB và màn chỉnh ảnh trên điện thoại của phòng
// Selfbooth (Polaroid). Chưa đặt: 250 giây.
export const SELECT_SECONDS_DEFAULT = 250;
export function selectSecondsOf(value) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 30 && seconds <= 900 ? seconds : SELECT_SECONDS_DEFAULT;
}
