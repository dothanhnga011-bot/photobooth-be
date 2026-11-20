import { isSelfboothSize } from "./print-sizes.js";
// Gói phòng Selfbooth (tờ 20 × 30) tính theo thời gian như web Selfbooth: giá, số phút chụp và số tờ in
// nằm trong gói. Khách bấm dây không
// giới hạn trong thời gian của gói, chọn ảnh và bộ khung trên điện thoại. Vé đã bán giữ đúng gói lúc bán.
export function selfboothPackage(pack) {
  if (!isSelfboothSize(pack?.printSize)) return pack;
  return { ...pack, shots: 0, prints: Math.max(1, Number(pack.prints) || 1) };
}
