import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import sharp from "sharp";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, PrintJob, Room } from "../src/models/index.js";
import { readMedia, saveMedia } from "../src/services/media.js";
import { validatePrintImage } from "../src/services/print-image.js";

let memory, png, jpeg;
let nextCode = 654321;
const dataUrl = (buffer, type) => `data:${type};base64,${buffer.toString("base64")}`;
const pixels = async (buffer) => sharp(buffer).ensureAlpha().raw().toBuffer();
const booking = () => Booking.create({
  code: String(nextCode++), accessToken: randomUUID(), status: "completed", prints: 10,
  photos: [{ file: "test-original.jpg", kind: "original" }],
});
const post = (b, images, requestKey = randomUUID()) => request(app)
  .post(`/api/albums/${b.accessToken}/print-pack`)
  .send({ images, frameName: "Sharp test pattern", requestKey });
before(async () => {
  config.dnpPrinter = ""; // Never talk to a physical printer.
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all([Booking.init(), PrintJob.init()]);
  const raw = Buffer.alloc(1200 * 1800 * 3);
  for (let y = 0; y < 1800; y++) for (let x = 0; x < 1200; x++) {
    const i = (y * 1200 + x) * 3;
    raw[i] = (x ^ y) & 255; raw[i + 1] = x & 255; raw[i + 2] = y & 255;
  }
  png = await sharp(raw, { raw: { width: 1200, height: 1800, channels: 3 } }).png().toBuffer();
  jpeg = await sharp({ create: { width: 1772, height: 1181, channels: 3, background: "#a74773" } })
    .jpeg({ quality: 97 }).toBuffer();
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });

test("new PNG print sheets keep all encoded bytes and pixels, including downloads and retries", async () => {
  const b = await booking(), key = randomUUID();
  const source = dataUrl(png, "image/png");
  const first = await post(b, [source], key).expect(201);
  assert.deepEqual([first.body.width, first.body.height], [1200, 1800]);
  const job = await PrintJob.findById(first.body._id);
  assert.match(job.file, /\.png$/);
  assert.deepEqual(await readMedia(job.file), png);
  const url = `/api/albums/${b.accessToken}/prints/${job._id}`;
  const image = await request(app).get(url).expect(200).expect("Content-Type", /image\/png/);
  assert.deepEqual(image.body, png);
  assert.deepEqual(await pixels(image.body), await pixels(png));
  const download = await request(app).get(url + "?download=1&size=thumbnail")
    .expect(200).expect("Content-Type", /image\/png/).expect("Content-Disposition", /-in\.png/);
  assert.deepEqual(download.body, png, "download must never use queue thumbnail");
  const thumbnail = await request(app).get(url + "?size=thumbnail")
    .expect(200).expect("Content-Type", /image\/jpeg/);
  const thumbnailMeta = await sharp(thumbnail.body).metadata();
  assert.ok(Math.max(thumbnailMeta.width, thumbnailMeta.height) <= 512);
  const replay = await post(b, [source], key).expect(200);
  assert.equal(replay.body._id, first.body._id);
  assert.equal((await Booking.findById(b._id)).printSheets, 1);
  await post(b, [dataUrl(jpeg, "image/jpeg")], key).expect(409);
});

test("mixed new PNG and legacy JPEG sheets download with the correct extensions and original bytes", async () => {
  const b = await booking();
  const first = await post(b, [dataUrl(png, "image/png"), dataUrl(jpeg, "image/jpeg")]).expect(201);
  const job = await PrintJob.findById(first.body._id);
  assert.deepEqual(await readMedia(job.sheets[1].file), jpeg);
  const url = `/api/albums/${b.accessToken}/prints/${job._id}`;
  const oldSheet = await request(app).get(url + "?sheet=1&download=1")
    .expect(200).expect("Content-Type", /image\/jpeg/).expect("Content-Disposition", /-to-02\.jpg/);
  assert.deepEqual(oldSheet.body, jpeg);
  const zip = await request(app).get(url + "?download=1").buffer(true)
    .parse((res, done) => { const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => done(null, Buffer.concat(chunks))); })
    .expect(200).expect("Content-Type", /application\/zip/);
  const end = zip.body.length - 22;
  let at = zip.body.readUInt32LE(end + 16);
  for (const [name, expected] of [[`NXC-${b.code}-to-01.png`, png], [`NXC-${b.code}-to-02.jpg`, jpeg]]) {
    const size = zip.body.readUInt32LE(at + 24), nameLength = zip.body.readUInt16LE(at + 28);
    assert.equal(zip.body.toString("utf8", at + 46, at + 46 + nameLength), name);
    const local = zip.body.readUInt32LE(at + 42), start = local + 30 + zip.body.readUInt16LE(local + 26);
    assert.deepEqual(zip.body.subarray(start, start + size), expected);
    at += 46 + nameLength;
  }
});

