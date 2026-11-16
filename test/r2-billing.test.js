// R2 tính tiền lưu trữ theo GB-tháng = tổng dung lượng đỉnh mỗi ngày ÷ 30 (miễn phí 10 GB-tháng, sau đó
// 0,015 USD / GB-tháng), không theo dung lượng đang lưu lúc này.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { config } from "../src/config.js";
import { Setting } from "../src/models/index.js";
import { readR2Billing, recordR2Peak, resetR2PeakMemory } from "../src/services/r2-billing.js";

const GB = 1_000_000_000;
let memory;
before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
});
after(async () => {
  await mongoose.disconnect();
  await memory?.stop();
});
beforeEach(async () => {
  await Setting.deleteMany({ key: "r2:daily-peaks" });
  resetR2PeakMemory();
  config.cloudflare = { apiToken: "", accountId: "" };
});

test("the server keeps each day's peak R2 size, never lowering it, and drops days older than ~2 months", async () => {
  await recordR2Peak(5 * GB, new Date("2026-09-01T08:00:00Z"));
  await recordR2Peak(3 * GB, new Date("2026-11-15T08:00:00Z"));
  await recordR2Peak(8 * GB, new Date("2026-11-15T12:00:00Z"));
  await recordR2Peak(6 * GB, new Date("2026-11-15T20:00:00Z"));
  await recordR2Peak(2 * GB, new Date("2026-11-16T01:00:00Z"));
  const days = (await Setting.collection.findOne({ key: "r2:daily-peaks" })).value.days;
  assert.deepEqual(days, { "2026-11-15": 8 * GB, "2026-11-16": 2 * GB }, "September is pruned on a new day");
});

test("month to date = sum of daily peaks / 30; the projection keeps today's size to the end of the month", async () => {
  // 16/11 (giống trang Billing của tiệm): 1–14/11 chưa đo, 15/11 đỉnh 40 GB, hôm nay đang lưu 61,9 GB.
  await recordR2Peak(40 * GB, new Date("2026-11-15T10:00:00Z"));
  const now = new Date("2026-11-16T06:35:00Z");
  const billing = await readR2Billing({ now, currentBytes: 61.9 * GB });
  assert.deepEqual(billing.period, { start: "2026-11-01", end: "2026-11-30", days: 30, today: 16 });
  assert.equal(billing.monthToDate, Math.round(((40 + 61.9) / 30) * 1e4) / 1e4);
  // 14 ngày còn lại × 61,9 GB / 30.
  assert.equal(billing.projected, Math.round(((40 + 61.9 + 61.9 * 14) / 30) * 1e4) / 1e4);
  assert.ok(Math.abs(billing.projectedCostUSD - (billing.projected - 10) * 0.015) < 0.0002, String(billing.projectedCostUSD));
  assert.equal(billing.monthToDateCostUSD, 0);
  assert.equal(billing.vndPerUsd, 26_400, "the admin page shows the cost in đồng at this estimated rate");
  assert.deepEqual([billing.measuredDays, billing.missingDays, billing.firstMeasured], [2, 14, "2026-11-15"]);
  assert.equal(billing.level, "normal", "judged by what is billed so far, not by the month-end projection");
  assert.equal(billing.source, "recorded");
  assert.equal(billing.usagePercent, Math.round((billing.monthToDate / 10) * 100 * 100) / 100);
  // Không phải 61,9 / 10 GB = 619 % như trước.
  assert.ok(billing.usagePercent < 100);
});

