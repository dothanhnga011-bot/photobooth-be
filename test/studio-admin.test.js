import { randomUUID } from "node:crypto";
import zlib from "node:zlib";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, Frame, Package, Room, Screen, Setting, Shift, User } from "../src/models/index.js";
import { addDays, previousRange } from "../src/services/stats.js";
import { today } from "../src/routes/validation.js";

let memory, room, other, pack, admin, staff;
const password = "TestPassword!123";
const png = "data:image/png;base64,iVBORw0KGgo=";
const slot = [{ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }];
const login = async (email) => {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password }).expect(200);
  return agent;
};

before(async () => {
  config.secret = "test-secret-only-not-used-in-production-123456789";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  [room, other] = await Room.create([
    { name: "Máy 1", description: "", branch: "Bắc Giang", active: true },
    { name: "Máy 2", description: "", branch: "Hà Nội", active: true },
  ]);
  pack = await Package.create({ name: "Gói 1", price: 100000, duration: 10, shots: 10, prints: 1, active: true });
  const hash = await bcrypt.hash(password, 10);
  await User.create([
    { name: "Admin", email: "admin@test.local", password: hash, role: "admin" },
    { name: "Lễ tân", email: "staff@test.local", password: hash, role: "staff", branch: "Bắc Giang" },
  ]);
  admin = await login("admin@test.local");
  staff = await login("staff@test.local");
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

test("staff permissions default to the old receptionist rights and can be widened per account", async () => {
  const me = (await staff.get("/api/auth/me").expect(200)).body;
  assert.deepEqual(me.permissions, ["orders:export", "print:operate", "shift:operate", "rooms:setup"]);
  assert.equal((await admin.get("/api/auth/me").expect(200)).body.permissions.includes("revenue:view"), true);
  await staff.get("/api/admin/stats/chart").expect(403);
  const summary = (await staff.get("/api/admin/stats/summary").expect(200)).body;
  assert.equal(summary.revenue, undefined, "no money without revenue:view");
  assert.equal(typeof summary.orders, "number");

  const user = await User.findOne({ email: "staff@test.local" });
  await admin.put(`/api/admin/users/${user._id}`).send({
    name: user.name, email: user.email, role: "staff", branch: "Bắc Giang", active: true,
    permissions: ["revenue:view", "orders:cancel", "made:up"],
  }).expect(400);
  await admin.put(`/api/admin/users/${user._id}`).send({
    name: user.name, email: user.email, role: "staff", branch: "Bắc Giang", active: true,
    permissions: ["revenue:view", "orders:cancel"],
  }).expect(200);
  // Đổi quyền không bắt đăng nhập lại; lưu lại không gửi quyền thì giữ nguyên quyền cũ.
  await admin.put(`/api/admin/users/${user._id}`).send({
    name: "Lễ tân Hoa", email: user.email, role: "staff", branch: "Bắc Giang", active: true,
  }).expect(200);
  assert.deepEqual((await staff.get("/api/auth/me").expect(200)).body.permissions, ["revenue:view", "orders:cancel"]);
  await staff.get("/api/admin/stats/chart").expect(200);
  assert.equal(typeof (await staff.get("/api/admin/stats/summary").expect(200)).body.revenue, "number");
  // Không còn quyền in / ca trực / cài máy.
  await staff.post(`/api/admin/rooms/${room._id}/device`).expect(403);
  await staff.post("/api/admin/shifts/open").send({}).expect(403);
  const ticket = await Booking.create({ branch: "Bắc Giang", code: "424242", status: "confirmed", paid: true, total: 1000 });
  await staff.patch(`/api/admin/bookings/${ticket._id}`).send({ status: "cancelled" }).expect(200);
  await User.updateOne({ _id: user._id }, { $unset: { permissions: 1 } });
  await Booking.deleteMany({});
});

test("summary compares with the previous period, splits cash and transfer and ranks themes, packages and machines", async () => {
  const day = today();
  const prev = previousRange(day, day).from;
  await Booking.create([
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", frameName: "Kawaii", date: day, paid: true,
      paymentMethod: "cash", total: 130000, extraSales: [{ sheets: 1, amount: 30000, paymentMethod: "transfer", at: new Date() }] },
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", frameName: "Kawaii", date: day, paid: true, paymentMethod: "transfer", total: 100000 },
    { branch: "Hà Nội", roomName: "Máy 2", packageName: "Gói 2", frameName: "Basic", date: day, paid: true, paymentMethod: "cash", total: 50000 },
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", date: day, paid: false, total: 999000 },
    { branch: "Bắc Giang", roomName: "Máy 1", packageName: "Gói 1", date: prev, paid: true, paymentMethod: "cash", total: 140000 },
  ]);
  try {
    const all = (await admin.get(`/api/admin/stats/summary?from=${day}&to=${day}`).expect(200)).body;
    assert.equal(all.revenue, 280000);
    assert.equal(all.orders, 3);
    assert.equal(all.cash, 100000 + 50000);
    assert.equal(all.transfer, 100000 + 30000);
    assert.equal(all.previousRevenue, 140000);
    assert.equal(all.revenueGrowth, 100);
    assert.equal(all.ordersGrowth, 200);
    assert.deepEqual(all.themes.map((t) => [t.name, t.count]), [["Kawaii", 2], ["Basic", 1]]);
    assert.deepEqual(all.rooms[0], { name: "Máy 1", count: 2, revenue: 230000 });
    const branch = (await admin.get(`/api/admin/stats/summary?from=${day}&to=${day}&branch=Hà Nội`).expect(200)).body;
    assert.equal(branch.revenue, 50000);
    // Lễ tân luôn chỉ thấy chi nhánh của mình, kể cả khi hỏi chi nhánh khác.
    const desk = (await staff.get(`/api/admin/stats/summary?from=${day}&to=${day}&branch=Hà Nội`).expect(200)).body;
    assert.equal(desk.orders, 2);
    await admin.get(`/api/admin/stats/summary?from=${day}&to=${prev}`).expect(400);

    const chart = (await admin.get(`/api/admin/stats/chart?from=${addDays(day, -6)}&to=${day}`).expect(200)).body;
    assert.equal(chart.unit, "day");
    assert.equal(chart.points.length, 7);
    assert.deepEqual(chart.points.at(-1).current, { revenue: 280000, orders: 3 });
    assert.equal(chart.points.at(-1).key, day);
    const yearly = (await admin.get(`/api/admin/stats/chart?from=${addDays(day, -200)}&to=${day}`).expect(200)).body;
    assert.equal(yearly.unit, "month");
    assert.equal(yearly.points.at(-1).key, day.slice(0, 7));
    assert.ok(yearly.points.reduce((n, p) => n + p.current.revenue, 0) >= 280000);
  } finally {
    await Booking.deleteMany({});
  }
});

test("monthly reconciliation lists closed shifts with their difference and paid money per branch", async () => {
  const opened = new Date();
  await Booking.create([
    { branch: "Bắc Giang", paid: true, paidAt: opened, paymentMethod: "cash", total: 70000, status: "confirmed" },
    { branch: "Hà Nội", paid: true, paidAt: opened, paymentMethod: "transfer", total: 90000, status: "confirmed" },
  ]);
  await Shift.create([
    { branch: "Bắc Giang", open: false, openedAt: opened, closedAt: opened, openingCash: 500000, closingCash: 560000,
      summary: { tickets: 1, extraSheets: 0, cash: 70000, transfer: 0, total: 70000 } },
    { branch: "Hà Nội", open: false, openedAt: opened, closedAt: opened, openingCash: 0, closingCash: 0,
      summary: { tickets: 1, extraSheets: 0, cash: 0, transfer: 90000, total: 90000 } },
  ]);
  try {
    const month = today().slice(0, 7);
    const report = (await admin.get(`/api/admin/shifts/report?month=${month}`).expect(200)).body;
    assert.equal(report.totals.shifts, 2);
    assert.equal(report.totals.matched, 1);
    assert.equal(report.totals.difference, -10000);
    assert.equal(report.totals.total, 160000);
    assert.deepEqual(report.branches.map((b) => b.branch), ["Bắc Giang", "Hà Nội"]);
    await staff.get(`/api/admin/shifts/report?month=${month}`).expect(403);
    await admin.get("/api/admin/shifts/report?month=2026-13").expect(400);
  } finally {
    await Booking.deleteMany({});
    await Shift.deleteMany({});
  }
});

test("waiting screens: one general screen plus per-machine screens reach the catalog with cached images", async () => {
  await Setting.findOneAndUpdate({ key: "studio" },
    { $set: { "value.kiosk": { idleTitle: "Cũ", idleSubtitle: "", idleImage: png } } }, { upsert: true });
  await staff.get("/api/admin/screens").expect(403);
  const [general] = (await admin.get("/api/admin/screens").expect(200)).body;
  assert.equal(general.isDefault, true);
  assert.equal(general.title, "Cũ", "the old idle screen becomes the general screen");
  assert.equal(general.images.length, 1);
  await admin.delete(`/api/admin/screens/${general._id}`).expect(409);
  await admin.post("/api/admin/screens").send({ name: "Riêng", rooms: [], images: [] }).expect(400);
  let list = (await admin.post("/api/admin/screens").send({
    name: "Máy 1", rooms: [String(room._id)], title: "Xin chào", images: [{ data: png }, { data: png }], interval: 4,
  }).expect(200)).body;
  const own = list.find((s) => !s.isDefault);
  assert.equal(own.images.length, 2);
  // Giữ ảnh cũ theo _id, bỏ ảnh còn lại, đổi thứ tự cấu hình.
  list = (await admin.put(`/api/admin/screens/${own._id}`).send({
    name: "Máy 1", rooms: [String(room._id), String(other._id)], images: [{ _id: own.images[1]._id }],
  }).expect(200)).body;
  assert.equal(list.find((s) => s._id === own._id).images[0]._id, own.images[1]._id);
  // Một máy chỉ thuộc một cấu hình riêng.
  list = (await admin.post("/api/admin/screens").send({
    name: "Máy 2 riêng", rooms: [String(other._id)], images: [],
  }).expect(200)).body;
  assert.deepEqual(list.find((s) => s._id === own._id).rooms, [String(room._id)]);
  const catalog = (await request(app).get("/api/catalog").expect(200)).body;
  const screen = catalog.screens.find((s) => s._id === own._id);
  assert.match(screen.images[0].url, /^\/api\/screens\/[a-f0-9]{24}\/images\/[a-f0-9]{24}\?v=[a-f0-9]{12}$/);
  const image = await request(app).get(screen.images[0].url).expect(200);
  assert.equal(image.headers["content-type"], "image/png");
  await admin.delete(`/api/admin/screens/${own._id}`).expect(200);
  await Screen.deleteMany({});
});

test("themes group frames: rename, hide from customers, order and ungroup without deleting frames", async () => {
  const frame = (name, themeName, order, printSize = "full") =>
    admin.post("/api/admin/frames").send({ name, themeName, order, printSize, image: png, slots: slot, active: true }).expect(200);
  await frame("A1", "Kawaii", 1);
  await frame("A2", "Kawaii", 2);
  await frame("B1", "Basic", 1);
  await frame("W1", "Wide trắng", 1, "instax");
  try {
    await staff.get("/api/admin/themes").expect(403);
    let themes = (await admin.get("/api/admin/themes").expect(200)).body;
    assert.deepEqual(themes.map((t) => [t.name, t.frames, t.slots, t.kind]).sort(),
      [["Basic", 1, 1, "photobooth"], ["Kawaii", 2, 2, "photobooth"], ["Wide trắng", 1, 1, "polaroid"]],
      "a theme without a stored kind follows its frames: Instax frames make it a Polaroid theme");
    await admin.post("/api/admin/themes").send({ name: "Sai loại", kind: "dnp" }).expect(400);
    themes = (await admin.post("/api/admin/themes").send({ name: "Wide hồng", kind: "polaroid" }).expect(201)).body;
    assert.deepEqual([themes.find((t) => t.name === "Wide hồng").kind, themes.find((t) => t.name === "Kawaii").kind],
      ["polaroid", "photobooth"]);
    await admin.delete(`/api/admin/themes/${encodeURIComponent("Wide hồng")}`).expect(200);
    await admin.delete(`/api/admin/themes/${encodeURIComponent("Wide trắng")}`).expect(200);
    await Frame.deleteOne({ name: "W1" });
    themes = (await admin.post("/api/admin/themes").send({ name: "Limited" }).expect(201)).body;
    assert.equal(themes.find((t) => t.name === "Limited").frames, 0);
    assert.equal(themes.find((t) => t.name === "Limited").kind, "photobooth");
    await admin.post("/api/admin/themes").send({ name: "kawaii" }).expect(409);
    await admin.put("/api/admin/themes").send({ name: "Kawaii", newName: "Basic" }).expect(409);
    themes = (await admin.put("/api/admin/themes").send({ name: "Kawaii", newName: "Dễ thương" }).expect(200)).body;
    assert.equal(await Frame.countDocuments({ themeName: "Dễ thương" }), 2);
    themes = (await admin.put("/api/admin/themes").send({ name: "Basic", active: false }).expect(200)).body;
    const catalog = (await request(app).get("/api/catalog").expect(200)).body;
    assert.equal(catalog.frames.some((f) => f.themeName === "Basic"), false, "hidden theme frames leave the catalog");
    assert.equal(catalog.frames.filter((f) => f.themeName === "Dễ thương").length, 2);
    const names = ["Limited", "Basic", "Dễ thương"];
    await admin.put("/api/admin/themes/order").send({ names: ["Basic"] }).expect(409);
    themes = (await admin.put("/api/admin/themes/order").send({ names }).expect(200)).body;
    assert.deepEqual(themes.map((t) => t.name), names);
    themes = (await admin.delete(`/api/admin/themes/${encodeURIComponent("Dễ thương")}`).expect(200)).body;
    assert.deepEqual(themes.map((t) => t.name), ["Limited", "Basic"]);
    assert.equal(await Frame.countDocuments({ themeName: "" }), 2, "frames stay as single frames");
  } finally {
    await Frame.deleteMany({});
    await Setting.updateOne({ key: "studio" }, { $unset: { "value.themes": 1 } });
  }
});

test("custom filters are validated and published in the catalog settings", async () => {
  const filter = { id: "abc123", name: "Hồng dịu", brightness: 105, contrast: 95, saturate: 110, sepia: 10, hueRotate: -5 };
  await staff.put("/api/admin/settings/custom-filters").send({ customFilters: [filter] }).expect(403);
  await admin.put("/api/admin/settings/custom-filters").send({ customFilters: [{ ...filter, contrast: 500 }] }).expect(400);
  await admin.put("/api/admin/settings/custom-filters").send({ customFilters: [filter, filter] }).expect(400);
  await admin.put("/api/admin/settings/custom-filters").send({ customFilters: [filter] }).expect(200);
  const settings = (await request(app).get("/api/catalog").expect(200)).body.settings;
  assert.deepEqual(settings.customFilters, [{ ...filter, active: true }]);
});

test("the room kind is set when the room is saved; only admins switch the photobooth test mode", async () => {
  const setup = (body, as = admin) => as.post(`/api/admin/rooms/${room._id}/device`).send(body);
  const saveRoom = (kind) => admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", kind, active: true,
  }).expect(200);
  // Lễ tân (quyền Cài máy chụp) lấy được liên kết nhưng không tự bật chế độ thử (khách chụp không trả tiền).
  const refused = await setup({ paymentTest: true }, staff).expect(403);
  assert.match(refused.body.message, /Chỉ quản trị viên/);
  assert.equal(Boolean((await Room.findById(room._id).lean()).paymentTest), false);
  const booth = (await setup({ paymentTest: true }).expect(200)).body;
  assert.deepEqual([booth.kind, booth.paymentTest], ["photobooth", true]);
  // Gửi đúng trạng thái đang lưu (không đổi gì) thì lễ tân vẫn cài máy được.
  assert.equal((await setup({ paymentTest: true }, staff).expect(200)).body.paymentTest, true);
  await setup({ paymentTest: false }, staff).expect(403);
  const ping = (await request(app).post("/api/kiosk/ping").send({ device: booth.token }).expect(200)).body;
  assert.equal(ping.room.kind, "photobooth");
  assert.equal(ping.room.paymentTest, true);
  assert.equal(ping.room.cashCheckoutReady, true);
  // "Cài máy chụp" không đổi loại phòng (loại phòng chọn lúc thêm phòng), kể cả khi gửi kèm.
  const ignored = (await setup({ kind: "polaroid" }).expect(200)).body;
  assert.deepEqual([ignored.kind, ignored.paymentTest], ["photobooth", true]);
  assert.equal((await Room.findById(room._id).lean()).kind, "photobooth");
  // Phòng Polaroid (quản trị lưu phòng): không thu tiền tại máy, không có chế độ thử.
  await saveRoom("polaroid");
  const polaroid = (await setup({}, staff).expect(200)).body;
  assert.deepEqual([polaroid.kind, polaroid.paymentTest], ["polaroid", false]);
  const pinged = (await request(app).post("/api/kiosk/ping").send({ device: polaroid.token }).expect(200)).body;
  assert.deepEqual([pinged.room.kind, pinged.room.cashCheckoutReady], ["polaroid", false]);
  assert.equal((await setup({ paymentTest: true }).expect(200)).body.paymentTest, false);
  await setup({ paymentTest: "yes" }).expect(400);
  await saveRoom("photobooth");
  await setup({ paymentTest: false }).expect(200);
  const saved = await Room.findById(room._id).lean();
  assert.deepEqual([saved.kind, saved.paymentTest], ["photobooth", false]);
});

