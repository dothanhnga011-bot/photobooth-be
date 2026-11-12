// Giới hạn chống dò mã ở máy chụp tính riêng từng máy: mọi máy trong tiệm chung một IP Wi-Fi, nên
// một máy bị nhập sai liên tục không được khoá các phòng khác. (File riêng: bộ đếm của giới hạn nằm
// trong bộ nhớ tiến trình, không lẫn với các test nhập mã khác.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { KioskAttempt, Room } from "../src/models/index.js";

let memory, busy, quiet;
const LIMIT_MESSAGE = /Quá nhiều lần thử không thành công/;

before(async () => {
  config.secret = "test-secret-only-not-used-in-production-123456789";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const [a, b] = await Room.create([
    { name: "PTB 01", branch: "Hà Nội", active: true },
    { name: "PTB 02", branch: "Hà Nội", active: true },
  ]);
  busy = jwt.sign({ type: "kiosk", room: String(a._id) }, config.secret);
  quiet = jwt.sign({ type: "kiosk", room: String(b._id) }, config.secret);
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});

const claim = (device, code = "000000") => request(app).post("/api/kiosk/claim").send({ code, device });

test("wrong codes on one kiosk never lock the other kiosks of the shop (same Wi-Fi IP)", async () => {
  // Máy 1 nhập sai liên tục: khoá 5 phút của chính máy (KioskAttempt) rồi giới hạn 25 lần / 15 phút.
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) {
    // Bỏ khoá 5 phút để mỗi lần thử đều là một lần sai thật, tới khi chạm giới hạn chung.
    await KioskAttempt.deleteMany({});
    const res = await claim(busy);
    if (res.status === 429 && LIMIT_MESSAGE.test(res.body.message)) limited = i + 1;
    else assert.equal(res.status, 400, JSON.stringify(res.body));
  }
  assert.equal(limited, 26, "the 26th wrong code on the same kiosk is refused");
  // Máy 2 cùng IP vẫn nhập mã bình thường: sai thì báo sai, không bị giới hạn của máy 1.
  const other = await claim(quiet);
  assert.equal(other.status, 400);
  assert.doesNotMatch(other.body.message, LIMIT_MESSAGE);
  // Không có liên kết máy: tính theo IP như trước.
  assert.equal((await request(app).post("/api/kiosk/claim").send({ code: "000000" })).status, 400);
});
