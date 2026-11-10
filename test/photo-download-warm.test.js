import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import sharp from "sharp";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import Booking from "../src/models/Booking.js";
import { saveMedia, readMedia } from "../src/services/media.js";
import { appendCapture, attachOriginal, finishCapture } from "../src/services/capture.js";
import { encodePhotoDownload } from "../src/services/photo-download.js";
import { schedulePhotoDownload, whenPhotoDownloadsIdle } from "../src/services/photo-download-warm.js";
import { saveImageTask } from "../src/services/image-save-queue.js";
import { whenPrintSourcesIdle } from "../src/services/print-source.js";

let memory, jpeg;
before(async () => {
  config.dnpPrinter = "";
  process.env.PHOTO_DOWNLOAD_PREWARM = "1";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri()); await Booking.init();
  jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#b8744c" } }).jpeg().toBuffer();
});
after(async () => {
  await whenPhotoDownloadsIdle(); await whenPrintSourcesIdle();
  process.env.PHOTO_DOWNLOAD_PREWARM = "0";
  await mongoose.disconnect(); await memory?.stop();
});
async function readyPhoto() {
  const file = `warm-${randomUUID()}.jpg`;
  await saveMedia(file, jpeg, "image/jpeg");
  const booking = await Booking.create({ accessToken: randomUUID(), status: "completed", photos: [{ file, kind: "original" }] });
  return { booking, photo: booking.photos[0] };
}
test("background cache prepares the exact same guest JPEG before the first Save click", async () => {
  const { booking, photo } = await readyPhoto();
  assert.equal(schedulePhotoDownload(booking._id, photo), true);
  assert.equal(schedulePhotoDownload(booking._id, photo), false);
  await whenPhotoDownloadsIdle();
  const cached = (await Booking.findById(booking._id)).photos[0].downloadFile;
  assert.ok(cached, "prepared without any HTTP download request");
  assert.deepEqual(await readMedia(cached), await encodePhotoDownload(jpeg));
  const saved = await request(app).get(`/api/albums/${booking.accessToken}/photos/${photo._id}?download=1`).expect(200);
  assert.deepEqual(saved.body, await readMedia(cached));
  assert.deepEqual(await readMedia(photo.file), jpeg, "camera bytes stay intact");
});
test("background preparation yields to accepted uploads and never prepares a pending preview", async () => {
  const { booking, photo } = await readyPhoto();
  assert.equal(schedulePhotoDownload(booking._id, { ...photo.toObject(), originalPending: true }), false);
  let release;
  const accepted = saveImageTask(() => new Promise((resolve) => { release = resolve; }));
  schedulePhotoDownload(booking._id, photo);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal((await Booking.findById(booking._id)).photos[0].downloadFile, undefined);
  release(); await accepted; await whenPhotoDownloadsIdle();
  assert.ok((await Booking.findById(booking._id)).photos[0].downloadFile);
});
test("newly appended photos and attached originals both schedule ready-to-save guest files", async () => {
  const first = await Booking.create({ status: "completed", accessToken: randomUUID() });
  const saved = await appendCapture(first._id, jpeg, { imported: true, clientKey: "warm-append" });
  const second = await Booking.create({ status: "completed", accessToken: randomUUID(),
    photos: [{ kind: "original", file: "temporary-preview.jpg", originalPending: true, clientKey: "warm-attach" }] });
  await attachOriginal(second._id, "warm-attach", { buffer: jpeg });
  await whenPhotoDownloadsIdle();
  assert.ok((await Booking.findById(saved._id)).photos[0].downloadFile);
  assert.ok((await Booking.findById(second._id)).photos[0].downloadFile);
});

test("live capture keeps its bandwidth and CPU; existing originals warm only after finishing", async () => {
  const active = await Booking.create({ status: "checked_in", accessToken: randomUUID(), shots: 2,
    captureEndsAt: new Date(Date.now() + 60_000), photos: [{ kind: "original", file: "pending.jpg", originalPending: true, clientKey: "live-original" }] });
  await attachOriginal(active._id, "live-original", { buffer: jpeg });
  await whenPhotoDownloadsIdle();
  assert.equal((await Booking.findById(active._id)).photos[0].downloadFile, undefined);
  await finishCapture(active._id);
  await whenPhotoDownloadsIdle();
  assert.ok((await Booking.findById(active._id)).photos[0].downloadFile);
});

test("an original committed across capture completion uses the atomic result instead of its old status snapshot", async () => {
  const active = await Booking.create({ status: "checked_in", accessToken: randomUUID(),
    photos: [{ kind: "original", file: "preview.jpg", originalPending: true, clientKey: "finish-race" }] });
  const snapshot = await Booking.findById(active._id);
  await finishCapture(active._id);
  const read = Booking.findById;
  const stale = mock.method(Booking, "findById", function (id, ...args) {
    return String(id) === String(active._id) ? { select: async () => snapshot } : read.call(this, id, ...args);
  });
  try { await attachOriginal(active._id, "finish-race", { buffer: jpeg }); }
  finally { stale.mock.restore(); }
  await whenPhotoDownloadsIdle();
  assert.ok((await Booking.findById(active._id)).photos[0].downloadFile);
});