test("kiosks report online with the remote flip mode; packages can be limited to branches", async () => {
  await admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", flip: "off", active: true,
  }).expect(200);
  const { token } = (await staff.post(`/api/admin/rooms/${room._id}/device`).expect(200)).body;
  await request(app).post("/api/kiosk/ping").send({ device: "bad" }).expect(403);
  const ping = (await request(app).post("/api/kiosk/ping").send({ device: token }).expect(200)).body;
  assert.deepEqual(ping.room, {
    _id: String(room._id), name: "Máy 1", branch: "Bắc Giang", flip: "off", kind: "photobooth", paymentTest: false,
    cashCheckoutReady: true,
    printers: { instax: { ready: false, film: null, message: "Máy in Instax chưa kết nối với máy tính." } },
  });
  const listed = (await admin.get("/api/admin/rooms").expect(200)).body.find((r) => r._id === String(room._id));
  assert.ok(Date.now() - new Date(listed.lastSeenAt) < 60000);
  assert.equal(listed.flip, "off");

  await admin.put(`/api/admin/packages/${pack._id}`).send({
    name: "Gói 1", description: "", price: 100000, duration: 10, prints: 2, branches: ["Hà Nội"], active: true,
  }).expect(200);
  const draft = { name: "Khách", phone: "0388123456", room: "", branch: "", package: String(pack._id), requestKey: randomUUID() };
  const refused = await staff.post("/api/admin/tickets/draft").send(draft).expect(400);
  assert.match(refused.body.message, /không áp dụng tại chi nhánh Bắc Giang/);
  await admin.put(`/api/admin/packages/${pack._id}`).send({
    name: "Gói 1", description: "", price: 100000, duration: 10, prints: 2, branches: [], active: true,
  }).expect(200);
  await staff.post("/api/admin/tickets/draft").send({ ...draft, requestKey: randomUUID() }).expect(201);
  await Booking.deleteMany({});
});

