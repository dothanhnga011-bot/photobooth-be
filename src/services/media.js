import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import {
  isR2File,
  mediaReference,
  r2Storage,
  validateMediaStorage,
} from "./r2.js";
import Booking from "../models/Booking.js";
import PrintJob from "../models/PrintJob.js";
import { expiredBookingHistory } from "./booking-history.js";
import { archiveBookingRevenue } from "./revenue-ledger.js";

// New files use the configured store; opaque r2: references keep older GridFS
// files readable throughout the transition. Never use ephemeral disk for writes.
const retentionHours = Number(process.env.MEDIA_TTL_HOURS || 72);
if (!Number.isFinite(retentionHours) || retentionHours <= 0)
  throw new Error("MEDIA_TTL_HOURS phải là số giờ lớn hơn 0.");
export const MEDIA_TTL_MS = retentionHours * 60 * 60 * 1000;
const buckets = new WeakMap();
const bucket = () => {
  const db = mongoose.connection.db;
  let current = buckets.get(db);
  if (!current) {
    current = new mongoose.mongo.GridFSBucket(db, { bucketName: "media" });
    buckets.set(db, current);
  }
  return current;
};

export async function saveMedia(file, buffer, contentType) {
  file = mediaReference(file);
  if (isR2File(file)) {
    await r2Storage.save(file, buffer, contentType);
    return file;
  }
  await new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(file, {
      metadata: { contentType },
    });
    upload.once("error", reject).once("finish", resolve);
    upload.end(buffer);
  });
  return file;
}

