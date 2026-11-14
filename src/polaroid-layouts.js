import { isPolaroidSize } from "./print-sizes.js";
// Gói phòng Polaroid (khổ Instax) tính theo thời gian như Selfbooth (14/11 chủ tiệm bỏ 2 layout "1 ảnh ·
// 3 phút" và "2 ảnh · 5 phút"): giá, số phút chụp và số tấm Instax nằm trong gói. Khách bấm dây không
// giới hạn trong thời gian của gói, chọn ảnh và bộ khung trên điện thoại. Vé đã bán giữ đúng gói lúc bán.
export function polaroidPackage(pack) {
  if (!isPolaroidSize(pack?.printSize)) return pack;
  return { ...pack, shots: 0, prints: Math.max(1, Number(pack.prints) || 1) };
}
