// Cloudflare R2 tính tiền lưu trữ theo GB-tháng, không theo dung lượng đang lưu lúc này (16/11 chủ tiệm chỉ ra
// trang quản trị báo 61,9 / 10 GB = 618 % trong khi Cloudflare → Billing chỉ tính 9,96 GB-tháng, 0 USD):
// "GB-tháng = trung bình dung lượng ĐỈNH mỗi ngày trên một kỳ 30 ngày" (developers.cloudflare.com/r2/pricing).
// Miễn phí 10 GB-tháng mỗi tháng, sau đó 0,015 USD / GB-tháng (lớp Standard).
//
// Máy chủ tự ghi dung lượng đỉnh từng ngày (mỗi giờ và mỗi lần quản trị xem trang Dung lượng ảnh). Ảnh tự xoá
// sau hạn lưu nên dung lượng hôm nay không cho biết các ngày trước: ngày chưa đo thì để trống (không đoán). Có
// CLOUDFLARE_API_TOKEN (quyền Account Analytics: Read) thì đọc thẳng số đo của Cloudflare (r2StorageAdaptiveGroups),
// đúng số trên trang Billing kể cả những ngày trước khi máy chủ bắt đầu đo.
import { config } from "../config.js";
import { Setting } from "../models/index.js";
import { r2Configured, readR2Inventory } from "./r2.js";

export const R2_FREE_GB_MONTHS = 10;
export const R2_PRICE_PER_GB_MONTH = 0.015;
export const R2_PERIOD_DAYS = 30;
const BYTES_PER_GB = 1_000_000_000;
const KEY = "r2:daily-peaks";
const KEEP_DAYS = 70;
const DAY_MS = 86_400_000;

export const dayKey = (time) => new Date(time).toISOString().slice(0, 10);

// Đỉnh hôm nay đã ghi (trong bộ nhớ): đo lại thấp hơn thì khỏi ghi DB.
let written = { day: "", bytes: -1 };
export function resetR2PeakMemory() {
  written = { day: "", bytes: -1 };
  cloudflareCache = null;
}

