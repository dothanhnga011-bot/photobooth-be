import { config } from "../config.js";
import { Room, Setting } from "../models/index.js";

// Tình trạng chương trình in / máy in DNP (quản trị xem ở Quản lý máy). Ghi thẳng collection: báo mỗi
// phút không làm mới bộ nhớ đệm danh mục.
const key = (branch) => `printers:${branch}`;

// Print agent nhận lệnh vài giây một lần: ghi "còn chạy" tối đa 30 giây một lần để quản trị biết
// chương trình in tự động có đang chạy không (và in được khổ nào).
const AGENT_WRITE_MS = 30_000;
export const AGENT_FRESH_MS = 2 * 60 * 1000;
const agentWrites = new Map();
export async function noteAgent(branch, printSizes) {
  const sizes = printSizes?.length ? [...new Set(printSizes)].sort() : ["full", "strip"];
  const last = agentWrites.get(branch);
  if (last && Date.now() - last.at < AGENT_WRITE_MS && last.sizes === sizes.join()) return;
  agentWrites.set(branch, { at: Date.now(), sizes: sizes.join() });
  await Setting.collection.updateOne(
    { key: key(branch) },
    { $set: { "value.agent": { at: new Date(), printSizes: sizes }, updatedAt: new Date() } },
    { upsert: true },
  );
}

// Máy in DNP của một phòng (chương trình in cài bằng "Cài máy in" trên mini PC của phòng): còn chạy
// không, máy in báo gì (sẵn sàng / offline / hết giấy), bao nhiêu tờ đang chờ trong hàng in Windows.
const roomKey = (room) => `printers:room:${room}`;
const roomWrites = new Map();
export async function noteRoomAgent({ room, branch }, printSizes) {
  const sizes = printSizes?.length ? [...new Set(printSizes)].sort() : ["full", "strip"];
  const last = roomWrites.get(String(room));
  if (last && Date.now() - last.at < AGENT_WRITE_MS && last.sizes === sizes.join()) return;
  roomWrites.set(String(room), { at: Date.now(), sizes: sizes.join() });
  await Setting.collection.updateOne(
    { key: roomKey(room) },
    { $set: { "value.agent": { at: new Date(), printSizes: sizes }, "value.room": String(room),
      "value.branch": branch, updatedAt: new Date() } },
    { upsert: true },
  );
}
export async function saveRoomPrinterStatus({ room, branch }, dnp) {
  const now = new Date();
  await Setting.collection.updateOne(
    { key: roomKey(room) },
    { $set: { "value.dnp": { ...dnp, at: now }, "value.agent.at": now, "value.room": String(room),
      "value.branch": branch, updatedAt: now } },
    { upsert: true },
  );
}
// Phòng đã có chương trình in DNP chạy (dù chỉ một lần): lệnh in của phòng vào hàng chờ để máy in tự in.
export async function roomHasPrintAgent(room) {
  if (!room) return false;
  return Boolean(await Setting.collection.findOne({ key: roomKey(room), "value.agent.at": { $exists: true } },
    { projection: { _id: 1 } }));
}

// Lệnh in mới: vào hàng chờ cho máy in tự in khi có cách in tự động (máy chủ chạy cạnh máy DNP, agent
// chung của chi nhánh, hoặc chương trình in của chính phòng đó); không thì nhân viên in tay ("idle").
export async function initialSpoolStatus(room) {
  if (config.dnpPrinter || config.printAgentToken) return "queued";
  return (await roomHasPrintAgent(room)) ? "queued" : "idle";
}

export async function listPrinterStatus(branch) {
  const rows = await Setting.collection
    .find(branch
      ? { $or: [{ key: key(branch) }, { key: /^printers:room:/, "value.branch": branch }] }
      : { key: /^printers:/ })
    .toArray();
  const roomRows = rows.filter((row) => row.key.startsWith("printers:room:"));
  const names = new Map((await Room.find({ _id: { $in: roomRows.map((row) => row.value?.room).filter(Boolean) } })
    .select("name active kind").lean()).map((room) => [String(room._id), room]));
  return [
    ...rows.filter((row) => !row.key.startsWith("printers:room:"))
      .map((row) => ({ branch: row.key.slice("printers:".length), ...describe(row.value) })),
    ...roomRows
      // Phòng đã xoá / ngừng hoạt động, hoặc phòng Selfbooth (in ở quầy, không có chương trình in): không hiện.
      .filter((row) => { const room = names.get(row.value?.room); return room && room.active !== false && room.kind !== "polaroid"; })
      .map((row) => ({
        branch: row.value.branch || "",
        room: row.value.room,
        roomName: names.get(row.value.room)?.name || "",
        ...describe(row.value),
        dnp: row.value.dnp || null,
        rx1Output: row.value.rx1Output || null,
        sharpnessTest: row.value.sharpnessTest || null,
      })),
  ];
}

const describe = (status, now = Date.now()) => ({
  at: status?.at || null,
  agent: status?.agent
    ? { running: now - new Date(status.agent.at).getTime() < AGENT_FRESH_MS, at: status.agent.at,
      printSizes: status.agent.printSizes || [] }
    : null,
});