test("packages snapshot how many photos the guest picks; the kiosk uploads one timelapse video per session", async () => {
  await admin.put(`/api/admin/packages/${pack._id}`).send({
    name: "Gói 1", description: "", price: 100000, duration: 10, prints: 2, selectCount: 6, active: true,
  }).expect(200);
  await admin.put(`/api/admin/packages/${pack._id}`).send({
    name: "Gói 1", description: "", price: 100000, duration: 10, prints: 2, selectCount: 40, active: true,
  }).expect(400);
  const draft = (await staff.post("/api/admin/tickets/draft").send({
    name: "Khách", phone: "0388123456", room: "", branch: "", package: String(pack._id), requestKey: randomUUID(),
  }).expect(201)).body;
  assert.equal((await Booking.findById(draft._id).lean()).selectCount, 6);

  const sessionId = "session-video-test";
  const accessToken = "v".repeat(48);
  const booking = await Booking.create({
    branch: "Bắc Giang", code: "515151", status: "checked_in", paid: true, accessToken,
    captureSession: sessionId, captureStartedAt: new Date(), captureEndsAt: new Date(Date.now() + 600000),
  });
  const captureToken = jwt.sign({ type: "capture", booking: String(booking._id), sessionId }, config.secret);
  await request(app).get(`/api/albums/${accessToken}/video`).expect(404);
  await request(app).post("/api/kiosk/video").set("X-Capture-Token", "bad").set("Content-Type", "video/webm")
    .send(Buffer.from("x")).expect(401);
  const clip = Buffer.alloc(2048, 7);
  await request(app).post("/api/kiosk/video").set("X-Capture-Token", captureToken)
    .set("Content-Type", "video/mp4").send(clip).expect(201);
  // Gửi lại thay video cũ.
  await request(app).post("/api/kiosk/video").set("X-Capture-Token", captureToken)
    .set("Content-Type", "video/mp4").send(clip).expect(201);
  const album = (await request(app).get(`/api/albums/${accessToken}`).expect(200)).body;
  assert.deepEqual(album.video, { mimeType: "video/mp4", size: 2048 });
  const video = await request(app).get(`/api/albums/${accessToken}/video?download=1`).expect(200);
  assert.equal(video.headers["content-type"], "video/mp4");
  assert.match(video.headers["content-disposition"], /NXC-515151-video\.mp4/);
  const part = await request(app).get(`/api/albums/${accessToken}/video`).set("Range", "bytes=0-99").expect(206);
  assert.equal(part.headers["content-length"], "100");
  await Booking.deleteMany({});
});

