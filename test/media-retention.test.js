import "./environment.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { Booking, PrintJob, RevenueEntry } from "../src/models/index.js";
import { MEDIA_TTL_MS, photoExpiry, purgeExpiredMedia, readMedia, saveMedia } from "../src/services/media.js";
import { getMonthRevenue, getRevenueSeries, getSummary } from "../src/services/stats.js";
import { statsCache } from "../src/services/read-cache.js";
import { getStorageSummary } from "../src/services/media-storage.js";
import { visibleBookingHistory } from "../src/services/booking-history.js";
import { archiveBookingRevenue, financialAggregate, rejectArchivedSale } from "../src/services/revenue-ledger.js";
import { expiredBookingHistory } from "../src/services/booking-history.js";

let memory;
const hour = 3_600_000;
const photoId = (at) => mongoose.Types.ObjectId.createFromTime(Math.floor(at / 1000));
const oldBooking = (now, patch = {}) => ({
  code: randomUUID(), accessToken: randomUUID(), name: "Khách cũ", phone: "0912345678",
  createdAt: new Date(now - MEDIA_TTL_MS - hour),
  captureEndsAt: new Date(now - MEDIA_TTL_MS - 60000), status: "completed",
  date: new Date(now - MEDIA_TTL_MS - hour).toISOString().slice(0, 10),
  paid: true, total: 90000, discount: 10000, paidAt: new Date(now - MEDIA_TTL_MS - hour),
  paymentMethod: "cash", branch: "Test", roomName: "Phòng 1", packageName: "Gói 70K", frameName: "Hồng",
  prints: 2, printSheets: 2, extraPrints: 1,
  cashReceived: 100000, cashBills: [{ amount: 100000, at: new Date(now - MEDIA_TTL_MS - hour) }],
  extraSales: [{ sheets: 1, amount: 20000, paymentMethod: "transfer", at: new Date(now - MEDIA_TTL_MS - hour) }],
  requestKey: randomUUID(), requestFingerprint: "sale-hash", extraPrintKeys: ["extra-sale-key"],
  captureSession: "session", captureDiag: { path: "camera-folder", error: "old diagnostic" },
  ...patch,
});
before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all([Booking.init(), PrintJob.init(), RevenueEntry.init()]);
});
beforeEach(async () => {
  await Promise.all([Booking.deleteMany({}), PrintJob.deleteMany({}), RevenueEntry.deleteMany({}),
    mongoose.connection.db.collection("media.files").deleteMany({}),
    mongoose.connection.db.collection("media.chunks").deleteMany({})]);
  statsCache.clear();
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });

test("72-hour retention deletes every media variant and customer data while all revenue reports stay identical", async () => {
  assert.equal(MEDIA_TTL_MS, 72 * hour);
  const now = Date.now();
  const taken = now - MEDIA_TTL_MS + 60000;
  const names = ["file", "originalFile", "thumbnailFile", "previewFile", "printFile", "downloadFile"];
  const photo = { _id: photoId(taken), kind: "original" };
  for (const key of names) photo[key] = `${key}.jpg`;
  const files = [...names.map((key) => photo[key]), "video.mp4", "composite.jpg", "composite.thumb.jpg", "composite.preview.jpg", "sheet.png"];
  for (const file of files) await saveMedia(file, Buffer.from(file), "application/octet-stream");
  const b = await Booking.create(oldBooking(now, { photos: [photo],
    captureEndsAt: new Date(taken), video: { file: "video.mp4" },
    composite: { file: "composite.jpg", thumbnailFile: "composite.thumb.jpg", previewFile: "composite.preview.jpg" },
  }));
  await PrintJob.create({ booking: b._id, file: "sheet.png", sheets: [{ file: "sheet.png" }], createdAt: new Date(taken) });
  const reports = async () => {
    statsCache.clear();
    return Promise.all([getSummary({ from: b.date, to: b.date }), getMonthRevenue(b.date.slice(0, 7)),
      getRevenueSeries({ from: b.date, to: b.date })]);
  };
  const beforeReports = await reports();
  assert.equal(beforeReports[0].revenue, 90000);
  assert.deepEqual([beforeReports[0].cash, beforeReports[0].transfer], [70000, 20000]);
  assert.equal(photoExpiry(photo).getTime(), photo._id.getTimestamp().getTime() + 72 * hour);
  await purgeExpiredMedia(new Date(now));
  assert.ok(await readMedia("originalFile.jpg"), "a photo at 71h59m is kept");
  assert.equal((await Booking.findById(b._id)).name, "Khách cũ");
  assert.equal(await PrintJob.countDocuments(), 1);
  const expiredAt = new Date(now + 61000);
  assert.equal(await purgeExpiredMedia(expiredAt), 1);
  for (const file of files) assert.equal(await readMedia(file), null, `${file} removed`);
  assert.equal(await PrintJob.countDocuments(), 0);
  assert.equal(await Booking.findById(b._id), null, "the booking document is physically removed");
  const after = await RevenueEntry.findById(b._id).select("+requestKey").lean();
  for (const key of ["name", "phone", "accessToken", "captureSession", "captureDiag", "captureEndsAt", "video", "composite", "mediaExpiresAt"])
    assert.equal(after[key], undefined, `${key} removed`);
  assert.equal(after.photos, undefined);
  assert.equal(after.archivedAt.getTime(), expiredAt.getTime());
  assert.equal(after.active, undefined);
  assert.equal(after.requestKey, b.requestKey, "sale retry cannot create another charge");
  assert.equal(after.extraPrintKeys, undefined);
  assert.equal(after.cashBills?.length || 0, 0, "individual bill events are removed");
  assert.equal(after.cashReceived, 100000, "cash total is retained");
  assert.equal(await Booking.countDocuments(visibleBookingHistory(expiredAt, MEDIA_TTL_MS)), 0);
  assert.deepEqual(await reports(), beforeReports);
  await assert.rejects(rejectArchivedSale(b.requestKey), { status: 410 });
  await request(app).get(`/api/albums/${b.accessToken}`).expect(404);
  assert.equal(await purgeExpiredMedia(expiredAt), 0, "second pass is idempotent");
});

test("only expired finished customers are pruned; active, future scheduled and recent cancelled tickets stay", async () => {
  const now = Date.now();
  const finished = await Booking.create(oldBooking(now, { photos: [] }));
  const protectedRows = await Booking.create([
    oldBooking(now, { status: "checked_in" }),
    oldBooking(now, { status: "confirmed", source: "scheduled", date: "2099-01-01" }),
    oldBooking(now, { captureEndsAt: new Date(now - hour) }),
    oldBooking(now, { status: "cancelled", createdAt: new Date(now - hour) }),
  ]);
  await purgeExpiredMedia(new Date(now));
  assert.equal(await Booking.findById(finished._id), null);
  assert.ok(await RevenueEntry.exists({ _id: finished._id }));
  for (const b of protectedRows) {
    const after = await Booking.findById(b._id).select("+accessToken");
    assert.equal(after.name, b.name);
    assert.equal(after.accessToken, b.accessToken);
  }
});

