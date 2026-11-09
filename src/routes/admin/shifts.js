import { Router } from "express";
import { z } from "zod";
import { Booking, Room, Shift } from "../../models/index.js";
import { allow, requireBranch, staffBranch } from "../../middleware/auth.js";
import { fail, id, today } from "../validation.js";

const cash = z.number({ error: "Vui lòng nhập số tiền." }).int().min(0).max(1_000_000_000);

export const shiftsRouter = Router();

const method = (field) => ({ $cond: [{ $eq: [field, "transfer"] }, "transfer", "cash"] });
// Tiền đã thu tại chi nhánh trong khoảng thời gian của ca, tách tiền mặt / chuyển khoản:
// tiền vé tính lúc xác nhận thu; tờ in bán thêm tính lúc bán, theo hình thức thu của lần bán đó.
export async function shiftSummary(branch, from, to = new Date()) {
  const window = { $gte: from, $lte: to };
  const [tickets, extras] = await Promise.all([
    Booking.aggregate([
      { $match: { branch, paid: true, paidAt: window } },
      { $group: {
        _id: method("$paymentMethod"),
        count: { $sum: 1 },
        amount: { $sum: { $subtract: [
          { $ifNull: ["$total", 0] },
          { $sum: { $ifNull: ["$extraSales.amount", []] } },
        ] } },
      } },
    ]),
    Booking.aggregate([
      { $match: { branch, "extraSales.at": window } },
      { $unwind: "$extraSales" },
      { $match: { "extraSales.at": window } },
      { $group: {
        _id: method("$extraSales.paymentMethod"),
        sheets: { $sum: "$extraSales.sheets" },
        amount: { $sum: "$extraSales.amount" },
      } },
    ]),
  ]);
  const sum = (rows, m) => rows.find((r) => r._id === m)?.amount || 0;
  const cash = sum(tickets, "cash") + sum(extras, "cash");
  const transfer = sum(tickets, "transfer") + sum(extras, "transfer");
  return {
    tickets: tickets.reduce((n, r) => n + r.count, 0),
    extraSheets: extras.reduce((n, r) => n + r.sheets, 0),
    cash,
    transfer,
    total: cash + transfer,
  };
}

const withLiveSummary = async (shift) =>
  shift && { ...shift, summary: shift.open
    ? await shiftSummary(shift.branch, shift.openedAt) : shift.summary };

// Lễ tân luôn ở chi nhánh được phân công; quản trị viên chọn chi nhánh (?branch=).
async function branchOf(req, requested) {
  const assigned = staffBranch(req);
  if (assigned) return assigned;
  const branch = String(requested || "").trim();
  if (!branch) fail(400, "Vui lòng chọn chi nhánh.");
  if (!(await Room.exists({ branch }))) fail(404, "Không tìm thấy chi nhánh.");
  return branch;
}

shiftsRouter.get("/", async (req, res) => {
  const assigned = staffBranch(req);
  const branch = assigned || String(req.query.branch || "").trim();
  const filter = branch ? { branch } : {};
  const [current, recent] = await Promise.all([
    branch ? Shift.findOne({ branch, open: true }).lean() : null,
    Shift.find({ ...filter, open: false }).sort({ openedAt: -1 }).limit(20).lean(),
  ]);
  res.json({ branch, current: await withLiveSummary(current), recent });
});

// Đối soát theo tháng: các ca đã đóng trong tháng (tiền đầu ca, tiền mặt thu trong ca, tiền đếm
// được cuối ca, chênh lệch) và tiền đã thu của từng chi nhánh, tách tiền mặt / chuyển khoản.
shiftsRouter.get("/report", allow("revenue:view"), async (req, res) => {
  const month = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng không hợp lệ.")
    .parse(req.query.month ?? today().slice(0, 7));
  const branch = staffBranch(req) || String(req.query.branch || "").trim() || null;
  const [year, m] = month.split("-").map(Number);
  // Đầu tháng và đầu tháng sau theo giờ Việt Nam (UTC+7).
  const from = new Date(Date.UTC(year, m - 1, 1) - 7 * 3600000);
  const to = new Date(Date.UTC(year, m, 1) - 7 * 3600000);
  const window = { $gte: from, $lt: to };
  const [shifts, paidBranches] = await Promise.all([
    Shift.find({ open: false, openedAt: window, ...(branch && { branch }) })
      .sort({ openedAt: -1 })
      .lean(),
    branch ? [branch] : Booking.distinct("branch", {
      $or: [{ paid: true, paidAt: window }, { "extraSales.at": window }],
    }),
  ]);
  const names = [...new Set([...paidBranches, ...shifts.map((s) => s.branch)])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "vi"));
  const branches = await Promise.all(
    names.map(async (name) => ({ branch: name, ...(await shiftSummary(name, from, new Date(to - 1))) })),
  );
  const rows = shifts.map((s) => {
    const expectedCash = (s.openingCash || 0) + (s.summary?.cash || 0);
    return { ...s, expectedCash, difference: (s.closingCash ?? 0) - expectedCash };
  });
  const sum = (list, key) => list.reduce((n, item) => n + (item[key] || 0), 0);
  res.json({
    month,
    branch,
    shifts: rows,
    branches,
    totals: {
      shifts: rows.length,
      matched: rows.filter((s) => !s.difference).length,
      difference: sum(rows, "difference"),
      tickets: sum(branches, "tickets"),
      extraSheets: sum(branches, "extraSheets"),
      cash: sum(branches, "cash"),
      transfer: sum(branches, "transfer"),
      total: sum(branches, "total"),
    },
  });
});

shiftsRouter.post("/open", allow("shift:operate"), async (req, res) => {
  const d = z.object({
    branch: z.string().trim().max(200).optional(),
    openingCash: cash.default(0),
  }).parse(req.body);
  const branch = await branchOf(req, d.branch);
  try {
    const shift = await Shift.create({
      branch,
      openedBy: req.user._id,
      openedByName: req.user.name,
      openingCash: d.openingCash,
    });
    res.status(201).json(await withLiveSummary(shift.toObject()));
  } catch (error) {
    if (error.code !== 11000) throw error;
    fail(409, `Chi nhánh ${branch} đang có ca mở. Đóng ca đó trước khi mở ca mới.`);
  }
});

shiftsRouter.post("/:id/close", allow("shift:operate"), async (req, res) => {
  const d = z.object({
    closingCash: cash,
    note: z.string().trim().max(1000).default(""),
  }).parse(req.body);
  const shiftId = id.parse(req.params.id);
  const shift = await Shift.findById(shiftId).lean();
  if (!shift) fail(404, "Không tìm thấy ca trực.");
  requireBranch(req, shift.branch);
  if (!shift.open) return res.json(shift);
  const closedAt = new Date();
  const closed = await Shift.findOneAndUpdate(
    { _id: shiftId, open: true },
    { $set: {
      open: false,
      closedAt,
      closedBy: req.user._id,
      closedByName: req.user.name,
      closingCash: d.closingCash,
      note: d.note,
      summary: await shiftSummary(shift.branch, shift.openedAt, closedAt),
    } },
    { new: true },
  ).lean();
  // Hai người bấm đóng cùng lúc: trả về ca đã đóng trước đó.
  res.json(closed || (await Shift.findById(shiftId).lean()));
});
