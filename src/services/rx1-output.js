import { z } from "zod";
import Setting from "../models/Setting.js";
import { catalogCache } from "./read-cache.js";

export const DEFAULT_RX1_OUTPUT = { gamma: 1.5, maxResolution: true };
export const rx1OutputSchema = z.object({
  gamma: z.number().min(0.85).max(1.5)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, "Gamma dùng tối đa 2 chữ số thập phân."),
  maxResolution: z.boolean(),
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