test("the level follows GB-months billed so far: a reminder from 80 % of the free tier, critical from 100 %", async () => {
  // 1–9/11 mỗi ngày đỉnh 27 GB → 8,1 GB-tháng (81 %), hôm nay thêm 30 GB → 9,1 (91 %).
  for (let d = 1; d <= 9; d++) await recordR2Peak(27 * GB, new Date(Date.UTC(2026, 10, d, 12)));
  const warning = await readR2Billing({ now: new Date("2026-11-10T08:00:00Z"), currentBytes: 30 * GB });
  assert.deepEqual([warning.monthToDate, warning.level, warning.monthToDateCostUSD], [9.1, "warning", 0]);
  // Thêm 10, 11/11 đỉnh 30 GB và hôm nay 30 GB → 333 GB-ngày = 11,1 GB-tháng: vượt 1,1 × 0,015 ≈ 0,02 USD.
  for (const d of [10, 11]) await recordR2Peak(30 * GB, new Date(Date.UTC(2026, 10, d, 12)));
  const critical = await readR2Billing({ now: new Date("2026-11-12T08:00:00Z"), currentBytes: 30 * GB });
  assert.deepEqual([critical.monthToDate, critical.level, critical.monthToDateCostUSD], [11.1, "critical", 0.0165]);
});

test("a small bucket stays in the free tier and the level is normal", async () => {
  const billing = await readR2Billing({ now: new Date("2026-11-03T00:00:00Z"), currentBytes: 2 * GB });
  assert.equal(billing.level, "normal");
  assert.equal(billing.projectedCostUSD, 0);
  assert.equal(billing.projected, Math.round(((2 + 2 * 27) / 30) * 1e4) / 1e4);
});

test("with a Cloudflare token the exact daily peaks come from Cloudflare analytics (all buckets of the account)", async () => {
  config.cloudflare = { apiToken: "test-token", accountId: "acc-1" };
  const calls = [];
  const rows = [
    // Ngày 1: bucket ảnh đỉnh 10 GB, bucket khác 1 GB → 11 GB.
    { dimensions: { datetime: "2026-11-01T01:00:00Z", bucketName: "nxc-media" }, max: { payloadSize: 8 * GB, metadataSize: 0 } },
    { dimensions: { datetime: "2026-11-01T13:00:00Z", bucketName: "nxc-media" }, max: { payloadSize: 10 * GB - 1000, metadataSize: 1000 } },
    { dimensions: { datetime: "2026-11-01T13:00:00Z", bucketName: "other" }, max: { payloadSize: 1 * GB, metadataSize: 0 } },
    // Ngày 2: 20 GB.
    { dimensions: { datetime: "2026-11-02T05:00:00Z", bucketName: "nxc-media" }, max: { payloadSize: 20 * GB, metadataSize: 0 } },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: rows }] } } }), { status: 200 });
  };
  const billing = await readR2Billing({ now: new Date("2026-11-02T09:00:00Z"), currentBytes: 15 * GB, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/graphql");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-token");
  const sent = JSON.parse(calls[0].init.body);
  assert.match(sent.query, /r2StorageAdaptiveGroups/);
  assert.deepEqual(sent.variables, { accountTag: "acc-1", start: "2026-11-01T00:00:00.000Z", end: "2026-11-02T09:00:00.000Z" });
  assert.deepEqual(billing.daily.map((d) => [d.date, d.bytes / GB, d.source]), [["2026-11-01", 11, "cloudflare"], ["2026-11-02", 20, "cloudflare"]]);
  assert.equal(billing.monthToDate, 1.0333);
  assert.equal(billing.source, "cloudflare");
  assert.equal(billing.cloudflare.configured, true);
});

test("a Cloudflare error is reported and the server's own daily peaks are used", async () => {
  config.cloudflare = { apiToken: "bad-token", accountId: "acc-1" };
  await recordR2Peak(4 * GB, new Date("2026-11-01T10:00:00Z"));
  const fetchImpl = async () => new Response(JSON.stringify({ errors: [{ message: "not authorized" }] }), { status: 200 });
  const billing = await readR2Billing({ now: new Date("2026-11-02T10:00:00Z"), currentBytes: 5 * GB, fetchImpl });
  assert.match(billing.cloudflare.error, /Chưa đọc được số đo từ Cloudflare: not authorized/);
  assert.deepEqual(billing.daily.map((d) => [d.date, d.bytes / GB, d.source]), [["2026-11-01", 4, "recorded"], ["2026-11-02", 5, "recorded"]]);
  assert.equal(billing.monthToDate, 0.3);
});
