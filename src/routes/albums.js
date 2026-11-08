import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { mediaReference } from "../services/r2.js";
import { Booking, PrintJob } from "../models/index.js";
import { appendCapture, attachOriginal } from "../services/capture.js";
import { timed } from "../services/image-save-queue.js";
import {
  deleteMedia,
  readMedia,
  saveMedia,
  sendMedia,
  photoExpiry,
  photoFile,
  albumMediaExpiry,
  MEDIA_TTL_MS,
} from "../services/media.js";
import { sendZip } from "../services/zip.js";
import { sheetPreview } from "../services/preview.js";
import { printEvents } from "../services/print-events.js";
import { dispatchPrint } from "../services/dnp.js";
import { initialSpoolStatus } from "../services/printer-status.js";
import { printExtension, printContentType, validatePrintImage } from "../services/print-image.js";
import { printLimit } from "../middleware/rate-limits.js";
import { fail, id, token } from "./validation.js";
import { directUploadRequest, photoBody, readPhotoUpload, storedOriginal } from "./photo-upload.js";
import { createDirectUpload, directUploadsEnabled } from "../services/direct-upload.js";
import { printBody, readPrintPack } from "./print-upload.js";
import {
  album,
  albumBooking,
  originals,
  printQuota,
  requireMedia,
} from "./booking-helpers.js";
import {
  publicJob,
  quotaMessage,
  reserveSheets,
  releaseSheets,
} from "./print-helpers.js";

export const albumsRouter = Router();

// Đọc lần lượt từng tệp để nén ZIP, bỏ qua tệp đã mất. Tệp kế tiếp được tải từ kho trong lúc
// tệp này đang gửi cho khách (giữ tối đa 2 ảnh trong bộ nhớ), nên hai việc không phải chờ nhau.
async function* readFiles(items) {
  const read = (i) => {
    if (i >= items.length) return null;
    const pending = readMedia(items[i].file);
    pending.catch(() => {}); // awaited below; a download stopped early just drops it
    return pending;
  };
  let next = read(0);
  for (let i = 0; i < items.length; i++) {
    const data = await next;
    next = read(i + 1);
    if (data) yield { name: items[i].name, data };
  }
}

