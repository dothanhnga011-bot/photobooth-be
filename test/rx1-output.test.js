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
  await request(app).get(settingsPath).set("Cookie", staffCookie).expect(403);
  await request(app).put(settingsPath).set("Cookie", staffCookie).send({ gamma: 1.3, maxResolution: true }).expect(403);
  assert.deepEqual((await asAdmin("get").expect(200)).body, { configured: false, settings: { gamma: 1.5, maxResolution: true } });
  assert.equal((await sync({ gamma: 1.18, maxResolution: false }).expect(200)).body.rx1Output, null);
});

test("a web save survives reload, invalidates cached configuration and preserves other studio settings", async () => {
  await Setting.create({ key: "studio", value: { name: "Studio", extraPrintPrice: 10000, kiosk: { idleTitle: "Hello" } } });
  assert.equal(await getRx1Output(), null);
  await asAdmin("put").send({ gamma: 1.4, maxResolution: false }).expect(200);
  assert.deepEqual((await asAdmin("get").expect(200)).body, { configured: true, settings: { gamma: 1.4, maxResolution: false } });
  assert.deepEqual((await sync().expect(200)).body.rx1Output, { gamma: 1.4, maxResolution: false });
  await asAdmin("put").send({ gamma: 1.5, maxResolution: true }).expect(200);
  assert.deepEqual((await sync().expect(200)).body.rx1Output, { gamma: 1.5, maxResolution: true });
  for (const gamma of [1, 1.51, 1.8, 2.2]) {
    const settings = { gamma, maxResolution: true };
    await asAdmin("put").send(settings).expect(200);
    assert.deepEqual((await asAdmin("get").expect(200)).body.settings, settings);
    assert.deepEqual((await sync(settings).expect(200)).body.rx1Output, settings);
  }
  const studio = (await Setting.findOne({ key: "studio" })).value;
  assert.equal(studio.name, "Studio"); assert.equal(studio.extraPrintPrice, 10000);
  assert.deepEqual(studio.kiosk, { idleTitle: "Hello" });
});

test("invalid values and unknown fields cannot change the last valid output", async () => {
  const valid = { gamma: 1.3, maxResolution: true };
  await asAdmin("put").send(valid).expect(200);
  for (const patch of [{ gamma: 0.99 }, { gamma: 2.21 }, { gamma: 1.234 }, { gamma: "1.4" },
    { gamma: true }, { gamma: null }, { maxResolution: "yes" }, { maxResolution: null }, { printer: "another queue" }]) {
    await asAdmin("put").send({ ...valid, ...patch }).expect(400);
    assert.deepEqual(await getRx1Output(), valid);
  }
});

test("sync reports the applied value but never claims a print, changes revenue or edits desired settings", async () => {
  await asAdmin("put").send({ gamma: 1.5, maxResolution: true }).expect(200);
  const booking = await Booking.create({ code: randomUUID(), room: room._id, total: 70000, printSheets: 1 });
  const job = await PrintJob.create({ booking: booking._id, room: room._id, spoolStatus: "queued", status: "pending" });
  assert.deepEqual((await sync({ gamma: 1.3, maxResolution: false }).expect(200)).body.rx1Output, { gamma: 1.5, maxResolution: true });
  const rows = (await request(app).get("/api/admin/print-jobs/printers").set("Cookie", adminCookie).expect(200)).body;
  const printer = rows.find((row) => row.room === String(room._id));
  assert.equal(printer.rx1Output.gamma, 1.3); assert.equal(printer.agent.running, true);
  assert.equal((await PrintJob.findById(job._id)).spoolStatus, "queued");
  const after = await Booking.findById(booking._id);
  assert.equal(after.total, 70000); assert.equal(after.printSheets, 1);
  assert.deepEqual(await getRx1Output(), { gamma: 1.5, maxResolution: true });
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
