// Kiểm tra nhanh toàn bộ luồng nội bộ của tiệm trên trình duyệt thật (bản build photobooth-fe/dist):
// lễ tân tạo phiếu và xác nhận đã thu → máy chụp trong phòng (chọn cách chụp, chụp, chọn ảnh và
// khung, ghép gửi album, in) → khách quét QR xem / tải ảnh trên điện thoại → lễ tân xem đơn hàng và
// in lại → Trợ lí dung lượng dọn ảnh hết hạn.
// Chạy: (cd ../photobooth-fe && npm run build) && npm run test:browser
import "./environment.js";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { config, root } from "../src/config.js";
import { MEDIA_TTL_MS, saveMedia, readMedia } from "../src/services/media.js";
import {
  User,
  Room,
  Package,
  Frame,
  Setting,
  Booking,
  PrintJob,
  Sticker,
} from "../src/models/index.js";

const memory = await MongoMemoryServer.create();
await mongoose.connect(memory.getUri());
await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
config.secret = "browser-test-secret-not-for-production-123456789";
// Không bao giờ in thật / điều khiển máy ảnh thật khi chạy test trên máy ở tiệm.
config.dnpPrinter = "";
config.printAgentToken = "";
config.mediaStorageLimitMB = 512;
const cloudflare = process.argv.includes("--cloudflare");
const browserOrigin = "http://localhost:8082";
// With --cloudflare, CLIENT_URL deliberately names some other site: the Worker must validate
// and translate the browser's origin for every mutation without Render listing it.
config.origin = cloudflare ? "https://another-frontend.example" : browserOrigin;
config.frontendDist = path.resolve(root, "../photobooth-fe/dist");
const storageTestDirectory = await fs.mkdtemp(
  path.join(tmpdir(), "nxc-browser-uploads-"),
);
config.uploadDir = storageTestDirectory;
await fs.access(path.join(config.frontendDist, "index.html")).catch(() => {
  throw new Error("Chưa có bản build: chạy `npm run build` trong photobooth-fe.");
});
const { app } = await import("../src/app.js");
config.origin = browserOrigin;
await Room.create({ name: "Phòng 01", branch: "Tiệm", active: true });
// Chụp 4 tấm, khách chọn 2 tấm ghép vào khung hai ô và in 1 tờ.
await Package.create({
  name: "Chụp nhanh",
  price: 70000,
  duration: 10,
  shots: 4,
  selectCount: 2,
  countdownSeconds: 5,
  prints: 1,
  active: true,
});
// Khung 10 × 15 dọc 1200 × 1800 (cỡ khung thật), hai ô ảnh. Máy chụp vẽ khung trước rồi mới đặt
// ảnh vào các ô, nên ô trong khung chỉ là chỗ để xem.
const frame = await sharp({
  create: { width: 1200, height: 1800, channels: 3, background: "#f6c9d6" },
})
  .composite([
    {
      input: {
        create: { width: 960, height: 1080, channels: 3, background: "#fff" },
      },
      left: 120,
      top: 180,
    },
  ])
  .png()
  .toBuffer();
await Frame.create({
  name: "Khung hồng",
  themeName: "Hồng",
  image: `data:image/png;base64,${frame.toString("base64")}`,
  slots: [
    { x: 0.1, y: 0.1, w: 0.8, h: 0.6 },
    { x: 0.1, y: 0.75, w: 0.8, h: 0.15 },
  ],
  active: true,
});
// Nhãn dán của tiệm (vuông xanh 120 px): máy chụp tải ảnh qua /api/stickers/:id/image rồi vẽ lên ảnh in.
const STICKER_BLUE = [30, 60, 220];
await Sticker.create({
  name: "Ngôi sao xanh",
  image: `data:image/png;base64,${(await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 30, g: 60, b: 220, alpha: 1 } },
  }).png().toBuffer()).toString("base64")}`,
  order: 0,
  active: true,
});
await Setting.create({
  key: "studio",
  value: {
    name: "NXC Photobooth",
    address: "Tiệm",
    phone: "0912345678",
    bank: "",
    bankAccount: "",
    bankOwner: "",
    bankQrImage:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJxkAAAAASUVORK5CYII=",
  },
});
const password = await bcrypt.hash("BrowserTest!123", 10);
await User.create([
  { name: "Quản trị", email: "admin@test.local", password, role: "admin" },
  // Lễ tân phải được gán chi nhánh mới tạo phiếu và xem máy, đơn hàng của chi nhánh đó.
  { name: "Lễ tân", email: "counter@test.local", password, role: "staff", branch: "Tiệm" },
]);
const server = await new Promise((resolve) => {
  const s = app.listen(cloudflare ? 8083 : 8082, () => resolve(s));
});
let proxyServer;
let browser;
let originalStorageCommand;
const errors = [];
const watch = (page) => page.on("pageerror", (e) => errors.push(e.message));
const noOverflow = async (page) =>
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    `Tràn ngang tại ${page.url()}`,
  );
