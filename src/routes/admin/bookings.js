import { Router } from "express";
import { z } from "zod";
import { Booking, PrintJob, Room, Setting } from "../../models/index.js";
import { allow, can, hideMoney, requireBranch, staffBranch } from "../../middleware/auth.js";
import { expiredPhotoIdBound, livePrintFilter, MEDIA_TTL_MS } from "../../services/media.js";
import { visibleBookingHistory } from "../../services/booking-history.js";
import { fail, id, date, today } from "../validation.js";
import { KIOSK_LIVE_MS } from "../kiosk-session.js";
import { publicJob } from "../print-helpers.js";
import { extraPriceFor } from "../print-count.js";

export const bookingsRouter = Router();
// Operational order history is retained for the same period as customer media.
export const BOOKING_RANGE_LIMIT = 2000;
const LIST_OMIT = "-photos -cashBills -extraSales -captureSeenAt -captureStartedAt -captureEndsAt " +
  "-nextPhotoNumber -codeExpiresAt -updatedAt";
// Tiền khách đút dư ở máy chụp (máy nhận tiền không trả tiền thừa), nhân viên thối lại ở quầy.
export const changeDue = (b) =>
  b.source === "kiosk" && b.paymentMethod === "cash" && b.paid
    ? Math.max(0, (Number(b.cashReceived) || 0) - (Number(b.total) || 0))
    : 0;

// Số đơn chờ thu tiền, hiện cạnh mục "Đơn hàng" trên thanh bên quản trị:
// - phiếu quầy tạo hôm nay mà nhân viên chưa bấm "Xác nhận đã thu" (phiếu bỏ dở từ hôm trước không tính
//   nữa, để con số không treo mãi);
// - lượt Selfbooth cũ (khách chọn layout ở máy, trả ở quầy) chưa bấm "Đã thu tiền".
// Lễ tân chỉ đếm đơn của chi nhánh được phân công.
bookingsRouter.get("/bookings/awaiting-payment", async (req, res) => {
  const assigned = staffBranch(req);
  const count = await Booking.countDocuments({
    ...visibleBookingHistory(new Date(), MEDIA_TTL_MS),
    ...(assigned && { branch: assigned }),
    paid: false,
    $or: [
      { source: "counter", status: "pending", date: today() },
      { source: "selfbooth", status: { $in: ["checked_in", "completed"] } },
    ],
  });
  res.json({ count });
});

