import express, { Router } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../../config.js";
import { Room } from "../../models/index.js";
import { allow, auth, isAdmin, requireBranch } from "../../middleware/auth.js";
import { fail, id } from "../validation.js";
import { ticketsRouter } from "./tickets.js";
import { printsRouter } from "./prints.js";
import { bookingsRouter } from "./bookings.js";
import { bookingPrintsRouter } from "./booking-prints.js";
import { statsRouter } from "./stats.js";
import { settingsRouter } from "./settings.js";
import { resourcesRouter } from "./resources.js";
import { selfboothFramesRouter } from "./selfbooth-frames.js";
import { storageRouter } from "./storage.js";
import { studioRouter } from "./studio.js";

export const adminRouter = Router();

// Các route cấp mã tự kiểm tra đăng nhập trước khi áp dụng giới hạn cấp mã.
adminRouter.use("/tickets", ticketsRouter);
adminRouter.use(auth);
// Body quản trị (tới 16 MB: ảnh khung, màn hình chờ, QR chuyển khoản dạng base64) — chỉ đọc sau khi
// đã đăng nhập (xem middleware/security.js).
adminRouter.use(express.json({ limit: "16mb", inflate: false }));
adminRouter.use("/print-jobs", printsRouter);
adminRouter.use(bookingsRouter);
adminRouter.use(bookingPrintsRouter);
adminRouter.use("/stats", statsRouter);
adminRouter.use("/storage", storageRouter);

// Cài máy chụp: cấp liên kết + QR mở máy chụp của phòng. Loại phòng (Photobooth / Polaroid) chọn lúc
// quản trị thêm phòng và không đổi ở đây; phòng Photobooth bật / tắt chế độ thử đút tiền (paymentTest)
// — chỉ quản trị viên, vì lượt chụp thử không thu tiền. Không gửi paymentTest thì giữ nguyên.
const deviceSetup = z.object({ paymentTest: z.boolean().optional() });
adminRouter.post("/rooms/:id/device", allow("rooms:setup"), async (req, res) => {
  const room = await Room.findById(id.parse(req.params.id));
  if (!room) fail(404, "Không tìm thấy phòng.");
  if (!room.active) fail(409, "Phòng chụp đã ngừng hoạt động.");
  requireBranch(req, room.branch);
  const d = deviceSetup.parse(req.body || {});
  if (d.paymentTest !== undefined) {
    // Chế độ thử (nút giả lập đút tiền) chỉ có ở phòng photobooth (phòng Polaroid không thu tiền).
    const paymentTest = (room.kind || "photobooth") === "photobooth" && d.paymentTest;
    if (Boolean(room.paymentTest) !== paymentTest) {
      if (!isAdmin(req)) fail(403, "Chỉ quản trị viên được bật / tắt chế độ thử tiền mặt.");
      await Room.updateOne({ _id: room._id }, { paymentTest });
    }
    room.paymentTest = paymentTest;
  }
  const kind = room.kind || "photobooth";
  res.json({
    kind,
    paymentTest: kind === "photobooth" && Boolean(room.paymentTest),
    token: jwt.sign({ type: "kiosk", room: String(room._id), jti: crypto.randomUUID() }, config.secret, {
      // Máy chụp nhớ liên kết sau lần mở đầu; 1 năm để tiệm không phải cài lại hằng tháng.
      expiresIn: "365d",
    }),
    name: room.name,
  });
});
// Cài máy in DNP của một phòng: mã cho chương trình in trên máy tính cắm máy in (phòng Photobooth: DS-RX1
// trên mini PC của phòng; phòng Polaroid / Selfbooth từ 14/11: DS820 in tờ 20 × 30). Mã chỉ nhận lệnh in
// của đúng phòng này (routes/print-agent.js).
adminRouter.post("/rooms/:id/printer", allow("rooms:setup"), async (req, res) => {
  const room = await Room.findById(id.parse(req.params.id));
  if (!room) fail(404, "Không tìm thấy phòng.");
  if (!room.active) fail(409, "Phòng chụp đã ngừng hoạt động.");
  requireBranch(req, room.branch);
  res.json({
    name: room.name,
    branch: room.branch,
    kind: room.kind || "photobooth",
    token: jwt.sign(
      { type: "print-agent", room: String(room._id), branch: room.branch, jti: crypto.randomUUID() },
      config.secret,
      // Như liên kết máy chụp: 1 năm, tải lại file cài khi hết hạn.
      { expiresIn: "365d" },
    ),
  });
});
adminRouter.use("/settings", settingsRouter);
adminRouter.use(studioRouter);
adminRouter.use("/selfbooth-frames", selfboothFramesRouter);
adminRouter.use(resourcesRouter);
