import crypto from "node:crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { PrintJob } from "../models/index.js";
import { livePrintFilter, sendMedia } from "../services/media.js";
import { printContentType } from "../services/print-image.js";
import { noteAgent, noteRoomAgent, savePrinterStatus, saveRoomPrinterStatus } from "../services/printer-status.js";
import { printEvents } from "../services/print-events.js";
import { publicJob } from "./print-helpers.js";
import { fail, id } from "./validation.js";
import { printBody } from "./print-upload.js";
import { PRINT_SIZES } from "../print-sizes.js";
import { submitPrintPack } from "./albums.js";
import { getRx1Output, noteRx1Output, noteSharpnessTest, pendingSharpnessTest, rx1AppliedSchema,
  sharpnessTestReportSchema } from "../services/rx1-output.js";

export const printAgentRouter = Router();
const LEASE_MS = 5 * 60 * 1000;

// Hai loại mã: PRINT_AGENT_TOKEN chung (agent Node cũ, nhận lệnh cả chi nhánh), hoặc mã máy in của
// một phòng (Quản lý máy → Cài máy chụp → Máy in DNP): chỉ nhận lệnh in của đúng phòng đó, nên mỗi
// mini PC cắm máy DNP chỉ in ảnh của phòng mình.
printAgentRouter.use((req, res, next) => {
  const raw = (req.get("Authorization") || "").replace(/^Bearer /i, "");
  const expected = Buffer.from(config.printAgentToken);
  const supplied = Buffer.from(raw);
  if (expected.length >= 32 && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
    req.printScope = null;
    return next();
  }
  try {
    const payload = jwt.verify(raw, config.secret);
    if (payload.type === "print-agent" && /^[a-f\d]{24}$/i.test(String(payload.room)) &&
      typeof payload.branch === "string") {
      req.printScope = { room: String(payload.room), branch: String(payload.branch) };
      return next();
    }
  } catch { /* không phải mã máy in hợp lệ */ }
  return res.status(403).json({ message: "Print agent chưa được cấp quyền." });
});
// Lệnh in agent này được thấy: của phòng (mã máy in phòng) hoặc của chi nhánh (mã chung).
const scopeFilter = (req, branch) => (req.printScope ? { room: req.printScope.room } : { branch });