// Web nội bộ: khách chỉ mở album bằng mã QR hiện trên máy chụp (mã truy cập 48 ký tự),
// không có trang tra cứu công khai bằng mã vé 6 số.
albumsRouter.get("/:token", async (req, res) => {
  const json = await albumBooking(await album(req));
  // Carries short-lived storage links: never kept by a shared cache. Polls in the same link
  // window send the same body, so the browser revalidates (ETag) and gets an empty 304.
  res.set("Cache-Control", "private, no-cache");
  res.json(json);
});
albumsRouter.get("/:token/photos/:photo", async (req, res) => {
  // Each tile needs one photo, not the entire album. Returning the full array
  // for every image multiplies database transfer and document hydration by N².
  const photoId = id.safeParse(req.params.photo);
  const b = await album(req, {
    status: 1,
    captureEndsAt: 1,
    photos: {
      $elemMatch: {
        _id: photoId.success ? new mongoose.Types.ObjectId(photoId.data) : null,
      },
    },
  });
  const p = b.photos.id(req.params.photo);
  if (!p || p.deleted || photoExpiry(p).getTime() <= Date.now())
    fail(404, "Ảnh không còn trong album hoặc đã hết hạn lưu trữ.");
  res.set(
    "Cache-Control",
    "private, max-age=" +
      Math.max(
        0,
        Math.min(
          3600,
          Math.floor((photoExpiry(p).getTime() - Date.now()) / 1000),
        ),
      ),
  );
  await sendMedia(req, res, photoFile(p, req.query.size), "image/jpeg", photoExpiry(p));
});
// Video tua nhanh của lượt chụp: xem trong album (hỗ trợ tua) hoặc tải về (?download=1).
albumsRouter.get("/:token/video", async (req, res) => {
  const b = await album(req, { code: 1, status: 1, captureEndsAt: 1, video: 1, mediaDeleted: 1,
    "photos._id": 1, mediaExpiresAt: 1 });
  if (!b.video?.file || b.mediaDeleted) fail(404, "Album chưa có video.");
  if (req.query.download === "1")
    res.attachment(`NXC-${b.code}-video.${b.video.mimeType === "video/mp4" ? "mp4" : "webm"}`);
  res.set("Cache-Control", "private, max-age=600");
  await sendMedia(req, res, b.video.file, b.video.mimeType, albumMediaExpiry(b));
});
// Ảnh đã ghép khung ở máy chụp: ?size=thumbnail bản xem nhanh, ?download=1 tải về.
albumsRouter.get("/:token/composite", async (req, res) => {
  const b = await album(req, { code: 1, status: 1, captureEndsAt: 1, composite: 1, mediaDeleted: 1,
    "photos._id": 1, mediaExpiresAt: 1 });
  if (!b.composite?.file || b.mediaDeleted) fail(404, "Album chưa có ảnh ghép khung.");
  if (req.query.download === "1") res.attachment(`NXC-${b.code}-anh-ghep.jpg`);
  res.set("Cache-Control", "private, max-age=600");
  const file = req.query.size === "thumbnail" && req.query.download !== "1"
    ? b.composite.thumbnailFile || b.composite.file
    : b.composite.file;
  await sendMedia(req, res, file, "image/jpeg", albumMediaExpiry(b));
});
albumsRouter.get("/:token/download", async (req, res) => {
  const b = await album(req);
  requireMedia(b);
  const photos = originals(b).filter(
    (p) => photoExpiry(p).getTime() > Date.now(),
  );
  const sent = await sendZip(
    res,
    `NXC-${b.code}-anh-goc.zip`,
    readFiles(
      photos.map((p, i) => ({
        name: `NXC-${b.code}-${String(i + 1).padStart(2, "0")}.jpg`,
        file: p.file,
      })),
    ),
  );
  if (!sent) fail(404, "Ảnh đã hết hạn lưu trữ.");
});
albumsRouter.get("/:token/print", async (req, res) => {
  const b = await album(req, "status captureEndsAt prints printSheets");
  const requestKey =
    req.query.requestKey === undefined
      ? undefined
      : z.uuid().parse(req.query.requestKey);
  const job = await PrintJob.findOne({
    booking: b._id,
    ...(requestKey && { requestKey }),
  }).sort({
    createdAt: -1,
  });
  res.json(
    job
      ? {
          ...publicJob(job),
          prints: printQuota(b),
          printSheets: b.printSheets || 0,
        }
      : null,
  );
});
albumsRouter.get("/:token/prints/:job", async (req, res) => {
  const b = await album(req, "code status captureEndsAt");
  const job = await PrintJob.findOne({
    _id: id.parse(req.params.job),
    booking: b._id,
  });
  if (!job) fail(404, "Không tìm thấy file in.");
  const expiresAt = job.createdAt.getTime() + MEDIA_TTL_MS;
  if (expiresAt <= Date.now()) fail(404, "File in đã hết hạn lưu trữ.");
  const sheets = job.sheets?.length ? job.sheets.map((s) => s.file) : [];
  // Tải lệnh in nhiều tờ (không chọn tờ nào): một tệp ZIP đủ các tờ, đặt tên theo thứ tự tờ.
  if (
    req.query.download === "1" &&
    req.query.sheet === undefined &&
    sheets.length > 1
  ) {
    const sent = await sendZip(
      res,
      `NXC-${b.code}-${sheets.length}-to-in.zip`,
      readFiles(
        sheets.map((file, i) => ({
          name: `NXC-${b.code}-to-${String(i + 1).padStart(2, "0")}.${printExtension(file)}`,
          file,
        })),
      ),
    );
    if (!sent) fail(404, "File in đã hết hạn lưu trữ.");
    return;
  }
  res.set(
    "Cache-Control",
    "private, max-age=" +
      Math.max(0, Math.min(3600, Math.floor((expiresAt - Date.now()) / 1000))),
  );
  const index = Number(req.query.sheet || 0);
  const file = job.sheets?.length
    ? job.sheets[index]?.file
    : index === 0
      ? job.file
      : null;
  if (!file) fail(404, "Không tìm thấy tờ in.");
  if (req.query.download === "1")
    res.attachment(
      req.query.sheet === undefined
        ? `NXC-${b.code}-in.${printExtension(file)}`
        : `NXC-${b.code}-to-${String(index + 1).padStart(2, "0")}.${printExtension(file)}`,
    );
  // Bản nhỏ cho hàng chờ in (xem lướt nhiều tờ); tải về / in luôn dùng tờ đầy đủ.
  if (req.query.size === "thumbnail" && req.query.download !== "1") {
    const preview = await sheetPreview(file);
    if (!preview) fail(404, "File in đã hết hạn lưu trữ.");
    return res.type("image/jpeg").send(preview);
  }
  await sendMedia(req, res, file, printContentType(file), expiresAt);
});
albumsRouter.post("/:token/print-pack", printLimit, printBody, async (req, res) => {
  const d = readPrintPack(req);
  const b = await album(req);
  const { fingerprint } = d;
  const verifyReplay = (job) => {
    // Keep legacy jobs replayable; newly created jobs always have a fingerprint.
    if (job.requestFingerprint && job.requestFingerprint !== fingerprint)
      fail(
        409,
        "Các tờ in của yêu cầu này đã thay đổi. Vui lòng kiểm tra yêu cầu đã gửi.",
      );
    return job;
  };
  const existing = await PrintJob.findOne({
    requestKey: d.requestKey,
    booking: b._id,
  }).select("+requestFingerprint");
  const quota = (booking) => ({
    prints: printQuota(booking),
    printSheets: booking.printSheets || 0,
  });
  if (existing)
    return res.json({ ...publicJob(verifyReplay(existing)), ...quota(b) });
  requireMedia(b);
  const n = d.sheets.length;
  const reserved = await reserveSheets(b, n, d.frameName);
  if (!reserved) fail(409, quotaMessage(printQuota(b), b.printSheets || 0));
  const files = [], saves = [];
  try {
    const sheets = [];
    for (const { buffer, type } of d.sheets) {
      let metadata;
      try {
        metadata = await validatePrintImage(buffer, `image/${type}`, b.printSize);
      } catch (error) {
        fail(400, /^(Tờ ảnh|Tấm Instax)/.test(error.message) ? error.message : "Ảnh in không hợp lệ.");
      }
      const { width, height, extension } = metadata;
      const file = mediaReference(token() + "." + extension);
      files.push(file);
      // Each sheet uploads while the next one is checked, instead of one after another.
      const saving = saveMedia(file, buffer, printContentType(file));
      saving.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
      saves.push(saving);
      if (saves.length >= 4) await saves[saves.length - 4];
      sheets.push({ file, width, height });
    }
    for (const saving of saves) await saving;
    const job = await PrintJob.create({
      booking: b._id,
      code: b.code,
      name: b.name,
      roomName: b.roomName,
      room: b.room,
      branch: b.branch,
      // Cắt đôi hay in nguyên tờ theo khung thật sự được in (gói ảnh nhỏ chưa có khung nhỏ thì
      // ghép khung lớn: không được cắt đôi), không theo khổ của gói.
      printSize: b.printSize === "instax" ? "instax" : d.printSize || b.printSize || "full",
      copies: 1,
      frameName: d.frameName,
      file: files[0],
      sheets,
      width: sheets[0].width,
      height: sheets[0].height,
      requestKey: d.requestKey,
      requestFingerprint: fingerprint,
      spoolStatus: await initialSpoolStatus(b.room),
    });
    dispatchPrint(job);
    printEvents.emit("print", { ...publicJob(job, req.params.token), branch: b.branch });
    res.status(201).json({ ...publicJob(job), ...quota(reserved) });
  } catch (e) {
    await Promise.allSettled(saves); // remove only after every upload has finished
    await deleteMedia(files).catch(() => {});
    await releaseSheets(b._id, n);
    if (e.code === 11000) {
      const previous = await PrintJob.findOne({
        requestKey: d.requestKey,
        booking: b._id,
      }).select("+requestFingerprint");
      if (previous)
        return res.json({
          ...publicJob(verifyReplay(previous)),
          ...quota(await Booking.findById(b._id)),
        });
    }
    throw e;
  }
});

