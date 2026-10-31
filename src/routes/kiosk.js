import { Router } from "express";
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import sharp from "sharp";
import { z } from "zod";
import { config } from "../config.js";
import { Booking, Room, Package, KioskAttempt, Setting } from "../models/index.js";
import { extraPriceFor, INSTAX_SHEETS, minSheets, piecesPerSheet, saleTotal } from "./print-count.js";
import { instaxState, readPrinterStatus } from "../services/printer-status.js";
import { appendCapture, finishCapture } from "../services/capture.js";
import { timed } from "../services/image-save-queue.js";
import { directUploadRequest, photoBody, readPhotoUpload, storedOriginal } from "./photo-upload.js";
import {
  createDirectUpload,
  createVideoUpload,
  directUploadsEnabled,
  MAX_VIDEO_BYTES,
  storedVideo,
  storedVideoSize,
} from "../services/direct-upload.js";
import { sensitive } from "../middleware/rate-limits.js";
import { deleteMedia, saveMedia } from "../services/media.js";
import { mediaReference } from "../services/r2.js";
import { fail, today, token } from "./validation.js";
import { publicBooking } from "./booking-helpers.js";
import {
  captureBooking,
  touchKiosk,
  touchKioskFast,
  kioskDiag,
} from "./kiosk-session.js";

export const kioskRouter = Router();

async function registerInvalidCode(deviceKey) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + 5 * 60 * 1000);
  const wasLocked = { $gt: ["$lockedUntil", now] };
  const lockExpired = { $and: [
    { $ne: [{ $ifNull: ["$lockedUntil", null] }, null] },
    { $lte: ["$lockedUntil", now] },
  ] };
  const update = [{ $set: {
    failures: { $cond: [wasLocked, "$failures", {
      $cond: [lockExpired, 1, { $add: [{ $ifNull: ["$failures", 0] }, 1] }],
    }] },
    lockedUntil: { $cond: [wasLocked, "$lockedUntil", {
      $cond: [lockExpired, null, {
        $cond: [{ $gte: [{ $ifNull: ["$failures", 0] }, 4] }, lockedUntil, null],
      }],
    }] },
  } }];
  try {
    return await KioskAttempt.findOneAndUpdate({ deviceKey }, update, { upsert: true, new: true });
  } catch (error) {
    // Concurrent first failures may race the unique deviceKey insert.
    if (error.code !== 11000) throw error;
    return KioskAttempt.findOneAndUpdate({ deviceKey }, update, { new: true });
  }
}

// Máy chụp đang mở báo về mỗi phút (kể cả lúc chưa có khách): Quản lý máy hiện Online / Offline
// và máy nhận chế độ lật ảnh quản trị đặt từ xa.
kioskRouter.post("/ping", async (req, res) => {
  const d = z.object({ device: z.string().max(2000) }).parse(req.body);
  let device;
  try {
    device = jwt.verify(d.device, config.secret);
  } catch {
    fail(403, "Máy chụp chưa được gán phòng hoặc liên kết đã hết hạn.");
  }
  if (device.type !== "kiosk" || !mongoose.isObjectIdOrHexString(String(device.room)))
    fail(403, "Thiết bị không hợp lệ.");
  // Ghi thẳng collection: báo "còn mở" không làm mới bộ nhớ đệm danh mục.
  const room = await Room.collection.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(String(device.room)), active: true },
    { $set: { lastSeenAt: new Date() } },
    { returnDocument: "after", projection: { name: 1, branch: 1, flip: 1, kind: 1, paymentTest: 1 } },
  );
  if (!room) fail(403, "Phòng chụp đã ngừng hoạt động.");
  const printers = await readPrinterStatus(room.branch);
  res.json({ room: {
    _id: room._id, name: room.name, branch: room.branch, flip: room.flip || "device",
    kind: room.kind || "photobooth", paymentTest: Boolean(room.paymentTest),
    // Phòng photobooth: máy chụp bán lượt tại máy bằng tiền mặt (bên cạnh nhập mã).
    cashCheckoutReady: (room.kind || "photobooth") === "photobooth",
    // Máy in Instax cạnh máy chụp: khổ Instax chỉ mở khi máy in sẵn sàng và đủ phim.
    printers: { instax: instaxState(printers) },
  } });
});

