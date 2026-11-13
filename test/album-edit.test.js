// Phòng Selfbooth (Polaroid): khách quét QR rồi chọn ảnh, làm đẹp, ghép khung trên điện thoại trong thời gian
// chọn ảnh của tiệm (mặc định 250 giây). Máy chủ tính giờ từ lần mở đầu tiên.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, Setting } from "../src/models/index.js";

let memory;
before(async () => {
  config.secret = "test-secret-only-not-used-in-production-123456789";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

const booking = (accessToken, extra = {}) => Booking.create({
  accessToken, code: String(Math.floor(100000 + Math.random() * 899999)), status: "completed", paid: true,
  printSize: "instax", selectCount: 2, prints: 1, photos: [], ...extra,
});
const start = (token) => request(app).post(`/api/albums/${token}/edit-start`);

test("the phone gets 250 seconds from its first open, and a reload keeps the same deadline", async () => {
  await booking("selfbooth-album-one");
  const first = (await start("selfbooth-album-one").expect(200)).body;
  const left = new Date(first.editEndsAt) - Date.now();
  assert.ok(left > 245_000 && left <= 250_000, `left ${left}`);
  assert.ok(Math.abs(first.serverTime - Date.now()) < 5000);
  const again = (await start("selfbooth-album-one").expect(200)).body;
  assert.equal(again.editEndsAt, first.editEndsAt);
  // Album đọc lại cũng thấy hạn này (điện thoại khác mở cùng QR).
  const read = (await request(app).get("/api/albums/selfbooth-album-one").expect(200)).body;
  assert.equal(new Date(read.editEndsAt).toISOString(), first.editEndsAt);
});

test("the shop's selection time (Thời gian chọn ảnh) sets the phone deadline too", async () => {
  await Setting.updateOne({ key: "studio" }, { $set: { "value.selectSeconds": 300 } }, { upsert: true });
  try {
    await booking("selfbooth-album-two");
    const { editEndsAt } = (await start("selfbooth-album-two").expect(200)).body;
    const left = new Date(editEndsAt) - Date.now();
    assert.ok(left > 295_000 && left <= 300_000, `left ${left}`);
  } finally {
    await Setting.updateOne({ key: "studio" }, { $unset: { "value.selectSeconds": 1 } });
  }
});

test("photobooth albums, sessions still shooting and unknown albums get no phone editing time", async () => {
  await booking("photobooth-album", { printSize: "full" });
  assert.match((await start("photobooth-album").expect(409)).body.message, /không chọn ảnh trên điện thoại/);
  await booking("still-shooting", { status: "checked_in" });
  assert.match((await start("still-shooting").expect(409)).body.message, /chưa kết thúc/);
  await start("no-such-album").expect(404);
  assert.equal((await Booking.findOne({ accessToken: "still-shooting" })).editEndsAt, undefined);
});