bookingsRouter.get("/bookings", async (req, res) => {
  const now = new Date();
  const q = visibleBookingHistory(now, MEDIA_TTL_MS);
  const assigned = staffBranch(req);
  if (assigned) q.branch = assigned;
  if (req.query.code)
    q.code = z
      .string()
      .regex(/^\d{6}$/, "Mã vé gồm 6 chữ số.")
      .parse(req.query.code);
  if (req.query.date) q.date = date.parse(req.query.date);
  if (req.query.from || req.query.to) {
    q.date = {};
    if (req.query.from) q.date.$gte = date.parse(req.query.from);
    if (req.query.to) q.date.$lte = date.parse(req.query.to);
  }
  if (req.query.status)
    q.status = z
      .enum(["pending", "confirmed", "checked_in", "completed", "cancelled"])
      .parse(req.query.status);
  if (req.query.room)
    q.roomName = z.string().trim().min(1).max(200).parse(req.query.room);
  if (req.query.paymentMethod)
    q.paymentMethod = z.enum(["cash", "transfer"]).parse(req.query.paymentMethod);
  // Danh sách tự làm mới ở nhiều màn hình: không kèm mảng ảnh, tiền từng tờ, chẩn đoán máy chụp và
  // các mốc máy chụp cập nhật vài giây một lần (captureSeenAt, updatedAt…) — giao diện không dùng, và
  // nhờ vậy lần làm mới không có gì đổi được trả 304 rỗng. Tra đúng một mã vé (Swagger) mới trả đủ
  // để xem máy chụp đang thấy gì. Xem theo khoảng ngày (cả tháng) trả tới BOOKING_RANGE_LIMIT đơn.
  const list = await Booking.find(q)
    .select(q.code ? "+accessToken +captureDiag" : `+accessToken ${LIST_OMIT}`)
    .sort({ createdAt: -1 })
    .limit(q.date?.$gte || q.date?.$lte ? BOOKING_RANGE_LIMIT : 500)
    .lean();
  // MongoDB returns one live print job and one photo ID per order. Use the
  // (booking, createdAt) print-job index to avoid transferring older jobs.
  const media = list.length ? await Booking.aggregate([
    { $match: { _id: { $in: list.map((booking) => booking._id) } } },
    { $project: { cover: { $cond: [
      { $or: [
        { $eq: ["$mediaDeleted", true] },
        { $ne: [{ $ifNull: ["$composite.file", ""] }, ""] },
      ] },
      null,
      { $first: { $filter: {
        input: { $ifNull: ["$photos", []] },
        as: "photo",
        cond: { $and: [
          { $eq: ["$$photo.kind", "original"] },
          { $ne: ["$$photo.deleted", true] },
          { $gte: ["$$photo._id", expiredPhotoIdBound(now)] },
        ] },
      } } },
    ] } } },
    { $lookup: {
      from: PrintJob.collection.name,
      localField: "_id",
      foreignField: "booking",
      pipeline: [
        { $match: livePrintFilter(now) },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
        { $project: {
          requestKey: 0, requestFingerprint: 0, spoolLeaseId: 0, spoolLeaseUntil: 0,
          "sheets.width": 0, "sheets.height": 0, "sheets._id": 0,
        } },
      ],
      as: "jobs",
    } },
    { $project: { coverPhotoId: "$cover._id", latestPrint: { $first: "$jobs" } } },
  ]) : [];
  const mediaByBooking = new Map(media.map((entry) => [String(entry._id), entry]));
  res.json(
    list.map((booking) => {
      const { latestPrint: job, coverPhotoId: photo } = mediaByBooking.get(String(booking._id)) || {};
      const visible = hideMoney(req, booking);
      const composite = booking.composite?.file && !booking.mediaDeleted && booking.accessToken
        ? `/api/albums/${booking.accessToken}/composite`
        : null;
      return {
        ...visible,
        latestPrint: job ? publicJob(job, booking.accessToken) : null,
        composite: composite ? { url: composite, frameName: booking.composite.frameName || "" } : null,
        coverPhoto: composite
          ? `${composite}?size=thumbnail`
          : photo && booking.accessToken
            ? `/api/albums/${booking.accessToken}/photos/${photo}?size=thumbnail`
            : null,
      };
    }),
  );
});
bookingsRouter.patch("/bookings/:id", async (req, res) => {
  const d = z
    .object({
      status: z
        .enum(["confirmed", "cancelled"])
        .optional(),
      printed: z.boolean().optional(),
      paymentReceived: z.boolean().optional(),
      // Lượt chụp phòng Selfbooth trả tiền ở quầy: nhân viên ghi nhận đã thu (tiền mặt / chuyển khoản).
      collected: z.enum(["cash", "transfer"]).optional(),
      // Khách đút dư tiền ở máy chụp (máy không trả tiền thừa): nhân viên đã thối lại phần dư.
      changeReturned: z.literal(true).optional(),
    })
    .parse(req.body);
  const b = await Booking.findById(id.parse(req.params.id));
  if (!b) fail(404, "Không tìm thấy vé.");
  requireBranch(req, b.branch);
  if (b.customerDataDeletedAt) fail(410, "Đơn đã hết hạn lưu lịch sử; số tiền vẫn được giữ trong báo cáo thu chi.");
  if (d.status === "cancelled" && !can(req, "orders:cancel"))
    fail(403, "Chỉ chủ cửa hàng hoặc nhân viên được cấp quyền hủy đơn mới hủy được mã chụp.");
  const allowed = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["cancelled"],
    checked_in: [],
    completed: [],
    cancelled: [],
  };
  if (d.status && !allowed[b.status].includes(d.status))
    fail(409, "Không thể chuyển trạng thái này.");
  if (d.status === "confirmed" && !d.paymentReceived)
    fail(400, "Vui lòng xác nhận đã nhận đủ tiền của khách.");
  if (d.status === "confirmed" && !b.code)
    fail(409, "Vui lòng kích hoạt mã tại quầy sau khi nhận tiền.");
  if (d.printed !== undefined && b.status !== "completed")
    fail(400, "Phiên chụp chưa hoàn tất.");
  if (d.collected && (b.paid || b.source !== "selfbooth" || !["checked_in", "completed"].includes(b.status)))
    fail(409, b.paid ? "Đơn này đã thu tiền." : "Chỉ ghi nhận thu tiền ở quầy cho lượt chụp phòng Selfbooth.");
  if (d.changeReturned && changeDue(b) <= 0)
    fail(409, "Đơn này không có tiền thừa cần thối lại.");
  if (d.changeReturned && b.changeReturnedAt)
    fail(409, "Đã ghi nhận thối tiền cho đơn này.");
  const { paymentReceived, collected, changeReturned, ...changes } = d;
  if (changeReturned) {
    changes.changeReturnedAt = new Date();
    changes.changeReturnedBy = req.user.name;
  }
  if (collected) {
    changes.paid = true;
    changes.paidAt = new Date();
    changes.paymentMethod = collected;
  }
  if (d.status === "confirmed") {
    changes.paid = true;
    changes.paidAt = new Date();
    changes.codeExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  }
  if (d.status === "cancelled") {
    changes.active = false;
    changes.paid = false;
  }
  const updated = await Booking.findOneAndUpdate(
    { _id: b._id, status: b.status, customerDataDeletedAt: null, ...(changeReturned && { changeReturnedAt: null }) },
    changes,
    { new: true },
  );
  if (!updated) fail(409, "Vé đã được cập nhật. Vui lòng tải lại.");
  res.json(hideMoney(req, updated.toObject()));
});
// Bán thêm tờ in tại quầy: cộng số tờ cho vé và cộng tiền vào doanh thu của vé.
bookingsRouter.post("/bookings/:id/prints", allow("print:operate"), async (req, res) => {
  const d = z
    .object({
      sheets: z.number().int().min(1).max(20),
      paymentMethod: z.enum(["cash", "transfer"]),
      paymentReceived: z.literal(true, {
        error: "Vui lòng xác nhận đã nhận đủ tiền của khách.",
      }),
      expectedTotal: z.number().int().nonnegative(),
      requestKey: z.uuid(),
    })
    .parse(req.body);
  const bookingId = id.parse(req.params.id);
  const target = await Booking.findById(bookingId).select("branch printSize").lean();
  if (!target) fail(404, "Không tìm thấy vé.");
  requireBranch(req, target.branch);
  const settings = (await Setting.findOne({ key: "studio" }).lean())?.value;
  const amount = d.sheets * (Number(extraPriceFor(target.printSize, settings)) || 0);
  if (d.expectedTotal !== amount)
    fail(409, "Giá in thêm vừa thay đổi. Vui lòng kiểm tra lại số tiền.");
  const updated = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      paid: true,
      status: { $in: ["confirmed", "checked_in", "completed"] },
      mediaDeleted: { $ne: true },
      extraPrintKeys: { $ne: d.requestKey },
    },
    [
      {
        $set: {
          prints: { $add: [{ $ifNull: ["$prints", 1] }, d.sheets] },
          extraPrints: { $add: [{ $ifNull: ["$extraPrints", 0] }, d.sheets] },
          requestedExtraPrints: {
            $max: [0, { $subtract: [{ $ifNull: ["$requestedExtraPrints", 0] }, d.sheets] }],
          },
          total: { $add: [{ $ifNull: ["$total", 0] }, amount] },
          extraSales: {
            $concatArrays: [
              { $ifNull: ["$extraSales", []] },
              [{ sheets: d.sheets, amount, paymentMethod: d.paymentMethod, at: "$$NOW" }],
            ],
          },
          extraPrintKeys: {
            $concatArrays: [
              { $ifNull: ["$extraPrintKeys", []] },
              [d.requestKey],
            ],
          },
        },
      },
    ],
    { new: true },
  );
  if (!updated) {
    // Bấm lại sau khi mất phản hồi: trả kết quả cũ, không cộng tiền lần nữa.
    const replay = await Booking.findOne({
      _id: bookingId,
      extraPrintKeys: d.requestKey,
    });
    if (replay)
      return res.json(
        hideMoney(req, { ...replay.toObject(), extraPrintKeys: undefined }),
      );
    fail(
      409,
      "Vé đã hủy, chưa thanh toán hoặc ảnh đã hết hạn — không bán thêm tờ in được.",
    );
  }
  res.json(
    hideMoney(req, { ...updated.toObject(), extraPrintKeys: undefined }),
  );
});

