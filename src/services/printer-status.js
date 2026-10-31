import { Setting } from "../models/index.js";
import { MIN_PIECES } from "../routes/print-count.js";

// Tình trạng máy in Instax (Link WIDE) do print agent cạnh máy in báo về (mỗi phút và sau mỗi lần
// in): còn kết nối Bluetooth không, còn bao nhiêu tấm phim, pin. Máy chụp chỉ bán / nhận khổ
// Instax khi máy in sẵn sàng; quản trị xem ở Quản lý máy.
export const PRINTER_FRESH_MS = 3 * 60 * 1000;
const key = (branch) => `printers:${branch}`;

// Ghi thẳng collection: báo tình trạng mỗi phút không làm mới bộ nhớ đệm danh mục.
export async function savePrinterStatus(branch, { instax } = {}) {
  const now = new Date();
  await Setting.collection.updateOne(
    { key: key(branch) },
    { $set: { ...(instax && { "value.instax": instax, "value.at": now }), updatedAt: now } },
    { upsert: true },
  );
}

// Print agent nhận lệnh vài giây một lần: ghi "còn chạy" tối đa 30 giây một lần để quản trị biết
// chương trình in tự động có đang chạy không (và in được khổ nào).
const AGENT_WRITE_MS = 30_000;
export const AGENT_FRESH_MS = 2 * 60 * 1000;
const agentWrites = new Map();
export async function noteAgent(branch, printSizes) {
  const sizes = printSizes?.length ? [...new Set(printSizes)].sort() : ["full", "instax", "strip"];
  const last = agentWrites.get(branch);
  if (last && Date.now() - last.at < AGENT_WRITE_MS && last.sizes === sizes.join()) return;
  agentWrites.set(branch, { at: Date.now(), sizes: sizes.join() });
  await Setting.collection.updateOne(
    { key: key(branch) },
    { $set: { "value.agent": { at: new Date(), printSizes: sizes }, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function readPrinterStatus(branch) {
  return (await Setting.collection.findOne({ key: key(branch) }))?.value || null;
}

export async function listPrinterStatus(branch) {
  const rows = await Setting.collection
    .find(branch ? { key: key(branch) } : { key: /^printers:/ })
    .toArray();
  return rows.map((row) => ({ branch: row.key.slice("printers:".length), ...describe(row.value) }));
}

// Máy Instax dùng được khi print agent vừa báo (≤ 3 phút), còn kết nối và còn ít nhất 2 tấm phim.
export function instaxState(status, now = Date.now()) {
  const instax = status?.instax;
  if (!instax) return { ready: false, film: null, message: "Máy in Instax chưa kết nối với máy tính." };
  const fresh = now - new Date(status.at).getTime() < PRINTER_FRESH_MS;
  const film = Number.isInteger(instax.film) ? instax.film : null;
  const base = { film, battery: instax.battery ?? null, charging: Boolean(instax.charging), at: status.at };
  if (!fresh)
    return { ...base, ready: false, message: "Chương trình in (print agent) cạnh máy Instax không báo về." };
  if (!instax.connected)
    return { ...base, ready: false, message: instax.message || "Máy in Instax chưa bật hoặc mất kết nối Bluetooth." };
  if (film !== null && film < MIN_PIECES)
    return { ...base, ready: false, message: film ? `Máy Instax chỉ còn ${film} tấm phim.` : "Máy Instax hết phim." };
  return { ...base, ready: true, message: instax.message || "" };
}

const describe = (status, now = Date.now()) => ({
  at: status?.at || null,
  instax: status?.instax ? instaxState(status, now) : null,
  agent: status?.agent
    ? { running: now - new Date(status.agent.at).getTime() < AGENT_FRESH_MS, at: status.agent.at,
      printSizes: status.agent.printSizes || [] }
    : null,
});
