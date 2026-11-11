import "./environment.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, PrintJob, Room, Setting, User } from "../src/models/index.js";
import { getRx1Output } from "../src/services/rx1-output.js";
import { STAFF_PERMISSIONS } from "../src/middleware/auth.js";

let memory, room, adminCookie, staffCookie, agent;
const settingsPath = "/api/admin/settings/rx1-output";
const asAdmin = (method) => request(app)[method](settingsPath).set("Cookie", adminCookie);
const sync = (applied = { gamma: 1.5, maxResolution: true }) =>
  request(app).post("/api/print-agent/output-settings/sync").set("Authorization", `Bearer ${agent}`).send({ applied });
before(async () => {
  config.secret = "test-rx1-settings-never-a-production-secret";
  config.printAgentToken = "test-common-agent-token-1234567890123456789";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const users = await User.create([
    { name: "Admin", email: "rx1-admin@test.local", role: "admin", active: true },
    { name: "Staff", email: "rx1-staff@test.local", role: "staff", active: true, branch: "A" },
  ]);
  [adminCookie, staffCookie] = users.map((user) => `session=${jwt.sign({ sub: String(user._id) }, config.secret)}`);
});
beforeEach(async () => {
  await Setting.deleteMany({});
  room = await Room.create({ name: `RX1 ${randomUUID()}`, branch: "A", active: true });
  agent = jwt.sign({ type: "print-agent", room: String(room._id), branch: "A" }, config.secret);
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });

test("only admins can change output; no web override preserves installed local choices", async () => {
  await request(app).get(settingsPath).expect(401);
  await request(app).put(settingsPath).send({ gamma: 1.3, maxResolution: true }).expect(401);
  await request(app).get(settingsPath).set("Cookie", staffCookie).expect(403);
  await request(app).put(settingsPath).set("Cookie", staffCookie).send({ gamma: 1.3, maxResolution: true }).expect(403);
  await User.updateOne({ email: "rx1-staff@test.local" }, { $set: { permissions: STAFF_PERMISSIONS } });
  await request(app).get(settingsPath).set("Cookie", staffCookie).expect(403);
  await request(app).put(settingsPath).set("Cookie", staffCookie).send({ gamma: 2.2, maxResolution: false }).expect(403);
  assert.deepEqual((await asAdmin("get").expect(200)).body, { configured: false, settings: { gamma: 1.5, maxResolution: true, sharpen: 2 } });
  assert.equal((await sync({ gamma: 1.18, maxResolution: false }).expect(200)).body.rx1Output, null);
});

test("a web save survives reload, invalidates cached configuration and preserves other studio settings", async () => {
  await Setting.create({ key: "studio", value: { name: "Studio", extraPrintPrice: 10000, kiosk: { idleTitle: "Hello" } } });
  assert.equal(await getRx1Output(), null);
  await asAdmin("put").send({ gamma: 1.4, maxResolution: false }).expect(200);
  // Lưu không kèm độ nét (trang quản trị cũ): dùng mức mặc định 2.
  assert.deepEqual((await asAdmin("get").expect(200)).body, { configured: true, settings: { gamma: 1.4, maxResolution: false, sharpen: 2 } });
  assert.deepEqual((await sync().expect(200)).body.rx1Output, { gamma: 1.4, maxResolution: false, sharpen: 2 });
  await asAdmin("put").send({ gamma: 1.5, maxResolution: true, sharpen: 0 }).expect(200);
  assert.deepEqual((await sync().expect(200)).body.rx1Output, { gamma: 1.5, maxResolution: true, sharpen: 0 });
  for (const [gamma, sharpen] of [[1, 0], [1.51, 1], [1.8, 3], [2.2, 4]]) {
    const settings = { gamma, maxResolution: true, sharpen };
    await asAdmin("put").send(settings).expect(200);
    assert.deepEqual((await asAdmin("get").expect(200)).body.settings, settings);
    assert.deepEqual((await sync(settings).expect(200)).body.rx1Output, settings);
  }
  const studio = (await Setting.findOne({ key: "studio" })).value;
  assert.equal(studio.name, "Studio"); assert.equal(studio.extraPrintPrice, 10000);
  assert.deepEqual(studio.kiosk, { idleTitle: "Hello" });
});

test("invalid values and unknown fields cannot change the last valid output", async () => {
  const valid = { gamma: 1.3, maxResolution: true, sharpen: 3 };
  await asAdmin("put").send(valid).expect(200);
  for (const patch of [{ gamma: 0.99 }, { gamma: 2.21 }, { gamma: 1.234 }, { gamma: "1.4" },
    { gamma: true }, { gamma: null }, { maxResolution: "yes" }, { maxResolution: null }, { printer: "another queue" },
    { sharpen: 5 }, { sharpen: -1 }, { sharpen: 1.5 }, { sharpen: "2" }, { sharpen: true }, { sharpen: null }]) {
    await asAdmin("put").send({ ...valid, ...patch }).expect(400);
    assert.deepEqual(await getRx1Output(), valid);
  }
});

