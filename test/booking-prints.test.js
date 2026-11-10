import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, PrintJob, Room, User } from "../src/models/index.js";
import { MEDIA_TTL_MS, purgeExpiredMedia, readMedia, saveMedia } from "../src/services/media.js";

let memory, room, png, staff, admin, noPermission;
let code = 865000;
const cookie = (user) => `session=${jwt.sign({ sub: String(user._id) }, config.secret)}`;
const asStaff = (method, path) => request(app)[method](path).set("Cookie", staff);
const makeBooking = (extra = {}) => Booking.create({ code: String(code++), accessToken: randomUUID(),
  branch: "A", room: room._id, roomName: room.name, status: "completed", paid: true, prints: 5,
  photos: [{ kind: "original", file: "source-photo.jpg" }], ...extra });
async function sourceFor(booking, extra = {}) {
  const file = `print-${randomUUID()}.png`;
  await saveMedia(file, png, "image/png");
  return PrintJob.create({ booking: booking._id, code: booking.code, room: room._id, branch: "A",
    file, sheets: [{ file, width: 1200, height: 1800 }], width: 1200, height: 1800,
    printSize: "strip", frameName: "Pink", copies: 1, spoolStatus: "sent", ...extra });
}
before(async () => {
  config.secret = "test-secret-operator-prints-never-production";
  config.dnpPrinter = "";
  config.printAgentToken = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  room = await Room.create({ name: "RX1 room", branch: "A", active: true });
  const users = await User.create([
    { name: "Operator", email: "operator@local.test", password: "unused", role: "staff", branch: "A" },
    { name: "Admin", email: "admin@local.test", password: "unused", role: "admin" },
    { name: "Viewer", email: "viewer@local.test", password: "unused", role: "staff", branch: "A", permissions: [] },
  ]);
  [staff, admin, noPermission] = users.map(cookie);
  png = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#fbe0e9" } }).png().toBuffer();
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });

test("kiosk archives exact locally printed bytes once, charges quota once, and never enters the claim queue", async () => {
  const b = await makeBooking();
  const body = { images: [`data:image/png;base64,${png.toString("base64")}`], frameName: "Pink", printSize: "strip", requestKey: randomUUID() };
  const first = await request(app).post(`/api/albums/${b.accessToken}/print-archive`).send(body).expect(201);
  const replay = await request(app).post(`/api/albums/${b.accessToken}/print-archive`).send(body).expect(200);
  assert.equal(first.body._id, replay.body._id);
  const saved = await PrintJob.findById(first.body._id);
  assert.equal(saved.spoolStatus, "sent");
  assert.deepEqual(await readMedia(saved.file), png);
  assert.equal((await Booking.findById(b._id)).printSheets, 1);
  const token = jwt.sign({ type: "print-agent", room: String(room._id), branch: "A" }, config.secret);
  const claim = await request(app).post("/api/print-agent/claim").set("Authorization", `Bearer ${token}`).send({}).expect(200);
  assert.equal(claim.body.job, null);
});

