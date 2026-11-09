import mongoose from "mongoose";
import { Booking, PrintJob } from "../models/index.js";
import { captureLock, captureError } from "./capture.js";
import { deleteMedia, MEDIA_TTL_MS, photoTime } from "./media.js";
import { r2Configured, readR2Inventory } from "./r2.js";
import { releaseSheets } from "../routes/print-helpers.js";

// The stored files of one customer: every size of every photo (hidden ones too, they are still
// stored until the TTL cleanup), the kiosk's framed composite, the timelapse video, and the
// sheets of their print jobs.
const photoFiles = (photo) =>
  [photo.file, photo.originalFile, photo.thumbnailFile, photo.previewFile, photo.printFile, photo.downloadFile];
const jobFiles = (job) => [job.file, ...(job.sheets || []).map((sheet) => sheet.file)];
function bookingFiles(booking, jobs) {
  return [...new Set([
    ...(booking.photos || []).flatMap(photoFiles),
    booking.video?.file,
    booking.composite?.file,
    booking.composite?.thumbnailFile,
    ...jobs.flatMap(jobFiles),
  ].filter(Boolean))];
}

// One row per customer who still has stored media, newest first, for the storage assistant.
// Sizes come from file metadata only (the R2 listing, cached 30 s, and GridFS file records);
// no image is read.
export async function listCustomerMedia({ db = mongoose.connection.db } = {}) {
  const [bookings, jobs] = await Promise.all([
    Booking.find({ $or: [
      { "photos.0": { $exists: true } },
      { "video.file": { $exists: true } },
      { "composite.file": { $exists: true } },
    ] })
      .select("code name phone status createdAt photos._id photos.deleted photos.file photos.originalFile " +
        "photos.thumbnailFile photos.previewFile photos.printFile photos.downloadFile video.file composite.file composite.thumbnailFile")
      .lean(),
    PrintJob.find().select("booking status file sheets.file").lean(),
  ]);
  const jobsByBooking = new Map();
  for (const job of jobs) {
    const key = String(job.booking);
    if (!jobsByBooking.has(key)) jobsByBooking.set(key, []);
    jobsByBooking.get(key).push(job);
  }
  const rows = bookings.map((booking) => {
    const own = jobsByBooking.get(String(booking._id)) || [];
    return { booking, jobs: own, files: bookingFiles(booking, own) };
  });
  const sizes = new Map();
  const all = rows.flatMap((row) => row.files);
  if (r2Configured()) {
    try {
      for (const file of await readR2Inventory()) sizes.set(file.filename, file.length);
    } catch {
      // Sizes stay unknown; the rows (and deleting) still work.
    }
  }
  const local = all.filter((name) => !sizes.has(name));
  if (local.length)
    for (const file of await db.collection("media.files")
      .find({ filename: { $in: local } }, { projection: { filename: 1, length: 1 } }).toArray())
      sizes.set(file.filename, (sizes.get(file.filename) || 0) + file.length);
  return rows
    .map(({ booking, jobs: own, files }) => {
      const photos = (booking.photos || []).filter((photo) => !photo.deleted);
      const stored = files.filter((name) => sizes.has(name));
      const times = (booking.photos || []).map(photoTime);
      return {
        id: String(booking._id),
        code: booking.code,
        name: booking.name || "",
        phone: booking.phone || "",
        status: booking.status,
        createdAt: booking.createdAt,
        photos: photos.length,
        printJobs: own.length,
        pendingPrints: own.filter((job) => job.status === "pending").length,
        files: stored.length,
        bytes: stored.reduce((sum, name) => sum + sizes.get(name), 0),
        lastPhotoAt: times.length ? new Date(Math.max(...times)) : null,
        expiresAt: times.length ? new Date(Math.min(...times) + MEDIA_TTL_MS) : null,
      };
    })
    .filter((row) => row.files > 0 || row.photos > 0)
    .sort((a, b) => (b.lastPhotoAt?.getTime() || 0) - (a.lastPhotoAt?.getTime() || 0));
}

// Deletes every stored file of one customer, when an admin asks for it (never automatically).
// The ticket, its payment and revenue stay; the album then says its photos are gone. If storage
// refuses a delete, nothing is unlinked, so the same request can simply be repeated.
export function deleteCustomerMedia(bookingId) {
  return captureLock(bookingId, async () => {
    const booking = await Booking.findById(bookingId).select("status photos video composite").lean();
    if (!booking) throw captureError(404, "Không tìm thấy vé.");
    if (booking.status === "checked_in")
      throw captureError(409, "Khách đang chụp. Hãy xoá sau khi buổi chụp kết thúc.");
    const jobs = await PrintJob.find({ booking: booking._id }).lean();
    const files = bookingFiles(booking, jobs);
    await deleteMedia(files);
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { photos: [], mediaDeleted: true }, $unset: { video: 1, composite: 1, mediaExpiresAt: 1 } },
    );
    const pendingSheets = jobs
      .filter((job) => job.status === "pending")
      .reduce((sum, job) => sum + (job.sheets?.length || 1), 0);
    await PrintJob.deleteMany({ booking: booking._id });
    // Unprinted sheets go back to the ticket, as when a print job is cancelled.
    if (pendingSheets) await releaseSheets(booking._id, pendingSheets);
    return { files: files.length, photos: (booking.photos || []).length, printJobs: jobs.length };
  });
}