async function deviceRoom(token) {
  let device;
  try {
    device = jwt.verify(token, config.secret);
  } catch {
    fail(403, "Máy chụp chưa được gán phòng hoặc liên kết đã hết hạn.");
  }
  if (device.type !== "kiosk") fail(403, "Thiết bị không hợp lệ.");
  const room = await Room.findOne({ _id: device.room, active: true });
  if (!room) fail(403, "Phòng chụp đã ngừng hoạt động.");
  return room;
}

// Khách tự mua lượt chụp tại máy: chọn gói, số tờ in, đút tiền vào máy nhận tiền (máy chụp gửi
// từng tờ đã nhận) rồi vào chụp luôn — không cần mã ở quầy. Chế độ thử (paymentTest) cho bỏ qua
// bước trả tiền để thử máy khi chưa lắp máy nhận tiền: vé thử không tính doanh thu.
kioskRouter.post("/sale", sensitive(), async (req, res) => {
  const d = z.object({
    device: z.string().max(2000),
    package: z.string().regex(/^[a-f\d]{24}$/i),
    requestKey: z.uuid(),
    skip: z.boolean().default(false),
    bills: z.array(z.object({
      amount: z.number().int().min(1000).max(10_000_000),
      at: z.string().datetime().optional(),
    })).max(100).default([]),
    // Số tờ 10 × 15 khách chọn (khổ nhỏ: 1 tờ cắt đôi = 2 tờ nhỏ); không gửi = mức tối thiểu của gói.
    prints: z.number().int().min(0).max(60).optional(),
    // Tổng tiền máy chụp đang hiển thị: khác giá máy chủ (vừa đổi giá) thì báo để khách gọi nhân viên.
    expectedTotal: z.number().int().nonnegative().optional(),
  }).parse(req.body);
  const room = await deviceRoom(d.device);
  // Gửi lại sau khi mất phản hồi: trả đúng lượt chụp đã tạo, không thu tiền lần nữa.
  const existing = await Booking.findOne({ requestKey: d.requestKey }).select("+accessToken +captureSession");
  if (existing) {
    if (String(existing.room) !== String(room._id)) fail(409, "Mã giao dịch đã dùng ở máy khác.");
    if (!existing.captureSession) fail(409, "Lượt chụp này đã kết thúc.");
    return res.json(saleSession(existing, room, existing.captureSession));
  }
  if (room.kind === "polaroid")
    fail(403, "Phòng Polaroid không thu tiền tại máy — khách chọn layout rồi trả tiền ở quầy.");
  if (d.skip && !room.paymentTest)
    fail(403, "Phòng chưa bật chế độ thử (bỏ qua đút tiền). Bật ở Quản trị → Quản lý máy.");
  const pack = await Package.findOne({ _id: d.package, active: true });
  if (!pack) fail(400, "Gói chụp không còn hoạt động.");
  if (pack.branches?.length && !pack.branches.includes(room.branch))
    fail(400, `Gói “${pack.name}” không áp dụng tại chi nhánh ${room.branch}.`);
  if (pack.printSize === "instax")
    fail(400, "Gói Instax là layout của phòng Polaroid, không bán ở phòng photobooth.");
  const least = minSheets(pack);
  const sheets = d.prints ?? least;
  if (sheets < least)
    fail(400, `Gói “${pack.name}” in tối thiểu ${least * piecesPerSheet(pack.printSize)} tờ.`);
  if (sheets - least > 20) fail(400, "Mỗi lượt in thêm tối đa 20 tờ.");
  let extraPrintPrice = 0;
  if (sheets > (Number(pack.prints) || 0)) {
    extraPrintPrice = extraPriceFor(pack.printSize, (await Setting.findOne({ key: "studio" }).lean())?.value);
    if (extraPrintPrice === undefined && sheets > least)
      fail(400, "Chưa đặt giá in thêm — nhờ nhân viên đặt ở Quản trị → Khổ ảnh & bảng giá.");
  }
  const total = saleTotal(pack, sheets, extraPrintPrice);
  const received = d.bills.reduce((sum, bill) => sum + bill.amount, 0);
  if (!d.skip && received < total)
    fail(
      d.expectedTotal !== undefined && d.expectedTotal !== total ? 409 : 400,
      `Chưa đủ tiền: đã nhận ${received.toLocaleString("vi-VN")} đ, cần ${total.toLocaleString("vi-VN")} đ.` +
        (d.expectedTotal !== undefined && d.expectedTotal !== total ? " Giá vừa thay đổi — nhờ nhân viên hỗ trợ." : ""),
    );
  const sessionId = token();
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const b = await Booking.create({
        code: String(crypto.randomInt(100000, 1000000)),
        accessToken: token(),
        name: d.skip ? "Thử máy (bỏ qua trả tiền)" : "Khách tự phục vụ",
        branch: room.branch,
        room: room._id,
        roomName: room.name,
        package: pack._id,
        packageName: pack.name,
        shots: pack.shots,
        countdownSeconds: pack.countdownSeconds || 10,
        selectCount: pack.selectCount || 4,
        printSize: pack.printSize || "full",
        captureDuration: pack.duration,
        prints: sheets,
        total: d.skip ? 0 : total,
        discount: 0,
        source: "kiosk",
        date: today(),
        time: "",
        // Vé thử: không tính là đã thu tiền (không vào doanh thu / đối soát).
        paid: !d.skip,
        ...(!d.skip && { paidAt: now }),
        paymentMethod: d.skip ? "test" : "cash",
        cashReceived: received,
        cashBills: d.bills.map((bill) => ({ amount: bill.amount, at: bill.at ? new Date(bill.at) : now })),
        status: "checked_in",
        captureSession: sessionId,
        captureSeenAt: now,
        requestKey: d.requestKey,
      });
      return res.status(201).json(saleSession(b, room, sessionId));
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.code) continue;
      if (error.code === 11000 && error.keyPattern?.requestKey) {
        const replay = await Booking.findOne({ requestKey: d.requestKey }).select("+accessToken +captureSession");
        if (replay) return res.json(saleSession(replay, room, replay.captureSession));
      }
      throw error;
    }
  }
  fail(503, "Không tạo được lượt chụp. Vui lòng thử lại.");
});
// Phòng Polaroid: khách chọn layout (gói khổ Instax) rồi vào chụp luôn, trả tiền ở quầy. Lượt chụp
// ghi là chưa thu tiền; nhân viên bấm "Đã thu tiền" ở Đơn hàng khi khách trả.
kioskRouter.post("/polaroid", sensitive(), async (req, res) => {
  const d = z.object({
    device: z.string().max(2000),
    package: z.string().regex(/^[a-f\d]{24}$/i),
    requestKey: z.uuid(),
  }).parse(req.body);
  const room = await deviceRoom(d.device);
  const existing = await Booking.findOne({ requestKey: d.requestKey }).select("+accessToken +captureSession");
  if (existing) {
    if (String(existing.room) !== String(room._id)) fail(409, "Mã giao dịch đã dùng ở máy khác.");
    if (!existing.captureSession) fail(409, "Lượt chụp này đã kết thúc.");
    return res.json(saleSession(existing, room, existing.captureSession));
  }
  if (room.kind !== "polaroid")
    fail(403, "Đây là phòng photobooth — khách chọn Nhập mã hoặc Tiền mặt. Đổi loại phòng ở Quản trị → Quản lý máy.");
  const pack = await Package.findOne({ _id: d.package, active: true });
  if (!pack || pack.printSize !== "instax") fail(400, "Layout không còn hoạt động.");
  if (pack.branches?.length && !pack.branches.includes(room.branch))
    fail(400, `Layout “${pack.name}” không áp dụng tại chi nhánh ${room.branch}.`);
  const sessionId = token();
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const b = await Booking.create({
        code: String(crypto.randomInt(100000, 1000000)),
        accessToken: token(),
        name: "Khách Polaroid",
        branch: room.branch,
        room: room._id,
        roomName: room.name,
        package: pack._id,
        packageName: pack.name,
        // Không ghi số lần chụp: khách bấm dây không giới hạn trong thời gian chụp. Layout in đúng
        // 1 tấm Instax (gói cũ ghi 2 tấm cũng chỉ in 1).
        countdownSeconds: pack.countdownSeconds || 10,
        selectCount: pack.selectCount || 4,
        printSize: "instax",
        captureDuration: pack.duration,
        prints: INSTAX_SHEETS,
        total: Number(pack.price) || 0,
        discount: 0,
        source: "polaroid",
        date: today(),
        time: "",
        // Trả tiền ở quầy: chưa tính là đã thu cho tới khi nhân viên xác nhận.
        paid: false,
        status: "checked_in",
        captureSession: sessionId,
        captureSeenAt: now,
        requestKey: d.requestKey,
      });
      return res.status(201).json(saleSession(b, room, sessionId));
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.code) continue;
      if (error.code === 11000 && error.keyPattern?.requestKey) {
        const replay = await Booking.findOne({ requestKey: d.requestKey }).select("+accessToken +captureSession");
        if (replay) return res.json(saleSession(replay, room, replay.captureSession));
      }
      throw error;
    }
  }
  fail(503, "Không tạo được lượt chụp. Vui lòng thử lại.");
});
const saleSession = (b, room, sessionId) => ({
  flip: room.flip || "device",
  booking: publicBooking(b),
  accessToken: b.accessToken,
  captureToken: jwt.sign(
    { type: "capture", booking: String(b._id), sessionId },
    config.secret,
    { expiresIn: "2h" },
  ),
});

