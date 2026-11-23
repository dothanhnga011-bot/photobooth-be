import { randomUUID } from "node:crypto";
import { z } from "zod";
import Setting from "../models/Setting.js";
import { catalogCache } from "./read-cache.js";

// sharpen: độ nét bản in 0–4 (0 = không làm nét). Agent co tờ in đúng lưới điểm của máy in rồi làm nét
// nhẹ trên độ sáng ở mức này (mực in nhiệt loang nhẹ trên giấy). Mức 2 (vừa) là mặc định.
export const RX1_SHARPEN_MAX = 4;
// stripShift (23/11): dời nội dung tờ cắt đôi (mm, dương = sang dải phải) cho đường cắt 2 inch của máy rơi
// đúng giữa hai dải. Mỗi máy RX1 cắt lệch một chút; đo bằng "In thử đường cắt". Tờ cắt đôi được in đúng
// tỉ lệ thiết kế (không phóng thêm phần tràn lề) nên dời tối đa ±5 mm vẫn không mất nội dung.
export const RX1_STRIP_SHIFT_MAX = 5;
export const DEFAULT_RX1_OUTPUT = { gamma: 1.5, maxResolution: true, sharpen: 2, stripShift: 0 };
const gamma = z.number().min(1).max(2.2)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, "Gamma dùng tối đa 2 chữ số thập phân.");
const sharpen = z.number().int().min(0).max(RX1_SHARPEN_MAX);
const stripShift = z.number().min(-RX1_STRIP_SHIFT_MAX).max(RX1_STRIP_SHIFT_MAX)
  .refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-8, "Dời đường cắt dùng tối đa 1 chữ số thập phân (0,1 mm).");
// Cấu hình cũ (trước khi có độ nét / dời đường cắt) vẫn hợp lệ: thiếu thì dùng mức mặc định.
export const rx1OutputSchema = z.object({
  gamma,
  maxResolution: z.boolean(),
  sharpen: sharpen.default(DEFAULT_RX1_OUTPUT.sharpen),
  stripShift: stripShift.default(DEFAULT_RX1_OUTPUT.stripShift),
}).strict();
// Agent bản cũ chưa biết độ nét / dời đường cắt: báo lại gamma và DPI, thiếu các mục mới.
export const rx1AppliedSchema = z.object({
  gamma, maxResolution: z.boolean(), sharpen: sharpen.optional(), stripShift: stripShift.optional(),
}).strict();

// Missing means no web override yet: preserve each installed agent's existing local settings.
export function getRx1Output() {
  return catalogCache.get("rx1-output", async () => {
    const row = await Setting.findOne({ key: "studio" }).select("value.rx1Output").lean();
    const parsed = rx1OutputSchema.safeParse(row?.value?.rx1Output);
    return parsed.success ? parsed.data : null;
  });
}

const reported = new Map();
export async function noteRx1Output({ room, branch }, applied) {
  const key = String(room);
  const signature = JSON.stringify(applied);
  const last = reported.get(key);
  if (last?.signature === signature && Date.now() - last.at < 30_000) return;
  const now = new Date();
  await Setting.collection.updateOne({ key: `printers:room:${room}` }, {
    $set: { "value.rx1Output": { ...applied, at: now }, "value.agent": { at: now, printSizes: ["full", "strip"] },
      "value.room": key, "value.branch": branch, updatedAt: now },
  }, { upsert: true });
  reported.set(key, { signature, at: Date.now() });
  if (reported.size > 1000) reported.delete(reported.keys().next().value);
}

// ─── In thử độ nét ─────────────────────────────────────────────────────────
// Quản trị bấm "In thử độ nét" cho một phòng: lưu yêu cầu ở tình trạng máy in của phòng. Chương trình in
// của phòng nhận yêu cầu ở lần đồng bộ màu kế tiếp (vài giây), in MỘT tờ chia 5 dải độ nét 0–4 từ tờ in
// gần nhất của máy (chưa có thì ảnh mẫu), rồi báo kết quả ở lần đồng bộ sau. Yêu cầu quá 15 phút chưa
// được nhận thì bỏ (máy in tắt / mất mạng) để không in bất ngờ lúc sau.
export const SHARPNESS_TEST_TTL_MS = 15 * 60_000;
export const sharpnessTestReportSchema = z.object({
  id: z.uuid(),
  sent: z.boolean(),
  message: z.string().max(500).default(""),
}).strict();

// kind "cut" (23/11): tờ thử đường cắt — thước vạch 0,5 mm quanh giữa tờ, in cắt đôi; đọc số ở mép cắt rồi
// nhập vào "Dời đường cắt dải". Cùng đường đồng bộ và cùng thời hạn với tờ thử độ nét.
export const TEST_KINDS = ["sharpness", "cut"];
export async function requestSharpnessTest({ room, branch, kind = "sharpness" }) {
  const now = new Date();
  const test = { id: randomUUID(), kind, status: "queued", at: now, message: "Đang chờ máy in của phòng nhận lệnh in thử." };
  await Setting.collection.updateOne({ key: `printers:room:${room}` }, {
    $set: { "value.sharpnessTest": test, "value.room": String(room), "value.branch": branch, updatedAt: now },
  }, { upsert: true });
  return test;
}

// Yêu cầu in thử đang chờ của phòng ({ id, kind }), hoặc null. Bộ in bản cũ (chưa báo stripShift) không in
// được tờ thử đường cắt — nó sẽ in tờ độ nét thay vào — nên không nhận yêu cầu đó (hết hạn sau 15 phút).
export async function pendingSharpnessTest(room, now = Date.now(), { cut = true } = {}) {
  const row = await Setting.findOne({ key: `printers:room:${room}` }).select("value.sharpnessTest").lean();
  const test = row?.value?.sharpnessTest;
  if (test?.status !== "queued" || now - new Date(test.at).getTime() > SHARPNESS_TEST_TTL_MS) return null;
  const kind = test.kind || "sharpness";
  if (kind === "cut" && !cut) return null;
  return { id: test.id, kind };
}

// Agent báo đã in (hoặc không in được) tờ thử: chỉ cập nhật đúng yêu cầu đó.
export async function noteSharpnessTest(room, report) {
  await Setting.collection.updateOne(
    { key: `printers:room:${room}`, "value.sharpnessTest.id": report.id },
    { $set: {
      "value.sharpnessTest.status": report.sent ? "sent" : "failed",
      "value.sharpnessTest.message": report.message || (report.sent ? "Đã in tờ thử." : "Máy in không nhận lệnh in thử."),
      "value.sharpnessTest.doneAt": new Date(),
    } },
  );
}
