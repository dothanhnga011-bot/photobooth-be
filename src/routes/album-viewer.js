import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";

// Mỗi điện thoại mở album có một mã máy ngẫu nhiên (cookie HttpOnly, chỉ gửi kèm /api/albums): ảnh máy
// chụp thì ai quét mã cũng thấy đủ; ảnh khách tải lên từ điện thoại chỉ điện thoại đó thấy, và khách xoá ảnh
// máy chụp thì chỉ ẩn trên máy mình. Cookie đi kèm cả <img src>, tải ZIP — không cần header riêng.
// Cơ sở dữ liệu chỉ lưu mã đã băm; ảnh chỉ thành "của riêng" khi trang album gửi X-Album-Guest: 1 lúc tải
// lên (máy chụp gửi ảnh vào album không bao giờ gửi header này, kể cả khi trình duyệt có cookie).
const COOKIE = "album_device";
const DEVICE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_AGE_MS = 180 * 86400000;

export function albumViewer(req, res) {
  let device = req.cookies?.[COOKIE];
  if (typeof device !== "string" || !DEVICE.test(device)) {
    device = randomUUID();
    res.cookie(COOKIE, device, {
      httpOnly: true,
      sameSite: config.production ? "none" : "lax",
      secure: config.production,
      path: "/api/albums",
      maxAge: MAX_AGE_MS,
    });
  }
  return createHash("sha256").update(device).digest("hex").slice(0, 32);
}

// Ảnh máy này thấy: chưa xoá, của chung (ảnh máy chụp) hoặc do chính máy này tải lên, và máy này chưa ẩn.
export const visibleTo = (viewer) => (photo) =>
  !photo.deleted && (!photo.owner || photo.owner === viewer) && !(photo.hiddenFor || []).includes(viewer);

export const guestUpload = (req) => req.get("X-Album-Guest") === "1";
