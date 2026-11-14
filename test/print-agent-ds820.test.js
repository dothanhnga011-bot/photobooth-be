// The Windows DNP DS820 print agent of a Polaroid / Selfbooth room (PowerShell,
// photobooth-fe/src/admin/installers/print-agent-ds820.ps1) against a real server: it takes only its own room's
// 20 x 30 cm jobs (printSize "large", sent from the guest's phone), prints every sheet and copy, reports the
// printer, and leaves 10 x 15 jobs and other rooms alone. Printing is replaced by copying the sheets
// (-DryRunDir); everything else is the real script. Windows only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import { MongoMemoryServer } from "mongodb-memory-server";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { PrintJob, Room, Setting } from "../src/models/index.js";
import { saveMedia } from "../src/services/media.js";

const script = fileURLToPath(new URL("../../photobooth-fe/src/admin/installers/print-agent-ds820.ps1", import.meta.url));
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(script) ? "photobooth-fe not next to photobooth-be" : false;
let memory, server, base, folder;

before(async () => {
  if (skip) return;
  config.secret = "test-secret-only-not-used-in-production-123456789";
  config.printAgentToken = "";
  config.dnpPrinter = "";
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  folder = await mkdtemp(path.join(os.tmpdir(), "nxc-ds820-agent-"));
});
after(async () => {
  if (skip) return;
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await memory?.stop();
  await rm(folder, { recursive: true, force: true });
});

test("the Selfbooth room's DS820 agent prints its own 20 x 30 jobs, every sheet and copy, and reports the printer", { skip, timeout: 120000 }, async () => {
  const [room, other] = await Room.create([
    { name: "Selfbooth 1", branch: "Chi nhánh A", kind: "polaroid", active: true },
    { name: "Selfbooth 2", branch: "Chi nhánh A", kind: "polaroid", active: true },
  ]);
  const sheet = async (name, width, height) => {
    await saveMedia(name, await sharp({ create: { width, height, channels: 3, background: "#e8d2c4" } }).jpeg().toBuffer(), "image/jpeg");
    return { file: name, width, height };
  };
  const portrait = await sheet("ds820-a.jpg", 2400, 3600), landscape = await sheet("ds820-b.jpg", 3600, 2400);
  const small = await sheet("rx1.jpg", 1200, 1800);
  const job = (target, code, printSize, sheets, copies = 1) => PrintJob.create({
    branch: "Chi nhánh A", room: target._id, code, printSize, copies, file: sheets[0].file, sheets,
    status: "pending", spoolStatus: "queued",
  });
  const mine = await job(room, "444444", "large", [portrait, landscape]);
  const twice = await job(room, "555555", "large", [portrait], 2);
  const tenByFifteen = await job(room, "666666", "full", [small]);
  const foreign = await job(other, "777777", "large", [portrait]);
  const token = jwt.sign({ type: "print-agent", room: String(room._id), branch: "Chi nhánh A" }, config.secret);
  const configPath = path.join(folder, "config.json");
  await writeFile(configPath, JSON.stringify({ api: base, token, room: "Selfbooth 1", printer: "DNP DS820" }));
  const out = path.join(folder, "printed");
  await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Once", "-DryRunDir", out, "-ConfigPath", configPath,
  ], { timeout: 110000, windowsHide: true });

  assert.deepEqual((await readdir(out)).sort(), [
    "NXC-444444-1-DNP_DS820.jpg", "NXC-444444-2-DNP_DS820.jpg",
    "NXC-555555-1-DNP_DS820.jpg", "NXC-555555-2-DNP_DS820.jpg",
  ], "both sheets of one job, two copies of the other, on the DS820");
  const [a, b, c, d] = await Promise.all([mine, twice, tenByFifteen, foreign].map((j) => PrintJob.findById(j._id)));
  assert.equal(a.spoolStatus, "sent");
  assert.match(a.spoolMessage, /^Đã gửi 2 tờ 20 x 30 tới máy DNP DS820/);
  assert.equal(b.spoolStatus, "sent");
  assert.equal(c.spoolStatus, "queued", "a 10 x 15 sheet is not printed on the DS820");
  assert.equal(d.spoolStatus, "queued", "the other room's DS820 prints this one");
  const status = (await Setting.collection.findOne({ key: `printers:room:${room._id}` })).value;
  assert.deepEqual([status.dnp.printer, status.dnp.ready], ["DNP DS820", true]);
  assert.ok(status.agent.at, "the admin sees the agent running");
});