test("guests can buy a session at the kiosk with cash; test mode skips payment without revenue", async () => {
  // Phòng Polaroid: không bán lượt bằng tiền mặt tại máy (khách trả ở quầy).
  await admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", kind: "polaroid", paymentTest: false, active: true,
  }).expect(200);
  const { token } = (await staff.post(`/api/admin/rooms/${room._id}/device`).expect(200)).body;
  const sale = (extra) => ({ device: token, package: String(pack._id), requestKey: randomUUID(), ...extra });
  const refused = await request(app).post("/api/kiosk/sale").send(sale({ bills: [{ amount: 100000 }] })).expect(403);
  assert.match(refused.body.message, /Polaroid/);
  // Phòng photobooth chưa bật chế độ thử: không bỏ qua bước đút tiền.
  await admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", kind: "photobooth", paymentTest: false, active: true,
  }).expect(200);
  await request(app).post("/api/kiosk/sale").send(sale({ skip: true })).expect(403);
  await admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", kind: "photobooth", paymentTest: true, active: true,
  }).expect(200);
  const ping = (await request(app).post("/api/kiosk/ping").send({ device: token }).expect(200)).body.room;
  assert.equal(ping.kind, "photobooth");
  assert.equal(ping.paymentTest, true);
  assert.equal(ping.cashCheckoutReady, true);
  const short = await request(app).post("/api/kiosk/sale").send(sale({ bills: [{ amount: 50000 }] })).expect(400);
  assert.match(short.body.message, /Chưa đủ tiền/);
  const paid = sale({ bills: [{ amount: 50000 }, { amount: 100000 }] });
  const first = (await request(app).post("/api/kiosk/sale").send(paid).expect(201)).body;
  assert.ok(first.captureToken && first.accessToken);
  assert.equal(first.booking.status, "checked_in");
  // Mất phản hồi rồi gửi lại: cùng lượt chụp, không thu lần hai.
  const again = (await request(app).post("/api/kiosk/sale").send(paid).expect(200)).body;
  assert.equal(again.booking._id, first.booking._id);
  const stored = await Booking.findById(first.booking._id).lean();
  assert.equal(stored.total, 100000);
  assert.equal(stored.cashReceived, 150000);
  assert.equal(stored.paymentMethod, "cash");
  assert.equal(stored.source, "kiosk");
  assert.equal(stored.prints, 2, "no print count sent: the package's sheets");
  await request(app).post("/api/kiosk/start").send({ captureToken: first.captureToken }).expect(200);
  const test = (await request(app).post("/api/kiosk/sale").send(sale({ skip: true })).expect(201)).body;
  const free = await Booking.findById(test.booking._id).lean();
  assert.equal(free.paid, false);
  assert.equal(free.total, 0);
  const day = today();
  const summary = (await admin.get(`/api/admin/stats/summary?from=${day}&to=${day}`).expect(200)).body;
  assert.equal(summary.orders, 1, "test sessions are not orders");
  assert.equal(summary.revenue, 100000);

  // Số tờ khách chọn: dưới mức tối thiểu bị từ chối; tờ thêm tính theo giá in thêm.
  const below = await request(app).post("/api/kiosk/sale").send(sale({ prints: 1, bills: [{ amount: 200000 }] })).expect(400);
  assert.match(below.body.message, /in tối thiểu 2 tờ/);
  const unpriced = await request(app).post("/api/kiosk/sale").send(sale({ prints: 3, bills: [{ amount: 200000 }] })).expect(400);
  assert.match(unpriced.body.message, /Chưa đặt giá in thêm/);
  await admin.put("/api/admin/settings/extra-print-price").send({ extraPrintPrice: 15000 }).expect(200);
  const short3 = await request(app).post("/api/kiosk/sale").send(sale({ prints: 3, bills: [{ amount: 100000 }] })).expect(400);
  assert.match(short3.body.message, /cần 115\.000 đ/);
  await request(app).post("/api/kiosk/sale")
    .send(sale({ prints: 3, expectedTotal: 110000, bills: [{ amount: 110000 }] })).expect(409);
  const extra = (await request(app).post("/api/kiosk/sale")
    .send(sale({ prints: 3, expectedTotal: 115000, bills: [{ amount: 100000 }, { amount: 20000 }] })).expect(201)).body;
  const extraStored = await Booking.findById(extra.booking._id).lean();
  assert.equal(extraStored.prints, 3);
  assert.equal(extraStored.total, 115000);
  assert.equal(extraStored.cashReceived, 120000);
  await Setting.updateOne({ key: "studio" }, { $unset: { "value.extraPrintPrice": 1 } });
  await Booking.deleteMany({});
});

