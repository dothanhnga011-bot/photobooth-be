import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import Booking from "../models/Booking.js";
import { saveMedia, deleteMedia, readMedia, photoExpiry, MEDIA_TTL_MS } from "./media.js";
import mongoose from "mongoose";
import { mediaReference } from "./r2.js";
import { cleanJpegMetadata } from "./jpeg-metadata.js";
import { saveImageTask } from "./image-save-queue.js";
import { schedulePrintSource } from "./print-source.js";
import { schedulePhotoDownload } from "./photo-download-warm.js";
import { inspectStoredOriginal } from "./direct-upload.js";

const locks = new Map();
export function captureLock(id, action) {
  const key = String(id),
    previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(key, next);
  return next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
}
export const captureError = (status, message) =>
  Object.assign(new Error(message), { status });

const THUMBNAIL_EDGE = 640;
const PREVIEW_EDGE = 1600;
// Print source: frame slots on a 1200 × 1800 px sheet are under ~900 px, so 3000 px holds
// every slot with room to zoom in, at a fraction of the 26 MP original's ~15 MB. Quality 95
// with full-resolution colour (4:4:4) keeps the camera's detail; the browser still falls
// back to the original whenever a slot is zoomed beyond what this source holds.
const PRINT_EDGE = 3000;
const preservesSource = (meta) => meta.format === "jpeg" && (meta.space === "srgb" || meta.space === "b-w");
// Keep JPEG pixel data byte for byte. Strip private metadata without decoding
// its pixels, retaining the colour profile and the minimal orientation tag.
// The thumbnail is decoded, oriented and mirrored for fast browsing. Non-JPEG
// uploads are converted once at high quality for editing and printing.
// The camera file is decoded ONCE: entropy-decoding a 14 MB JPEG costs about as much as the whole
// rest of the work, and the free server has a tenth of a CPU. Rotated, mirrored sRGB pixels at up
// to 3000 px are kept in memory and every derivative is cut from them (lossless raw hand-over,
// no intermediate JPEG). The 3000 px print source is encoded later (see print-source.js).
const decodeOnce = (input, mirrored) => input.clone().rotate().flop(mirrored)
  .toColourspace("srgb")
  .resize({ width: PRINT_EDGE, height: PRINT_EDGE, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
  .raw().toBuffer({ resolveWithObject: true });
const fromPixels = ({ data, info }) => sharp(data, { raw: info });
const downscale = (edge) => ({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
export const encodePrintSource = (pixels) => fromPixels(pixels)
  .jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();

// A booth has already decoded the camera photo to show it on screen: it sends that upright,
// mirrored-as-chosen 1600 px JPEG along with the camera bytes. When it really is the same picture
// (a JPEG of the same proportions), it becomes the editor preview and the source of the gallery
// thumbnail, so the free server never decodes the 26 MP original while the guest waits (about
// 10x less CPU before the photo counts as saved). The print source is still made from the camera
// original, in the background. Anything unexpected is ignored and the server makes its own.
export const MAX_BOOTH_PREVIEW_BYTES = 6 * 1024 * 1024;
async function usableBoothPreview(preview, meta) {
  if (!preview?.length || preview.length > MAX_BOOTH_PREVIEW_BYTES) return null;
  try {
    const p = await sharp(preview).metadata();
    if (p.format !== "jpeg" || !["srgb", "b-w"].includes(p.space)) return null;
    if (p.orientation && p.orientation !== 1) return null;
    const long = Math.max(p.width, p.height);
    if (long < THUMBNAIL_EDGE || long > 2048) return null;
    // Upright proportions of the camera file (EXIF orientations 5-8 swap width and height).
    const [w, h] = meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
    if (!w || !h || Math.abs(p.width / p.height - w / h) > 0.02 * (w / h)) return null;
    return preview;
  } catch {
    return null;
  }
}

export function prepareImageTasks(buffer, mirrored = false, boothPreview) {
  const input = sharp(buffer, { limitInputPixels: 100_000_000 });
  const metadata = input.metadata();
  const fromBooth = boothPreview
    ? metadata.then((meta) => usableBoothPreview(boothPreview, meta))
    : Promise.resolve(null);
  // Decoded at most once, and only when something needs the camera pixels.
  let decoded;
  const pixels = () => (decoded ??= metadata.then(() => decodeOnce(input, mirrored)));
  const preview = fromBooth.then((booth) => booth || pixels().then((p) =>
    fromPixels(p).resize(downscale(PREVIEW_EDGE)).jpeg({ quality: 90 }).toBuffer()));
  const thumbnail = fromBooth.then((booth) => booth
    ? sharp(booth).resize(downscale(THUMBNAIL_EDGE)).jpeg({ quality: 78 }).toBuffer()
    : pixels().then((p) => fromPixels(p).resize(downscale(THUMBNAIL_EDGE))
      .jpeg({ quality: 78 }).toBuffer()));
  const jpeg = metadata.then((meta) => preservesSource(meta)
      ? cleanJpegMetadata(buffer, meta.orientation)
      : input.clone().rotate().jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer());
  // Encoding is deferred; the closure keeps the camera bytes / decoded pixels until it has run
  // (or is dropped), so with a booth preview the original is decoded only in the background.
  const encodePrint = () => pixels().then(encodePrintSource);
  return { jpeg, thumbnail, preview, encodePrint, metadata, usedBoothPreview: fromBooth.then(Boolean) };
}
// Everything at once (tests, one-off tools).
export async function prepareImages(buffer, mirrored = false, boothPreview) {
  const tasks = prepareImageTasks(buffer, mirrored, boothPreview);
  const [jpeg, thumbnail, , print] = await Promise.all([
    tasks.jpeg, tasks.thumbnail, tasks.preview, tasks.encodePrint(),
  ]);
  return { jpeg, thumbnail, print };
}
// Print source made again from the stored camera file (used when many jobs are waiting).
const printSourceFromFile = async (buffer, mirrored) =>
  encodePrintSource(await decodeOnce(sharp(buffer, { limitInputPixels: 100_000_000 }), mirrored));
// Keep this closure outside appendCapture: queued fallback jobs must retain only a filename,
// never the media object whose encodePrint closure holds the full decoded camera pixels.
const reloadPrintSource = (file, mirrored) => async () =>
  printSourceFromFile(await readMedia(file), mirrored);

// Waiting print sources live only in memory: a restart (every deploy, or a server that ran out of
// RAM) drops them. At startup, queue one again for every photo still in its storage window that
// has none; the album prints from the camera original meanwhile.
export async function resumePrintSources({ limit = 300, now = Date.now() } = {}) {
  const bookings = await Booking.find({
    // A ticket is bought at most a couple of hours before the shoot; photos last MEDIA_TTL_MS.
    createdAt: { $gt: new Date(now - MEDIA_TTL_MS - 3 * 3600_000) },
    mediaDeleted: { $ne: true },
    photos: { $elemMatch: { kind: "original", deleted: { $ne: true }, printFile: null, originalPending: { $ne: true } } },
  }).select("photos._id photos.kind photos.deleted photos.file photos.printFile photos.mirrored photos.originalPending").lean();
  let queued = 0;
  for (const b of bookings) for (const p of b.photos) {
    if (queued >= limit) return queued;
    if (p.kind !== "original" || p.deleted || p.printFile || p.originalPending || !p.file || photoExpiry(p) <= now) continue;
    if (schedulePrintSource({
      bookingId: b._id,
      photoId: p._id,
      printFile: mediaReference(crypto.randomUUID() + ".print.jpg"),
      encode: null,
      reload: reloadPrintSource(p.file, Boolean(p.mirrored)),
    })) queued++;
  }
  return queued;
}

// The booth already put the camera original in storage (see direct-upload.js): check its header
// there, take preview and thumbnail from the booth's own preview, and read the 15 MB original
// back only in the background for the print source. If the booth preview does not match the
// photo, both are made from the stored original instead (rare; no upload is repeated).
async function storedImageTasks(file, mirrored, boothPreview) {
  const { meta } = await inspectStoredOriginal(file);
  const fromStorage = async () => {
    const buffer = await readMedia(file);
    if (!buffer) throw captureError(422, "Ảnh gốc chưa tải lên kho xong. Máy chụp sẽ gửi lại.");
    return buffer;
  };
  const booth = await usableBoothPreview(boothPreview, meta);
  if (booth) return {
    preview: Promise.resolve(booth),
    thumbnail: sharp(booth).resize(downscale(THUMBNAIL_EDGE)).jpeg({ quality: 78 }).toBuffer(),
    encodePrint: () => fromStorage().then((buffer) => printSourceFromFile(buffer, mirrored)),
    metadata: Promise.resolve(meta),
  };
  const { preview, thumbnail, encodePrint, metadata } = prepareImageTasks(await fromStorage(), mirrored);
  return { preview, thumbnail, encodePrint, metadata };
}
// Preview first: the booth's own upright 1600 px JPEG becomes the album photo right away (and its
// thumbnail); the camera original is attached later by attachOriginal.
async function previewOnlyTasks(preview) {
  let meta;
  try {
    meta = await sharp(preview).metadata();
  } catch {
    throw captureError(400, "Ảnh xem trước không hợp lệ.");
  }
  const long = Math.max(meta.width || 0, meta.height || 0);
  if (meta.format !== "jpeg" || !["srgb", "b-w"].includes(meta.space) ||
    (meta.orientation && meta.orientation !== 1) || long < THUMBNAIL_EDGE || long > 2048)
    throw captureError(400, "Ảnh xem trước không hợp lệ.");
  return {
    preview: Promise.resolve(preview),
    thumbnail: sharp(preview).resize(downscale(THUMBNAIL_EDGE)).jpeg({ quality: 78 }).toBuffer(),
    metadata: Promise.resolve(meta),
  };
}

// The camera original for a photo the album already shows from its preview (preview first,
// original later). storedOriginal: the booth uploaded it straight to storage; buffer: sent
// through the server. Returns false when the photo already has its original (a retry).
export async function attachOriginal(bookingId, clientKey, { storedOriginal, buffer } = {}) {
  const b = await Booking.findById(bookingId).select({ photos: { $elemMatch: { clientKey } } });
  const photo = b?.photos?.[0];
  if (!photo || photo.deleted) throw captureError(410, "Ảnh không còn trong album.");
  if (!photo.originalPending) return false;
  let file = storedOriginal, meta;
  if (storedOriginal) {
    ({ meta } = await inspectStoredOriginal(storedOriginal));
  } else {
    const input = sharp(buffer, { limitInputPixels: 100_000_000 });
    try {
      meta = await input.metadata();
    } catch {
      throw captureError(400, "Ảnh không hợp lệ. Hỗ trợ JPEG, PNG, WebP.");
    }
    file = mediaReference(crypto.randomUUID() + ".jpg");
    await saveImageTask(async () => {
      const bytes = preservesSource(meta)
        ? await cleanJpegMetadata(buffer, meta.orientation)
        : await input.clone().rotate().jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
      await saveMedia(file, bytes, "image/jpeg");
    });
  }
  const mirrored = Boolean(photo.originalMirrored);
  const attached = await Booking.findOneAndUpdate(
    { _id: bookingId, photos: { $elemMatch: { clientKey, originalPending: true, deleted: { $ne: true } } } },
    {
      $set: { "photos.$.file": file, "photos.$.mirrored": mirrored, "photos.$.sourcePreserved": preservesSource(meta) },
      $unset: { "photos.$.originalPending": 1, "photos.$.originalMirrored": 1 },
    },
    { new: true },
  ).select("status");
  if (!attached) {
    // Attached meanwhile by a retry, or the photo was removed: keep nothing of this attempt.
    if (!storedOriginal) await deleteMedia([file]).catch(() => {});
    return false;
  }
  schedulePrintSource({
    bookingId: b._id,
    photoId: photo._id,
    printFile: mediaReference(crypto.randomUUID() + ".print.jpg"),
    encode: null,
    reload: reloadPrintSource(file, mirrored),
  });
  if (attached.status === "completed") schedulePhotoDownload(b._id, { _id: photo._id, file });
  return true;
}

const uploads = new Map();
export function appendCapture(
  bookingId,
  buffer,
  { clientKey, originalName = "photo.jpg", imported = false, mirrored = false, precheck, preview, storedOriginal,
    previewOnly = false } = {},
) {
  const key = clientKey && `${bookingId}:${clientKey}`;
  if (key && uploads.has(key)) return uploads.get(key);
  // Start storage independently of the commit lock. Reserve the commit's place
  // synchronously so finishCapture still waits for all already accepted photos,
  // and photos keep their request order even when a later R2 write finishes first.
  const stored = saveImageTask(async () => {
    // The database is far from the server on the free plans: callers that already loaded
    // the session (status, end time and this clientKey's photo) pass it to save a round trip.
    const b = precheck || await Booking.findById(bookingId).select({
      status: 1, captureEndsAt: 1,
      photos: { $elemMatch: { clientKey: clientKey || null } },
    });
    if (!b) throw captureError(404, "Không tìm thấy phiên.");
    if (clientKey && (b.photos || []).some((p) => p.clientKey === clientKey)) return null;
    if (
      imported
        ? b.status !== "completed"
        : b.status !== "checked_in" ||
          !b.captureEndsAt ||
          b.captureEndsAt <= new Date()
    )
      throw captureError(409, "Phiên chụp đã kết thúc.");
    const thumbnailFile = mediaReference(crypto.randomUUID() + ".thumb.jpg"),
      previewFile = mediaReference(crypto.randomUUID() + ".preview.jpg"),
      // Preview first: the album photo is the preview until the camera original arrives.
      file = storedOriginal || (previewOnly ? previewFile : mediaReference(crypto.randomUUID() + ".jpg"));
    let images;
    if (previewOnly) {
      images = await previewOnlyTasks(preview);
    } else if (storedOriginal) {
      try {
        images = await storedImageTasks(storedOriginal, mirrored, preview);
      } catch (error) {
        // Unusable (missing, not a clean JPEG): the booth sends the photo through the server
        // instead, so this upload is of no further use.
        if (error.status === 422) await deleteMedia([storedOriginal]).catch(() => {});
        throw error;
      }
    } else {
      try {
        images = prepareImageTasks(buffer, mirrored, preview);
      } catch {
        throw captureError(400, "Ảnh không hợp lệ. Hỗ trợ JPEG, PNG, WebP.");
      }
    }
    try {
      // Wait for both writes before committing or rolling back: a slower write
      // must not finish after error cleanup has already removed its sibling.
      // Start sending the untouched JPEG while Sharp creates the small preview.
      // A bad image still rolls both writes back before it reaches the album.
      const writes = [[thumbnailFile, images.thumbnail], [previewFile, images.preview]];
      if (!storedOriginal && !previewOnly) writes.unshift([file, images.jpeg]);
      const saved = await Promise.allSettled(
        writes.map(([name, task]) =>
          task.catch(() => { throw captureError(400, "Ảnh không hợp lệ. Hỗ trợ JPEG, PNG, WebP."); })
            .then(bytes => saveMedia(name, bytes, "image/jpeg")),
        ),
      );
      const failed = saved.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      return {
        file, thumbnailFile, previewFile, encodePrint: images.encodePrint, previewOnly,
        sourcePreserved: previewOnly ? false : preservesSource(await images.metadata),
      };
    } catch (error) {
      // The booth's own upload stays for its retry (same token); manual cleanup covers strays.
      await deleteMedia(storedOriginal ? [thumbnailFile, previewFile] : [file, thumbnailFile, previewFile])
        .catch(() => {});
      throw error;
    }
  });
  // Files this attempt made itself (a booth upload is kept for a retry of the same photo).
  const ownFiles = (media) =>
    [storedOriginal ? null : media.file, media.thumbnailFile, media.previewFile].filter(Boolean);
  // A queued commit may not await this promise until an earlier upload ends.
  // Handle early failures immediately without turning them into unhandled errors.
  stored.catch(() => {});
  const committed = captureLock(bookingId, async () => {
    const media = await stored;
    try {
      const photo = media && {
        _id: new mongoose.Types.ObjectId(),
        file: media.file,
        originalName,
        thumbnailFile: media.thumbnailFile,
        previewFile: media.previewFile,
        kind: "original",
        ...(clientKey && { clientKey }),
        // The preview is already flipped like the screen; the original's flip waits with it.
        mirrored: media.previewOnly ? false : Boolean(mirrored),
        sourcePreserved: media.sourcePreserved,
        ...(media.previewOnly && { originalPending: true, originalMirrored: Boolean(mirrored) }),
      };
      // One database round trip: number, append and expiry are computed by the database in a
      // single atomic update. The guards (status, not already saved) are part of the filter.
      const updated = photo && await Booking.findOneAndUpdate(
        {
          _id: bookingId,
          status: imported ? "completed" : "checked_in",
          ...(clientKey && { "photos.clientKey": { $ne: clientKey } }),
          ...(imported ? {} : { $expr: { $lt: [
            { $size: { $filter: {
              input: { $ifNull: ["$photos", []] }, as: "p",
              cond: { $and: [
                { $eq: ["$$p.kind", "original"] },
                { $ne: ["$$p.deleted", true] },
              ] },
            } } },
            { $ifNull: ["$shots", 1000000] },
          ] } }),
        },
        appendPhotoPipeline(photo),
        { new: true },
      );
      if (!updated) {
        // Rare: a retry of the same photo already saved it, or the session ended meanwhile.
        const b = await Booking.findById(bookingId);
        if (!b) throw captureError(404, "Không tìm thấy phiên.");
        const saved = clientKey && b.photos.find((p) => p.clientKey === clientKey);
        if (saved) {
          // Never the saved photo's own files: a retried booth commit names the same original.
          const kept = new Set([saved.file, saved.thumbnailFile, saved.previewFile, saved.printFile]);
          if (media) await deleteMedia([media.file, media.thumbnailFile, media.previewFile]
            .filter((f) => !kept.has(f)));
          return b;
        }
        if (!imported && Number.isFinite(b.shots) &&
          b.photos.filter((p) => p.kind === "original" && !p.deleted).length >= b.shots)
          throw captureError(409, `Đã chụp đủ ${b.shots} ảnh của gói.`);
        throw captureError(409, "Phiên chụp đã kết thúc.");
      }
      // The photo is saved: the heavy 3000 px print source follows in the background (preview
      // first: once the camera original is attached).
      if (!media.previewOnly) schedulePrintSource({
        bookingId,
        photoId: photo._id,
        printFile: mediaReference(crypto.randomUUID() + ".print.jpg"),
        encode: media.encodePrint,
        reload: reloadPrintSource(media.file, mirrored),
      });
      if (!media.previewOnly && updated.status === "completed") schedulePhotoDownload(bookingId, photo);
      return updated;
    } catch (error) {
      if (media) await deleteMedia(ownFiles(media)).catch(() => {});
      throw error;
    }
  });
  const result = committed.finally(() => {
    if (key && uploads.get(key) === result) uploads.delete(key);
  });
  if (key) uploads.set(key, result);
  return result;
}
// Photos still in the album are numbered 1, 2, 3… in the order they were taken or added, with
// no gaps: deleting #02 makes the next photo #02 again, and later photos move up one number.
// Deleted (hidden) photos keep their old number until they are purged. nextPhotoNumber is the
// last number in use. These stages run inside the same atomic update as the append or delete,
// so concurrent saves and deletes can never hand out a number twice.
export const renumberPhotoStages = () => [
  { $set: { numbering: { $reduce: {
    input: "$photos",
    initialValue: { n: 0, list: [] },
    in: { $let: {
      vars: { hidden: { $eq: ["$$this.deleted", true] }, next: { $add: ["$$value.n", 1] } },
      in: {
        n: { $cond: ["$$hidden", "$$value.n", "$$next"] },
        list: { $concatArrays: ["$$value.list", [{ $cond: ["$$hidden", "$$this",
          { $mergeObjects: ["$$this", { number: "$$next" }] }] }]] },
      },
    } },
  } } } },
  { $set: { photos: "$numbering.list", nextPhotoNumber: "$numbering.n" } },
  { $unset: "numbering" },
];

// Append one photo atomically; mediaExpiresAt becomes the time the earliest visible photo
// expires (each photo is kept MEDIA_TTL_MS after it was taken; ObjectId = time).
function appendPhotoPipeline(photo) {
  const visible = { $filter: { input: "$photos", as: "p", cond: { $ne: ["$$p.deleted", true] } } };
  return [
    { $set: { photos: { $ifNull: ["$photos", []] } } },
    { $set: {
      photos: { $concatArrays: ["$photos", [{ $literal: photo }]] },
      mediaDeleted: false,
    } },
    ...renumberPhotoStages(),
    { $set: { mediaExpiresAt: { $add: [
      { $min: { $map: {
        input: { $cond: [{ $gt: [{ $size: visible }, 0] }, visible, "$photos"] },
        as: "p", in: { $toDate: "$$p._id" },
      } } },
      MEDIA_TTL_MS,
    ] } } },
  ];
}
// Máy in DNP chỉ có khi máy chủ chạy trên Windows tại tiệm.
export const captureStatus = () => ({
  printerAvailable: Boolean(config.dnpPrinter) && process.platform === "win32",
});
export async function finishCapture(id) {
  return captureLock(id, async () => {
    const completed = await Booking.findOneAndUpdate(
      { _id: id, status: "checked_in" },
      {
        $set: { status: "completed" },
      },
      { new: true },
    );
    // Start expensive guest preparation during selection, after live capture has finished.
    for (const photo of completed?.photos || []) schedulePhotoDownload(completed._id, photo);
    return completed;
  });
}
// Máy chụp bị tắt / mất mạng trước khi bấm "Hoàn thành": máy chủ tự chốt phiên
// sau khi hết giờ một chút để khách vẫn mở được album bằng mã vé.
export const FINISH_GRACE_MS = 2 * 60000;
export const isOverdue = (b, now = Date.now()) =>
  b.status === "checked_in" &&
  Boolean(b.captureEndsAt) &&
  new Date(b.captureEndsAt).getTime() <= now - FINISH_GRACE_MS;
export async function finishOverdueSessions(now = Date.now()) {
  const overdue = await Booking.find({
    status: "checked_in",
    captureEndsAt: { $lte: new Date(now - FINISH_GRACE_MS) },
  }).select("_id");
  for (const b of overdue) await finishCapture(b._id);
  return overdue.length;
}
export function startSessionSweeper() {
  const run = () =>
    finishOverdueSessions().catch((e) =>
      console.error("Tự chốt phiên chụp quá giờ thất bại:", e.message),
    );
  run();
  return setInterval(run, 60000).unref();
}
