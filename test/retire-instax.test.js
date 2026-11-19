// 19/11: không còn Instax — gói và khung Instax còn sót đổi sang tờ 20 × 30 (phòng Selfbooth, máy DS820) khi khởi động.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Booking, Frame, Package } from "../src/models/index.js";
import { retireInstax } from "../src/services/retire-instax.js";

let memory;
before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

test("leftover Instax packages and frames become 20 × 30; other sizes and old tickets are untouched; running again changes nothing", async () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const slot = [{ x: 0.1, y: 0.1, w: 0.5, h: 0.5, kind: "photo", photo: 1 }];
  const [oldPack, booth] = await Package.create([
    { name: "Chụp đôi", price: 150000, duration: 12, prints: 2, printSize: "instax", active: true },
    { name: "Khổ to", price: 90000, duration: 10, prints: 2, printSize: "full", active: true },
  ]);
  const [oldFrame, strip] = await Frame.create([
    { name: "Hoa", printSize: "instax", image, slots: slot, active: true },
    { name: "Dải", printSize: "strip", image, slots: slot, active: true },
  ]);
  const ticket = await Booking.create({ code: "135790", status: "confirmed", printSize: "instax", prints: 1 });
  assert.deepEqual(await retireInstax(), { packages: 1, frames: 1 });
  assert.equal((await Package.findById(oldPack._id)).printSize, "large");
  assert.equal((await Frame.findById(oldFrame._id)).printSize, "large");
  assert.equal((await Package.findById(booth._id)).printSize, "full");
  assert.equal((await Frame.findById(strip._id)).printSize, "strip");
  assert.equal((await Booking.findById(ticket._id)).printSize, "instax", "an issued ticket keeps what was sold");
  assert.deepEqual(await retireInstax(), { packages: 0, frames: 0 });
});