test("packages print at least two pieces: one strip sheet cut in half, or two full sheets", async () => {
  const base = { name: "Gói 1", description: "", price: 100000, duration: 10, active: true };
  const full = await admin.put(`/api/admin/packages/${pack._id}`).send({ ...base, printSize: "full", prints: 1 }).expect(400);
  assert.match(full.body.message, /Số tờ in: khổ to kèm ít nhất 2 tờ/);
  const strip = await admin.put(`/api/admin/packages/${pack._id}`).send({ ...base, printSize: "strip", prints: 0 }).expect(400);
  assert.match(strip.body.message, /khổ nhỏ kèm ít nhất 1 tờ/);
  await admin.put(`/api/admin/packages/${pack._id}`).send({ ...base, printSize: "strip", prints: 1 }).expect(200);
  await admin.put(`/api/admin/packages/${pack._id}`).send({ ...base, printSize: "full", prints: 2 }).expect(200);
});

test("Instax: two prints minimum, its own extra price, and the kiosk sells it only while the printer is ready", async () => {
  const base = { name: "Gói Instax", description: "", price: 120000, duration: 10, active: true, printSize: "instax" };
  const one = await admin.put(`/api/admin/packages/${pack._id}`).send({ ...base, prints: 1 }).expect(400);
  assert.match(one.body.message, /khổ Instax kèm ít nhất 2 tấm/);
  await admin.put(`/api/admin/packages/${pack._id}`).send({ ...base, prints: 2 }).expect(200);
  await admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", kind: "polaroid", paymentTest: false, active: true,
  }).expect(200);
  const { token } = (await staff.post(`/api/admin/rooms/${room._id}/device`).expect(200)).body;
  const instax = async () => (await request(app).post("/api/kiosk/ping").send({ device: token }).expect(200)).body.room.printers.instax;
  assert.equal((await instax()).ready, false);

  const previous = config.printAgentToken;
  config.printAgentToken = randomUUID() + randomUUID();
  const agent = (body) => request(app).post("/api/print-agent/status")
    .set("Authorization", `Bearer ${config.printAgentToken}`).send(body);
  try {
    await request(app).post("/api/print-agent/status").send({ branch: "Bắc Giang" }).expect(403);
    await agent({ branch: "Bắc Giang", instax: { connected: true, film: 1, battery: 80 } }).expect(200);
    assert.deepEqual({ ...(await instax()), at: undefined },
      { ready: false, film: 1, battery: 80, charging: false, at: undefined, message: "Máy Instax chỉ còn 1 tấm phim." });
    await agent({ branch: "Bắc Giang", instax: { connected: false, message: "Không kết nối được máy Instax" } }).expect(200);
    assert.equal((await instax()).message, "Không kết nối được máy Instax");
    await agent({ branch: "Bắc Giang", instax: { connected: true, film: 8, battery: 60, charging: true } }).expect(200);
    const ready = await instax();
    assert.equal(ready.ready, true);
    assert.equal(ready.film, 8);
    const listed = (await staff.get("/api/admin/print-jobs/printers").expect(200)).body;
    assert.deepEqual(listed.map((row) => [row.branch, row.instax.ready, row.instax.film]), [["Bắc Giang", true, 8]]);
    // Báo cũ hơn 3 phút: print agent đã tắt, không bán khổ Instax nữa.
    await Setting.collection.updateOne({ key: "printers:Bắc Giang" }, { $set: { "value.at": new Date(Date.now() - 4 * 60000) } });
    assert.match((await instax()).message, /không báo về/);
  } finally {
    config.printAgentToken = previous;
    await Setting.collection.deleteOne({ key: "printers:Bắc Giang" });
  }

  // Tấm Instax thêm tính theo giá in thêm Instax, không theo giá tờ 10 × 15.
  await admin.put("/api/admin/settings/extra-print-price").send({}).expect(400);
  await admin.put("/api/admin/settings/extra-print-price").send({ extraPrintPrice: 15000, extraInstaxPrice: 25000 }).expect(200);
  await admin.put("/api/admin/settings/extra-print-price").send({ extraInstaxPrice: 30000 }).expect(200);
  const prices = (await request(app).get("/api/catalog").expect(200)).body.settings;
  assert.deepEqual([prices.extraPrintPrice, prices.extraInstaxPrice], [15000, 30000]);
  // Phòng Polaroid: khách chọn layout (gói khổ Instax) rồi vào chụp luôn, trả tiền ở quầy.
  const layout = { device: token, package: String(pack._id), requestKey: randomUUID() };
  const started = (await request(app).post("/api/kiosk/polaroid").send(layout).expect(201)).body;
  assert.ok(started.captureToken && started.accessToken);
  // Gửi lại sau khi mất phản hồi: đúng lượt chụp cũ, không tạo đơn mới.
  const replay = (await request(app).post("/api/kiosk/polaroid").send(layout).expect(200)).body;
  assert.equal(replay.booking._id, started.booking._id);
  let stored = await Booking.findById(started.booking._id).lean();
  assert.deepEqual([stored.printSize, stored.prints, stored.total, stored.paid, stored.source, stored.status],
    ["instax", 2, 120000, false, "polaroid", "checked_in"]);
  // Không bán gói Instax bằng tiền mặt ở máy; nhân viên ghi nhận đã thu ở quầy.
  await request(app).post("/api/kiosk/sale").send({ ...layout, requestKey: randomUUID(), bills: [{ amount: 200000 }] }).expect(403);
  const collected = (await staff.patch(`/api/admin/bookings/${stored._id}`).send({ collected: "transfer" }).expect(200)).body;
  assert.equal(collected.paid, true);
  stored = await Booking.findById(stored._id).lean();
  assert.deepEqual([stored.paid, stored.paymentMethod], [true, "transfer"]);
  assert.ok(stored.paidAt);
  await staff.patch(`/api/admin/bookings/${stored._id}`).send({ collected: "cash" }).expect(409);
  // Phòng photobooth không mở lượt Polaroid.
  await admin.put(`/api/admin/rooms/${room._id}`).send({
    name: "Máy 1", description: "", branch: "Bắc Giang", kind: "photobooth", paymentTest: false, active: true,
  }).expect(200);
  await request(app).post("/api/kiosk/polaroid").send({ ...layout, requestKey: randomUUID() }).expect(403);

  await Setting.updateOne({ key: "studio" }, { $unset: { "value.extraPrintPrice": 1, "value.extraInstaxPrice": 1 } });
  await admin.put(`/api/admin/packages/${pack._id}`)
    .send({ ...base, name: "Gói 1", price: 100000, printSize: "full", prints: 2 }).expect(200);
  await Booking.deleteMany({});
});

