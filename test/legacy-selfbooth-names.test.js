// 20/11: tên cũ của phòng thứ hai đổi hết sang "selfbooth" khi khởi động — phòng, chủ đề, đơn, chữ máy chụp.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Booking, Room, Setting } from "../src/models/index.js";
import { migrateSelfboothNames } from "../src/services/legacy-selfbooth-names.js";

let memory;
before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

test("rooms, themes, bookings and kiosk texts saved with the old name become selfbooth; running again changes nothing", async () => {
  const OLD = "polaroid";
  const { insertedId: oldRoom } = await Room.collection.insertOne({ name: "Phòng 2", branch: "Bắc Giang", active: true, kind: OLD });
  const { insertedId: booth } = await Room.collection.insertOne({ name: "Phòng 1", branch: "Bắc Giang", active: true, kind: "photobooth" });
  const { insertedId: oldBooking } = await Booking.collection.insertOne({ code: "135790", status: "completed", source: OLD });
  const { insertedId: counterBooking } = await Booking.collection.insertOne({ code: "246802", status: "completed", source: "counter" });
  await Setting.collection.updateOne({ key: "studio" }, { $set: {
    "value.themes": [{ name: "Hoa", kind: OLD }, { name: "Kawaii", kind: "photobooth" }, { name: "Mây", kind: OLD }],
    "value.kioskTexts": { [`${OLD}.codeTitle`]: "Nhập mã của bạn", "done.title": "Cảm ơn!" },
  } }, { upsert: true });

  assert.deepEqual(await migrateSelfboothNames(), { rooms: 1, bookings: 1, themes: 1, kioskTexts: 1 });
  assert.equal((await Room.collection.findOne({ _id: oldRoom })).kind, "selfbooth");
  assert.equal((await Room.collection.findOne({ _id: booth })).kind, "photobooth");
  assert.equal((await Booking.collection.findOne({ _id: oldBooking })).source, "selfbooth");
  assert.equal((await Booking.collection.findOne({ _id: counterBooking })).source, "counter");
  const studio = (await Setting.collection.findOne({ key: "studio" })).value;
  assert.deepEqual(studio.themes.map((t) => [t.name, t.kind]), [["Hoa", "selfbooth"], ["Kawaii", "photobooth"], ["Mây", "selfbooth"]]);
  assert.deepEqual(studio.kioskTexts, { "selfbooth.codeTitle": "Nhập mã của bạn", "done.title": "Cảm ơn!" });
  // Đã lưu qua model mới: loại phòng mới hợp lệ.
  assert.equal((await Room.findById(oldRoom)).kind, "selfbooth");
  assert.deepEqual(await migrateSelfboothNames(), { rooms: 0, bookings: 0, themes: 0, kioskTexts: 0 });
});
