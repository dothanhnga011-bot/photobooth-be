import { Router } from "express";
import { rejectArchivedSale } from "../../services/revenue-ledger.js";
import crypto from "node:crypto";
import { z } from "zod";
import { Booking, Room, Package } from "../../models/index.js";
import { auth, staffBranch, requireBranch } from "../../middleware/auth.js";
import { bookingLimit } from "../../middleware/rate-limits.js";
import { fail, id, phone, token, today } from "../validation.js";
import { publicBooking } from "../booking-helpers.js";

export const ticketsRouter = Router();
const CODE_LIFETIME_MS = 2 * 60 * 60 * 1000;

async function requireCounterRoom(branch, room) {
  if (room?.kind === "polaroid")
    fail(400, "Phòng Polaroid chọn layout tại máy và thanh toán ở quầy, không dùng mã chụp.");
  // Older rooms without a kind are photobooths. Never issue a code at a branch
  // where no active booth can redeem it (e.g. a Polaroid-only branch).
  if (!await Room.exists({ branch, active: true, kind: { $ne: "polaroid" } }))
    fail(400, `Chi nhánh “${branch}” chưa có phòng photobooth đang hoạt động để nhập mã. Vui lòng chọn đúng chi nhánh hoặc kiểm tra loại phòng trong Quản lý máy.`);
}

// Phiếu tại quầy không cần thông tin khách. Vẫn kiểm tra khi client cũ gửi kèm.
const customerName = z.string().trim().max(100).default("");
const customerPhone = z.string().trim()
  .refine((value) => !value || phone.safeParse(value).success, "Số điện thoại Việt Nam không hợp lệ")
  .default("");
const draftSchema = z.object({
  name: customerName,
  phone: customerPhone,
  room: z.union([id, z.literal("")]).default(""),
  branch: z.string().trim().max(200).default(""),
  package: id,
  requestKey: z.uuid(),
  expectedTotal: z.number().int().nonnegative().optional(),
});

// Preparing a sale never releases a usable code. Only an explicit payment
// confirmation below creates the six digits and starts their two-hour clock.
ticketsRouter.post("/draft", auth, bookingLimit, async (req, res) => {
  const d = draftSchema.parse(req.body);
  const assigned = staffBranch(req);
  const requestFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ ...d, issuedBy: String(req.user._id) }))
    .digest("hex");
  const existing = await Booking.findOne({ requestKey: d.requestKey }).select("+requestFingerprint");
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint)
      fail(409, "Thông tin phiếu đã thay đổi. Vui lòng tạo phiếu mới.");
    requireBranch(req, existing.branch);
    if (String(existing.issuedBy) !== String(req.user._id) && req.user.role !== "admin")
      fail(403, "Phiếu này do tài khoản khác tạo.");
    return res.json(publicBooking(existing));
  }
  await rejectArchivedSale(d.requestKey);
  const [room, pack] = await Promise.all([
    d.room ? Room.findOne({ _id: d.room, active: true }) : null,
    Package.findOne({ _id: d.package, active: true }),
  ]);
  if ((d.room && !room) || !pack) fail(400, "Phòng hoặc gói chụp không còn hoạt động.");
  // Mã chụp chỉ cho phòng photobooth (in DNP); layout Polaroid (khổ Instax) khách chọn ở máy phòng
  // Polaroid và trả tiền ở quầy, không dùng mã.
  if (pack.printSize === "instax")
    fail(400, "Layout Polaroid không bán bằng mã chụp — khách chọn layout ở máy phòng Polaroid và trả tiền ở quầy.");
  if (room) requireBranch(req, room.branch);
  const branch = room?.branch || d.branch || assigned;
  if (!branch) fail(400, "Vui lòng chọn chi nhánh trước khi tạo phiếu.");
  requireBranch(req, branch);
  if (room && d.branch && d.branch !== room.branch) fail(400, "Phòng không thuộc chi nhánh đã chọn.");
  await requireCounterRoom(branch, room);
  // Bảng giá riêng: gói chỉ bán ở các chi nhánh đã chọn (để trống = mọi chi nhánh).
  if (pack.branches?.length && !pack.branches.includes(branch))
    fail(400, `Gói “${pack.name}” không áp dụng tại chi nhánh ${branch}.`);
  if (d.expectedTotal !== undefined && d.expectedTotal !== pack.price)
    fail(409, "Giá gói vừa thay đổi. Vui lòng kiểm tra lại số tiền.");
  try {
    const b = await Booking.create({
      name: d.name,
      phone: d.phone,
      room: room?._id,
      roomName: room?.name || "",
      branch,
      package: pack._id,
      packageName: pack.name,
      shots: pack.shots,
      countdownSeconds: pack.countdownSeconds || 10,
      selectCount: pack.selectCount || 4,
      printSize: pack.printSize || "full",
      captureDuration: pack.duration,
      prints: pack.prints,
      total: pack.price,
      discount: 0,
      source: "counter",
      issuedBy: req.user._id,
      date: today(),
      time: "",
      status: "pending",
      paid: false,
      requestKey: d.requestKey,
      requestFingerprint,
    });
    res.status(201).json(publicBooking(b));
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.requestKey) {
      const replay = await Booking.findOne({ requestKey: d.requestKey }).select("+requestFingerprint");
      if (replay && replay.requestFingerprint !== requestFingerprint)
        fail(409, "Thông tin phiếu đã thay đổi. Vui lòng tạo phiếu mới.");
      if (replay && String(replay.issuedBy) === String(req.user._id)) return res.json(publicBooking(replay));
    }
    throw error;
  }
});

