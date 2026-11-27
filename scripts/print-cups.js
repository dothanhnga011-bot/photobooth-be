import { spawn } from "node:child_process";

// Chạy một lệnh, trả về stdout; lỗi thì báo stderr (hoặc mã thoát).
export function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data.toString().slice(0, 1000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(
      stderr.trim() || `${command} trả mã ${code}.`)));
  });
}

const is4x6 = (size) => /w288h432|w432h288|4x6|6x4|10x15|15x10/i.test(size);
const isCut = (size) => /div|2x6|cut|strip/i.test(size);
const isWide = (size) => {
  const points = size.match(/w(\d+)h(\d+)/i);
  return points ? Number(points[1]) > Number(points[2]) : /6x4|15x10/i.test(size);
};

// Khổ giấy từ danh sách PageSize của driver (`lpoptions -p <máy in> -l`). Hàng in đã đặt sẵn khổ 4x6
// (kể cả kiểu cắt đôi 2inch cut cho khung nhỏ) thì giữ nguyên; không thì chọn khổ 4x6 thường.
export function pageSize(options) {
  const line = options.split("\n").find((l) => l.startsWith("PageSize/"));
  if (!line) return { args: [], wide: false };
  const sizes = line.slice(line.indexOf(":") + 1).trim().split(/\s+/);
  const current = sizes.find((s) => s.startsWith("*"))?.slice(1) || "";
  if (is4x6(current)) return { args: [], wide: isWide(current) };
  const pick = sizes.map((s) => s.replace(/^\*/, "")).filter(is4x6).sort((a, b) => isCut(a) - isCut(b))[0];
  if (!pick) return {
    args: [], wide: isWide(current),
    warning: `Driver không có khổ 4x6 rõ ràng (${sizes.join(" ")}) — in theo khổ mặc định ${current || "của máy in"}.`,
  };
  return { args: ["-o", `PageSize=${pick}`], wide: isWide(pick) };
}

async function imageWide(file) {
  const info = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const size = (key) => Number(info.match(new RegExp(`${key}:\\s*(\\d+)`))?.[1]);
  return size("pixelWidth") > size("pixelHeight");
}

// macOS: in qua hệ thống in CUPS (lệnh lp). Máy in DNP phải được thêm trong Cài đặt hệ thống → Máy in &
// Máy quét bằng driver DNP cho Mac. Tờ khác chiều với khổ giấy thì xoay 90 độ, phóng kín khổ (không viền).
export async function printCups(printer, sheets) {
  let options;
  try {
    options = await run("lpoptions", ["-p", printer, "-l"]);
  } catch (error) {
    const names = (await run("lpstat", ["-e"]).catch(() => "")).split("\n").filter(Boolean);
    throw new Error(`Không thấy máy in "${printer}" trên Mac này${names.length
      ? ` (DNP_PRINTER_NAME phải là một trong: ${names.join(", ")})` : ""} — ${error.message}`, { cause: error });
  }
  const page = pageSize(options);
  if (page.warning) console.warn(page.warning);
  for (const { file, copies } of sheets) {
    const rotate = (await imageWide(file)) !== page.wide;
    await run("lp", ["-d", printer, "-n", String(copies), ...page.args,
      "-o", "print-scaling=fill", "-o", `orientation-requested=${rotate ? 4 : 3}`, file]);
  }
}