// Configuration/acknowledgement only. This never claims, prints, archives, or charges a sheet.
// Kèm yêu cầu "In thử độ nét" của phòng (nếu đang chờ) và nhận lại kết quả tờ thử agent đã in.
printAgentRouter.post("/output-settings/sync", async (req, res) => {
  if (!req.printScope) fail(403, "Đồng bộ màu RX1 cần mã máy in riêng của phòng.");
  const { applied, sharpnessTest } = z.object({
    applied: rx1AppliedSchema,
    sharpnessTest: sharpnessTestReportSchema.optional(),
  }).strict().parse(req.body);
  await noteRx1Output(req.printScope, applied);
  if (sharpnessTest) await noteSharpnessTest(req.printScope.room, sharpnessTest);
  res.json({ rx1Output: await getRx1Output(), sharpnessTest: await pendingSharpnessTest(req.printScope.room) });
});
// Authenticated room agent reserves/stores a local print without ever putting it in the claim queue.
// Only the first response includes a lease. A retry cannot print an uncertain physical result twice.
printAgentRouter.post("/direct/:token", printBody, async (req, res) => {
  if (!req.printScope) fail(403, "In trực tiếp cần mã máy in riêng của phòng.");
  req.directPrintScope = req.printScope;
  await submitPrintPack(req, res);
});
printAgentRouter.post("/claim", async (req, res) => {
  const body = z.object({
    branch: z.string().trim().min(1).max(200).optional(),
    // Khổ máy in cạnh agent này in được (DNP: full + strip, Instax: instax). Không gửi = mọi khổ.
    // DS820 (phòng Selfbooth): large.
    printSizes: z.array(z.enum(PRINT_SIZES)).min(1).max(4).optional(),
  }).parse(req.body);
  const { printSizes } = body;
  const branch = req.printScope ? req.printScope.branch : body.branch;
  if (!req.printScope && !branch) fail(400, "Thiếu chi nhánh của máy in.");
  const scope = scopeFilter(req, branch);
  const now = new Date();
  // An expired lease has uncertain physical outcome. Require a human check
  // before resending so a lost acknowledgement cannot print a second copy.
  await PrintJob.updateMany({ ...scope, status: "pending", spoolStatus: "sending",
    spoolLeaseUntil: { $lte: now } }, { $set: { spoolStatus: "failed",
      spoolMessage: "Mất xác nhận từ máy in; kiểm tra giấy trước khi gửi lại." } });
  const leaseId = crypto.randomUUID();
  const sizes = printSizes && [...new Set(printSizes)];
  await (req.printScope ? noteRoomAgent(req.printScope, sizes) : noteAgent(branch, sizes)).catch(() => {});
  const job = await PrintJob.findOneAndUpdate({
    ...scope, status: "pending", spoolStatus: "queued",
    ...livePrintFilter(now),
    // Lệnh in cũ không ghi khổ là khổ to.
    ...(sizes && { printSize: sizes.includes("full") ? { $in: [...sizes, null] } : { $in: sizes } }),
  }, { $set: { spoolStatus: "sending", spoolMessage: "Máy in tại tiệm đang nhận lệnh.",
    spoolLeaseId: leaseId, spoolLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
  { sort: { createdAt: 1 }, new: true }).select("+spoolLeaseId");
  if (!job) return res.json({ job: null });
  res.json({ job: { id: job._id, leaseId, code: job.code,
    printSize: job.printSize || "full", copies: Math.max(1, job.copies || 1),
    sheets: (job.sheets?.length ? job.sheets : [{ file: job.file }]).map((sheet, index) => ({
      index, extension: /\.png$/i.test(sheet.file) ? "png" : "jpg",
    })) } });
});

printAgentRouter.get("/jobs/:id/sheets/:index", async (req, res) => {
  const job = await PrintJob.findOne({ _id: id.parse(req.params.id),
    ...(req.printScope && { room: req.printScope.room }),
    spoolLeaseId: z.uuid().parse(req.get("X-Print-Lease")),
    spoolStatus: "sending", spoolLeaseUntil: { $gt: new Date() } })
    .select("+spoolLeaseId");
  if (!job) fail(404, "Lệnh in không còn được cấp cho máy này.");
  const index = z.coerce.number().int().min(0).max(19).parse(req.params.index);
  const file = job.sheets?.length ? job.sheets[index]?.file : index === 0 ? job.file : null;
  if (!file) fail(404, "Không tìm thấy tờ in.");
  await sendMedia(req, res, file, printContentType(file));
});

printAgentRouter.post("/jobs/:id/complete", async (req, res) => {
  const { leaseId, sent, message } = z.object({
    leaseId: z.uuid(), sent: z.boolean(), message: z.string().max(500).default(""),
  }).parse(req.body);
  const job = await PrintJob.findOneAndUpdate({ _id: id.parse(req.params.id),
    ...(req.printScope && { room: req.printScope.room }),
    spoolLeaseId: leaseId, spoolStatus: "sending" }, { $set: {
      spoolStatus: sent ? "sent" : "failed",
      spoolMessage: sent ? (message || "Đã gửi đến hàng đợi máy in tại tiệm.") :
        (message || "Máy in không nhận lệnh."),
    }, $unset: { spoolLeaseUntil: 1 } }, { new: true }).select("+spoolLeaseId");
  if (!job) fail(409, "Lệnh in đã được xử lý hoặc phiên máy in đã thay đổi.");
  // In lỗi (hết phim, mất kết nối…): báo ngay cho lễ tân đang mở trang quản trị.
  if (!sent) printEvents.emit("print-failed", { ...publicJob(job), branch: job.branch });
  res.json({ spoolStatus: job.spoolStatus });
});

// Tình trạng máy Instax cạnh agent (mỗi phút và sau mỗi lần in): máy chụp chỉ bán khổ Instax khi
// máy in còn kết nối và đủ phim.
printAgentRouter.post("/status", async (req, res) => {
  const d = z.object({
    branch: z.string().trim().min(1).max(200).optional(),
    instax: z.object({
      connected: z.boolean(),
      film: z.number().int().min(0).max(100).nullable().default(null),
      battery: z.number().int().min(0).max(100).nullable().default(null),
      charging: z.boolean().default(false),
      message: z.string().max(300).default(""),
    }).optional(),
    // Máy DNP của phòng (chương trình in của phòng báo mỗi phút): tên hàng in Windows, trạng thái,
    // số tờ đang chờ, cách cắt đôi tờ nhỏ (auto: đã tự bật 2inch cut; queue: hàng in cắt đôi riêng,
    // nhân viên bật 2inch cut một lần; none: chưa có — tờ nhỏ ra nguyên tờ, cần tự cắt).
    dnp: z.object({
      printer: z.string().max(200).default(""),
      stripPrinter: z.string().max(200).default(""),
      ready: z.boolean(),
      state: z.string().max(120).default(""),
      jobs: z.number().int().min(0).max(10000).default(0),
      cut: z.enum(["auto", "queue", "none"]).default("none"),
    }).optional(),
  }).parse(req.body);
  if (req.printScope) {
    if (d.dnp) await saveRoomPrinterStatus(req.printScope, d.dnp);
    else await noteRoomAgent(req.printScope);
    return res.json({ ok: true });
  }
  if (!d.branch) fail(400, "Thiếu chi nhánh của máy in.");
  await savePrinterStatus(d.branch, d.instax ? { instax: d.instax } : {});
  res.json({ ok: true });
});