test("sync reports the applied value but never claims a print, changes revenue or edits desired settings", async () => {
  await asAdmin("put").send({ gamma: 1.5, maxResolution: true }).expect(200);
  const booking = await Booking.create({ code: randomUUID(), room: room._id, total: 70000, printSheets: 1 });
  const job = await PrintJob.create({ booking: booking._id, room: room._id, spoolStatus: "queued", status: "pending" });
  assert.deepEqual((await sync({ gamma: 1.3, maxResolution: false }).expect(200)).body.rx1Output, { gamma: 1.5, maxResolution: true, sharpen: 2 });
  const rows = (await request(app).get("/api/admin/print-jobs/printers").set("Cookie", adminCookie).expect(200)).body;
  const printer = rows.find((row) => row.room === String(room._id));
  assert.equal(printer.rx1Output.gamma, 1.3); assert.equal(printer.agent.running, true);
  assert.equal((await PrintJob.findById(job._id)).spoolStatus, "queued");
  const after = await Booking.findById(booking._id);
  assert.equal(after.total, 70000); assert.equal(after.printSheets, 1);
  assert.deepEqual(await getRx1Output(), { gamma: 1.5, maxResolution: true, sharpen: 2 });
});

test("sync rejects wrong identities and invalid acknowledgements; stored invalid profiles are never sent", async () => {
  const path = "/api/print-agent/output-settings/sync";
  const payload = { applied: { gamma: 1.3, maxResolution: true } };
  await request(app).post(path).send(payload).expect(403);
  await request(app).post(path).set("Authorization", `Bearer ${config.printAgentToken}`).send(payload).expect(403);
  await sync({ gamma: 20, maxResolution: true }).expect(400);
  await Setting.create({ key: "studio", value: { rx1Output: { gamma: 20, maxResolution: true } } });
  assert.equal((await sync().expect(200)).body.rx1Output, null);
});

test("agents report the sharpness they use; an old agent without it is still accepted", async () => {
  await sync({ gamma: 1.3, maxResolution: true }).expect(200);
  await sync({ gamma: 1.3, maxResolution: true, sharpen: 3 }).expect(200);
  const printer = (await request(app).get("/api/admin/print-jobs/printers").set("Cookie", adminCookie).expect(200)).body
    .find((row) => row.room === String(room._id));
  assert.equal(printer.rx1Output.sharpen, 3);
  for (const sharpen of [5, -1, 1.5, "2"]) await sync({ gamma: 1.3, maxResolution: true, sharpen }).expect(400);
});

test("a sharpness test print reaches only that room's printer once and its result shows in the printer list", async () => {
  const testPath = (id) => `/api/admin/settings/rx1-output/sharpness-test/${id}`;
  await request(app).post(testPath(room._id)).expect(401);
  await request(app).post(testPath(room._id)).set("Cookie", staffCookie).expect(403);
  await request(app).post(testPath("0".repeat(24))).set("Cookie", adminCookie).expect(404);
  const polaroid = await Room.create({ name: `Polaroid ${randomUUID()}`, branch: "A", kind: "polaroid", active: true });
  await request(app).post(testPath(polaroid._id)).set("Cookie", adminCookie).expect(409);
  assert.equal((await sync().expect(200)).body.sharpnessTest, null);

  const created = (await request(app).post(testPath(room._id)).set("Cookie", adminCookie).expect(201)).body;
  assert.equal(created.status, "queued");
  assert.deepEqual((await sync().expect(200)).body.sharpnessTest, { id: created.id });
  // Máy in của phòng khác không thấy yêu cầu này.
  const other = await Room.create({ name: `Other ${randomUUID()}`, branch: "A", active: true });
  const otherAgent = jwt.sign({ type: "print-agent", room: String(other._id), branch: "A" }, config.secret);
  const otherSync = await request(app).post("/api/print-agent/output-settings/sync").set("Authorization", `Bearer ${otherAgent}`)
    .send({ applied: { gamma: 1.5, maxResolution: true } }).expect(200);
  assert.equal(otherSync.body.sharpnessTest, null);

  // Báo sai mã yêu cầu: không đổi gì; báo đúng: hết chờ, danh sách máy in hiện kết quả.
  const report = (body) => request(app).post("/api/print-agent/output-settings/sync").set("Authorization", `Bearer ${agent}`)
    .send({ applied: { gamma: 1.5, maxResolution: true, sharpen: 2 }, sharpnessTest: body });
  await report({ id: randomUUID(), sent: true }).expect(200);
  assert.deepEqual((await sync().expect(200)).body.sharpnessTest, { id: created.id });
  await report({ id: "not-a-uuid", sent: true }).expect(400);
  assert.equal((await report({ id: created.id, sent: true, message: "Đã in tờ thử độ nét (1844x1240)." }).expect(200)).body.sharpnessTest, null);
  const printer = (await request(app).get("/api/admin/print-jobs/printers").set("Cookie", adminCookie).expect(200)).body
    .find((row) => row.room === String(room._id));
  assert.equal(printer.sharpnessTest.status, "sent");
  assert.equal(printer.sharpnessTest.message, "Đã in tờ thử độ nét (1844x1240).");

  // Yêu cầu quá 15 phút chưa được nhận (máy in tắt): bỏ, không in bất ngờ lúc sau.
  await request(app).post(testPath(room._id)).set("Cookie", adminCookie).expect(201);
  await Setting.updateOne({ key: `printers:room:${room._id}` }, { $set: { "value.sharpnessTest.at": new Date(Date.now() - 16 * 60_000) } });
  assert.equal((await sync().expect(200)).body.sharpnessTest, null);
  assert.equal(await PrintJob.countDocuments({ room: room._id }), 0, "a test print never becomes a guest print job");
});
