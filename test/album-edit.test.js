// Phòng Selfbooth: khách quét QR rồi chọn ảnh, làm đẹp, ghép khung trên điện thoại, không tính giờ (như web
// Selfbooth); bấm Gửi in thì lệnh in lên Hàng chờ in của quầy.
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
  printSize: "large", selectCount: 2, prints: 1, photos: [], ...extra,
});

test("choosing photos on the phone has no time limit: there is no editing deadline to start", async () => {
  await booking("selfbooth-album-one");
  await request(app).post("/api/albums/selfbooth-album-one/edit-start").expect(404);
  const read = (await request(app).get("/api/albums/selfbooth-album-one").expect(200)).body;
  assert.equal(read.editEndsAt, undefined);
});

test("a Selfbooth album lets the guest delete photos (numbers close up); a photobooth album stays view-only", async () => {
  const photo = (n) => ({ _id: new mongoose.Types.ObjectId(), kind: "original", number: n, file: `f${n}.jpg` });
  const photos = [photo(1), photo(2), photo(3)];
  await booking("selfbooth-delete", { photos });
  const phone = request.agent(app);
  const after = (await phone.delete("/api/albums/selfbooth-delete/photos")
    .send({ ids: [String(photos[0]._id)] }).expect(200)).body;
  const visible = after.photos.filter((p) => p.kind === "original");
  assert.deepEqual(visible.map((p) => [p.id, p.number]), [[String(photos[1]._id), 1], [String(photos[2]._id), 2]]);
  assert.equal((await phone.get("/api/albums/selfbooth-delete").expect(200)).body.photos.length, 2);
  // Ảnh máy chụp chỉ ẩn trên điện thoại đã xoá: người khác quét mã vẫn thấy đủ 3 ảnh.
  assert.equal((await request(app).get("/api/albums/selfbooth-delete").expect(200)).body.photos.length, 3);
  const stored = await Booking.findOne({ accessToken: "selfbooth-delete" }).lean();
  assert.equal(stored.photos.find((p) => String(p._id) === String(photos[0]._id)).hiddenFor.length, 1, "hidden on that phone");
  await request(app).delete("/api/albums/selfbooth-delete/photos").send({ ids: [] }).expect(400);
  await booking("photobooth-delete", { printSize: "full", photos: [photo(1)] });
  await request(app).delete("/api/albums/photobooth-delete/photos").send({ ids: [String(photos[0]._id)] }).expect(404);
});