test("remaining photos and live print files prevent early customer-data deletion", async () => {
  const now = Date.now();
  const b = await Booking.create(oldBooking(now, { photos: [
    { _id: photoId(now - MEDIA_TTL_MS - hour), file: "old.jpg" },
    { _id: photoId(now - hour), file: "fresh.jpg" },
  ] }));
  await saveMedia("fresh.jpg", Buffer.from("fresh"), "image/jpeg");
  const printOnly = await Booking.create(oldBooking(now, { photos: [] }));
  await saveMedia("print.png", Buffer.from("print"), "image/png");
  await PrintJob.create({ booking: printOnly._id, file: "print.png", createdAt: new Date(now - hour) });
  await purgeExpiredMedia(new Date(now));
  for (const row of [b, printOnly]) assert.equal((await Booking.findById(row._id)).name, row.name);
  assert.ok(await readMedia("fresh.jpg"));
  assert.ok(await readMedia("print.png"));
  await purgeExpiredMedia(new Date(now + MEDIA_TTL_MS));
  for (const row of [b, printOnly]) {
    assert.equal(await Booking.findById(row._id), null);
    assert.ok(await RevenueEntry.exists({ _id: row._id }));
  }
  assert.equal(await readMedia("print.png"), null);
});

test("expired unused codes and abandoned drafts lose customer history but retain their financial amounts", async () => {
  const now = Date.now();
  const expired = await Booking.create([
    oldBooking(now, { status: "pending", paid: false, captureEndsAt: undefined }),
    oldBooking(now, { status: "confirmed", captureEndsAt: undefined, codeExpiresAt: new Date(now - hour) }),
  ]);
  const protectedRows = await Booking.create([
    oldBooking(now, { status: "confirmed", paidAt: new Date(now - hour), captureEndsAt: undefined }),
    oldBooking(now, { status: "confirmed", codeExpiresAt: new Date(now + hour), captureEndsAt: undefined }),
    oldBooking(now, { status: "pending", date: "2099-01-01", captureEndsAt: undefined }),
  ]);
  const visible = await Booking.find(visibleBookingHistory(new Date(now), MEDIA_TTL_MS)).lean();
  assert.deepEqual(visible.map(b => String(b._id)).sort(), protectedRows.map(b => String(b._id)).sort(), "old history is hidden even before cleanup");
  await purgeExpiredMedia(new Date(now));
  for (const b of expired) {
    assert.equal(await Booking.findById(b._id), null);
    const after = await RevenueEntry.findById(b._id).lean();
    assert.equal(after.name, undefined);
    assert.equal(after.accessToken, undefined);
    assert.ok(after.archivedAt);
    assert.deepEqual([after.paid, after.total, after.paymentMethod, after.date], [b.paid, b.total, b.paymentMethod, b.date]);
  }
  for (const b of protectedRows) assert.equal((await Booking.findById(b._id)).name, b.name);
});

test("a storage deletion failure keeps customer data and references for the next successful cleanup", async () => {
  const now = Date.now();
  await saveMedia("retry.jpg", Buffer.from("retry"), "image/jpeg");
  const b = await Booking.create(oldBooking(now, { photos: [{ _id: photoId(now - MEDIA_TTL_MS - hour), file: "retry.jpg" }] }));
  const failure = mock.method(mongoose.mongo.GridFSBucket.prototype, "delete", async () => { throw new Error("storage unavailable"); });
  try { await assert.rejects(purgeExpiredMedia(new Date(now)), /storage unavailable/); }
  finally { failure.mock.restore(); }
  const kept = await Booking.findById(b._id);
  assert.equal(kept.name, b.name);
  assert.equal(kept.photos.length, 1);
  assert.equal(kept.customerDataDeletedAt, undefined);
  assert.ok(await readMedia("retry.jpg"));
  await purgeExpiredMedia(new Date(now));
  assert.equal(await readMedia("retry.jpg"), null);
  assert.equal(await Booking.findById(b._id), null);
  assert.ok(await RevenueEntry.exists({ _id: b._id }));
});

test("old records leave Booking across cursor batches while every sale remains in the ledger", async () => {
  const now = Date.now();
  await Booking.insertMany(Array.from({ length: 501 }, () => oldBooking(now)));
  await purgeExpiredMedia(new Date(now));
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal(await RevenueEntry.countDocuments(), 501);
  assert.equal(await Booking.countDocuments({ name: { $exists: true } }), 0);
  const [money] = await financialAggregate([{ $match: {} }, { $group: { _id: null, total: { $sum: "$total" } } }]);
  assert.equal(money.total, 501 * 90000);
});

