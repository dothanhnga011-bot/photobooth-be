import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import sharp from "sharp";
import request from "supertest";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import Booking from "../src/models/Booking.js";
import { readMedia, saveMedia, purgeExpiredMedia, MEDIA_TTL_MS } from "../src/services/media.js";
import { encodePhotoDownload, DOWNLOAD_PIXELS } from "../src/services/photo-download.js";
import { deleteCustomerMedia, listCustomerMedia } from "../src/services/customer-media.js";

let memory, source, booking, photo, downloaded;
before(async () => {
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Booking.init();
  // A 26 MP camera photo whose left/right halves have visibly different colours.
  const width = 6240, height = 4160;
  source = await sharp({ create: { width, height, channels: 3, background: "#ed1923" } })
    .composite([{ input: { create: { width: width / 2, height, channels: 3, background: "#1e32e1" } }, left: width / 2, top: 0 }])
    .withIccProfile("srgb").jpeg({ quality: 96, chromaSubsampling: "4:4:4" }).toBuffer();
  const file = await saveMedia("download-camera.jpg", source, "image/jpeg");
  booking = await Booking.create({ code: "765432", accessToken: randomUUID(), status: "completed",
    photos: [{ file, kind: "original", number: 1, mirrored: false, sourcePreserved: true }] });
  photo = booking.photos[0];
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });
const url = () => `/api/albums/${booking.accessToken}/photos/${photo._id}`;

test("guest downloads always mirror the camera source, keep the aspect ratio near 20 MP and cache a single file", async () => {
  const [first, concurrent] = await Promise.all([
    request(app).get(url() + "?download=1").expect(200),
    request(app).get(url() + "?download=1&size=thumbnail").expect(200),
  ]);
  downloaded = first.body;
  assert.deepEqual(concurrent.body, downloaded);
  assert.match(first.headers["content-disposition"], /NXC-765432-01\.jpg/);
  const meta = await sharp(downloaded).metadata();
  assert.ok(meta.width * meta.height <= DOWNLOAD_PIXELS);
  assert.ok(meta.width * meta.height > 19_900_000, "26 MP source becomes approximately 20 MP");
  assert.ok(Math.abs(meta.width / meta.height - 1.5) < 0.001);
  assert.equal(meta.orientation, undefined, "orientation is baked into the pixels");
  assert.ok(meta.icc?.length, "download carries an explicit sRGB profile");
  const pixel = await sharp(downloaded).resize(2, 1).raw().toBuffer();
  assert.ok(pixel[2] > pixel[0], "blue is now on the left, even when kiosk mirroring was disabled");
  assert.ok(pixel[3] > pixel[5], "red is now on the right");
  const saved = await Booking.findById(booking._id);
  assert.match(saved.photos[0].downloadFile, /\.download\.jpg$/);
  assert.equal(await mongoose.connection.db.collection("media.files").countDocuments(), 2);
  assert.deepEqual((await request(app).get(url()).expect(200)).body, source, "editing still gets the camera source");
  assert.deepEqual((await request(app).get(url() + "?download=1").expect(200)).body, downloaded);
});

test("the album ZIP contains the exact prepared guest file", async () => {
  const zip = await request(app).get(`/api/albums/${booking.accessToken}/download`).buffer(true)
    .parse((res, done) => { const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => done(null, Buffer.concat(chunks))); })
    .expect(200);
  const header = zip.body;
  assert.equal(header.readUInt32LE(0), 0x04034b50);
  const length = header.readUInt32LE(18), nameLength = header.readUInt16LE(26), extraLength = header.readUInt16LE(28);
  assert.equal(header.toString("utf8", 30, 30 + nameLength), "NXC-765432-01.jpg");
  assert.deepEqual(header.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + length), downloaded);
});

