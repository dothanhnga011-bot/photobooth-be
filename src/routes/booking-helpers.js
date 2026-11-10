import { Booking } from "../models/index.js";
import { finishCapture, isOverdue } from "../services/capture.js";
import { albumMediaExpiry, mediaLinks, photoExpiry, photoLinks } from "../services/media.js";
import { fail } from "./validation.js";

export const publicBooking = (b) => ({
  ...(b.toObject ? b.toObject() : b),
  accessToken: undefined,
  captureSession: undefined,
  requestKey: undefined,
  requestFingerprint: undefined,
  extraPrintKeys: undefined,
  prints: printQuota(b),
  photos: b.photos
    .filter((p) => !p.deleted)
    .map((p, i) => ({
      number: p.number || i + 1,
      id: p._id,
      kind: p.kind,
      // Mỗi ảnh lưu 3 ngày kể từ lúc chụp.
      expiresAt: photoExpiry(p),
      // Máy chụp ghép ảnh "đang lưu" với ảnh đã lưu (không nạp lại ảnh đang hiện).
      clientKey: p.clientKey || undefined,
      mirrored: Boolean(p.mirrored),
      sourcePreserved: Boolean(p.sourcePreserved),
      // Ảnh gốc của máy ảnh chưa tới (album đang hiện ảnh xem trước 1600 px).
      originalPending: p.originalPending ? true : undefined,
      // Có nguồn in 3000 px riêng (ảnh mới); ảnh cũ in từ ảnh gốc.
      printSource: Boolean(p.printFile),
    })),
  // Video tua nhanh máy chụp quay trong lúc chụp (tải ở /albums/:token/video).
  video: b.video?.file ? { mimeType: b.video.mimeType, size: b.video.size } : undefined,
  // Ảnh đã ghép khung ở máy chụp (tải ở /albums/:token/composite).
  composite: b.composite?.file
    ? { frameName: b.composite.frameName || "", width: b.composite.width, height: b.composite.height }
    : undefined,
});
// Album page responses also carry each photo's storage links (see photoLinks): the gallery
// and editor load straight from R2 instead of one server round trip per image.
export async function albumBooking(b, now = Date.now()) {
  const json = publicBooking(b);
  const byId = new Map(b.photos.map((p) => [String(p._id), p]));
  json.photos = await Promise.all(json.photos.map(async (p) => {
    const links = await photoLinks(byId.get(String(p.id)), now);
    return links ? { ...p, links } : p;
  }));
  const expiresAt = albumMediaExpiry(b);
  if (json.video) {
    const links = await mediaLinks({ original: b.video.file }, expiresAt, b.video.mimeType, now);
    if (links) json.video.links = links;
  }
  if (json.composite) {
    const links = await mediaLinks({
      original: b.composite.file,
      thumbnail: b.composite.thumbnailFile || b.composite.file,
      preview: b.composite.previewFile || b.composite.file,
    }, expiresAt, "image/jpeg", now);
    if (links) json.composite.links = links;
  }
  return json;
}
// Số tờ 10 × 15 cm vé được in: theo gói lúc cấp mã + tờ mua thêm tại quầy.
export const printQuota = (b) => (Number.isFinite(b.prints) ? b.prints : 1);
export async function album(req, projection) {
  const read = () =>
    Booking.findOne({ accessToken: req.params.token }).select(projection);
  const b = await read();
  if (!b) fail(404, "Album không tồn tại hoặc đã hết hạn lưu trữ.");
  // Máy chụp tắt trước khi bấm "Hoàn thành": khách mở album vẫn nhận được ảnh.
  if (isOverdue(b))
    return (
      (await finishCapture(b._id)) ||
      (await read())
    );
  return b;
}

export const originals = (b) =>
  b.photos.filter((p) => p.kind === "original" && !p.deleted);
export function requireMedia(b) {
  if (b.status !== "completed" || !originals(b).length)
    fail(409, "Album chưa có ảnh hoặc ảnh đã hết hạn lưu trữ.");
}