ticketsRouter.patch("/:id/activate", auth, async (req, res) => {
  const { paymentReceived, paymentMethod, expectedTotal } = z.object({
    paymentReceived: z.literal(true),
    paymentMethod: z.enum(["cash", "transfer"]),
    expectedTotal: z.number().int().nonnegative(),
  }).parse(req.body);
  const bookingId = id.parse(req.params.id);
  const draft = await Booking.findById(bookingId).select("+accessToken");
  if (!draft || draft.source !== "counter") fail(404, "Không tìm thấy mã chụp tại quầy.");
  requireBranch(req, draft.branch);
  if (draft.customerDataDeletedAt) fail(410, "Phiếu đã hết hạn lưu lịch sử. Vui lòng tạo phiếu mới.");
  if (String(draft.issuedBy) !== String(req.user._id) && req.user.role !== "admin")
    fail(403, "Chỉ người tạo mã hoặc quản trị viên được xác nhận thanh toán.");
  if (draft.total !== expectedTotal) fail(409, "Số tiền đã thay đổi. Vui lòng kiểm tra lại.");
  if (draft.status === "confirmed" && draft.paid)
    return res.json({ ...publicBooking(draft), accessToken: draft.accessToken });
  if (draft.status !== "pending" || draft.paid)
    fail(409, "Mã này không thể kích hoạt.");
  await requireCounterRoom(draft.branch);
  const currentPackage = await Package.findById(draft.package).select("price active").lean();
  if (!currentPackage?.active || currentPackage.price !== draft.total)
    fail(409, "Gói chụp hoặc giá đã thay đổi trước khi thu tiền. Vui lòng tạo phiếu mới.");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const now = new Date();
      const updated = await Booking.findOneAndUpdate(
        { _id: bookingId, status: "pending", paid: false, customerDataDeletedAt: null },
        { $set: {
          code: String(crypto.randomInt(100000, 1000000)),
          accessToken: token(),
          paid: paymentReceived,
          paidAt: now,
          codeExpiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
          paymentMethod,
          status: "confirmed",
        } },
        { new: true },
      ).select("+accessToken");
      if (updated) return res.json({ ...publicBooking(updated), accessToken: updated.accessToken });
      const replay = await Booking.findById(bookingId).select("+accessToken");
      if (replay?.status === "confirmed" && replay.paid)
        return res.json({ ...publicBooking(replay), accessToken: replay.accessToken });
      fail(409, "Mã này không thể kích hoạt.");
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.code) continue;
      throw error;
    }
  }
  fail(503, "Không thể tạo mã 6 số. Vui lòng thử lại.");
});