export async function readMedia(file) {
  if (isR2File(file)) return r2Storage.read(file);
  const [info] = await bucket().find({ filename: file }).limit(1).toArray();
  if (!info)
    return fs.readFile(path.join(config.uploadDir, file)).catch(() => null);
  const chunks = [];
  for await (const chunk of bucket().openDownloadStream(info._id))
    chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function deleteMedia(files) {
  const unique = [...new Set(files.filter(Boolean))];
  const remote = unique.filter(isR2File);
  // Batch remote deletes; partial failures retain refs for the next TTL retry.
  if (remote.length) await r2Storage.deleteMany(remote);
  for (const file of unique.filter((name) => !isR2File(name))) {
    const b = bucket();
    const found = await b.find({ filename: file }).toArray();
    await Promise.all(found.map((f) => b.delete(f._id)));
    // Dọn cả file cũ còn trên ổ đĩa (dữ liệu trước khi chuyển sang GridFS).
    await fs.unlink(path.join(config.uploadDir, file)).catch(() => {});
  }
}

const LINK_WINDOW_MS = 120_000, LINK_MAX_SECONDS = 300, LINK_MARGIN_SECONDS = 15;

// Links are signed for a fixed 2-minute window, so every request in that window gets the very
// same URL: the browser reuses the cached redirect and image bytes (gallery revisits, editor ↔
// gallery) instead of asking Render and R2 again. A link never outlives the photo.
function linkWindow(expiresAt, now) {
  let signedAt = Math.floor(now / LINK_WINDOW_MS) * LINK_WINDOW_MS;
  let seconds = Math.min(LINK_MAX_SECONDS, Math.floor((Number(expiresAt) - signedAt) / 1000));
  const fresh = Math.floor((signedAt + seconds * 1000 - now) / 1000) - LINK_MARGIN_SECONDS;
  if (fresh <= 0) {
    // Photo about to expire: a one-off link, not cached.
    signedAt = now;
    seconds = Math.min(LINK_MAX_SECONDS, Math.floor((Number(expiresAt) - now) / 1000));
  }
  return { signedAt, seconds, fresh };
}
const signLink = (file, { signedAt, seconds }, contentType, disposition) =>
  r2Storage.signedGet(file, seconds, {
    ...(contentType && { ResponseContentType: contentType }),
    ...(disposition && { ResponseContentDisposition: disposition }),
    ResponseCacheControl: `private, max-age=${seconds}`,
  }, new Date(signedAt));

// The stored file behind each size of /albums/:token/photos/:id?size=… (and the album's links).
export function photoFile(p, size) {
  switch (size) {
    case "thumbnail": return p.thumbnailFile || p.file;
    case "preview": return p.previewFile || p.thumbnailFile || p.file;
    // Ảnh cũ chưa có nguồn in: trả ảnh gốc (máy khách chỉ xin size=print khi printSource).
    case "print": return p.printFile || p.file;
    default: return p.file;
  }
}

// The album sends each photo's storage links with the photo list, so the gallery, the editor and
// print composition load straight from R2 instead of one server round trip (a 302 or a JSON link)
// per image. They are the very URLs /photos/:id?size=…&direct=1 redirects to in the same window,
// so either path reuses the other's cached bytes. Album polls in one window revalidate to an
// empty 304, so carrying the links costs a few KB only when the window changes.
// Legacy GridFS photos and photos about to expire get no links.
const LINKED_SIZES = ["thumbnail", "preview", "print", "original", "download"];
export async function photoLinks(p, now = Date.now()) {
  if (!p || !isR2File(p.file)) return undefined;
  const files = Object.fromEntries(LINKED_SIZES
    .filter((size) => (size !== "print" || p.printFile) && (size !== "download" || p.downloadFile))
    .map((size) => [size, size === "download" ? p.downloadFile : photoFile(p, size)]));
  return mediaLinks(files, photoExpiry(p), "image/jpeg", now);
}

// Videos and composed photos are retained until the last photo expires, including hidden
// photos (the cleanup task uses the same rule). A media-only remainder uses its stored expiry.
export function albumMediaExpiry(b) {
  if (b.mediaDeleted) return undefined;
  const sessionEnd = b.captureEndsAt || b.createdAt;
  return b.photos?.length
    ? new Date(Math.max(...b.photos.map((p) => photoExpiry(p).getTime())))
    : b.mediaExpiresAt || (sessionEnd ? new Date(Number(sessionEnd) + MEDIA_TTL_MS) : undefined);
}

export async function mediaLinks(files, expiresAt, contentType, now = Date.now()) {
  if (!expiresAt || !Object.values(files).some(isR2File)) return undefined;
  const window = linkWindow(expiresAt, now);
  if (window.fresh <= 0 || window.seconds <= 0) return undefined;
  const links = { until: new Date(window.signedAt + window.seconds * 1000) };
  await Promise.all(
    Object.entries(files).map(async ([size, file]) => {
      if (isR2File(file)) links[size] = await signLink(file, window, contentType);
    }),
  );
  return links;
}

// Gửi file cho client, hỗ trợ Range để trình duyệt tua/phát video.
export async function sendMedia(req, res, file, contentType, expiresAt) {
  const remote = isR2File(file);
  // Only authenticated routes supply an expiry. The bucket remains private;
  // each link authorizes one file for at most five minutes, within its TTL.
  // HEAD/Range and older clients keep the streaming path below.
  if (remote && req.method === "GET" && !req.headers.range &&
      ["1", "link"].includes(req.query.direct) && expiresAt) {
    const window = linkWindow(expiresAt, Date.now());
    const { seconds, fresh } = window;
    if (seconds > 0) {
      const location = await signLink(file, window, contentType, res.getHeader("Content-Disposition"));
      res.set("Cache-Control", fresh > 0 ? `private, max-age=${fresh}` : "private, no-store");
      // Canvas fetches request a JSON link and fetch R2 themselves. Following a
      // redirect across API + storage origins can change the CORS Origin to null.
      if (req.query.direct === "link") {
        res.removeHeader("Content-Disposition");
        return res.type("application/json").json({ url: location });
      }
      return res.redirect(302, location);
    }
  }
  // Tải trọn tệp trên R2 (không Range, không HEAD): lệnh GET đã kèm kích thước và loại tệp nên bỏ
  // lệnh HEAD riêng — mỗi ảnh bớt một vòng đi về tới R2 (thư viện mở hàng chục ảnh nhỏ một lúc).
  if (remote && req.method !== "HEAD" && !req.headers.range) {
    const data = await r2Storage.get(file);
    if (!data)
      return res.status(404).json({ message: "Ảnh/video đã hết hạn lưu trữ." });
    res.type(contentType || data.ContentType || "application/octet-stream");
    res.set("Accept-Ranges", "bytes");
    if (Number.isFinite(data.ContentLength))
      res.set("Content-Length", String(data.ContentLength));
    if (data.ContentLength === 0) {
      data.Body?.destroy?.();
      return res.end();
    }
    await pipeline(data.Body, res);
    return;
  }
  const info = remote
    ? await r2Storage.head(file)
    : (await bucket().find({ filename: file }).limit(1).toArray())[0];
  if (!info) {
    // Tương thích dữ liệu cũ nằm trên ổ đĩa.
    const disk = path.join(config.uploadDir, file);
    if (!remote && (await fs.stat(disk).catch(() => null)))
      return res.sendFile(disk);
    return res.status(404).json({ message: "Ảnh/video đã hết hạn lưu trữ." });
  }
  const size = remote ? info.ContentLength : info.length;
  res.type(
    contentType ||
      info.ContentType ||
      info.metadata?.contentType ||
      "application/octet-stream",
  );
  res.set("Accept-Ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else start = Math.max(0, size - Number(range[2]));
    if (start > end || start >= size) {
      res.set("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.set("Content-Length", String(end - start + 1));
  if (req.method === "HEAD" || size === 0) return res.end();
  if (remote) {
    const data = await r2Storage.get(
      file,
      range && (range[1] || range[2]) ? `bytes=${start}-${end}` : undefined,
    );
    if (!data) {
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Range");
      return res.status(404).json({ message: "Ảnh/video đã hết hạn lưu trữ." });
    }
    // Keep the existing authenticated URLs; bucket keys/credentials are private.
    await pipeline(data.Body, res);
    return;
  }
  await new Promise((resolve, reject) =>
    bucket()
      .openDownloadStream(info._id, { start, end: end + 1 })
      .once("error", reject)
      .pipe(res)
      .once("finish", resolve)
      .once("close", resolve),
  );
}

// Mỗi ảnh lưu MEDIA_TTL_HOURS giờ (mặc định 72 = 3 ngày) kể từ lúc chụp / tải lên — thời điểm lấy từ
// mã ảnh (ObjectId), nên ảnh cũ cũng tính đúng. Lệnh in dùng cùng thời hạn kể từ lúc khách gửi.
export const photoTime = (p) => p._id.getTimestamp().getTime();
export const photoExpiry = (p) => new Date(photoTime(p) + MEDIA_TTL_MS);
export const printExpiry = (job) => new Date(Math.min(
  new Date(job.createdAt).getTime() + MEDIA_TTL_MS,
  job.fileExpiresAt ? new Date(job.fileExpiresAt).getTime() : Infinity,
));
export const livePrintFilter = (now = Date.now()) => ({
  createdAt: { $gt: new Date(Number(now) - MEDIA_TTL_MS) },
  $or: [{ fileExpiresAt: null }, { fileExpiresAt: { $gt: new Date(now) } }],
});
// Reprints share files. Deleting one job must not break the other jobs using them.
export async function unsharedPrintFiles(jobs) {
  const files = [...new Set(jobs.flatMap((j) => [j.file, ...(j.sheets || []).map((s) => s.file)]).filter(Boolean))];
  if (!files.length) return [];
  const others = await PrintJob.find({ _id: { $nin: jobs.map((j) => j._id) },
    $or: [{ file: { $in: files } }, { "sheets.file": { $in: files } }],
  }).select("file sheets.file").lean();
  const used = new Set(others.flatMap((j) => [j.file, ...(j.sheets || []).map((s) => s.file)]));
  return files.filter((file) => !used.has(file));
}
// Lúc ảnh sớm nhất còn lại tự xóa (hiện cho khách: "ảnh đầu tiên tự xóa lúc …").
export function firstExpiry(photos = []) {
  const shown = photos.filter((p) => !p.deleted);
  const list = shown.length ? shown : photos;
  return list.length
    ? new Date(Math.min(...list.map(photoTime)) + MEDIA_TTL_MS)
    : undefined;
}

export async function purgeExpiredMedia(now = new Date()) {
  const cutoff = new Date(now - MEDIA_TTL_MS);
  // Mọi ObjectId tạo trước giây (cutoff + 1) — lọc chính xác lại bằng photoTime bên dưới.
  const before = mongoose.Types.ObjectId.createFromTime(
    Math.floor(cutoff.getTime() / 1000) + 1,
  );
  const candidates = await Booking.find({
    $or: [
      { "photos._id": { $lt: before } },
      // Album đã hết ảnh nhưng còn video / ảnh ghép khung.
      { "video.file": { $exists: true }, mediaExpiresAt: { $lte: now } },
      { "composite.file": { $exists: true }, mediaExpiresAt: { $lte: now } },
      // Phiên chỉ tải được video/ảnh ghép mà không có ảnh gốc vẫn phải hết hạn.
      { "photos.0": { $exists: false }, mediaExpiresAt: null, createdAt: { $lte: cutoff },
        $or: [{ "video.file": { $exists: true } }, { "composite.file": { $exists: true } }] },
    ],
  });
  let changed = 0;
  for (const b of candidates) {
    const old = b.photos.filter((p) => photoTime(p) <= cutoff.getTime());
    const keep = b.photos.filter((p) => photoTime(p) > cutoff.getTime());
    // Lọc lại hạn của album chỉ có video/ảnh ghép: createdAt có thể sớm hơn buổi chụp nhiều ngày.
    if (!old.length && (!albumMediaExpiry(b) || albumMediaExpiry(b) > now)) continue;
    // Video và ảnh ghép khung xóa cùng ảnh cuối cùng của album.
    const video = keep.length
      ? []
      : [b.video?.file, b.composite?.file, b.composite?.thumbnailFile, b.composite?.previewFile].filter(Boolean);
    if (!old.length && !video.length) continue;
    changed++;
    await deleteMedia([
      ...old.flatMap((p) =>
        [p.file, p.originalFile, p.thumbnailFile, p.previewFile, p.printFile, p.downloadFile].filter(Boolean),
      ),
      ...video,
    ]);
    // Chỉ gỡ đúng các ảnh hết hạn (ảnh vừa chụp thêm trong lúc dọn không bị ảnh hưởng).
    await Booking.updateOne(
      { _id: b._id },
      {
        $pull: { photos: { _id: { $in: old.map((p) => p._id) } } },
        ...(keep.length && { $set: { mediaExpiresAt: firstExpiry(keep) } }),
      },
    );
    // Hết sạch ảnh: album báo "Ảnh đã hết hạn lưu trữ".
    await Booking.updateOne(
      { _id: b._id, photos: { $size: 0 } },
      { $set: { mediaDeleted: true }, $unset: { video: 1, composite: 1 } },
    );
  }
  // Lệnh in dùng cùng thời hạn lưu trữ (đã in hay chưa), rồi xóa cùng file tờ in.
  const oldJobs = await PrintJob.find({ $or: [{ createdAt: { $lte: cutoff } }, { fileExpiresAt: { $lte: now } }] });
  await deleteMedia(await unsharedPrintFiles(oldJobs));
  await PrintJob.deleteMany({ _id: { $in: oldJobs.map((j) => j._id) } });
  await purgeExpiredCustomerData(now);
  return changed;
}

// Expired, file-free orders move to the financial ledger, then leave Booking entirely.
async function purgeExpiredCustomerData(now) {
  const eligible = {
    ...expiredBookingHistory(now, MEDIA_TTL_MS),
    "photos.0": { $exists: false },
    "video.file": { $exists: false },
    "composite.file": { $exists: false },
  };
  // Join theo chỉ mục booking của PrintJob, đọc từng batch thay vì nạp mọi vé cũ vào RAM.
  const cursor = Booking.aggregate([
    { $match: eligible },
    { $lookup: { from: PrintJob.collection.name, localField: "_id", foreignField: "booking",
      pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: "remainingPrints" } },
    { $match: { "remainingPrints.0": { $exists: false } } },
    { $project: { _id: 1 } },
  ]).cursor({ batchSize: 500 });
  try {
    for await (const booking of cursor) await archiveBookingRevenue(booking._id, eligible, now);
  } finally {
    await cursor.close();
  }
}

export function startMediaCleanup() {
  validateMediaStorage();
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await purgeExpiredMedia(); }
    catch (e) { console.error("Dọn ảnh/video hết hạn thất bại:", e.message); }
    finally { running = false; }
  };
  run();
  return setInterval(run, 15 * 60 * 1000).unref();
}