export async function recordR2Peak(bytes, now = new Date()) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return;
  const day = dayKey(now);
  if (written.day === day && bytes <= written.bytes) return;
  const newDay = written.day !== day;
  written = { day, bytes: Math.max(bytes, newDay ? -1 : written.bytes) };
  await Setting.collection.updateOne(
    { key: KEY },
    { $max: { [`value.days.${day}`]: bytes }, $set: { updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  // Sang ngày mới: bỏ các ngày quá cũ (giữ hơn 2 tháng).
  if (newDay) {
    const doc = await Setting.collection.findOne({ key: KEY }, { projection: { "value.days": 1 } });
    const oldest = dayKey(now.getTime() - KEEP_DAYS * DAY_MS);
    const stale = Object.keys(doc?.value?.days || {}).filter((d) => d < oldest);
    if (stale.length)
      await Setting.collection.updateOne({ key: KEY }, { $unset: Object.fromEntries(stale.map((d) => [`value.days.${d}`, ""])) });
  }
}

// ─── Số đo của Cloudflare (tuỳ chọn) ────────────────────────────────────────────────────────────────────────
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const QUERY = `query R2Storage($accountTag: string!, $start: Time, $end: Time) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_ASC]) {
      max { payloadSize metadataSize }
      dimensions { datetime bucketName }
    }
  } }
}`;
let cloudflareCache = null;

// Đỉnh từng ngày của cả tài khoản (Cloudflare tính tiền theo tài khoản): đỉnh trong ngày của từng bucket, cộng
// các bucket. Trả { days: { "YYYY-MM-DD": bytes } } hoặc { error }.
export async function readCloudflarePeaks(start, now, { fetchImpl = globalThis.fetch } = {}) {
  const token = config.cloudflare?.apiToken;
  const accountTag = config.cloudflare?.accountId || config.r2.accountId;
  if (!token || !accountTag) return null;
  const cacheKey = `${dayKey(start)}:${accountTag}`;
  if (cloudflareCache?.key === cacheKey && Date.now() - cloudflareCache.at < 15 * 60 * 1000) return cloudflareCache.value;
  let value;
  try {
    const res = await fetchImpl(GRAPHQL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { accountTag, start: start.toISOString(), end: now.toISOString() } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors?.length || !body?.data)
      throw new Error(body?.errors?.[0]?.message || `Cloudflare trả lỗi ${res.status}.`);
    const rows = body.data.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups;
    if (!Array.isArray(rows)) throw new Error("Cloudflare không trả số đo R2 của tài khoản này.");
    const perBucket = new Map();
    for (const row of rows) {
      const at = Date.parse(row?.dimensions?.datetime);
      const bytes = (Number(row?.max?.payloadSize) || 0) + (Number(row?.max?.metadataSize) || 0);
      if (!Number.isFinite(at)) continue;
      const key = `${dayKey(at)}|${row.dimensions.bucketName || ""}`;
      perBucket.set(key, Math.max(perBucket.get(key) || 0, bytes));
    }
    const days = {};
    for (const [key, bytes] of perBucket) {
      const day = key.split("|")[0];
      days[day] = (days[day] || 0) + bytes;
    }
    value = { days, truncated: rows.length >= 10000 };
  } catch (error) {
    value = { error: `Chưa đọc được số đo từ Cloudflare: ${error.message}` };
  }
  cloudflareCache = { key: cacheKey, at: Date.now(), value };
  return value;
}

// ─── Tháng này: GB-tháng đã tính, dự kiến cuối tháng, phí ───────────────────────────────────────────────────
// currentBytes: dung lượng đang lưu (vừa đo). limitGBMonths: mức theo dõi của tiệm (mặc định 10 = miễn phí).
export async function readR2Billing({ now = new Date(), currentBytes = null, limitGBMonths = R2_FREE_GB_MONTHS, fetchImpl } = {}) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const today = now.getUTCDate();
  const [stored, cloudflare] = await Promise.all([
    Setting.collection.findOne({ key: KEY }, { projection: { "value.days": 1 } }),
    readCloudflarePeaks(start, now, { fetchImpl }),
  ]);
  const recorded = stored?.value?.days || {};
  const fromCloudflare = cloudflare?.days || {};
  const daily = [];
  for (let d = 1; d <= today; d++) {
    const day = dayKey(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d));
    const live = d === today && Number.isFinite(currentBytes) ? currentBytes : null;
    if (Number.isFinite(fromCloudflare[day])) {
      daily.push({ date: day, bytes: Math.max(fromCloudflare[day], live ?? 0), source: "cloudflare" });
    } else if (Number.isFinite(recorded[day]) || live !== null) {
      daily.push({ date: day, bytes: Math.max(recorded[day] ?? 0, live ?? 0), source: "recorded" });
    } else daily.push({ date: day, bytes: null, source: "missing" });
  }
  const measured = daily.filter((d) => d.bytes !== null);
  const gbMonths = (bytes) => bytes / BYTES_PER_GB / R2_PERIOD_DAYS;
  const monthToDate = measured.reduce((sum, d) => sum + gbMonths(d.bytes), 0);
  const remainingDays = daysInMonth - today;
  const projected = monthToDate + (Number.isFinite(currentBytes) ? gbMonths(currentBytes) * remainingDays : 0);
  const cost = (gb) => Math.max(0, gb - R2_FREE_GB_MONTHS) * R2_PRICE_PER_GB_MONTH;
  const limit = Number.isFinite(limitGBMonths) && limitGBMonths > 0 ? limitGBMonths : R2_FREE_GB_MONTHS;
  const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
  const missing = daily.filter((d) => d.source === "missing");
  return {
    period: { start: dayKey(start), end: dayKey(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), daysInMonth)), days: daysInMonth, today },
    periodDays: R2_PERIOD_DAYS,
    freeGBMonths: R2_FREE_GB_MONTHS,
    pricePerGBMonth: R2_PRICE_PER_GB_MONTH,
    limitGBMonths: limit,
    monthToDate: round(monthToDate),
    projected: round(projected),
    monthToDateCostUSD: round(cost(monthToDate), 4),
    projectedCostUSD: round(cost(projected), 4),
    usagePercent: round((monthToDate / limit) * 100, 2),
    projectedPercent: round((projected / limit) * 100, 2),
    // Theo số đã tính tới hôm nay (16/11 chủ tiệm bỏ phần dự kiến cuối tháng): từ 80 % mức miễn phí là nhắc,
    // từ 100 % là đã bắt đầu mất tiền.
    level: monthToDate >= limit ? "critical" : monthToDate >= limit * 0.8 ? "warning" : "normal",
    measuredDays: measured.length,
    missingDays: missing.length,
    firstMeasured: measured[0]?.date || null,
    source: cloudflare?.days ? (missing.length ? "mixed" : "cloudflare") : "recorded",
    cloudflare: {
      configured: Boolean(config.cloudflare?.apiToken),
      ...(cloudflare?.error && { error: cloudflare.error }),
      ...(cloudflare?.truncated && { truncated: true }),
    },
    daily,
  };
}

// Mỗi giờ: đo dung lượng R2 (danh sách tệp, chỉ đọc thông tin, không tải ảnh) và ghi đỉnh của ngày. Danh sách
// dùng chung bộ nhớ đệm 30 giây với trang quản trị; ~24 lượt liệt kê / ngày, rất xa 1 triệu lượt Class A miễn phí.
export async function sampleR2Usage(readInventory, now = new Date()) {
  const files = await readInventory();
  await recordR2Peak(files.reduce((sum, f) => sum + f.length, 0), now);
}
export function startR2UsageSampler() {
  if (!r2Configured()) return null;
  const run = () => sampleR2Usage(readR2Inventory).catch((e) => console.error("Đo dung lượng R2 thất bại:", e.message));
  setTimeout(run, 60_000).unref();
  return setInterval(run, 60 * 60 * 1000).unref();
}
