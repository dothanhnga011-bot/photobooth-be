import { config } from "../config.js";
import { Booking, PrintJob } from "../models/index.js";
import { deleteMedia, MEDIA_TTL_MS } from "./media.js";
import { isStaleOrphan, ORPHAN_GRACE_MS } from "./media-storage.js";
import { r2Configured, readR2Inventory } from "./r2.js";

// Every file name some booking photo or print job still refers to.
async function referencedMedia() {
  const [bookings, jobs] = await Promise.all([
    Booking.find({ $or: [
      { "photos.0": { $exists: true } },
      { "video.file": { $exists: true } },
      { "composite.file": { $exists: true } },
    ] })
      .select("photos.file photos.originalFile photos.thumbnailFile photos.previewFile photos.printFile photos.downloadFile video.file composite.file composite.thumbnailFile composite.previewFile")
      .lean(),
    PrintJob.find().select("file sheets.file").lean(),
  ]);
  const names = new Set();
  for (const b of bookings) {
    for (const p of b.photos || [])
      for (const f of [p.file, p.originalFile, p.thumbnailFile, p.previewFile, p.printFile, p.downloadFile]) if (f) names.add(f);
    if (b.video?.file) names.add(b.video.file);
    for (const f of [b.composite?.file, b.composite?.thumbnailFile, b.composite?.previewFile]) if (f) names.add(f);
  }
  for (const j of jobs) for (const f of [j.file, ...(j.sheets || []).map((s) => s.file)]) if (f) names.add(f);
  return names;
}

async function removeStaleOrphans(now) {
  const files = await readR2Inventory({ fresh: true });
  const oldEnough = files.filter((f) => f.modified <= now.getTime() - MEDIA_TTL_MS - ORPHAN_GRACE_MS);
  if (!oldEnough.length) return 0;
  const referenced = await referencedMedia();
  const stale = oldEnough.filter((f) => isStaleOrphan(f, referenced, now.getTime()));
  if (stale.length) await deleteMedia(stale.map((f) => f.filename));
  return stale.length;
}

let cleanup;
// Share a sweep between the scheduler and the admin button.
export function purgeStaleOrphans(now = new Date()) {
  if (!r2Configured()) return Promise.resolve(0);
  return cleanup ??= removeStaleOrphans(now).finally(() => { cleanup = undefined; });
}

export function startOrphanCleanup() {
  // A shared R2 prefix may still have files referenced by a different database.
  if (!r2Configured() || !config.r2.autoCleanOrphans) return null;
  const run = () => purgeStaleOrphans().catch((error) =>
    console.error("Dọn file R2 không còn dùng thất bại:", error.message));
  run();
  return setInterval(run, 60 * 60 * 1000).unref();
}