kioskRouter.post("/claim", sensitive(), async (req, res) => {
  const d = z
    .object({
      code: z.string().regex(/^\d{6}$/, "Mã vé gồm 6 chữ số."),
      device: z.string({ error: "Máy chụp chưa được gán phòng." }),
    })
    .parse(req.body);
  let device;
  try {
    device = jwt.verify(d.device, config.secret);
  } catch {
    fail(403, "Máy chụp chưa được gán phòng hoặc liên kết đã hết hạn.");
  }
  if (device.type !== "kiosk") fail(403, "Thiết bị không hợp lệ.");
  const room = await Room.findOne({ _id: device.room, active: true });
  if (!room) fail(403, "Phòng chụp đã ngừng hoạt động.");
  const deviceKey = crypto.createHash("sha256").update(d.device).digest("hex");
  const attempts = await KioskAttempt.findOne({ deviceKey });
  if (attempts?.lockedUntil > new Date()) {
    const seconds = Math.ceil((attempts.lockedUntil.getTime() - Date.now()) / 1000);
    res.set("Retry-After", String(seconds));
    fail(429, `Nhập sai 5 lần. Vui lòng chờ ${Math.ceil(seconds / 60)} phút rồi thử lại.`);
  }
  const validCode = {
    code: d.code,
    paid: true,
    status: "confirmed",
    branch: room.branch,
    $or: [
      { codeExpiresAt: { $gt: new Date() } },
      { codeExpiresAt: { $exists: false }, createdAt: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
    ],
  };
  const sessionId = token();
  // Claim the paid ticket atomically. The ticket alone determines the package and print quota.
  const b = await Booking.findOneAndUpdate(
    validCode,
    [{ $set: {
      status: "checked_in",
      room: room._id,
      roomName: { $literal: room.name },
      captureSession: { $literal: sessionId },
      captureSeenAt: "$$NOW",
    } }],
    { new: true },
  ).select("+accessToken");
  if (!b) {
    const other = await Booking.findOne({ code: d.code, paid: true });
    if (other && ["checked_in", "completed"].includes(other.status))
      fail(409, "Mã chụp đã được sử dụng. Nhờ nhân viên mở lại đường dẫn ảnh nếu cần.");
    const failed = await registerInvalidCode(deviceKey);
    if (failed.lockedUntil > new Date()) {
      res.set("Retry-After", String(Math.ceil((failed.lockedUntil - Date.now()) / 1000)));
      fail(429, "Nhập sai 5 lần. Máy chụp tạm khóa 5 phút.");
    }
    fail(
      400,
      "Mã chụp không đúng, chưa thanh toán hoặc đã hết hạn 2 giờ.",
    );
  }
  await KioskAttempt.deleteOne({ deviceKey });
  res.json({
    flip: room.flip || "device",
    booking: publicBooking(b),
    accessToken: b.accessToken,
    captureToken: jwt.sign(
      { type: "capture", booking: String(b._id), sessionId },
      config.secret,
      { expiresIn: "2h" },
    ),
  });
});

// Khách chỉ chụp bằng nút chụp / remote của máy ảnh: ảnh gốc về thư mục X Acquire trên máy
// chụp, máy chụp đọc thư mục rồi gửi lên (không có nút chụp trên màn hình).
kioskRouter.post("/start", async (req, res) => {
  const d = z.object({ captureToken: z.string() }).parse(req.body);
  const { b, payload } = await captureBooking(d.captureToken);
  if (!b.captureStartedAt && b.status === "checked_in") {
    // Older tickets have no snapshot; only those fall back to the current package.
    if (!b.captureDuration) {
      const pack = await Package.findById(b.package);
      b.captureDuration = pack?.duration || 10;
    }
    b.captureStartedAt = new Date();
    b.captureEndsAt = new Date(Date.now() + b.captureDuration * 60000);
    b.captureMode = "folder";
    b.captureSession = payload.sessionId;
    b.captureSeenAt = new Date();
    await b.save();
  } else await touchKiosk(b);
  res.json({ booking: publicBooking(b) });
});
kioskRouter.post("/state", async (req, res) => {
  const captureToken = z.string().parse(req.body.captureToken);
  const diag = kioskDiag.parse(req.body.diag);
  const live = await touchKioskFast(captureToken, diag);
  if (live) return res.json({ booking: publicBooking(live) });
  const { b } = await captureBooking(captureToken);
  await touchKiosk(b, diag);
  res.json({ booking: publicBooking(b) });
});
// The camera original goes straight to storage (direct-upload.js): a URL for one photo.
kioskRouter.post("/photo/upload-url", async (req, res) => {
  const d = directUploadRequest(true).parse(req.body);
  if (!directUploadsEnabled()) fail(404, "Kho ảnh chưa hỗ trợ tải thẳng.");
  const { b } = await captureBooking(d.captureToken, { authOnly: true, photoKey: d.clientKey });
  // Already saved (a lost reply): hand back the session instead of a second upload.
  if (b.photos?.length) return res.json({ saved: true, booking: publicBooking(await Booking.findById(b._id)) });
  if (b.status !== "checked_in" || !b.captureEndsAt || new Date(b.captureEndsAt) <= new Date())
    fail(409, "Phiên chụp đã kết thúc.");
  res.json({ upload: await createDirectUpload(b._id, d.clientKey, d.size) });
});
kioskRouter.post("/photo", photoBody, async (req, res) => {
  const d = readPhotoUpload(req, { capture: true });
  // appendCapture re-reads the booking under its write lock. Authorization
  // needs only the session/status, so avoid fetching all photos twice.
  const { b } = await captureBooking(d.captureToken, { authOnly: true, photoKey: d.clientKey });
  res.json(
    publicBooking(
      await timed(res, "save", appendCapture(b._id, d.buffer, {
        clientKey: d.clientKey,
        mirrored: d.mirrored,
        precheck: b,
        preview: d.preview,
        storedOriginal: storedOriginal(b._id, d),
      })),
    ),
  );
});
// Video tua nhanh của lượt chụp (máy chụp ghép từ hình trực tiếp, đã lật gương): gửi một lần
// sau khi chụp xong, gửi lại thì thay video cũ.
async function attachVideo(bookingId, file, mimeType, size) {
  const old = await Booking.findOneAndUpdate(
    { _id: bookingId },
    { $set: { video: { file, mimeType, size } } },
  ).select("video");
  if (old?.video?.file && old.video.file !== file) await deleteMedia([old.video.file]).catch(() => {});
}
// Kho R2: máy chụp gửi video thẳng lên kho — xin URL tải lên cho đúng một video (loại, kích thước)…
kioskRouter.post("/video/upload-url", async (req, res) => {
  const d = z.object({
    captureToken: z.string(),
    type: z.enum(["video/mp4", "video/webm"]),
    size: z.number().int().positive().max(MAX_VIDEO_BYTES),
  }).parse(req.body);
  if (!directUploadsEnabled()) fail(404, "Kho ảnh chưa hỗ trợ tải thẳng.");
  const { b } = await captureBooking(d.captureToken, { authOnly: true });
  res.json({ upload: await createVideoUpload(b._id, d.type, d.size) });
});
// … tải lên rồi báo xong: máy chủ chỉ kiểm tra tệp trên kho và gắn vào album. Không dùng được (422)
// thì máy chụp gửi video qua máy chủ (route dưới).
kioskRouter.post("/video/commit", async (req, res) => {
  const d = z.object({ captureToken: z.string(), stored: z.string().max(200) }).parse(req.body);
  const { b } = await captureBooking(d.captureToken, { authOnly: true });
  const video = storedVideo(b._id, d.stored);
  if (!video) fail(422, "Video tải thẳng lên kho không khớp phiên chụp. Máy chụp sẽ gửi lại qua máy chủ.");
  const size = await storedVideoSize(video.file);
  await attachVideo(b._id, video.file, video.mimeType, size);
  res.status(201).json({ ok: true, size });
});
// Qua máy chủ: kho MongoDB (GridFS), hoặc trang máy chụp chưa tải thẳng lên R2 được.
const videoBody = express.raw({ type: ["video/webm", "video/mp4"], limit: "60mb", inflate: false });
kioskRouter.post("/video", videoBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, "Video trống.");
  const { b } = await captureBooking(z.string().parse(req.get("X-Capture-Token")), { authOnly: true });
  const mimeType = req.is("video/mp4") ? "video/mp4" : "video/webm";
  const file = mediaReference(`${crypto.randomUUID()}.${mimeType === "video/mp4" ? "mp4" : "webm"}`);
  await saveMedia(file, req.body, mimeType);
  await attachVideo(b._id, file, mimeType, req.body.length);
  res.status(201).json({ ok: true, size: req.body.length });
});
// Ảnh đã ghép khung của lượt chụp (máy chụp ghép bản chất lượng in sau khi khách chọn khung): gửi
// một lần, gửi lại thì thay ảnh cũ. Kèm bản xem nhanh 720 px cho album.
const compositeBody = express.raw({ type: ["image/jpeg"], limit: "20mb", inflate: false });
kioskRouter.post("/composite", compositeBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, "Ảnh ghép trống.");
  const { b } = await captureBooking(z.string().parse(req.get("X-Capture-Token")), { authOnly: true });
  let frameName = "";
  try {
    frameName = decodeURIComponent(req.get("X-Frame-Name") || "").trim().slice(0, 200);
  } catch {
    frameName = "";
  }
  const meta = await sharp(req.body, { limitInputPixels: 40_000_000 }).metadata().catch(() => null);
  if (meta?.format !== "jpeg" || !meta.width || !meta.height || Math.max(meta.width, meta.height) > 6000)
    fail(400, "Ảnh ghép phải là JPEG (tối đa 6000 px).");
  const thumbnail = await sharp(req.body)
    .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
  const name = crypto.randomUUID();
  const file = mediaReference(`${name}.jpg`);
  const thumbnailFile = mediaReference(`${name}.thumb.jpg`);
  await Promise.all([
    saveMedia(file, req.body, "image/jpeg"),
    saveMedia(thumbnailFile, thumbnail, "image/jpeg"),
  ]);
  const old = await Booking.findOneAndUpdate(
    { _id: b._id },
    {
      $set: {
        composite: { file, thumbnailFile, frameName, width: meta.width, height: meta.height },
        // Xếp hạng chủ đề ở Tổng quan tính cả lượt không in.
        ...(frameName && { frameName }),
      },
    },
  ).select("composite");
  const stale = [old?.composite?.file, old?.composite?.thumbnailFile].filter((f) => f && f !== file && f !== thumbnailFile);
  if (stale.length) await deleteMedia(stale).catch(() => {});
  res.status(201).json({ ok: true, width: meta.width, height: meta.height });
});
kioskRouter.post("/finish", async (req, res) => {
  const { b } = await captureBooking(z.string().parse(req.body.captureToken));
  if (b.status === "completed") return res.json(publicBooking(b));
  res.json(publicBooking(await finishCapture(b._id)));
});