test("frames keep photo numbers, copied regions, QR and print-date regions", async () => {
  const sheet = {
    name: "Dải đôi", themeName: "Kawaii", printSize: "strip", sheet: true, dateColor: "#aa3366", shots: 6,
    image: png, active: true,
    slots: [
      { x: 0.05, y: 0.05, w: 0.4, h: 0.25, kind: "photo", photo: 1 },
      { x: 0.55, y: 0.05, w: 0.4, h: 0.25, kind: "photo", photo: 1 },
      { x: 0.05, y: 0.35, w: 0.4, h: 0.25, kind: "photo", photo: 2 },
      { x: 0.55, y: 0.35, w: 0.4, h: 0.25, kind: "photo", photo: 2 },
      { x: 0.05, y: 0.9, w: 0.1, h: 0.07, kind: "qr", photo: 3 },
      { x: 0.2, y: 0.92, w: 0.2, h: 0.04, kind: "date" },
    ],
  };
  const saved = (await admin.post("/api/admin/frames").send(sheet).expect(200)).body;
  assert.equal(saved.sheet, true);
  assert.equal(saved.dateColor, "#aa3366");
  assert.equal(saved.shots, 6);
  assert.deepEqual(saved.slots.map((s) => [s.kind, s.photo]), [
    ["photo", 1], ["photo", 1], ["photo", 2], ["photo", 2], ["qr", undefined], ["date", undefined],
  ]);
  const catalog = (await request(app).get("/api/catalog").expect(200)).body;
  assert.equal(catalog.frames.find((f) => f._id === saved._id).slots.length, 6);
  await admin.post("/api/admin/frames").send({ ...sheet, slots: [sheet.slots[4]] }).expect(400);
  await admin.post("/api/admin/frames").send({ ...sheet, dateColor: "red" }).expect(400);
  await Frame.deleteMany({});
});

