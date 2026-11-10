import { Router } from "express";
import { z } from "zod";
import { Booking, PrintJob } from "../../models/index.js";
import { allow, requireBranch } from "../../middleware/auth.js";
import { dispatchPrint } from "../../services/dnp.js";
import { initialSpoolStatus } from "../../services/printer-status.js";
import { deleteMedia, livePrintFilter, photoExpiry, printExpiry, saveMedia } from "../../services/media.js";
import { mediaReference } from "../../services/r2.js";
import { printContentType, validatePrintImage } from "../../services/print-image.js";
import { printEvents } from "../../services/print-events.js";
import { publicJob } from "../print-helpers.js";
import { printBody, readPrintPack } from "../print-upload.js";
import { fail, id, token } from "../validation.js";

export const bookingPrintsRouter = Router();

async function bookingFor(req, operating = false) {
  const booking = await Booking.findById(id.parse(req.params.id)).select(
    "+accessToken code name branch room roomName status paid printSize prints printSheets mediaDeleted composite.frameName composite.file photos._id photos.kind photos.deleted",
  ).lean();
  if (!booking) fail(404, "Không tìm thấy đơn hàng.");
  requireBranch(req, booking.branch);
  if (operating && (booking.mediaDeleted || !["checked_in", "completed"].includes(booking.status)))
    fail(409, "Đơn chưa chụp, đã hủy hoặc ảnh đã hết hạn — không thể in lại.");
  return booking;
}

async function replay(booking, requestKey, fingerprint) {
  if (!requestKey) return null; // compatibility with older counter clients
  const previous = await PrintJob.findOne({ requestKey }).select("+requestFingerprint");
  if (!previous) return null;
  if (String(previous.booking) !== String(booking._id) || previous.requestFingerprint !== fingerprint)
    fail(409, "Mã yêu cầu in đã được dùng cho nội dung khác. Hãy kiểm tra lượt in trước.");
  return previous;
}

function respond(res, job, booking, status = 200) {
  return res.status(status).json(publicJob(job, booking.accessToken));
}

bookingPrintsRouter.get("/bookings/:id/prints", allow("print:operate"), async (req, res) => {
  const booking = await bookingFor(req);
  const jobs = booking.mediaDeleted ? [] : await PrintJob.find({ booking: booking._id, ...livePrintFilter() })
    .sort({ createdAt: -1, _id: -1 }).limit(20).lean();
  const photoCount = (booking.photos || []).filter((p) => p.kind === "original" && !p.deleted && photoExpiry(p) > Date.now()).length;
  const { photos, composite, ...details } = booking;
  res.json({ booking: { ...details, photoCount, composite: composite?.file ? {
    url: `/api/albums/${booking.accessToken}/composite`, frameName: composite.frameName || "",
  } : null }, jobs: jobs.map((job) => publicJob(job, booking.accessToken)) });
});

// Local delivery records a successful local send; it NEVER creates an automatic print queue job.
bookingPrintsRouter.post("/bookings/:id/reprint", allow("print:operate"), async (req, res) => {
  const d = z.object({ jobId: id, copies: z.number().int().min(1).max(20),
    requestKey: z.uuid().optional(), delivery: z.enum(["queue", "local"]).default("queue"),
  }).refine((v) => v.delivery !== "local" || v.requestKey, "Thiếu mã chống trùng của lượt in.").parse(req.body);
  const booking = await bookingFor(req, true);
  const fingerprint = JSON.stringify(["reprint", d.jobId, d.copies, d.delivery]);
  const previous = await replay(booking, d.requestKey, fingerprint);
  if (previous) return respond(res, previous, booking);
  const source = await PrintJob.findOne({ _id: d.jobId, booking: booking._id, ...livePrintFilter() });
  if (!source) fail(404, "File in không còn hoặc đã hết hạn lưu trữ.");
  if (d.delivery === "local" && source.printSize === "instax") fail(400, "Instax cần chương trình in Instax riêng.");
  if (d.delivery === "local" && (source.sheets?.length || 1) * d.copies > 20)
    fail(400, "Mỗi lượt hỗ trợ tối đa 20 tờ in.");
  let job;
  try {
    job = await PrintJob.create({ booking: booking._id, code: booking.code, name: booking.name,
      roomName: booking.roomName, room: booking.room, branch: booking.branch,
      copies: d.copies, frameName: source.frameName, printSize: source.printSize || "full",
      file: source.file, sheets: source.sheets, width: source.width, height: source.height,
      operatorPrint: true, reprintOf: source._id, fileExpiresAt: printExpiry(source),
      requestKey: d.requestKey, requestFingerprint: fingerprint,
      spoolStatus: d.delivery === "local" ? "sent" : await initialSpoolStatus(booking.room),
      ...(d.delivery === "local" && { spoolMessage: "Quầy đã gửi trực tiếp tới hàng in RX1." }),
    });
  } catch (error) {
    if (error.code === 11000) {
      const raced = await replay(booking, d.requestKey, fingerprint);
      if (raced) return respond(res, raced, booking);
    }
    throw error;
  }
  if (d.delivery !== "local") dispatchPrint(job);
  printEvents.emit("print", { ...publicJob(job, booking.accessToken), branch: booking.branch });
  return respond(res, job, booking, 201);
});

// A manually composed recovery sheet is archived after local output, without charging the album.
bookingPrintsRouter.post("/bookings/:id/print-file", allow("print:operate"), printBody, async (req, res) => {
  const booking = await bookingFor(req, true);
  if (booking.printSize === "instax") fail(400, "Instax cần chương trình in Instax riêng.");
  const d = readPrintPack(req);
  const copies = z.coerce.number().int().min(1).max(20).parse(req.get("X-Print-Copies") || 1);
  if (d.sheets.length * copies > 20) fail(400, "Mỗi lượt hỗ trợ tối đa 20 tờ in.");
  const printSize = d.printSize || booking.printSize || "full";
  const fingerprint = JSON.stringify(["manual", d.fingerprint, printSize, copies]);
  const previous = await replay(booking, d.requestKey, fingerprint);
  if (previous) return respond(res, previous, booking);
  const files = [];
  let job;
  try {
    const sheets = [];
    for (const { buffer, type } of d.sheets) {
      let metadata;
      try { metadata = await validatePrintImage(buffer, `image/${type}`, printSize); }
      catch { fail(400, "File in phải là PNG/JPEG đúng khổ và đọc được đầy đủ."); }
      const file = mediaReference(`${token()}.${metadata.extension}`);
      files.push(file);
      await saveMedia(file, buffer, printContentType(file));
      sheets.push({ file, width: metadata.width, height: metadata.height });
    }
    job = await PrintJob.create({ booking: booking._id, code: booking.code, name: booking.name,
      roomName: booking.roomName, room: booking.room, branch: booking.branch, printSize,
      copies, frameName: d.frameName, file: sheets[0].file, sheets,
      width: sheets[0].width, height: sheets[0].height,
      requestKey: d.requestKey, requestFingerprint: fingerprint, operatorPrint: true,
      spoolStatus: "sent", spoolMessage: "Quầy đã ghép ảnh và gửi trực tiếp tới hàng in RX1.",
    });
  } catch (error) {
    await deleteMedia(files).catch(() => {});
    if (error.code === 11000) {
      const raced = await replay(booking, d.requestKey, fingerprint);
      if (raced) return respond(res, raced, booking);
    }
    throw error;
  }
  printEvents.emit("print", { ...publicJob(job, booking.accessToken), branch: booking.branch });
  return respond(res, job, booking, 201);
});
