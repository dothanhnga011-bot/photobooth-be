import { randomUUID } from "node:crypto";
import sharp from "sharp";
import Booking from "../models/Booking.js";
import { deleteMedia, photoExpiry, readMedia, saveMedia } from "./media.js";
import { mediaReference } from "./r2.js";
import { saveImageTask } from "./image-save-queue.js";

export const DOWNLOAD_PIXELS = 20_000_000;
const pending = new Map();
const unavailable = () => Object.assign(new Error("Ảnh không còn trong album hoặc đã hết hạn lưu trữ."), { status: 404 });

// Limit by pixel count, preserve the aspect ratio, and never enlarge a small source.
export async function encodePhotoDownload(buffer) {
  const input = sharp(buffer, { limitInputPixels: 100_000_000, failOn: "warning" });
  const meta = await input.metadata();
  const [width, height] = meta.orientation >= 5
    ? [meta.height, meta.width] : [meta.width, meta.height];
  const scale = Math.min(1, Math.sqrt(DOWNLOAD_PIXELS / (width * height)));
  return input.autoOrient().flop()
    .resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)),
      fit: "inside", withoutEnlargement: true })
    .withIccProfile("srgb")
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
}

// Keep the camera source for editing/printing. Guest downloads get their own cached,
// upright JPEG, always mirrored once from the camera source. Concurrent requests share
// one encoder; the existing image queue bounds RAM across downloads and uploads.
export function photoDownloadFile(bookingId, photo) {
  if (photo.deleted || photoExpiry(photo).getTime() <= Date.now()) return Promise.reject(unavailable());
  if (photo.originalPending)
    return Promise.reject(Object.assign(new Error("Ảnh gốc đang tải lên. Vui lòng chờ rồi lưu ảnh lại."), { status: 409 }));
  if (photo.downloadFile) return Promise.resolve(photo.downloadFile);
  const key = `${bookingId}:${photo._id}:${photo.file}`;
  if (pending.has(key)) return pending.get(key);
  const work = saveImageTask(async () => {
    // Another request/process may have finished while this task waited in the queue.
    const match = { _id: photo._id, file: photo.file, deleted: { $ne: true }, originalPending: { $ne: true } };
    const current = await Booking.findOne({ _id: bookingId, photos: { $elemMatch: match } })
      .select({ photos: { $elemMatch: match } }).lean();
    const saved = current?.photos[0];
    if (!saved || photoExpiry(saved).getTime() <= Date.now()) throw unavailable();
    if (saved.downloadFile) return saved.downloadFile;
    const source = await readMedia(saved.originalFile || saved.file);
    if (!source) throw unavailable();
    const bytes = await encodePhotoDownload(source);
    const file = mediaReference(`${randomUUID()}.download.jpg`);
    try {
      await saveMedia(file, bytes, "image/jpeg");
      if (photoExpiry(saved).getTime() <= Date.now()) throw unavailable();
      const result = await Booking.updateOne(
        { _id: bookingId, photos: { $elemMatch: { ...match, downloadFile: null } } },
        { $set: { "photos.$.downloadFile": file } },
      );
      if (result.matchedCount) return file;
    } catch (error) {
      await deleteMedia([file]).catch(() => {});
      throw error;
    }
    // A different server won, or the photo was removed during encoding.
    await deleteMedia([file]);
    const winner = await Booking.findOne({ _id: bookingId, photos: { $elemMatch: match } })
      .select({ photos: { $elemMatch: match } }).lean();
    if (winner?.photos[0]?.downloadFile) return winner.photos[0].downloadFile;
    throw unavailable();
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