const signIn = async (page, email) => {
  await page.goto(config.origin + "/admin");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill("BrowserTest!123");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.locator(".admin-shell").waitFor();
  if (cloudflare) {
    await page.reload();
    await page.locator(".admin-shell").waitFor();
    assert.equal(await page.getByLabel("Email", { exact: true }).count(), 0,
      "Same-origin authentication cookie survives a Cloudflare page reload");
  }
};
// Chờ máy chủ làm xong việc chạy nền (máy chụp gửi ảnh ghép, lệnh in… sau khi màn hình đã chuyển).
const until = async (check, what, timeout = 40000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Hết thời gian chờ: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
// Link tải trong trang là đường dẫn tương đối; yêu cầu gửi từ test cần địa chỉ đầy đủ.
const absolute = (href) => new URL(href, config.origin).href;
const menu = (page, name) =>
  page
    .getByRole("navigation", { name: "Quản lý studio" })
    .getByRole("button", { name, exact: true });
// Màu của một điểm ảnh, theo tỉ lệ vị trí trong ảnh.
const pixel = async (buffer, x, y) => {
  const { width, height } = await sharp(buffer).metadata();
  return [
    ...(await sharp(buffer)
      .extract({ left: Math.round(width * x), top: Math.round(height * y), width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer()),
  ];
};
try {
  if (cloudflare) {
    const { startCloudflareProxyServer } = await import(
      "../../photobooth-fe/test/cloudflare-proxy-server.mjs"
    );
    proxyServer = await startCloudflareProxyServer({
      apiOrigin: "http://localhost:8083",
      frontendDist: config.frontendDist,
      port: 8082,
    });
    // A direct request from the new frontend origin is rejected by the unchanged
    // backend; the browser flow below can pass only through Worker translation.
    const rejected = await fetch("http://localhost:8083/api/auth/login", {
      method: "POST",
      headers: { Origin: browserOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.local", password: "BrowserTest!123" }),
    });
    assert.equal(rejected.status, 403, "Backend still rejects the unconfigured frontend origin");
  }
  browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    permissions: ["camera"],
  });

  // ── Web nội bộ: không có trang chủ / tra cứu công khai ──
  const page = await context.newPage();
  watch(page);
  await page.goto(config.origin + "/");
  await page.waitForURL("**/admin");
  await page.getByText("quét mã QR trên màn hình máy").waitFor();
  for (const route of ["/gallery", "/booking"]) {
    await page.goto(config.origin + route);
    await page
      .getByRole("heading", { name: "Không tìm thấy trang." })
      .waitFor();
    assert.equal(await page.locator("a").count(), 0, `${route}: không có link`);
  }
  // Mỗi màn hình vào được từ địa chỉ trần, và vừa chiều ngang từ điện thoại nhỏ tới màn hình lớn.
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, landmark] of [
      ["/admin", () => page.getByRole("heading", { name: "Đăng nhập studio" })],
      ["/kiosk", () => page.getByRole("button", { name: "Chạm để bắt đầu" })],
      ["/khong-co", () => page.getByRole("heading", { name: "Không tìm thấy trang." })],
    ]) {
      await page.goto(config.origin + route);
      await landmark().waitFor();
      await noOverflow(page);
    }
  }
  assert.equal(
    (await fetch(`${config.origin}/robots.txt`).then((r) => r.text())).trim(),
    "User-agent: *\nDisallow: /",
  );

  // ── Quản trị: cài máy chụp cho phòng ──
  const admin = await context.newPage();
  watch(admin);
  await admin.goto(config.origin + "/admin");
  await admin.getByLabel("Mật khẩu", { exact: true }).fill("x");
  await admin
    .getByRole("button", { name: "Hiện mật khẩu", exact: true })
    .click();
  assert.equal(
    await admin.getByLabel("Mật khẩu", { exact: true }).getAttribute("type"),
    "text",
  );
  await signIn(admin, "admin@test.local");
  await menu(admin, "Quản lý máy").click();
  await admin.getByRole("button", { name: /^Cài máy chụp cho / }).click();
  // Mở thẳng liên kết và QR (loại phòng đã chọn lúc thêm phòng).
  const kioskUrl = await admin
    .getByRole("link", { name: "Mở máy chụp", exact: true })
    .getAttribute("href");
  await admin
    .getByRole("dialog", { name: "Cài máy chụp" })
    .getByRole("button", { name: "Đóng" })
    .click();

  // ── Lễ tân (điện thoại): tạo phiếu rồi xác nhận đã thu; mất phản hồi vẫn không trùng phiếu / mã ──
  const counterContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const counter = await counterContext.newPage();
  watch(counter);
  await signIn(counter, "counter@test.local");
  await counter.getByText("1 trống", { exact: true }).waitFor();
  await counter.getByRole("button", { name: "Tạo mã chụp" }).click();
  const ticket = counter.getByRole("dialog", { name: "Tạo mã chụp cho khách" });
  await ticket.locator("select[name=paymentMethod]").selectOption("transfer");
  await ticket.getByAltText("Mã QR chuyển khoản").waitFor();
  assert.equal(
    await ticket.locator('input[type="date"], input[type="time"]').count(),
    0,
    "Không có ô chọn ngày giờ: mã dùng trong ngày",
  );
  // Phiếu không cần tên / số điện thoại khách và không có ô gợi ý phòng.
  assert.equal(await ticket.locator("select[name=room]").count(), 0);
  assert.equal(await ticket.locator("input[name=name], input[name=phone]").count(), 0);
  assert.equal(await ticket.getByText("Dùng để tra cứu lại album của khách.").count(), 0);
  // Phản hồi của máy chủ bị mất đúng một lần: bấm lại phải ra cùng một phiếu.
  let loseDraftResponse = true;
  await counter.route("**/api/admin/tickets/draft", async (route) => {
    const response = await route.fetch();
    if (loseDraftResponse) {
      loseDraftResponse = false;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  const draft = ticket.getByRole("button", { name: "Tạo phiếu chụp" });
  await draft.click();
  await counter
    .getByRole("alert")
    .filter({ hasText: /kết nối được máy chủ/ })
    .first()
    .waitFor();
  await draft.click();
  await counter.getByRole("dialog", { name: "Chờ xác nhận đã thu" }).waitFor();
  assert.equal(await Booking.countDocuments({ source: "counter" }), 1);
  // Phiếu mới chỉ ghi nhận gói: chưa có mã 6 số, chưa thu tiền.
  const pending = await Booking.findOne({ source: "counter" });
  assert.equal(pending.name, "");
  assert.equal(pending.phone, "");
  assert.equal(pending.status, "pending");
  assert.equal(pending.paid, false);
  assert.equal(pending.code, undefined);
  assert.equal(await counter.locator(".ticket-code").count(), 0);
  const collected = counter.getByRole("dialog", { name: "Chờ xác nhận đã thu" });
  const activate = collected.getByRole("button", {
    name: "Xác nhận đã thu & hiện mã 6 số",
  });
  assert.equal(await activate.isDisabled(), true, "Chưa tích đã nhận tiền thì chưa cấp mã");
  await collected.getByRole("checkbox").check();
  // Mất phản hồi lúc xác nhận thu tiền: bấm lại vẫn là một mã, không cấp mã thứ hai.
  let loseActivateResponse = true;
  await counter.route("**/api/admin/tickets/*/activate", async (route) => {
    const response = await route.fetch();
    if (loseActivateResponse) {
      loseActivateResponse = false;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await activate.click();
  await counter
    .getByRole("alert")
    .filter({ hasText: /kết nối được máy chủ/ })
    .first()
    .waitFor();
  await activate.click();
  await counter.getByRole("dialog", { name: "Mã chụp đã sẵn sàng" }).waitFor();
  await noOverflow(counter);
  const booking = await Booking.findById(pending._id).select(
    "+accessToken",
  );
  assert.equal(await Booking.countDocuments({ source: "counter" }), 1);
  assert.equal(booking.status, "confirmed");
  assert.equal(booking.paid, true);
  assert.equal(booking.paymentMethod, "transfer");
  assert.match(booking.code, /^\d{6}$/);
  assert.equal(
    await counter.getByLabel("Mã chụp của khách").innerText(),
    booking.code,
  );
  assert.equal(
    await counter.getByRole("dialog").locator("svg[role=img], canvas").count(),
    0,
    "Phiếu ở quầy không có QR album: khách quét QR ở máy chụp",
  );
  await counter.getByRole("button", { name: "Xong", exact: true }).click();

  // ── Máy chụp trong phòng: khách chỉ chụp bằng máy ảnh, ảnh về thư mục X Acquire ──
  const kiosk = await context.newPage();
  watch(kiosk);
  // Hộp chọn thư mục giả lập: thư mục X Acquire nằm trong bộ nhớ riêng của trình duyệt (OPFS).
  await kiosk.addInitScript(() => {
    window.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("X Acquire", {
        create: true,
      });
  });
  // Máy ảnh chụp: X Acquire ghi một tệp JPEG mới vào thư mục.
  const shoot = async (name) => {
    const bytes = [
      ...(await sharp({
        create: { width: 1500, height: 1000, channels: 3, background: "#7a9" },
      })
        .jpeg()
        .toBuffer()),
    ];
    await kiosk.evaluate(
      async ([name, bytes]) => {
        const dir = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("X Acquire", { create: true });
        const w = await (
          await dir.getFileHandle(name, { create: true })
        ).createWritable();
        await w.write(new Uint8Array(bytes));
        await w.close();
      },
      [name, bytes],
    );
  };
  await kiosk.goto(kioskUrl);
  assert.equal(
    await kiosk.getByRole("button", { name: "Chụp ảnh" }).count(),
    0,
    "Không có nút chụp trên màn hình: chỉ chụp bằng máy ảnh",
  );
  await kiosk.getByText("Cài đặt máy chụp (nhân viên)").click();
  await kiosk.getByRole("button", { name: /Chọn thư mục ảnh/ }).click();
  await kiosk
    .getByText(/Đã chọn thư mục ảnh “X Acquire”/)
    .first()
    .waitFor();
  // Phòng photobooth: Chạm để bắt đầu → chọn cách thanh toán → Nhập mã (khách đã chuyển khoản ở
  // quầy) → nhập mã → vào chụp luôn.
  await kiosk.getByRole("button", { name: "Chạm để bắt đầu" }).click();
  await kiosk.getByRole("heading", { name: "Chọn cách thanh toán" }).waitFor();
  await kiosk.getByRole("button", { name: /Nhập mã/ }).click();
  await kiosk.getByRole("heading", { name: "Nhập mã chụp" }).waitFor();
  await kiosk
    .getByRole("textbox", { name: "Mã chụp", exact: true })
    .fill(booking.code);
  // Đủ 6 số là máy chụp tự kiểm tra mã và vào chụp, không cần bấm "Bắt đầu chụp".
  // Khách chụp bằng dây bấm của máy ảnh (không có nút chụp trên màn hình).
  await kiosk.locator(".shoot-screen.phase-shoot").waitFor({ timeout: 20000 });
  assert.equal(
    await kiosk.getByRole("button", { name: "Chụp ảnh" }).count(),
    0,
    "Màn chụp không có nút chụp",
  );
  await kiosk.waitForTimeout(1000);
  for (const [i, n] of ["1", "2"].entries()) {
    await shoot(`DSCF000${i + 1}.JPG`);
    await kiosk
      .locator(".shoot-thumbs .shoot-thumb-no", { hasText: n })
      .waitFor({ timeout: 20000 });
  }
  await kiosk.getByRole("button", { name: "Chụp xong, chọn ảnh" }).click();
  // Chọn ảnh, màu ảnh và nhãn dán trên cùng một màn: chọn đủ 2 tấm của gói, chọn màu, dán nhãn dán
  // của tiệm rồi bấm In ảnh.
  await kiosk.getByRole("heading", { name: /để chọn ảnh & trang trí/ }).waitFor();
  const picks = kiosk
    .getByRole("group", { name: "Ảnh đã chụp" })
    .getByRole("button");
  assert.equal(await picks.count(), 2);
  const print = kiosk.getByRole("button", { name: "In ảnh", exact: true });
  assert.equal(await print.isDisabled(), true, "Chọn đủ ảnh của gói mới được in");
  await picks.nth(0).click();
  await picks.nth(1).click();
  // Chọn đủ ảnh: máy tự mở mục kế tiếp (Khung khi có nhiều khung, không thì Chỉnh ảnh); màu ảnh ở mục Màu ảnh.
  await kiosk.getByRole("tab", { name: /Chỉnh ảnh/ }).waitFor();
  await kiosk.getByRole("tab", { name: /Màu ảnh/ }).click();
  await kiosk.getByRole("radio", { name: "Trắng đen" }).click();
  await kiosk.getByRole("tab", { name: /Nhãn dán/ }).click();
  await kiosk.getByRole("button", { name: "Thêm nhãn dán Ngôi sao xanh" }).click();
  const decor = await kiosk.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith("photo-capture-"));
    return JSON.parse(sessionStorage.getItem(key)).decor;
  });
  assert.equal(decor.filter, "mono");
  assert.equal(decor.stickers.length, 1);
  await print.click();
  await kiosk.getByRole("heading", { name: /Quét QR để tải ảnh/ }).waitFor();
  await kiosk.getByRole("img", { name: "Ảnh đã ghép khung" }).waitFor();
  // Máy chủ chưa bật máy in tự động (config.dnpPrinter trống): máy chụp mời nhân viên in giúp.
  await kiosk
    .getByRole("status")
    .filter({ hasText: /Nhờ nhân viên in ảnh giúp bạn/ })
    .waitFor({ timeout: 30000 });
  // Việc chạy nền của máy chụp: chốt phiên, tải ảnh gốc lên album, gửi ảnh ghép và lệnh in.
  await until(async () => (await Booking.findById(booking._id)).status === "completed", "chốt phiên chụp");
  const album = await until(async () => {
    const b = await Booking.findById(booking._id);
    return b.photos.length === 2 && b.composite?.file ? b : null;
  }, "ảnh gốc và ảnh ghép khung lên album");
  assert.deepEqual(album.photos.map((p) => p.number), [1, 2]);
  // Ảnh xem trước tới trước (album có ảnh ngay), ảnh gốc của máy ảnh tới sau và thay vào (kho MongoDB:
  // gửi qua máy chủ), sau lệnh in và ảnh ghép.
  const withOriginals = await until(async () => {
    const b = await Booking.findById(booking._id);
    return b.photos.every((p) => !p.originalPending && p.file !== p.previewFile) ? b : null;
  }, "ảnh gốc của máy ảnh gắn vào album", 60000);
  for (const photo of withOriginals.photos) {
    assert.equal(photo.sourcePreserved, true);
    assert.equal((await sharp(await readMedia(photo.file)).metadata()).width, 1500);
  }
  // Ảnh ghép trên máy chủ đúng như khách thấy: ảnh trong ô trắng đen, nhãn dán vẫn xanh, viền khung
  // giữ màu hồng.
  {
    const { data, info } = await sharp(await readMedia(album.composite.file))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const color = (x, y) => {
      const i = (Math.round(y * (info.height - 1)) * info.width + Math.round(x * (info.width - 1))) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const near = (actual, expected, label) =>
      assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 24), `${label}: ${actual}`);
    const [sticker] = decor.stickers;
    near(color(sticker.u, sticker.v), STICKER_BLUE, "nhãn dán");
    // Ảnh #7a9 qua Trắng đen ≈ xám 158.
    near(color(0.15, 0.12), [158, 158, 158], "ảnh trắng đen");
    near(color(0.03, 0.5), [246, 201, 214], "viền khung");
  }
  // Video tua nhanh ghép từ hình trực tiếp (camera giả của trình duyệt), gửi lên sau ảnh ghép.
  const withVideo = await until(async () => {
    const b = await Booking.findById(booking._id);
    return b.video?.file ? b : null;
  }, "video tua nhanh");
  const sent = await until(() => PrintJob.findOne({ code: booking.code }), "lệnh in từ máy chụp");
  assert.equal(sent.sheets.length, 1, "Gói 1 tờ → một tờ in");
  assert.equal(sent.frameName, "Hồng");
  assert.equal(await PrintJob.countDocuments({ code: booking.code }), 1);

  // ── Khách quét QR: album chỉ để xem và tải, trên điện thoại ──
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const phone = await phoneContext.newPage();
  watch(phone);
  await phone.goto(`${config.origin}/album/${booking.accessToken}`);
  const viewer = phone.getByRole("region", { name: "Ảnh và video của bạn" });
  await viewer.waitFor();
  await noOverflow(phone);
  // Ảnh ghép khung đứng đầu, rồi video tua nhanh, rồi tới từng ảnh gốc.
  assert.deepEqual(
    await viewer
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label"))),
    ["Ảnh ghép khung", "Video tua nhanh", "Ảnh 1", "Ảnh 2"],
  );
  await phone.waitForFunction(() => {
    const image = document.querySelector(".album-viewer-stage img.album-viewer-main");
    return image?.complete && image.naturalWidth > 0;
  });
  await phone.getByText(`#${booking.code}`, { exact: true }).waitFor();
  const albumPath = `/api/albums/${booking.accessToken}`;
  const compositeHref = `${albumPath}/composite?download=1`;
  const zipHref = `${albumPath}/download`;
  const videoExt = withVideo.video.mimeType === "video/mp4" ? "mp4" : "webm";
  // Không còn dòng nhắc "giữ vào ảnh / bấm tải video" và nút ZIP: chỉ "Lưu" và "Lưu tất cả".
  assert.equal(await viewer.getByText(/GIỮ VÀO ẢNH|TẢI VIDEO/).count(), 0);
  assert.equal(await viewer.getByText(/ZIP/).count(), 0);
  // Android / máy tính: "Lưu" tải tệp đang xem, "Lưu tất cả" tải từng tệp (ảnh ghép, video, ảnh gốc).
  const savedOne = phone.waitForEvent("download");
  await viewer.getByRole("button", { name: "Lưu ảnh ghép" }).click();
  assert.equal((await savedOne).suggestedFilename(), `NXC-${booking.code}-anh-ghep.jpg`);
  const savedAll = [];
  const collect = (download) => savedAll.push(download.suggestedFilename());
  phone.on("download", collect);
  await viewer.getByRole("button", { name: "Lưu tất cả (4)" }).click();
  await until(() => savedAll.length === 4 || null, "tải đủ 4 tệp của album");
  phone.off("download", collect);
  assert.deepEqual(savedAll, [
    `NXC-${booking.code}-anh-ghep.jpg`,
    `NXC-${booking.code}-video.${videoExt}`,
    `NXC-${booking.code}-01.jpg`,
    `NXC-${booking.code}-02.jpg`,
  ]);
  await viewer.getByRole("tab", { name: "Video tua nhanh" }).click();
  await viewer.getByRole("button", { name: "Lưu video" }).waitFor();
  const video = await phone.request.get(absolute(`${albumPath}/video?download=1`));
  assert.equal(video.status(), 200);
  assert.equal(video.headers()["content-type"], withVideo.video.mimeType);
  assert.equal((await video.body()).length, withVideo.video.size);
  await viewer.getByRole("tab", { name: "Ảnh 2" }).click();
  await viewer.getByRole("button", { name: "Lưu ảnh", exact: true }).waitFor();
  assert.equal(await viewer.getByRole("img", { name: "Ảnh 2" }).count(), 1);

  // iPhone: "Lưu tất cả" mở bảng chia sẻ của iOS với mọi tệp ("Lưu N mục" → app Ảnh). App Ảnh không
  // nhận WebM nên video WebM không nằm trong bảng. Tải lâu, Safari chặn bảng chia sẻ: nút đổi thành
  // "Bấm để lưu", bấm lại là mở với các tệp đã tải.
  const iphoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await iphoneContext.addInitScript(() => {
    window.__shared = [];
    let blocked = true;
    navigator.canShare = (data) => Array.isArray(data?.files);
    navigator.share = async ({ files }) => {
      if (blocked) {
        blocked = false;
        throw new DOMException("activation expired", "NotAllowedError");
      }
      window.__shared.push(files.map((file) => ({ name: file.name, type: file.type, size: file.size })));
    };
  });
  const iphone = await iphoneContext.newPage();
  watch(iphone);
  await iphone.goto(`${config.origin}/album/${booking.accessToken}`);
  const iphoneViewer = iphone.getByRole("region", { name: "Ảnh và video của bạn" });
  const iosCount = videoExt === "mp4" ? 4 : 3;
  await iphoneViewer.getByRole("button", { name: `Lưu tất cả (${iosCount})` }).click();
  await iphoneViewer.getByRole("button", { name: `Bấm để lưu ${iosCount} mục` }).click();
  const shared = await iphone.waitForFunction(() => window.__shared[0]).then((handle) => handle.jsonValue());
  assert.deepEqual(shared.map((file) => [file.name, file.type]), [
    [`NXC-${booking.code}-anh-ghep.jpg`, "image/jpeg"],
    ...(videoExt === "mp4" ? [[`NXC-${booking.code}-video.mp4`, "video/mp4"]] : []),
    [`NXC-${booking.code}-01.jpg`, "image/jpeg"],
    [`NXC-${booking.code}-02.jpg`, "image/jpeg"],
  ]);
  assert.ok(shared.every((file) => file.size > 1000), "các tệp chia sẻ là ảnh / video thật");
  await iphoneContext.close();
  // Album chỉ có các link tải về: không có đường dẫn sang trang nào khác.
  assert.deepEqual(
    (await phone.locator("a").evaluateAll((links) => links.map((a) => a.getAttribute("href"))))
      .filter((href) => !href.includes(albumPath)),
    [],
  );
  // Bản ghép máy chụp gửi lên: đúng cỡ khung và ô ảnh chứa ảnh khách chụp (đã chọn Trắng đen: xám),
  // không phải nền hồng. Điểm đo (0,2; 0,2) nằm ngoài chỗ nhãn dán có thể được dán (giữa khung).
  const composite = await phone.request.get(absolute(compositeHref));
  assert.equal(composite.status(), 200);
  assert.match(composite.headers()["content-type"], /image\/jpeg/);
  const compositeImage = Buffer.from(await composite.body());
  assert.equal((await sharp(compositeImage).metadata()).width, 1200);
  assert.equal((await sharp(compositeImage).metadata()).height, 1800);
  const [red, green, blue] = await pixel(compositeImage, 0.2, 0.2);
  assert.ok(red < 170 && green > 140 && Math.abs(red - blue) < 20,
    `Ô ảnh chứa ảnh khách chụp, không phải nền khung: ${red},${green},${blue}`);
  const [frameRed] = await pixel(compositeImage, 0.03, 0.4);
  assert.ok(frameRed > 220, "Viền khung giữ màu hồng");
  // Tờ in máy chụp gửi cho lễ tân giống bản ghép: ảnh khách nằm trong ô.
  const sheet = await phone.request.get(`${config.origin}${albumPath}/prints/${sent._id}`);
  assert.equal(sheet.status(), 200);
  const sheetImage = Buffer.from(await sheet.body());
  const [sheetRed, sheetGreen, sheetBlue] = await pixel(sheetImage, 0.2, 0.2);
  assert.ok(sheetRed < 170 && sheetGreen > 140 && Math.abs(sheetRed - sheetBlue) < 20,
    "Ô ảnh trên tờ in chứa ảnh khách chụp, cùng màu Trắng đen");
  // Tờ in có nhãn dán đúng chỗ khách dán.
  const [stickerRed, , stickerBlue] = await pixel(sheetImage, decor.stickers[0].u, decor.stickers[0].v);
  assert.ok(stickerBlue > 170 && stickerRed < 90, `Nhãn dán trên tờ in: ${stickerRed},${stickerBlue}`);
  // ZIP: đúng hai ảnh gốc của buổi chụp.
  const zip = await phone.request.get(absolute(zipHref));
  assert.equal(zip.status(), 200);
  assert.match(zip.headers()["content-type"], /zip/);
  const zipBytes = Buffer.from(await zip.body());
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
  assert.equal(zipBytes.readUInt16LE(zipBytes.length - 12), 2);
  // Làm mới ảnh không đổi gì và không báo lỗi.
  await phone.getByRole("button", { name: "Làm mới ảnh" }).click();
  await phone.getByRole("button", { name: "Làm mới ảnh" }).waitFor();
  await noOverflow(phone);
  if (process.env.UI_SCREENSHOTS) {
    await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
    await phone.screenshot({
      path: path.join(process.env.UI_SCREENSHOTS, "album-mobile.png"),
      fullPage: true,
    });
  }

  // ── Lễ tân xem đơn hàng, tải ảnh và in lại ──
  await menu(admin, "Đơn hàng").click();
  const order = admin.locator("article.order-card", { hasText: `#${booking.code}` });
  await order.waitFor();
  assert.match(await order.innerText(), /Khách tại quầy/);
  assert.match(await order.innerText(), /Chuyển khoản/);
  assert.match(await order.innerText(), /1\/1 tờ/);
  assert.match(await order.innerText(), /Hồng/);
  await order.getByRole("img", { name: "Ảnh đã ghép khung" }).first().waitFor();
  await order.getByRole("button", { name: /Tải ảnh/ }).click();
  await admin.getByRole("menuitem", { name: /Tải tất cả ảnh \(ZIP\)/ }).waitFor();
  await admin.getByRole("menuitem", { name: /Tải ảnh ghép khung/ }).waitFor();
  await admin.keyboard.press("Escape");
  await order.getByRole("button", { name: /^In ảnh/ }).click();
  const printDialog = admin.getByRole("dialog", { name: `In ảnh đơn ${booking.code}` });
  await printDialog.getByRole("img", { name: `Ảnh in của đơn ${booking.code}` }).waitFor();
  assert.match(await printDialog.innerText(), /Số tờ trong file\s*1/);
  await printDialog.getByLabel("Số bản in lại").selectOption("2");
  await printDialog.getByRole("button", { name: "In lại ảnh" }).click();
  await admin.getByText("Đã gửi 2 bản vào hàng chờ in.").first().waitFor();
  // Lệnh in lại có thêm một bản ghi riêng và báo ngay trên màn hình quản trị đang mở.
  const reprint = await until(async () => {
    const jobs = await PrintJob.find({ code: booking.code }).sort({ createdAt: 1 });
    return jobs.length === 2 ? jobs[1] : null;
  }, "lệnh in lại");
  assert.equal(reprint.copies, 2);
  assert.equal(reprint.file, sent.file, "In lại đúng file khách đã gửi");
  await admin.getByText(/Lệnh in mới · vé #/).first().waitFor();

  // ── Trợ lí dung lượng: số liệu thật, giới hạn và chỉ dọn ảnh đã hết hạn ──
  // Mở trợ lí từ cảnh báo dung lượng (MongoDB tạm chưa đo được cả cluster); trang cũng có trên menu.
  await admin.getByRole("button", { name: "Mở trợ lí để dọn ảnh", exact: true }).click();
  await admin
    .getByRole("heading", { name: "Trợ lí Minh", exact: true })
    .waitFor();
  await admin
    .getByText("Chưa đo được dung lượng toàn cluster", { exact: false })
    .first()
    .waitFor();
  const storageBefore = await admin.request.get(
    config.origin + "/api/admin/storage",
  );
  assert.equal(storageBefore.status(), 200);
  const stored = await storageBefore.json();
  assert.equal(
    stored.quota.limitMB,
    512,
    "Giới hạn studio được xác nhận là 512 MB",
  );
  assert.equal(
    stored.cluster.available,
    false,
    "MongoDB tạm không hỗ trợ atlasSize",
  );
  assert.equal(stored.quota.remainingBytes, null);
  assert.ok(stored.media.files >= 6 && stored.media.bytes > 0);
  assert.ok(
    stored.database.available &&
      stored.database.usedBytes >= stored.media.bytes,
  );
  // MongoDB tạm không có lệnh riêng của Atlas. Mô phỏng phản hồi của lệnh đó
  // bằng dbStats thật cộng dung lượng một database khác trong cluster.
  const storageDB = mongoose.connection.db;
  originalStorageCommand = storageDB.command;
  storageDB.command = async function (command, ...options) {
    if (!command.atlasSize)
      return originalStorageCommand.call(this, command, ...options);
    const stats = await originalStorageCommand.call(this, {
      dbStats: 1,
      scale: 1,
    });
    const dataSize = stats.dataSize + 2 * 1048576;
    return {
      ok: 1,
      atlasSize: dataSize + stats.indexSize,
      totals: { dataSize, indexSize: stats.indexSize, numDatabases: 2 },
    };
  };
  const [liveStorage] = await Promise.all([
    admin.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/storage") &&
        response.request().method() === "GET",
    ),
    admin.getByRole("button", { name: "Làm mới", exact: true }).click(),
  ]);
  const live = await liveStorage.json();
  assert.equal(live.cluster.available, true);
  assert.equal(live.cluster.databaseCount, 2);
  assert.ok(live.cluster.usedBytes > live.database.usedBytes);
  assert.equal(live.quota.scope, "cluster");
  assert.equal(
    live.quota.remainingBytes,
    Math.max(0, 512 * 1048576 - live.cluster.usedBytes),
  );
  await admin
    .getByRole("progressbar", {
      name: "Phần trăm dung lượng đã dùng",
      exact: true,
    })
    .waitFor();
  for (const width of [390, 1366]) {
    await admin.setViewportSize({ width, height: 900 });
    await noOverflow(admin);
    if (process.env.UI_SCREENSHOTS) {
      await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
      await admin.screenshot({
        path: path.join(process.env.UI_SCREENSHOTS, `storage-${width}.png`),
        fullPage: true,
      });
    }
  }

  // Giao diện không còn ô chỉnh giới hạn; API vẫn nhận mức giới hạn cho quản trị.
  const savedLimit = await admin.request.put(
    config.origin + "/api/admin/storage/limit",
    { data: { limitMB: 128 } },
  );
  assert.equal(savedLimit.status(), 200);
  const configured = await savedLimit.json();
  assert.equal(configured.quota.limitMB, 128);
  assert.equal(
    configured.quota.remainingBytes,
    Math.max(0, 128 * 1048576 - configured.cluster.usedBytes),
  );

  const expiredAt = new Date(Date.now() - MEDIA_TTL_MS - 60_000);
  const oldPhotoId = mongoose.Types.ObjectId.createFromTime(
    Math.floor(expiredAt.getTime() / 1000),
  );
  await saveMedia(
    "storage-expired-photo.jpg",
    Buffer.from("old-photo"),
    "image/jpeg",
  );
  await saveMedia(
    "storage-expired-photo.original",
    Buffer.from("old-original"),
    "application/octet-stream",
  );
  await saveMedia(
    "storage-expired-print.jpg",
    Buffer.from("old-print"),
    "image/jpeg",
  );
  await Booking.updateOne(
    { _id: booking._id },
    {
      $push: {
        photos: {
          _id: oldPhotoId,
          file: "storage-expired-photo.jpg",
          originalFile: "storage-expired-photo.original",
          kind: "original",
        },
      },
    },
  );
  await PrintJob.create({
    code: "111111",
    status: "printed",
    file: "storage-expired-print.jpg",
    sheets: [{ file: "storage-expired-print.jpg" }],
    createdAt: expiredAt,
  });
  await admin.getByRole("button", { name: "Làm mới", exact: true }).click();
  const cleanupButton = admin.getByRole("button", {
    name: "Dọn ảnh đã hết hạn",
    exact: true,
  });
  await cleanupButton.waitFor();
  await admin.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) =>
        button.textContent.includes("Dọn ảnh đã hết hạn") && !button.disabled,
    ),
  );
  admin.once("dialog", (dialog) => dialog.accept());
  const [cleanupResponse] = await Promise.all([
    admin.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/storage/cleanup-expired") &&
        response.request().method() === "POST",
    ),
    cleanupButton.click(),
  ]);
  assert.equal(cleanupResponse.status(), 200);
  const result = await cleanupResponse.json();
  assert.ok(
    result.freedBytes >= 30,
    "Dọn đúng các tệp hết hạn và đo byte giảm thực tế",
  );
  assert.equal(result.summary.expired.files, 0);
  assert.equal(await readMedia("storage-expired-photo.jpg"), null);
  assert.equal(await readMedia("storage-expired-photo.original"), null);
  assert.equal(await readMedia("storage-expired-print.jpg"), null);
  assert.ok(await readMedia(sent.file), "Giữ nguyên tờ in mới của khách");
  const keptAlbum = await Booking.findById(booking._id);
  assert.equal(keptAlbum.photos.length, 2, "Giữ nguyên hai ảnh còn hạn");
  assert.ok(keptAlbum.composite?.file, "Giữ nguyên ảnh ghép của máy chụp");
  assert.ok(await readMedia(keptAlbum.composite.file));
  assert.ok(await PrintJob.findById(sent._id));

  // ── Quản trị trên điện thoại: menu gọn, đơn hàng dạng thẻ ──
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin
    .getByRole("button", { name: "Menu quản lý", exact: true })
    .click();
  await menu(admin, "Đơn hàng").click();
  await admin.locator("article.order-card").first().waitFor();
  await noOverflow(admin);
  assert.equal(
    await admin
      .getByRole("button", { name: "Menu quản lý", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await admin
      .locator("article.order-card")
      .first()
      .evaluate((card) => getComputedStyle(card).display),
    "grid",
  );
  if (process.env.UI_SCREENSHOTS) {
    await fs.mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
    for (const [name, target] of [
      ["admin-mobile", admin],
      ["counter-mobile", counter],
      ["kiosk-qr", kiosk],
      ["album-mobile", phone],
    ])
      await target.screenshot({
        path: path.join(process.env.UI_SCREENSHOTS, `${name}.png`),
        fullPage: true,
      });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: web nội bộ (/ → quản trị, không trang công khai) → lễ tân tạo phiếu rồi xác nhận đã thu (mất phản hồi không trùng phiếu, không trùng mã) → máy chụp: bấm dây, chụp, chọn ảnh và khung, ghép gửi album, gửi lệnh in → khách quét QR xem / tải ảnh ghép, ảnh gốc, ZIP trên điện thoại → lễ tân xem đơn hàng, in lại → Trợ lí Minh đo dung lượng, lưu giới hạn, dọn đúng ảnh hết hạn; không lỗi trình duyệt, không tràn ngang.",
  );
} catch (error) {
  for (const context of browser?.contexts() || [])
    for (const page of context.pages())
      console.error(
        "Trạng thái trình duyệt:",
        page.url(),
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 2500),
      );
  throw error;
} finally {
  if (originalStorageCommand)
    mongoose.connection.db.command = originalStorageCommand;
  await browser?.close();
  if (proxyServer) {
    proxyServer.closeAllConnections();
    await new Promise((resolve) => proxyServer.close(resolve));
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await memory.stop();
  await fs.rmdir(storageTestDirectory);
}