test("frame lists carry a light WebP preview; the original stays untouched for printing", async () => {
  const sharp = (await import("sharp")).default;
  const hole = await sharp({ create: { width: 480, height: 440, channels: 4, background: "#000" } }).png().toBuffer();
  const big = await sharp({ create: { width: 1200, height: 1800, channels: 4, background: { r: 231, g: 143, b: 168, alpha: 1 } } })
    .composite([{ input: hole, left: 60, top: 100, blend: "dest-out" }])
    .png()
    .toBuffer();
  const image = `data:image/png;base64,${big.toString("base64")}`;
  const slots = [{ x: 0.05, y: 0.05, w: 0.4, h: 0.25 }];
  const saved = (await admin.post("/api/admin/frames")
    .send({ name: "Lớn", themeName: "Kawaii", printSize: "full", image, active: true, slots }).expect(200)).body;
  assert.equal(saved.thumb, undefined, "không trả ảnh xem nhanh base64 về trang sửa");
  const item = (await request(app).get("/api/catalog").expect(200)).body.frames.find((f) => f._id === saved._id);
  assert.equal(item.thumb, `${item.image}&size=thumb`);
  const thumb = await request(app).get(item.thumb).expect(200);
  assert.equal(thumb.headers["content-type"], "image/webp");
  assert.match(thumb.headers["cache-control"], /immutable/);
  const meta = await sharp(thumb.body).metadata();
  assert.deepEqual([meta.width, meta.height, meta.hasAlpha], [480, 720, true]);
  assert.ok(thumb.body.length < big.length, `${thumb.body.length} < ${big.length}`);
  assert.deepEqual((await request(app).get(item.image).expect(200)).body, big, "ảnh gốc để ghép / in giữ nguyên");
  // Khung cũ chưa có ảnh xem nhanh: tạo khi có người xem lần đầu rồi lưu lại.
  await Frame.collection.updateOne({ _id: new mongoose.Types.ObjectId(saved._id) }, { $unset: { thumb: 1 } });
  assert.equal((await request(app).get(item.thumb).expect(200)).headers["content-type"], "image/webp");
  assert.match((await Frame.findById(saved._id).select("thumb").lean()).thumb, /^data:image\/webp;base64,/);
  // Ảnh không đọc được: vẫn trả ảnh gốc.
  const broken = (await admin.post("/api/admin/frames")
    .send({ name: "Hỏng", image: png, active: true, slots }).expect(200)).body;
  const brokenItem = (await admin.get("/api/admin/frames").expect(200)).body.find((f) => f._id === broken._id);
  assert.equal((await request(app).get(brokenItem.thumb).expect(200)).headers["content-type"], "image/png");
  const themes = (await admin.get("/api/admin/themes").expect(200)).body;
  assert.ok(themes.find((t) => t.name === "Kawaii").previews.every((u) => u.endsWith("&size=thumb")));
  await Frame.deleteMany({});
  // Nhãn dán: bảng chọn dùng ảnh 200 px, dán lên khung dùng ảnh gốc.
  const star = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 240, g: 190, b: 60, alpha: 0.9 } } }).png().toBuffer();
  const sticker = (await admin.post("/api/admin/stickers")
    .send({ name: "Sao", image: `data:image/png;base64,${star.toString("base64")}`, active: true }).expect(200)).body;
  assert.equal(sticker.thumb, undefined);
  const listed = (await request(app).get("/api/catalog").expect(200)).body.stickers.find((s) => s._id === sticker._id);
  assert.equal(listed.thumb, `${listed.image}&size=thumb`);
  const small = await request(app).get(listed.thumb).expect(200);
  assert.equal(small.headers["content-type"], "image/webp");
  assert.deepEqual([(await sharp(small.body).metadata()).width, (await sharp(small.body).metadata()).hasAlpha], [200, true]);
  assert.deepEqual((await request(app).get(listed.image).expect(200)).body, star);
  assert.ok(!JSON.stringify((await admin.get("/api/admin/stickers").expect(200)).body).includes("base64"));
  await admin.delete(`/api/admin/stickers/${sticker._id}`).expect(200);
});

test("the kiosk saves the framed photo into the album even without prints; it expires with the album", async () => {
  const sharp = (await import("sharp")).default;
  const { purgeExpiredMedia, readMedia } = await import("../src/services/media.js");
  const sessionId = "session-composite-test";
  const accessToken = "k".repeat(48);
  const old = new mongoose.Types.ObjectId(Math.floor((Date.now() - 30 * 3600_000) / 1000));
  const booking = await Booking.create({
    branch: "Bắc Giang", code: "616161", status: "completed", paid: true, accessToken, prints: 0,
    captureSession: sessionId, captureStartedAt: new Date(), captureEndsAt: new Date(Date.now() - 1000),
    photos: [{ _id: new mongoose.Types.ObjectId(), file: "c1.jpg", thumbnailFile: "c1.jpg", kind: "original" }],
  });
  const captureToken = jwt.sign({ type: "capture", booking: String(booking._id), sessionId }, config.secret);
  await request(app).get(`/api/albums/${accessToken}/composite`).expect(404);
  const framed = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#e78fa8" } }).jpeg({ quality: 92 }).toBuffer();
  const send = (body, token = captureToken, type = "image/jpeg") => request(app).post("/api/kiosk/composite")
    .set("X-Capture-Token", token).set("X-Frame-Name", encodeURIComponent("Mộng mơ")).set("Content-Type", type).send(body);
  await send(framed, "bad").expect(401);
  await send(Buffer.from("not a jpeg")).expect(400);
  await send(framed).expect(201);
  const first = (await Booking.findById(booking._id).lean()).composite;
  // Gửi lại (máy chụp thử lại sau khi mất mạng) thay ảnh cũ, xóa file cũ.
  await send(framed).expect(201);
  const saved = await Booking.findById(booking._id).lean();
  assert.notEqual(saved.composite.file, first.file);
  assert.equal(await readMedia(first.file), null);
  assert.equal(saved.frameName, "Mộng mơ", "xếp hạng chủ đề tính cả lượt không in");
  const album = (await request(app).get(`/api/albums/${accessToken}`).expect(200)).body;
  assert.deepEqual(album.composite, { frameName: "Mộng mơ", width: 1200, height: 1800 });
  assert.ok(!JSON.stringify(album).includes(saved.composite.file), "không lộ tên file");
  const full = await request(app).get(`/api/albums/${accessToken}/composite?download=1`).expect(200);
  assert.deepEqual(full.body, framed);
  assert.match(full.headers["content-disposition"], /NXC-616161-anh-ghep\.jpg/);
  const thumb = await request(app).get(`/api/albums/${accessToken}/composite?size=thumbnail`).expect(200);
  assert.deepEqual([(await sharp(thumb.body).metadata()).width, (await sharp(thumb.body).metadata()).height], [480, 720]);
  // Danh sách đơn: ảnh đại diện là ảnh ghép, có link tải.
  const orders = (await admin.get(`/api/admin/bookings?code=616161`).expect(200)).body;
  const order = (Array.isArray(orders) ? orders : orders.items || []).find((o) => o.code === "616161");
  assert.deepEqual(order.composite, { url: `/api/albums/${accessToken}/composite`, frameName: "Mộng mơ" });
  assert.equal(order.coverPhoto, `/api/albums/${accessToken}/composite?size=thumbnail`);
  // Ảnh cuối cùng của album hết hạn: ảnh ghép xóa theo.
  await Booking.updateOne({ _id: booking._id }, { $set: { photos: [{ _id: old, file: "c1.jpg", kind: "original" }], mediaExpiresAt: new Date(Date.now() - 1000) } });
  await purgeExpiredMedia();
  const after = await Booking.findById(booking._id).lean();
  assert.equal(after.composite, undefined);
  assert.equal(after.mediaDeleted, true);
  assert.equal(await readMedia(saved.composite.file), null);
  assert.equal(await readMedia(saved.composite.thumbnailFile), null);
  await request(app).get(`/api/albums/${accessToken}/composite`).expect(404);
  await Booking.deleteMany({});
});