test("600 ppi automatic sheets retain original bytes through binary upload, download and retry", async () => {
  const catalog = await request(app).get('/api/catalog').expect(200);
  assert.equal(catalog.body.printCapabilities.dnpSheetScale, 2);
  const b = await booking(), key = randomUUID();
  const high = await sharp(png).resize(2400, 3600).png().toBuffer();
  const send = () => request(app).post(`/api/albums/${b.accessToken}/print-pack`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Print-Key', key).set('X-Print-Frame', 'HQ')
    .set('X-Print-Sheets', String(high.length)).send(high);
  const first = await send().expect(201);
  assert.deepEqual([first.body.width, first.body.height], [2400, 3600]);
  const image = await request(app).get(`/api/albums/${b.accessToken}/prints/${first.body._id}?download=1`)
    .expect(200).expect('Content-Type', /image\/png/);
  assert.deepEqual(image.body, high);
  assert.equal((await send().expect(200)).body._id, first.body._id);
  assert.equal((await Booking.findById(b._id)).printSheets, 1);
  const landscape = await sharp(high).rotate(90).png().toBuffer();
  assert.deepEqual(await validatePrintImage(landscape, 'image/png'), { width: 3600, height: 2400, extension: 'png' });
  await assert.rejects(validatePrintImage(high, 'image/png', 'instax'), /Instax Wide/);
});

test("direct room printing is scoped, leased immediately, never cloud-queued, and never replayed physically", async () => {
  const room = await Room.create({ name: 'Direct room', branch: 'A', active: true });
  const b = await booking();
  b.room = room._id; b.branch = 'A'; await b.save();
  const auth = jwt.sign({ type: 'print-agent', room: String(room._id), branch: 'A' }, config.secret);
  const key = randomUUID();
  const send = (token = auth) => request(app).post(`/api/print-agent/direct/${b.accessToken}`)
    .set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream')
    .set('X-Print-Key', key).set('X-Print-Frame', 'Local').set('X-Print-Sheets', String(png.length)).send(png);
  const other = jwt.sign({ type: 'print-agent', room: new mongoose.Types.ObjectId().toString(), branch: 'A' }, config.secret);
  await send(other).expect(403);
  assert.equal((await Booking.findById(b._id)).printSheets, 0);
  const first = await send().expect(201);
  assert.equal(first.body.spoolStatus, 'sending');
  assert.equal(first.body.direct.fresh, true);
  assert.ok(first.body.direct.job.leaseId);
  assert.equal((await send().expect(200)).body.direct.fresh, false);
  assert.equal((await Booking.findById(b._id)).printSheets, 1);
  const claim = await request(app).post('/api/print-agent/claim').set('Authorization', `Bearer ${auth}`).send({}).expect(200);
  assert.equal(claim.body.job, null, 'cloud polling cannot take this direct job');
  await request(app).post(`/api/print-agent/jobs/${first.body._id}/complete`).set('Authorization', `Bearer ${auth}`)
    .send({ leaseId: first.body.direct.job.leaseId, sent: true, message: 'Local spool accepted' }).expect(200);
  const replay = await send().expect(200);
  assert.equal(replay.body.spoolStatus, 'sent');
  assert.equal(replay.body.direct.fresh, false);
});

test("old jobs without a sheets array still return original JPEG files", async () => {
  const b = await booking();
  await saveMedia("legacy-print-quality.jpg", jpeg, "image/jpeg");
  const job = await PrintJob.create({ booking: b._id, code: b.code, file: "legacy-print-quality.jpg" });
  const file = await request(app).get(`/api/albums/${b.accessToken}/prints/${job._id}?download=1`)
    .expect(200).expect("Content-Type", /image\/jpeg/).expect("Content-Disposition", /-in\.jpg/);
  assert.deepEqual(file.body, jpeg);
});

test("corrupt pixels, MIME mismatches, unsupported formats and page sizes never consume quota or leave files", async () => {
  const b = await booking();
  const storedFiles = await mongoose.connection.db.collection("media.files").countDocuments();
  const shortPng = png.subarray(0, Math.floor(png.length / 2));
  assert.equal((await sharp(shortPng).metadata()).width, 1200, "fixture has a valid header");
  const badSize = await sharp(png).resize(1200, 1799).png().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  for (const source of [dataUrl(shortPng, "image/png"), dataUrl(png, "image/jpeg"),
    dataUrl(jpeg, "image/png"), dataUrl(webp, "image/png"), dataUrl(badSize, "image/png")]) {
    await post(b, [source]).expect(400);
    assert.equal((await Booking.findById(b._id)).printSheets, 0);
  }
  assert.equal(await PrintJob.countDocuments({ booking: b._id }), 0);
  assert.equal(await mongoose.connection.db.collection("media.files").countDocuments(), storedFiles,
    "rejected print attempts must not leave stored files");
  const landscape = await sharp(png).rotate(90).png().toBuffer();
  assert.deepEqual(await validatePrintImage(landscape, "image/png"), { width: 1800, height: 1200, extension: "png" });
});

test("an Instax album prints one 1260 × 840 Wide image per piece and refuses 10 × 15 sheets", async () => {
  const b = await Booking.create({
    code: String(nextCode++), accessToken: randomUUID(), status: "completed", prints: 2, printSize: "instax",
    photos: [{ file: "test-original.jpg", kind: "original" }],
  });
  const instax = await sharp({ create: { width: 1260, height: 840, channels: 3, background: "#d8b4a0" } })
    .jpeg({ quality: 92 }).toBuffer();
  const sheet = await post(b, [dataUrl(png, "image/png")]).expect(400);
  assert.match(sheet.body.message, /Tấm Instax Wide phải là ảnh ngang 1260 × 840 px/);
  const portrait = await sharp(instax).rotate(90).jpeg().toBuffer();
  await post(b, [dataUrl(portrait, "image/jpeg")]).expect(400);
  const printed = await post(b, [dataUrl(instax, "image/jpeg"), dataUrl(instax, "image/jpeg")]).expect(201);
  assert.deepEqual([printed.body.width, printed.body.height, printed.body.sheetCount], [1260, 840, 2]);
  // A print queued by a kiosk before the switch from Instax mini still goes through.
  const mini = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#d8b4a0" } }).jpeg().toBuffer();
  assert.deepEqual(await validatePrintImage(mini, "image/jpeg", "instax"), { width: 600, height: 800, extension: "jpg" });
  assert.equal((await PrintJob.findById(printed.body._id)).printSize, "instax");
  await assert.rejects(validatePrintImage(instax, "image/jpeg"), /Tờ ảnh phải là 1200 × 1800/);
});
