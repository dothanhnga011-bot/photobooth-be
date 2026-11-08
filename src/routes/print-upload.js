import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fail } from "./validation.js";

// Print sheets travel as raw bytes (about a quarter smaller than base64 JSON, and no 12 MB
// strings to parse): the body is the sheets one after another, X-Print-Sheets lists their sizes.
// Saved attempts from older pages still arrive as JSON data URLs.
export const printBody = express.raw({ type: "application/octet-stream", limit: "64mb", inflate: false });

const MAX_SHEETS = 100;
// Khổ của khung được in (máy chụp gửi kèm): "strip" = tờ 2 dải, máy DNP cắt đôi; "full" = in nguyên
// tờ. Không gửi (trang cũ) thì theo khổ của gói. Instax luôn theo gói (máy in riêng).
const SHEET_SIZE = z.enum(["full", "strip"]).optional();
const MAX_SHEET_BYTES = 9_000_000; // the JSON limit: 12 M base64 characters
const BASE64_CHUNK = 3 * 64 * 1024; // whole 3-byte groups, so chunked base64 joins up exactly

const sheetType = (buffer) =>
  buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a ? "png"
    : buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff ? "jpeg"
      : null;

// A retried request must be recognised whichever way it travelled: binary sheets are hashed as
// the data URLs the JSON form carries ("data:image/png;base64,…"), without building them.
export function printFingerprint(frameName, sheets) {
  const hash = createHash("sha256").update(JSON.stringify(frameName));
  for (const { buffer, type, dataUrl } of sheets) {
    if (dataUrl) {
      hash.update(`:${dataUrl.length}:`).update(dataUrl);
      continue;
    }
    const prefix = `data:image/${type};base64,`;
    hash.update(`:${prefix.length + Math.ceil(buffer.length / 3) * 4}:`).update(prefix);
    for (let i = 0; i < buffer.length; i += BASE64_CHUNK)
      hash.update(buffer.subarray(i, i + BASE64_CHUNK).toString("base64"));
  }
  return hash.digest("hex");
}

export function readPrintPack(req) {
  if (Buffer.isBuffer(req.body)) {
    let frameName;
    try {
      frameName = decodeURIComponent(req.get("X-Print-Frame") ?? "");
    } catch {
      fail(400, "Tên bộ khung không hợp lệ.");
    }
    const d = z.object({
      requestKey: z.uuid(),
      frameName: z.string().max(100),
      sizes: z.string().regex(/^\d{1,9}(,\d{1,9}){0,99}$/),
      printSize: SHEET_SIZE,
    }).parse({ requestKey: req.get("X-Print-Key"), frameName, sizes: req.get("X-Print-Sheets"),
      printSize: req.get("X-Print-Size") || undefined });
    const sizes = d.sizes.split(",").map(Number);
    if (sizes.length > MAX_SHEETS || sizes.some((n) => n <= 0 || n > MAX_SHEET_BYTES) ||
        sizes.reduce((sum, n) => sum + n, 0) !== req.body.length)
      fail(400, "Ảnh in không hợp lệ.");
    let offset = 0;
    const sheets = sizes.map((n) => {
      const buffer = req.body.subarray(offset, (offset += n));
      const type = sheetType(buffer);
      if (!type) fail(400, "Ảnh in không hợp lệ.");
      return { buffer, type };
    });
    return { requestKey: d.requestKey, frameName: d.frameName, printSize: d.printSize, sheets,
      fingerprint: printFingerprint(d.frameName, sheets) };
  }
  const d = z
    .object({
      images: z
        .array(
          z
            .string()
            .max(12_000_000)
            .regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/),
        )
        .min(1)
        .max(MAX_SHEETS),
      frameName: z.string().max(100),
      requestKey: z.string().uuid(),
      printSize: SHEET_SIZE,
    })
    .parse(req.body);
  const sheets = d.images.map((dataUrl) => ({
    dataUrl,
    type: dataUrl.slice(11, dataUrl.indexOf(";")),
    buffer: Buffer.from(dataUrl.split(",")[1], "base64"),
  }));
  const fingerprint = printFingerprint(d.frameName, sheets);
  return { requestKey: d.requestKey, frameName: d.frameName, printSize: d.printSize,
    sheets: sheets.map(({ type, buffer }) => ({ type, buffer })), fingerprint };
}
