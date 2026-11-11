// The database (Atlas, Hong Kong) is far from the free server, so every query costs a long round
// trip. These tests pin the number of database commands on the hottest requests.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, Room, Setting, User } from "../src/models/index.js";
import { catalogCache } from "../src/services/read-cache.js";

let memory;
// Database commands (find, update, aggregate…) sent while `action` runs.
async function commands(action) {
  const seen = [];
  const client = mongoose.connection.getClient();
  const monitor = (event) => {
    if (!["ping", "hello", "isMaster", "endSessions"].includes(event.commandName))
      seen.push(`${event.commandName}:${event.command[event.commandName]}`);
  };
  client.on("commandStarted", monitor);
  try { await action(); } finally { client.off("commandStarted", monitor); }
  return seen;
}
const cookieFor = (user) => "session=" + jwt.sign({ sub: String(user._id), version: user.sessionVersion || 0 }, config.secret);

before(async () => {
  config.secret = "isolated-round-trip-test-secret-1234567890";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri(), { monitorCommands: true });
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});
after(async () => { await mongoose.disconnect(); await memory?.stop(); });

test("the catalog is read from the database once, and any admin edit shows on the next request", async () => {
  await Room.create({ name: "Phòng cache", active: true });
  await request(app).get("/api/catalog").expect(200);
  const repeated = await commands(() => request(app).get("/api/catalog").expect(200));
  assert.deepEqual(repeated, [], "a repeated catalog request does not touch the database");
  await Room.create({ name: "Phòng mới", active: true });
  const after = (await request(app).get("/api/catalog").expect(200)).body;
  assert.ok(after.rooms.some((r) => r.name === "Phòng mới"), "a new room is visible at once");
  await Setting.findOneAndUpdate({ key: "studio" }, { value: { name: "Đổi tên" } }, { upsert: true });
  assert.equal((await request(app).get("/api/catalog").expect(200)).body.settings.name, "Đổi tên");
  await Room.updateOne({ name: "Phòng mới" }, { active: false });
  assert.ok(!(await request(app).get("/api/catalog")).body.rooms.some((r) => r.name === "Phòng mới"));
});

test("six kiosks opening a cold catalog share one set of six database reads", async () => {
  catalogCache.clear();
  const sent = await commands(() => Promise.all(Array.from({ length: 6 }, () =>
    request(app).get("/api/catalog").expect(200))));
  assert.equal(sent.length, 6, sent.join(", "));
  assert.equal(new Set(sent).size, 6, "one query per collection, rather than six per kiosk");
});

test("admin session checks are cached, but deactivation and password changes apply on the next request", async () => {
  const user = await User.create({ name: "Lễ tân", email: `cache-${randomUUID()}@test.local`, role: "staff" });
  const cookie = cookieFor(user);
  await request(app).get("/api/auth/me").set("Cookie", cookie).expect(200);
  const repeated = await commands(() => request(app).get("/api/auth/me").set("Cookie", cookie).expect(200));
  assert.deepEqual(repeated, [], "the session check is answered without a database query");
  await User.updateOne({ _id: user._id }, { active: false });
  await request(app).get("/api/auth/me").set("Cookie", cookie).expect(401);
  await User.updateOne({ _id: user._id }, { active: true, $inc: { sessionVersion: 1 } });
  // An old session after a password change (sessionVersion moved on).
  await request(app).get("/api/auth/me").set("Cookie", cookie).expect(401);
  const fresh = await User.findById(user._id).select("+sessionVersion");
  await request(app).get("/api/auth/me").set("Cookie", cookieFor(fresh)).expect(200);
});

test("the booth heartbeat is a single database command and still rejects a replaced session", async () => {
  const sessionId = randomUUID();
  const b = await Booking.create({
    code: String(Math.floor(100000 + Math.random() * 899999)), accessToken: randomUUID(),
    status: "checked_in", captureSession: sessionId, captureEndsAt: new Date(Date.now() + 600000),
  });
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id), sessionId }, config.secret);
  let body;
  const sent = await commands(async () => {
    body = (await request(app).post("/api/kiosk/state")
      .send({ captureToken, diag: { folder: "X Acquire", jpegs: 3 } }).expect(200)).body;
  });
  assert.equal(sent.length, 1, sent.join(", "));
  assert.match(sent[0], /^findAndModify:bookings$/);
  assert.equal(body.booking.code, b.code);
  const stored = await Booking.findById(b._id).select("+captureDiag");
  assert.ok(stored.captureSeenAt > new Date(Date.now() - 5000));
  assert.equal(stored.captureDiag.jpegs, 3);
  await Booking.updateOne({ _id: b._id }, { captureSession: randomUUID() });
  const replaced = await request(app).post("/api/kiosk/state").send({ captureToken }).expect(409);
  assert.match(replaced.body.message, /máy chụp khác/);
  await Booking.updateOne({ _id: b._id }, { captureSession: sessionId, status: "completed" });
  const done = await request(app).post("/api/kiosk/state").send({ captureToken }).expect(200);
  assert.equal(done.body.booking.status, "completed", "a finished session still answers");
  await request(app).post("/api/kiosk/state").send({ captureToken: "not-a-token" }).expect(401);
});

test("health can report one timed database round trip without caching", async () => {
  const response = await request(app).get("/api/health?db=1").expect(200);
  assert.match(response.headers["server-timing"], /^db;dur=\d+$/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await request(app).get("/api/health").expect(200)).headers["server-timing"], undefined,
    "a plain probe (keep-awake, reconnect) does not query the database");
});