test("the shop edits the kiosk's on-screen texts; blank lines fall back to the kiosk defaults", async () => {
  const texts = { "layout.title": "Chọn layout nè", "layout.confirm": "Chốt layout này, vào chụp nha!", "pay.title": "" };
  await staff.put("/api/admin/settings/kiosk-texts").send({ kioskTexts: texts }).expect(403);
  await admin.put("/api/admin/settings/kiosk-texts").send({ kioskTexts: { "Bad Key!": "x" } }).expect(400);
  await admin.put("/api/admin/settings/kiosk-texts").send({ kioskTexts: { "layout.title": "x".repeat(201) } }).expect(400);
  const saved = (await admin.put("/api/admin/settings/kiosk-texts").send({ kioskTexts: texts }).expect(200)).body;
  assert.deepEqual(saved.kioskTexts, { "layout.title": "Chọn layout nè", "layout.confirm": "Chốt layout này, vào chụp nha!" });
  const catalog = (await request(app).get("/api/catalog").expect(200)).body.settings;
  assert.equal(catalog.kioskTexts["layout.title"], "Chọn layout nè");
  await admin.put("/api/admin/settings/kiosk-texts").send({ kioskTexts: {} }).expect(200);
});

test("a counter code never sells a Polaroid layout (Instax): photobooth codes print on the DNP only", async () => {
  const layout = await Package.create({
    name: "Polaroid 4 ảnh", price: 110000, duration: 10, prints: 2, shots: 10, selectCount: 4, printSize: "instax", active: true,
  });
  try {
    const refused = await staff.post("/api/admin/tickets").send({
      name: "Khách", phone: "0388123456", room: "", branch: "Bắc Giang", package: String(layout._id), requestKey: randomUUID(),
      paymentMethod: "cash", paymentReceived: true,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.message, /Layout Polaroid không bán bằng mã chụp/);
  } finally {
    await Package.deleteOne({ _id: layout._id });
  }
});

test("a room is deleted for good only after it was stopped; staff cannot delete rooms", async () => {
  const spare = await Room.create({ name: "Phòng thừa", branch: "Bắc Giang", active: true });
  try {
    const running = await admin.delete(`/api/admin/rooms/${spare._id}/permanent`).expect(409);
    assert.match(running.body.message, /Ngừng sử dụng phòng trước/);
    await admin.delete(`/api/admin/rooms/${spare._id}`).expect(200);
    await staff.delete(`/api/admin/rooms/${spare._id}/permanent`).expect(403);
    await admin.delete(`/api/admin/rooms/${spare._id}/permanent`).expect(200);
    assert.equal(await Room.countDocuments({ _id: spare._id }), 0);
    await admin.delete(`/api/admin/rooms/${spare._id}/permanent`).expect(404);
  } finally {
    await Room.deleteOne({ _id: spare._id });
  }
});

test("request bodies: 1 MB unless signed in to admin; compressed bodies are refused", async () => {
  await request(app).post("/api/auth/login")
    .send({ email: "a@b.vn", password: "x".repeat(1_200_000) }).expect(413);
  // Chưa đăng nhập: body lớn gửi tới quản trị không được đọc, chỉ báo cần đăng nhập.
  await request(app).put("/api/admin/settings/kiosk").send({ idleImage: "x".repeat(2_000_000) }).expect(401);
  // Đã đăng nhập: quản trị gửi được ảnh base64 vài MB (dữ liệu sai nên 400, không phải 413).
  const signedIn = await admin.put("/api/admin/settings/kiosk").send({ idleImage: "x".repeat(2_000_000) });
  assert.equal(signedIn.status, 400, JSON.stringify(signedIn.body));
  // Phiếu tại quầy (route tự kiểm tra đăng nhập) vẫn đọc body JSON thường.
  await staff.post("/api/admin/tickets/quote").send({ package: String(pack._id) }).expect(200);
  const zipped = zlib.gzipSync(JSON.stringify({ email: "a@b.vn", password: "x" }));
  const refused = await request(app).post("/api/auth/login")
    .set("Content-Type", "application/json").set("Content-Encoding", "gzip").send(zipped).expect(415);
  assert.match(refused.body.message, /dữ liệu nén/);
});

test("the orders list for a date range leaves out what the booth updates every few seconds", async () => {
  const day = today();
  const b = await Booking.create({
    code: "424242", name: "Khách", branch: "Bắc Giang", date: day, status: "checked_in", total: 100000,
    paid: true, captureSeenAt: new Date(), cashBills: [{ amount: 100000, at: new Date() }], accessToken: "t".repeat(48),
  });
  try {
    const path = `/api/admin/bookings?from=${day.slice(0, 8)}01&to=${day}`;
    const first = await admin.get(path).expect(200);
    const item = first.body.find((entry) => entry._id === String(b._id));
    assert.equal(item.accessToken, "t".repeat(48));
    assert.equal(item.total, 100000);
    for (const key of ["captureSeenAt", "updatedAt", "cashBills", "photos"])
      assert.equal(item[key], undefined, key);
    // Máy chụp chỉ báo "còn sống": danh sách không đổi, cùng ETag (lần làm mới nhận 304 rỗng).
    await Booking.updateOne({ _id: b._id }, { $set: { captureSeenAt: new Date(Date.now() + 5000) } });
    const second = await admin.get(path).expect(200);
    assert.equal(second.headers.etag, first.headers.etag);
  } finally {
    await Booking.deleteOne({ _id: b._id });
  }
});
