import crypto from "node:crypto";
import Booking from "../models/Booking.js";
import RevenueEntry from "../models/RevenueEntry.js";
import { statsCache } from "./read-cache.js";

const FIELDS = ["date", "branch", "room", "roomName", "package", "packageName", "frameName",
  "source", "status", "paid", "total", "discount", "paymentMethod", "paidAt", "cashReceived",
  "printSize", "prints", "printSheets", "extraPrints", "createdAt", "requestKey"];
const PERSONAL_FIELDS = ["name", "phone", "accessToken", "captureSession", "captureDiag", "captureSeenAt",
  "captureStartedAt", "captureEndsAt", "captureMode", "captureDuration", "countdownSeconds",
  "selectCount", "shots", "nextPhotoNumber", "codeExpiresAt", "mediaExpiresAt", "requestedExtraPrints", "cashBills"];

export function revenueSnapshot(booking, now) {
  const value = { _id: booking._id };
  for (const key of FIELDS) if (booking[key] !== undefined) value[key] = booking[key];
  value.extraSales = (booking.extraSales || []).map(({ sheets, amount, paymentMethod, at }) => ({ sheets, amount, paymentMethod, at }));
  const snapshotHash = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { ...value, archivedAt: now, snapshotHash };
}

// Copy -> verify -> remove. If interrupted, either collection (or both) retains the sale.
// Reports deduplicate the overlap; retries use the same _id and never add another amount.
export async function archiveBookingRevenue(id, eligible, now) {
  let booking = await Booking.findOne({ ...eligible, _id: id }).select("+requestKey").lean();
  if (!booking) return false;
  if (!booking.customerDataDeletedAt) {
    booking = await Booking.findOneAndUpdate({ ...eligible, _id: id, updatedAt: booking.updatedAt }, {
      $set: { mediaDeleted: true, active: false, customerDataDeletedAt: now },
      $unset: Object.fromEntries(PERSONAL_FIELDS.map(key => [key, 1])),
    }, { new: true }).select("+requestKey").lean();
    if (!booking) return false;
  }
  const snapshot = revenueSnapshot(booking, now);
  const saved = await RevenueEntry.replaceOne({ _id: id }, snapshot, { upsert: true, writeConcern: { w: "majority" } });
  if (!saved.acknowledged) throw new Error("Chưa xác nhận lưu sổ tiền; giữ nguyên đơn cũ.");
  const verified = await RevenueEntry.findOne({ _id: id, snapshotHash: snapshot.snapshotHash }).select("_id").lean();
  if (!verified) throw new Error("Chưa kiểm tra được sổ tiền; giữ nguyên đơn cũ.");
  const removed = await Booking.deleteOne({ ...eligible, _id: id, updatedAt: booking.updatedAt,
    customerDataDeletedAt: { $ne: null } }, { writeConcern: { w: "majority" } });
  statsCache.clear();
  return removed.deletedCount === 1;
}

export function financialAggregate(stages) {
  const [match, ...rest] = stages;
  if (!match?.$match) throw new Error("Financial queries must start with a match filter.");
  return Booking.aggregate([
    match,
    { $unionWith: { coll: RevenueEntry.collection.name, pipeline: [match] } },
    { $group: { _id: "$_id", sale: { $first: "$$ROOT" } } },
    { $replaceWith: "$sale" },
    ...rest,
  ]);
}

export async function rejectArchivedSale(requestKey) {
  if (requestKey && await RevenueEntry.exists({ requestKey })) {
    const error = new Error("Giao dịch cũ đã lưu vào sổ tiền và hết hạn. Không tạo lại giao dịch này.");
    error.status = 410;
    throw error;
  }
}