// The booth uploads a camera original straight to storage: one short-lived URL for one photo.
albumsRouter.post("/:token/photos/upload-url", async (req, res) => {
  const d = directUploadRequest().parse(req.body);
  if (!directUploadsEnabled()) fail(404, "Kho ảnh chưa hỗ trợ tải thẳng.");
  const b = await album(req, {
    status: 1, captureEndsAt: 1, photos: { $elemMatch: { clientKey: d.clientKey } },
  });
  // Already saved (a lost reply): hand back the album instead of a second upload.
  if (b.photos?.length) return res.json({ saved: true, booking: await albumBooking(await album(req)) });
  if (b.status !== "completed") fail(409, "Phiên chụp đã kết thúc.");
  res.json({ upload: await createDirectUpload(b._id, d.clientKey, d.size) });
});
albumsRouter.post("/:token/photos", photoBody, async (req, res) => {
  // Capture re-reads the album once under its write lock; auth needn't load
  // the entire photo array again for every file in a phone upload batch.
  const d = readPhotoUpload(req);
  const b = await album(req, {
    status: 1, captureEndsAt: 1, photos: { $elemMatch: { clientKey: d.clientKey } },
  });
  const saved = await timed(res, "save", appendCapture(
    b._id,
    d.buffer,
    { clientKey: d.clientKey, originalName: d.name, imported: true, mirrored: d.mirrored, precheck: b,
      preview: d.preview, previewOnly: Boolean(d.later), storedOriginal: storedOriginal(b._id, d) },
  ));
  res.status(201).json(await albumBooking(saved));
});
// Ảnh xem trước tới trước, ảnh gốc tới sau: máy chụp gửi ảnh gốc của máy ảnh cho ảnh album đã có.
// 1) Xin URL tải thẳng lên kho R2 cho đúng ảnh đó (ảnh đã có ảnh gốc: { saved: true }; kho MongoDB: 404,
// máy chụp gửi qua máy chủ); ảnh không còn trong album: 410.
albumsRouter.post("/:token/photos/original-url", async (req, res) => {
  const d = directUploadRequest().parse(req.body);
  const b = await album(req, { status: 1, captureEndsAt: 1, photos: { $elemMatch: { clientKey: d.clientKey } } });
  const photo = b.photos?.[0];
  if (!photo || photo.deleted) fail(410, "Ảnh không còn trong album.");
  if (!photo.originalPending) return res.json({ saved: true });
  if (!directUploadsEnabled()) fail(404, "Kho ảnh chưa hỗ trợ tải thẳng.");
  res.json({ upload: await createDirectUpload(b._id, d.clientKey, d.size) });
});
// 2) Gắn ảnh gốc: JSON { clientKey, stored } (đã tải thẳng lên kho) hoặc chính tệp JPEG kèm X-Photo-Key.
albumsRouter.post("/:token/photos/original", photoBody, async (req, res) => {
  const b = await album(req, { status: 1, captureEndsAt: 1 });
  const raw = Buffer.isBuffer(req.body);
  const clientKey = z.string().min(8).max(160).parse(raw ? req.get("X-Photo-Key") : req.body?.clientKey);
  if (raw && !req.body.length) fail(400, "Ảnh không có dữ liệu.");
  const source = raw
    ? { buffer: req.body }
    : { storedOriginal: storedOriginal(b._id, { clientKey, stored: z.string().max(200).parse(req.body?.stored) }) };
  res.json({ attached: await attachOriginal(b._id, clientKey, source) });
});