test("every EXIF orientation is normalized before mirroring; small photos are never enlarged", async () => {
  const width = 96, height = 64;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    data[i] = x * 2; data[i + 1] = y * 3; data[i + 2] = 200 - y;
  }
  for (let orientation = 1; orientation <= 8; orientation++) {
    const input = await sharp(data, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation }).jpeg({ quality: 98, chromaSubsampling: "4:4:4" }).toBuffer();
    const upright = await sharp(input).autoOrient().raw().toBuffer({ resolveWithObject: true });
    const result = await sharp(await encodePhotoDownload(input)).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([result.info.width, result.info.height], [upright.info.width, upright.info.height]);
    let error = 0;
    for (let y = 0; y < upright.info.height; y++) for (let x = 0; x < upright.info.width; x++) for (let c = 0; c < 3; c++) {
      const expected = upright.data[(y * upright.info.width + upright.info.width - 1 - x) * 3 + c];
      error += Math.abs(result.data[(y * result.info.width + x) * 3 + c] - expected);
    }
    assert.ok(error / result.data.length < 2, `orientation ${orientation}: mirror the upright pixels exactly once`);
  }
});

test("preview-only photos cannot be downloaded as originals or silently included in a ZIP", async () => {
  const b = await Booking.create({ code: "pending", accessToken: randomUUID(), status: "completed",
    photos: [{ file: "preview.jpg", kind: "original", originalPending: true }] });
  await request(app).get(`/api/albums/${b.accessToken}/photos/${b.photos[0]._id}?download=1`).expect(409);
  await request(app).get(`/api/albums/${b.accessToken}/download`).expect(409);
  await request(app).get(`/api/albums/wrong/photos/${photo._id}?download=1`).expect(404);
});

test("20 MP guest composites, including a single strip longer than 6000 px, upload and download without another mirror", async () => {
  const captureToken = jwt.sign({ type: "capture", booking: String(booking._id) }, config.secret);
  const image = await sharp({ create: { width: 2582, height: 7745, channels: 3, background: "#ed1923" } })
    .jpeg({ quality: 95 }).toBuffer();
  const uploaded = await request(app).post("/api/kiosk/composite")
    .set("X-Capture-Token", captureToken).set("Content-Type", "image/jpeg").send(image).expect(201);
  assert.deepEqual([uploaded.body.width, uploaded.body.height], [2582, 7745]);
  assert.deepEqual((await request(app).get(`/api/albums/${booking.accessToken}/composite?download=1`).expect(200)).body,
    image, "framed image keeps its existing photo orientation, text and layout");
  const oversized = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "#ed1923" } }).jpeg().toBuffer();
  await request(app).post("/api/kiosk/composite").set("X-Capture-Token", captureToken)
    .set("Content-Type", "image/jpeg").send(oversized).expect(400);
});

test("cached guest files are counted and removed with their customer's media", async () => {
  const saved = await Booking.findById(booking._id);
  const file = saved.photos[0].downloadFile;
  const row = (await listCustomerMedia()).find(row => row.id === String(booking._id));
  assert.equal(row.files, 4, "source, guest download, composite and its thumbnail");
  assert.ok(row.bytes > source.length + downloaded.length);
  await deleteCustomerMedia(booking._id);
  assert.equal(await readMedia(file), null);
  assert.equal(await readMedia(photo.file), null);
  await request(app).get(url() + "?download=1").expect(404);
});

test("TTL cleanup deletes the cached guest JPEG with an expired original", async () => {
  const oldId = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - MEDIA_TTL_MS - 10000) / 1000));
  await saveMedia("expired-source.jpg", source, "image/jpeg");
  await saveMedia("expired-download.jpg", downloaded, "image/jpeg");
  const b = await Booking.create({ code: "expired", accessToken: randomUUID(), status: "completed",
    photos: [{ _id: oldId, file: "expired-source.jpg", downloadFile: "expired-download.jpg", kind: "original" }] });
  await request(app).get(`/api/albums/${b.accessToken}/photos/${oldId}?download=1`).expect(404);
  await purgeExpiredMedia();
  assert.equal(await readMedia("expired-download.jpg"), null);
  assert.equal(await readMedia("expired-source.jpg"), null);
});
