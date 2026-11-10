import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { Booking } from "../models/index.js";
import { fail } from "./validation.js";

// Máy chụp gửi trạng thái 2 giây/lần; im lặng quá 20 giây coi như đã tắt.
export const KIOSK_LIVE_MS = 20000;
export const touchKiosk = (b, diag) =>
  Booking.updateOne(
    { _id: b._id, status: "checked_in" },
    {
      $set: {
        captureSeenAt: new Date(),
        ...(diag && { captureDiag: { ...diag, at: new Date() } }),
      },
    },
  );
// Tình trạng máy chụp (chế độ, camera, thư mục ảnh máy ảnh): sai định dạng thì bỏ qua.
const diagCount = z.number().int().min(0).max(1e7).optional();
const diagText = (max) => z.string().max(max).optional();
export const kioskDiag = z
  .object({
    mode: diagText(20),
    camera: diagText(160),
    cameras: diagText(300),
    cameraError: diagText(300),
    folder: diagText(200),
    access: diagText(20),
    jpegs: diagCount,
    raws: diagCount,
    fresh: diagCount,
    imported: diagCount,
    scans: diagCount,
    newest: diagText(260),
    newestAt: z.number().optional(),
    error: diagText(400),
  })
  .optional()
  .catch(undefined);

// Live self-booth: append each photo independently; package duration controls the session.
// Heartbeat in ONE database round trip (every 2 s per booth): record "still alive" for a valid
// open session and get the booking back. Anything else (ended, replaced session, bad token)
// returns null and the caller falls back to captureBooking for the exact answer.
export async function touchKioskFast(captureToken, diag) {
  let payload;
  try {
    payload = jwt.verify(captureToken, config.secret);
  } catch {
    return null;
  }
  if (payload.type !== "capture" || !/^[a-f\d]{24}$/i.test(String(payload.booking))) return null;
  return Booking.findOneAndUpdate(
    {
      _id: payload.booking,
      status: "checked_in",
      captureSession: { $in: [null, payload.sessionId] },
    },
    { $set: { captureSeenAt: new Date(), ...(diag && { captureDiag: { ...diag, at: new Date() } }) } },
    { new: true, lean: true },
  );
}
// photoKey: also load what a photo save checks (end time, whether this photo is already saved),
// so the save does not need another database round trip.
export async function captureBooking(captureToken, { authOnly = false, photoKey } = {}) {
  let payload;
  try {
    payload = jwt.verify(captureToken, config.secret);
  } catch {
    fail(401, "Phiên chụp đã hết hạn.");
  }
  if (payload.type !== "capture") fail(403, "Phiên chụp không hợp lệ.");
  const b = await Booking.findById(payload.booking)
    .select(photoKey !== undefined
      ? { status: 1, captureEndsAt: 1, captureSession: 1, photos: { $elemMatch: { clientKey: photoKey } } }
      : authOnly ? "status +captureSession" : "+captureSession")
    .lean(authOnly);
  if (!b || !["checked_in", "completed"].includes(b.status))
    fail(409, "Phiên chụp không còn hợp lệ.");
  if (b.captureSession && b.captureSession !== payload.sessionId)
    fail(409, "Mã vé này vừa được mở ở máy chụp khác.");
  return { b, payload };
}