// Bảng phòng cho lễ tân: phòng nào trống, phòng nào đang chụp và còn bao lâu.
const MACHINE_LIVE_MS = 3 * 60 * 1000;
bookingsRouter.get("/rooms/live", async (req, res) => {
  const now = Date.now();
  const assigned = staffBranch(req);
  const [rooms, sessions] = await Promise.all([
    Room.find({ active: true, ...(assigned && { branch: assigned }) }).sort({ name: 1 }).select("name branch lastSeenAt").lean(),
    Booking.find({
      status: "checked_in",
      ...(assigned && { branch: assigned }),
      room: { $ne: null },
      $or: [
        { captureEndsAt: { $gt: new Date(now) } },
        {
          captureStartedAt: { $exists: false },
          captureSeenAt: { $gte: new Date(now - 10 * 60000) },
        },
      ],
    })
      .select("code name room captureStartedAt captureEndsAt captureSeenAt")
      .lean(),
  ]);
  res.json({
    now,
    rooms: rooms.map((room) => {
      const s = sessions.find((x) => String(x.room) === String(room._id));
      return {
        _id: room._id,
        name: room.name,
        branch: room.branch,
        status: !s ? "free" : s.captureEndsAt ? "shooting" : "starting",
        code: s?.code,
        customer: s?.name,
        startedAt: s?.captureStartedAt,
        endsAt: s?.captureEndsAt,
        online: Boolean(
          s?.captureSeenAt &&
          now - new Date(s.captureSeenAt).getTime() < KIOSK_LIVE_MS,
        ),
        // Máy chụp của phòng đang mở (báo còn sống mỗi phút) — lễ tân biết phòng nào dùng được.
        machine: Boolean(room.lastSeenAt && now - new Date(room.lastSeenAt).getTime() < MACHINE_LIVE_MS),
      };
    }),
  });
});
