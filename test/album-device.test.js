// Album phòng Selfbooth: ai quét mã cũng thấy đủ ảnh máy chụp; ảnh khách tải lên từ điện thoại chỉ điện
// thoại đó thấy; khách xoá ảnh máy chụp thì chỉ ẩn trên máy mình.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import sharp from "sharp";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking } from "../src/models/index.js";

let memory, jpeg;
before(async () => {
  config.secret = "album-device-test-secret-only-1234567890";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  jpeg = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

const camera = (n) => ({ _id: new mongoose.Types.ObjectId(), kind: "original", number: n, file: `camera-${n}.jpg` });
const selfboothAlbum = (photos) => Booking.create({
  accessToken: randomUUID(), code: String(Math.floor(100000 + Math.random() * 899999)), status: "completed", paid: true,
  printSize: "large", selectCount: 2, prints: 1, photos, nextPhotoNumber: photos.length,
});
const upload = (client, token, key, guest) => {
  const req = client.post(`/api/albums/${token}/photos`)
    .set("Content-Type", "image/jpeg").set("X-Photo-Key", key).set("X-Photo-Name", `${key}.jpg`);
  return (guest ? req.set("X-Album-Guest", "1") : req).send(jpeg);
};
const view = async (client, token) =>
  (await client.get(`/api/albums/${token}`).expect(200)).body.photos.map((p) => [p.clientKey || String(p.id), p.number, Boolean(p.mine)]);

test("each phone gets its own HttpOnly device cookie for /api/albums only", async () => {
  const b = await selfboothAlbum([camera(1)]);
  const first = await request(app).get(`/api/albums/${b.accessToken}`).expect(200);
  const cookie = first.headers["set-cookie"]?.find((c) => c.startsWith("album_device="));
  assert.ok(cookie, "a new phone gets a device cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Path=\/api\/albums/);
  // A phone that already has one keeps it; a forged value is replaced.
  const phone = request.agent(app);
  await phone.get(`/api/albums/${b.accessToken}`).expect(200);
  const again = await phone.get(`/api/albums/${b.accessToken}`).expect(200);
  assert.equal(again.headers["set-cookie"], undefined);
  const forged = await request(app).get(`/api/albums/${b.accessToken}`).set("Cookie", "album_device=../../etc").expect(200);
  assert.ok(forged.headers["set-cookie"]?.some((c) => c.startsWith("album_device=")));
});

test("camera photos are shared; a phone's own upload is visible, downloadable and deletable only on that phone", async () => {
  const shots = [camera(1), camera(2)];
  const b = await selfboothAlbum(shots);
  const token = b.accessToken;
  const phoneA = request.agent(app), phoneB = request.agent(app);
  await phoneA.get(`/api/albums/${token}`).expect(200);
  await phoneB.get(`/api/albums/${token}`).expect(200);

  // Phone A adds a photo from its gallery; the booth sends a late camera photo (never X-Album-Guest).
  const added = (await upload(phoneA, token, "phone-a-photo", true).expect(201)).body;
  assert.deepEqual(added.photos.find((p) => p.clientKey === "phone-a-photo")?.mine, true);
  await upload(request(app), token, "booth-late-photo", false).expect(201);

  const [one, two] = shots.map((p) => String(p._id));
  assert.deepEqual(await view(phoneA, token),
    [[one, 1, false], [two, 2, false], ["phone-a-photo", 3, true], ["booth-late-photo", 4, false]]);
  // Phone B: every camera photo, numbered without a gap, but not phone A's own photo.
  assert.deepEqual(await view(phoneB, token), [[one, 1, false], [two, 2, false], ["booth-late-photo", 3, false]]);

  const stored = await Booking.findById(b._id).lean();
  const mine = stored.photos.find((p) => p.clientKey === "phone-a-photo");
  const late = stored.photos.find((p) => p.clientKey === "booth-late-photo");
  assert.match(mine.owner, /^[0-9a-f]{32}$/, "only a hash of the device is stored");
  assert.equal(late.owner, undefined, "booth photos stay shared");
  // Only phone A can open its photo; the ZIP of phone B leaves it out too.
  await phoneA.get(`/api/albums/${token}/photos/${mine._id}`).expect(200);
  await phoneB.get(`/api/albums/${token}/photos/${mine._id}`).expect(404);
  await request(app).get(`/api/albums/${token}/photos/${mine._id}`).expect(404);

  // Phone B deleting a camera photo hides it on phone B only.
  const afterB = (await phoneB.delete(`/api/albums/${token}/photos`).send({ ids: [one] }).expect(200)).body;
  assert.deepEqual(afterB.photos.map((p) => [p.clientKey || String(p.id), p.number]), [[two, 1], ["booth-late-photo", 2]]);
  assert.deepEqual((await view(phoneA, token)).map(([id]) => id), [one, two, "phone-a-photo", "booth-late-photo"]);
  await phoneB.get(`/api/albums/${token}/photos/${one}`).expect(404);
  // Phone B cannot delete phone A's photo (it does not even see it).
  await phoneB.delete(`/api/albums/${token}/photos`).send({ ids: [String(mine._id)] }).expect(200);
  assert.ok((await view(phoneA, token)).some(([id]) => id === "phone-a-photo"));
  // Phone A deleting its own photo removes it.
  await phoneA.delete(`/api/albums/${token}/photos`).send({ ids: [String(mine._id)] }).expect(200);
  assert.deepEqual((await view(phoneA, token)).map(([id]) => id), [one, two, "booth-late-photo"]);
  const final = await Booking.findById(b._id).lean();
  const byId = (id) => final.photos.find((p) => String(p._id) === id);
  assert.equal(byId(String(mine._id)).deleted, true);
  assert.equal(byId(one).deleted, undefined, "a camera photo is never deleted for everyone by one guest");
  assert.equal(byId(one).hiddenFor.length, 1);
});