ticketsRouter.post("/quote", auth, async (req, res) => {
  const d = z.object({ package: id }).parse(req.body);
  const pack = await Package.findOne({ _id: d.package, active: true });
  if (!pack) fail(400, "Gói chụp không còn hoạt động.");
  res.json({ total: pack.price, discount: 0 });
});
ticketsRouter.post("/", auth, bookingLimit, async (req, res) => {
  const assigned = staffBranch(req);
  const d = z
    .object({
      name: customerName,
      phone: customerPhone,
      // Mã dùng ở phòng nào cũng được; phòng gửi kèm (nếu có) chỉ để gợi ý.
      room: z.union([id, z.literal("")]).default(""),
      branch: z.string().trim().max(200).default(""),
      package: id,
      paymentMethod: z.enum(["cash", "transfer"]),
      requestKey: z.uuid(),
      paymentReceived: z.literal(true, {
        error: "Vui lòng xác nhận đã nhận đủ tiền của khách.",
      }),
      expectedTotal: z.number().int().nonnegative().optional(),
    })
    .parse(req.body);
  const requestFingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ ...d, issuedBy: String(req.user._id) }))
    .digest("hex");
  const replay = async () => {
    if (!d.requestKey) return null;
    const existing = await Booking.findOne({ requestKey: d.requestKey }).select(
      "+accessToken +requestFingerprint",
    );
    if (existing && existing.requestFingerprint !== requestFingerprint)
      fail(409, "Thông tin tạo mã đã thay đổi. Vui lòng kiểm tra lại.");
    if (existing) requireBranch(req, existing.branch);
    else await rejectArchivedSale(d.requestKey);
    return existing;
  };
  const previous = await replay();
  if (previous)
    return res.json({
      ...publicBooking(previous),
      accessToken: previous.accessToken,
    });
  const [room, pack] = await Promise.all([
    d.room ? Room.findOne({ _id: d.room, active: true }) : null,
    Package.findOne({ _id: d.package, active: true }),
  ]);
  if ((d.room && !room) || !pack)
    fail(400, "Phòng hoặc gói chụp không còn hoạt động.");
  // Mã chụp chỉ cho phòng photobooth (in DNP); layout Polaroid (khổ Instax) khách chọn ở máy phòng
  // Polaroid và trả tiền ở quầy, không dùng mã.
  if (pack.printSize === "instax")
    fail(400, "Layout Polaroid không bán bằng mã chụp — khách chọn layout ở máy phòng Polaroid và trả tiền ở quầy.");
  if (room) requireBranch(req, room.branch);
  const branch = room?.branch || d.branch || assigned;
  if (!branch) fail(400, "Vui lòng chọn chi nhánh trước khi tạo mã.");
  requireBranch(req, branch);
  if (room && d.branch && d.branch !== room.branch) fail(400, "Phòng không thuộc chi nhánh đã chọn.");
  await requireCounterRoom(branch, room);
  // Bảng giá riêng: gói chỉ bán ở các chi nhánh đã chọn (để trống = mọi chi nhánh).
  if (pack.branches?.length && !pack.branches.includes(branch))
    fail(400, `Gói “${pack.name}” không áp dụng tại chi nhánh ${branch}.`);
  if (d.expectedTotal !== undefined && d.expectedTotal !== pack.price)
    fail(
      409,
      "Giá gói vừa thay đổi. Vui lòng kiểm tra lại số tiền trước khi tạo mã.",
    );
  const accessToken = token();
  let b;
  for (let i = 0; i < 5; i++) {
    try {
      b = await Booking.create({
        ...d,
        name: d.name,
        date: today(),
        time: "",
        status: "confirmed",
        paid: true,
        paidAt: new Date(),
        codeExpiresAt: new Date(Date.now() + CODE_LIFETIME_MS),
        source: "counter",
        issuedBy: req.user._id,
        code: String(crypto.randomInt(100000, 1000000)),
        accessToken,
        requestFingerprint,
        room: room?._id,
        roomName: room?.name || "",
        branch,
        packageName: pack.name,
        captureDuration: pack.duration,
        shots: pack.shots,
        countdownSeconds: pack.countdownSeconds || 10,
      selectCount: pack.selectCount || 4,
        printSize: pack.printSize || "full",
        prints: pack.prints,
        total: pack.price,
        discount: 0,
      });
      break;
    } catch (e) {
      if (e.code === 11000) {
        const existing = await replay();
        if (existing)
          return res.json({
            ...publicBooking(existing),
            accessToken: existing.accessToken,
          });
      }
      if (e.code === 11000 && e.keyPattern?.code) continue;
      throw e;
    }
  }
  if (!b) fail(503, "Không thể tạo mã vé. Vui lòng thử lại.");
  res.status(201).json({ ...publicBooking(b), accessToken });
});
