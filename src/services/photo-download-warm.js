import mongoose from "mongoose";
import { config } from "../config.js";
import { photoExpiry } from "./media.js";
import { photoDownloadFile } from "./photo-download.js";
import { isSaveQueueBusy } from "./image-save-queue.js";
import { memoryUse, MEMORY_BUSY } from "./capacity.js";

// Cache the same 20 MP mirrored guest JPEG before the first Save click. Keep only file refs;
// one derivative runs at a time, yielding to accepted uploads and memory pressure.
const waiting = new Map();
const MAX_WAITING = 128;
let running = false, activeKey = "", timer;
let idle = [];
function wake(delay = 100) {
  if (timer || running) return;
  timer = setTimeout(() => { timer = null; pump(); }, delay);
  timer.unref?.();
}
function finishIdle() {
  if (running || waiting.size) return;
  const listeners = idle; idle = [];
  for (const resolve of listeners) resolve();
}
async function pump() {
  if (running) return;
  if (mongoose.connection.readyState !== 1) { waiting.clear(); finishIdle(); return; }
  if (isSaveQueueBusy() || memoryUse() >= MEMORY_BUSY) { wake(250); return; }
  const first = waiting.entries().next().value;
  if (!first) { finishIdle(); return; }
  const [key, { bookingId, photo }] = first;
  waiting.delete(key); activeKey = key; running = true;
  try {
    if (photoExpiry(photo).getTime() > Date.now()) await photoDownloadFile(bookingId, photo);
  } catch { /* The normal download endpoint retries on demand; camera bytes stay untouched. */ }
  finally {
    running = false; activeKey = "";
    if (waiting.size) wake(); else finishIdle();
  }
}
export function schedulePhotoDownload(bookingId, photo) {
  const mode = process.env.PHOTO_DOWNLOAD_PREWARM;
  if (mode === "0" || (config.mediaStorageProvider !== "r2" && mode !== "1") ||
      !photo?.file || (photo.kind && photo.kind !== "original") || photo.deleted || photo.originalPending || photo.downloadFile) return false;
  const key = `${bookingId}:${photo._id}:${photo.file}`;
  if (waiting.has(key) || activeKey === key || waiting.size >= MAX_WAITING) return false;
  waiting.set(key, { bookingId, photo: { _id: photo._id, file: photo.file, originalFile: photo.originalFile } });
  wake();
  return true;
}
export const whenPhotoDownloadsIdle = () => running || waiting.size
  ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve();