test("fresh print detail exposes all sheets and actual paper, without returning photo arrays", async () => {
  const b = await makeBooking({ printSize: "full" });
  const source = await sourceFor(b);
  source.sheets.push({ file: source.file, width: 1200, height: 1800 }); await source.save();
  const response = await asStaff("get", `/api/admin/bookings/${b._id}/prints`).expect(200);
  assert.equal(response.body.booking.photos, undefined);
  assert.equal(response.body.booking.photoCount, 1);
  assert.equal(response.body.jobs[0].sheetCount, 2);
  assert.equal(response.body.jobs[0].printSize, "strip");
  assert.match(response.body.jobs[0].image, /\/prints\//);
});

test("simultaneous retry creates one local reprint, preserves bytes, expiry and guest allowance", async () => {
  const b = await makeBooking({ printSheets: 2 });
  const source = await sourceFor(b);
  const body = { jobId: String(source._id), copies: 2, delivery: "local", requestKey: randomUUID() };
  const responses = await Promise.all(Array.from({ length: 3 }, () => asStaff("post", `/api/admin/bookings/${b._id}/reprint`).send(body)));
  assert.ok(responses.every((r) => [200, 201].includes(r.status)));
  assert.equal(new Set(responses.map((r) => r.body._id)).size, 1);
  const repeated = await PrintJob.findById(responses[0].body._id);
  assert.equal(repeated.spoolStatus, "sent");
  assert.equal(repeated.file, source.file);
  assert.equal(repeated.fileExpiresAt.getTime(), source.createdAt.getTime() + MEDIA_TTL_MS);
  assert.equal(repeated.operatorPrint, true);
  assert.equal((await Booking.findById(b._id)).printSheets, 2);
  await asStaff("post", `/api/admin/bookings/${b._id}/reprint`).send({ ...body, copies: 3 }).expect(409);
});

test("manual recovery archives PNG bytes without quota charge and can be retried safely", async () => {
  const b = await makeBooking({ printSheets: 5 });
  const key = randomUUID();
  const send = () => asStaff("post", `/api/admin/bookings/${b._id}/print-file`)
    .set("Content-Type", "application/octet-stream").set("X-Print-Key", key)
    .set("X-Print-Sheets", String(png.length)).set("X-Print-Frame", "Manual").set("X-Print-Copies", "2").send(png);
  const first = await send().expect(201), again = await send().expect(200);
  assert.equal(first.body._id, again.body._id);
  const saved = await PrintJob.findById(first.body._id);
  assert.deepEqual(await readMedia(saved.file), png);
  assert.equal(saved.copies, 2);
  assert.equal(saved.spoolStatus, "sent");
  assert.equal((await Booking.findById(b._id)).printSheets, 5);
});

test("printing requires permission, the assigned branch, an active completed capture and valid pixels", async () => {
  const b = await makeBooking();
  await request(app).get(`/api/admin/bookings/${b._id}/prints`).expect(401);
  await request(app).get(`/api/admin/bookings/${b._id}/prints`).set("Cookie", noPermission).expect(403);
  const elsewhere = await makeBooking({ branch: "B" });
  await asStaff("get", `/api/admin/bookings/${elsewhere._id}/prints`).expect(403);
  const source = await sourceFor(b);
  await Booking.updateOne({ _id: b._id }, { $set: { status: "cancelled" } });
  await asStaff("post", `/api/admin/bookings/${b._id}/reprint`).send({ jobId: String(source._id), copies: 1 }).expect(409);
  const active = await makeBooking();
  await asStaff("post", `/api/admin/bookings/${active._id}/print-file`).send({
    images: ["data:image/png;base64,iVBORw0KGgo="], requestKey: randomUUID(), frameName: "Bad",
  }).expect(400);
  assert.equal(await PrintJob.countDocuments({ booking: active._id }), 0);
});

test("deleting a reprint keeps the shared original file and never returns uncharged quota", async () => {
  const b = await makeBooking({ printSheets: 2 });
  const source = await sourceFor(b);
  const repeated = await asStaff("post", `/api/admin/bookings/${b._id}/reprint`).send({
    jobId: String(source._id), copies: 1, delivery: "local", requestKey: randomUUID(),
  }).expect(201);
  await request(app).delete(`/api/admin/print-jobs/${repeated.body._id}`).set("Cookie", admin).expect(200);
  assert.deepEqual(await readMedia(source.file), png);
  assert.equal((await Booking.findById(b._id)).printSheets, 2);
});

test("shared files expire with the source instead of gaining another retention period on reprint", async () => {
  const b = await makeBooking();
  const source = await sourceFor(b, { createdAt: new Date(Date.now() - MEDIA_TTL_MS + 30_000) });
  const repeated = await asStaff("post", `/api/admin/bookings/${b._id}/reprint`).send({
    jobId: String(source._id), copies: 1, delivery: "local", requestKey: randomUUID(),
  }).expect(201);
  assert.equal(Date.parse(repeated.body.expiresAt), source.createdAt.getTime() + MEDIA_TTL_MS);
  await PrintJob.updateOne({ _id: repeated.body._id }, { $set: { fileExpiresAt: new Date(Date.now() - 1000) } });
  await request(app).get(`/api/albums/${b.accessToken}/prints/${repeated.body._id}`).expect(404);
  const detail = await asStaff("get", `/api/admin/bookings/${b._id}/prints`).expect(200);
  assert.ok(!detail.body.jobs.some((job) => job._id === repeated.body._id));
  await purgeExpiredMedia(new Date());
  assert.equal(await PrintJob.findById(repeated.body._id), null);
  assert.deepEqual(await readMedia(source.file), png, "unexpired source still owns the file");
});
