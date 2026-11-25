import { Router } from "express";
import { z } from "zod";
import { Booking, PrintJob, Room } from "../../models/index.js";
import { admin, allow, requireBranch, staffBranch } from "../../middleware/auth.js";
import { deleteMedia, livePrintFilter, unsharedPrintFiles } from "../../services/media.js";
import { printEvents } from "../../services/print-events.js";
import { fail, id } from "../validation.js";
import { publicJob, releaseSheets } from "../print-helpers.js";
import { listPrinterStatus } from "../../services/printer-status.js";
import { PRINT_SIZES } from "../../print-sizes.js";

export const printsRouter = Router();

// An omitted branch keeps older clients compatible. An explicit empty branch
// selects only legacy unassigned jobs, never all sites. Staff cannot change scope.
function queueBranch(req) {
  const assigned = staffBranch(req);
  const requested = z.string().trim().max(200).optional().parse(req.query.branch);
  if (assigned && requested !== undefined && requested !== assigned)
    fail(403, "Bạn chỉ được xem hàng chờ in của cơ sở được phân công.");
  return assigned || requested;
}
const branchFilter = branch => branch === undefined ? {} : { branch: branch || { $in: [null, ""] } };
const queueSize = req => z.enum(PRINT_SIZES).optional().parse(req.query.size);

// ─── Hàng chờ in: lệnh in khách gửi từ Web App ───────────────────────────
printsRouter.get("/stream", (req, res) => {
  const branch = queueBranch(req), size = queueSize(req);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  // Lệnh in mới và lệnh in lỗi (print agent báo hết phim, mất kết nối…).
  const relay = (event) => (job) => {
    if ((branch === undefined || (job.branch || "").trim() === branch) && (!size || job.printSize === size))
      res.write(`event: ${event}\ndata: ${JSON.stringify(job)}\n\n`);
  };
  const send = relay("print");
  const failed = relay("print-failed");
  const updated = relay("print-updated");
  printEvents.on("print", send);
  printEvents.on("print-failed", failed);
  printEvents.on("print-updated", updated);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    printEvents.off("print", send);
    printEvents.off("print-failed", failed);
    printEvents.off("print-updated", updated);
  });
});
// Tình trạng máy in theo chi nhánh / phòng (lễ tân chỉ thấy chi nhánh được phân công).
printsRouter.get("/printers", async (req, res) => {
  res.json(await listPrinterStatus(staffBranch(req)));
});
// Counts and available sites include old jobs whose room has since been removed.
printsRouter.get("/branches", async (req, res) => {
  const branch = queueBranch(req), size = queueSize(req);
  const scope = branchFilter(branch);
  const [counts, rooms] = await Promise.all([
    PrintJob.aggregate([
      { $match: { ...scope, ...(size && { printSize: size }), ...livePrintFilter() } },
      { $group: { _id: { $ifNull: ["$branch", ""] },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
        printed: { $sum: { $cond: [{ $eq: ["$status", "printed"] }, 1, 0] } } } },
    ]),
    Room.distinct("branch", scope),
  ]);
  const names = [...new Set([...rooms.filter(name => typeof name === "string"), ...counts.map(row => row._id),
    ...(branch !== undefined ? [branch] : [])])].sort((a,b) => a.localeCompare(b,"vi"));
  res.json(names.map(name => ({ branch: name, pending: counts.find(row => row._id === name)?.pending || 0,
    printed: counts.find(row => row._id === name)?.printed || 0 })));
});
printsRouter.get("/", async (req, res) => {
  const branch = queueBranch(req);
  const status = z
    .enum(["pending", "printed"])
    .default("pending")
    .parse(req.query.status);
  // size=large: Hàng chờ in của phòng Selfbooth (nhân viên ở quầy in tờ 20 × 30).
  const size = queueSize(req);
  // Chỉ lệnh in còn hạn (3 ngày kể từ lúc gửi); lệnh hết hạn được dọn mỗi 15 phút.
  const jobs = await PrintJob.find({
    status,
    ...(size && { printSize: size }),
    ...branchFilter(branch),
    ...livePrintFilter(),
  })
    .sort({ createdAt: status === "pending" ? 1 : -1 })
    .limit(200)
    .populate({ path: "booking", select: "accessToken" })
    .lean();
  res.json(jobs.map((j) => publicJob(j, j.booking?.accessToken)));
});
printsRouter.patch("/:id", allow("print:operate"), async (req, res) => {
  const d = z
    .object({ status: z.enum(["pending", "printed"]) })
    .parse(req.body);
  const target = await PrintJob.findById(id.parse(req.params.id)).select("branch").lean();
  if (!target) fail(404, "Không tìm thấy lệnh in.");
  requireBranch(req, target.branch);
  const job = await PrintJob.findByIdAndUpdate(
    id.parse(req.params.id),
    d.status === "printed"
      ? { status: "printed", printedAt: new Date(), printedBy: req.user.name }
      : { status: "pending", $unset: { printedAt: 1, printedBy: 1 } },
    { new: true },
  ).populate({ path: "booking", select: "accessToken" });
  if (!job) fail(404, "Không tìm thấy lệnh in.");
  if (d.status === "printed" && job.booking)
    await Booking.updateOne({ _id: job.booking._id }, { printed: true });
  const result = publicJob(job, job.booking?.accessToken);
  printEvents.emit("print-updated", result);
  res.json(result);
});
printsRouter.delete("/:id", admin, async (req, res) => {
  const job = await PrintJob.findById(id.parse(req.params.id));
  if (!job) fail(404, "Không tìm thấy lệnh in.");
  await deleteMedia(await unsharedPrintFiles([job]));
  // Keep the reference/quota when R2 is unavailable so cancellation can retry.
  const removed = await PrintJob.findOneAndDelete({ _id: job._id });
  if (!removed) return res.json({ ok: true });
  // Lệnh chưa in bị hủy: trả lại số tờ để khách sửa và gửi lại.
  if (removed.status === "pending" && removed.booking && !removed.operatorPrint)
    await releaseSheets(removed.booking, (removed.sheets?.length || 1) * (removed.copies || 1));
  printEvents.emit("print-updated", publicJob(removed));
  res.json({ ok: true });
});
