import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, root } from "../src/config.js";
import { printCups, run } from "./print-cups.js";
import { createInstaxPrinter, instaxStatus, printInstaxJob } from "./instax-printer.js";

const api = (process.env.PRINT_AGENT_API_URL || "").replace(/\/$/, "");
const branch = (process.env.PRINT_AGENT_BRANCH || "").trim();
const token = config.printAgentToken;
const mac = process.platform === "darwin";
if (!(mac || process.platform === "win32") || !/^https:\/\//.test(api) || !branch || token.length < 32)
  throw new Error("Cần Windows hoặc macOS, PRINT_AGENT_API_URL (HTTPS), PRINT_AGENT_BRANCH và PRINT_AGENT_TOKEN dài ít nhất 32 ký tự.");

// Máy Instax mini Link 3 / Link WIDE cạnh máy chụp (Bluetooth): INSTAX_ADDRESS là địa chỉ của máy in,
// INSTAX_PYTHON là python của virtualenv đã cài instax-sdk.
const instaxAddress = (process.env.INSTAX_ADDRESS || "").trim();
const instax = instaxAddress
  ? createInstaxPrinter({ address: instaxAddress, python: process.env.INSTAX_PYTHON || "python" })
  : null;
// Khổ máy in cạnh agent này in được; chưa cấu hình máy nào thì nhận mọi lệnh (và báo thiếu cấu hình).
const printSizes = [...(config.dnpPrinter ? ["full", "strip"] : []), ...(instax ? ["instax"] : [])];
const STATUS_EVERY_MS = 60_000;

const headers = { Authorization: `Bearer ${token}` };
async function call(endpoint, options = {}) {
  const response = await fetch(`${api}/api/print-agent${endpoint}`, {
    ...options, headers: { ...headers, ...options.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Print API ${response.status} tại ${endpoint}`);
  return response;
}
const post = (endpoint, body) => call(endpoint, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function download(job, directory) {
  const files = [];
  for (const sheet of job.sheets) {
    const response = await call(`/jobs/${job.id}/sheets/${sheet.index}`, {
      headers: { "X-Print-Lease": job.leaseId },
    });
    const file = path.join(directory, `${sheet.index}.${sheet.extension}`);
    await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    files.push(file);
  }
  return files;
}
async function printDnp(job, files) {
  // Khung nhỏ (2 dải trên một tờ 1200 × 1800): bật "2inch cut" cho riêng lệnh in này để máy DNP cắt đôi;
  // khung to: tắt cắt, in nguyên tờ. Có hàng in cắt đôi riêng (DNP_STRIP_PRINTER_NAME) thì dùng hàng đó.
  const strip = job.printSize === "strip";
  const printer = strip ? config.dnpStripPrinter || config.dnpPrinter : config.dnpPrinter;
  if (!printer)
    throw new Error("Thiếu DNP_PRINTER_NAME (tên máy in DNP trong Windows / trên Mac) trong file .env của print agent.");
  const sheets = files.map((file) => ({ file, copies: job.copies }));
  if (mac) await printCups(printer, sheets);
  else {
    const manifest = path.join(path.dirname(files[0]), "manifest.json");
    await fs.writeFile(manifest, JSON.stringify(sheets.flatMap(({ file, copies }) => Array(copies).fill(file))));
    const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
      path.join(root, "scripts", "print-dnp.ps1"), "-PrinterName", printer, "-Manifest", manifest,
      "-Cut", strip ? "on" : "off"]);
    if (strip && /CUT:unsupported/.test(output) && printer === config.dnpPrinter)
      return `Đã gửi tới ${printer} — driver không nhận lệnh cắt đôi 2 inch: tờ nhỏ ra nguyên tờ, nhân viên tự cắt.`;
    return `Đã gửi tới ${printer}${strip ? ", tờ nhỏ cắt đôi 2 inch" : ", in nguyên tờ"}.`;
  }
}
async function print(job) {
  if (job.printSize === "instax" && !instax)
    throw new Error("Thiếu INSTAX_ADDRESS (địa chỉ Bluetooth máy Instax) trong file .env của print agent.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "photo-agent-"));
  try {
    const files = await download(job, directory);
    if (job.printSize !== "instax") return await printDnp(job, files);
    const { printed, film } = await printInstaxJob(instax, files.flatMap((file) => Array(job.copies).fill(file)));
    return `Đã in ${printed} tấm ra máy Instax${Number.isInteger(film) ? ` · còn ${film} tấm phim` : ""}.`;
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      path.basename(resolved).startsWith("photo-agent-"))
      await fs.rm(resolved, { recursive: true, force: true });
  }
}

let statusAt = 0;
async function reportStatus() {
  if (!instax) return;
  statusAt = Date.now();
  const state = await instaxStatus(instax);
  await post("/status", { branch, instax: state });
  if (!state.connected) console.warn(state.message);
}

async function cycle() {
  const { job } = await (await post("/claim", { branch, ...(printSizes.length && { printSizes }) })).json();
  if (!job) return false;
  let sent = false, message = "";
  try {
    message = (await print(job)) || "";
    sent = true;
    console.log(`Lệnh ${job.id}: ${message || `đã gửi đến hàng in ${mac ? "của Mac" : "Windows"}.`}`);
  } catch (error) {
    message = error.message;
    console.error(`Lệnh ${job.id} thất bại: ${message}`);
  }
  await post(`/jobs/${job.id}/complete`, { leaseId: job.leaseId, sent, message: message.slice(0, 500) });
  // Số phim vừa đổi: báo ngay để máy chụp không bán khi đã hết phim.
  if (job.printSize === "instax") await reportStatus().catch(() => {});
  return true;
}

console.log(`Print agent đang theo dõi chi nhánh ${branch}${printSizes.length ? ` (khổ: ${printSizes.join(", ")})` : ""}.`);
do {
  try { await cycle(); }
  catch (error) { console.error(`Không thể nhận lệnh in: ${error.message}`); }
  if (instax && Date.now() - statusAt >= STATUS_EVERY_MS)
    await reportStatus().catch((error) => console.error(`Không báo được tình trạng máy Instax: ${error.message}`));
  if (process.env.PRINT_AGENT_ONCE === "1") break;
  await new Promise((resolve) => setTimeout(resolve, 4000));
} while (true);
instax?.close();