test("a video/composite-only album without a legacy expiry is blocked on time and physically cleaned", async () => {
  const now = Date.now();
  await saveMedia("video-only.mp4", Buffer.from("video"), "video/mp4");
  await saveMedia("composite-only.jpg", Buffer.from("composite"), "image/jpeg");
  const b = await Booking.create(oldBooking(now, { photos: [], captureEndsAt: new Date(now - hour),
    video: { file: "video-only.mp4", mimeType: "video/mp4" }, composite: { file: "composite-only.jpg" } }));
  await purgeExpiredMedia(new Date(now));
  assert.ok(await readMedia("video-only.mp4"), "an old sale with a recent shoot is kept");
  await request(app).get(`/api/albums/${b.accessToken}/video`).expect(200);
  await request(app).get(`/api/albums/${b.accessToken}/composite`).expect(200);
  await Booking.updateOne({ _id: b._id }, { $set: { captureEndsAt: new Date(now - MEDIA_TTL_MS - hour) } });
  await request(app).get(`/api/albums/${b.accessToken}/video`).expect(404);
  await request(app).get(`/api/albums/${b.accessToken}/video`).set("Range", "bytes=0-1").expect(404);
  await request(app).head(`/api/albums/${b.accessToken}/composite`).expect(404);
  const summary = await getStorageSummary();
  assert.equal(summary.expired.files, 2, "storage assistant counts the same expired files");
  await purgeExpiredMedia(new Date(now));
  assert.equal(await readMedia("video-only.mp4"), null);
  assert.equal(await readMedia("composite-only.jpg"), null);
  assert.equal(await Booking.findById(b._id), null);
  assert.ok(await RevenueEntry.exists({ _id: b._id }));
});

test("ledger failures retain Booking and an interrupted copy never double-counts money on retry", async () => {
  const now = new Date(), b = await Booking.create(oldBooking(Number(now)));
  const eligible = expiredBookingHistory(now, MEDIA_TTL_MS);
  const failure = mock.method(RevenueEntry, "replaceOne", async () => { throw new Error("ledger unavailable"); });
  try { await assert.rejects(archiveBookingRevenue(b._id, eligible, now), /ledger unavailable/); }
  finally { failure.mock.restore(); }
  assert.ok(await Booking.findById(b._id), "no deletion without a verified financial copy");
  assert.equal(await RevenueEntry.countDocuments(), 0);
  const stopDelete = mock.method(Booking, "deleteOne", async () => { throw new Error("interrupted after copy"); });
  try { await assert.rejects(archiveBookingRevenue(b._id, eligible, now), /interrupted after copy/); }
  finally { stopDelete.mock.restore(); }
  assert.equal(await Booking.countDocuments(), 1);
  assert.equal(await RevenueEntry.countDocuments(), 1);
  const before = await getSummary({ from: b.date, to: b.date });
  assert.equal(before.revenue, 90000, "overlap counts once");
  await archiveBookingRevenue(b._id, eligible, now);
  assert.equal(await Booking.countDocuments(), 0);
  assert.equal(await RevenueEntry.countDocuments(), 1);
  statsCache.clear();
  assert.deepEqual(await getSummary({ from: b.date, to: b.date }), before);
});

test("previously compacted financial stubs also leave Booking", async () => {
  const now = Date.now();
  const b = await Booking.create(oldBooking(now, { customerDataDeletedAt: new Date(now - hour), active: false, mediaDeleted: true }));
  await purgeExpiredMedia(new Date(now));
  assert.equal(await Booking.findById(b._id), null);
  const entry = await RevenueEntry.findById(b._id).lean();
  assert.equal(entry.total, b.total);
  for (const key of ["name", "phone", "code", "photos", "cashBills", "captureDiag", "accessToken"])
    assert.equal(entry[key], undefined);
});
