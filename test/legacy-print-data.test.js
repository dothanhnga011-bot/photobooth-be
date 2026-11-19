// 19/11: web chỉ in DNP — dữ liệu còn ghi khổ đã bỏ đổi sang tờ 20 × 30 (phòng Selfbooth, máy DS820) khi khởi động.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Booking, Frame, Package, PrintJob, Setting } from "../src/models/index.js";
import { migrateLegacyPrintData } from "../src/services/legacy-print-data.js";

let memory;
before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

test("records with a retired print size become 20 × 30, waiting prints stop, the old extra price moves; running again changes nothing", async () => {
  const OLD = "retired-size";
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const slot = [{ x: 0.1, y: 0.1, w: 0.5, h: 0.5, kind: "photo", photo: 1 }];
  const [booth] = await Package.create([{ name: "Khổ to", price: 90000, duration: 10, prints: 2, printSize: "full", active: true }]);
  const [strip] = await Frame.create([{ name: "Dải", printSize: "strip", image, slots: slot, active: true }]);
  const plain = await Booking.create({ code: "246802", status: "confirmed" });
  // Bản ghi cũ được ghi thẳng vào collection (khổ cũ không còn qua được kiểm tra của model).
  const ids = {};
  for (const [name, model, doc] of [
    ["pack", Package, { name: "Chụp đôi", price: 150000, duration: 12, prints: 2, active: true }],
    ["frame", Frame, { name: "Hoa", image, slots: slot, active: true }],
    ["ticket", Booking, { code: "135790", status: "confirmed", prints: 1 }],
    ["queued", PrintJob, { branch: "B", code: "135790", file: "x.jpg", status: "pending", spoolStatus: "queued" }],
    ["done", PrintJob, { branch: "B", code: "135790", file: "y.jpg", status: "printed", spoolStatus: "sent" }],
  ]) ids[name] = (await model.collection.insertOne({ ...doc, printSize: OLD })).insertedId;
  await Setting.collection.updateOne({ key: "studio" }, { $set: { "value.extraPrintPrice": 15000, "value.extraInstaxPrice": 30000 } }, { upsert: true });

  assert.deepEqual(await migrateLegacyPrintData(),
    { packages: 1, frames: 1, bookings: 1, printJobs: 2, stoppedPrints: 1, extraPrice: 1 });
  assert.equal((await Package.findById(ids.pack)).printSize, "large");
  assert.equal((await Frame.findById(ids.frame)).printSize, "large");
  assert.equal((await Booking.findById(ids.ticket)).printSize, "large");
  const queued = await PrintJob.findById(ids.queued);
  assert.deepEqual([queued.printSize, queued.spoolStatus], ["large", "failed"]);
  assert.match(queued.spoolMessage, /Khổ in cũ đã bỏ/);
  assert.equal((await PrintJob.findById(ids.done)).spoolStatus, "sent", "a finished print keeps its result");
  assert.equal((await Package.findById(booth._id)).printSize, "full");
  assert.equal((await Frame.findById(strip._id)).printSize, "strip");
  assert.equal((await Booking.findById(plain._id)).printSize, undefined, "a ticket without a size stays without one");
  const studio = (await Setting.collection.findOne({ key: "studio" })).value;
  assert.deepEqual([studio.extraPrintPrice, studio.extraSelfboothPrice, Object.keys(studio).length], [15000, 30000, 2]);
  assert.deepEqual(await migrateLegacyPrintData(),
    { packages: 0, frames: 0, bookings: 0, printJobs: 0, stoppedPrints: 0, extraPrice: 0 });
});
