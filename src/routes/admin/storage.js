import { Router } from "express";
import { purgeStaleOrphans } from "../../services/orphans.js";
import { z } from "zod";
import { Setting } from "../../models/index.js";
import { admin } from "../../middleware/auth.js";
import { purgeExpiredMedia } from "../../services/media.js";
import { deleteCustomerMedia, listCustomerMedia } from "../../services/customer-media.js";
import { id } from "../validation.js";
import {
  BYTES_PER_MB,
  STORAGE_SETTING_KEY,
  R2_STORAGE_SETTING_KEY,
  getStorageSummary,
} from "../../services/media-storage.js";
import { BYTES_PER_GB } from "../../services/r2.js";

export const storageRouter = Router();

storageRouter.get("/", async (req, res) => {
  res.json(await getStorageSummary());
});

storageRouter.put("/limit", admin, async (req, res) => {
  const value = z
    .object({
      limitMB: z
        .number()
        .positive()
        .max(Number.MAX_SAFE_INTEGER / BYTES_PER_MB)
        .refine(
          (amount) => Math.round(amount * BYTES_PER_MB) >= 1,
          "Giới hạn phải đạt ít nhất 1 byte.",
        )
        .nullable(),
    })
    .strict()
    .parse(req.body);
  await Setting.findOneAndUpdate(
    { key: STORAGE_SETTING_KEY },
    { value },
    { upsert: true },
  );
  res.json(await getStorageSummary());
});

storageRouter.put("/r2-limit", admin, async (req, res) => {
  const value = z
    .object({
      limitGB: z
        .number()
        .positive()
        .max(Number.MAX_SAFE_INTEGER / BYTES_PER_GB)
        .refine((amount) => Math.round(amount * BYTES_PER_GB) >= 1)
        .nullable(),
    })
    .strict()
    .parse(req.body);
  await Setting.findOneAndUpdate(
    { key: R2_STORAGE_SETTING_KEY },
    { value },
    { upsert: true },
  );
  res.json(await getStorageSummary());
});

// Ảnh đang lưu của từng khách (Trợ lí Minh): chỉ quản trị viên xem và xoá.
storageRouter.get("/customers", admin, async (req, res) => {
  res.json(await listCustomerMedia());
});
storageRouter.delete("/customers/:id", admin, async (req, res) => {
  const deleted = await deleteCustomerMedia(id.parse(req.params.id));
  res.json({ ...deleted, summary: await getStorageSummary({ freshR2: true }) });
});

storageRouter.post("/cleanup-expired", admin, async (req, res) => {
  const before = await getStorageSummary({ freshR2: true });
  await purgeExpiredMedia();
  await purgeStaleOrphans();
  const summary = await getStorageSummary({ freshR2: true });
  // Measured media bytes removed, not estimated database allocation recovery.
  const freedBytes =
    before.media.available && summary.media.available
      ? Math.max(0, before.media.bytes - summary.media.bytes)
      : null;
  res.json({ freedBytes, summary });
});
