import mongoose from "mongoose";
import sharp from "sharp";
import { config } from "./config.js";
import { budget, describeBudget } from "./services/capacity.js";
import { app } from "./app.js";
import { migrateCounterIndexes } from "./services/counter-indexes.js";
import { startMediaCleanup } from "./services/media.js";
import Frame from "./models/Frame.js";
import { removeActivityLogs, removeRetiredFeatureData } from "./services/activity-log-cleanup.js";
import { validateMediaStorage } from "./services/r2.js";
import { backfillImageHashes, backfillThumbs } from "./services/frame-image.js";
import { ensureDefaultPackages } from "./services/default-packages.js";
if (!config.mongo || !config.secret || config.secret.length < 32)
  throw new Error("Thiếu MONGO_URI hoặc JWT_SECRET (ít nhất 32 ký tự).");
validateMediaStorage();
// Xử lý ảnh theo CPU và RAM thật Render cấp (services/capacity.js), không theo máy vật lý: bộ nhớ
// đệm của sharp (Starter 512 MB → 16 MB, Standard 2 GB → 64 MB) và số luồng (1 CPU → 1 luồng).
// Đặt SHARP_CONCURRENCY để ghi đè số luồng.
sharp.cache({ memory: budget.sharpCacheMB, files: 0, items: 64 });
sharp.concurrency(Number(process.env.SHARP_CONCURRENCY) || budget.threads);
console.log(`Máy chủ: ${describeBudget()}.`);
try {
  // Mặc định mongoose mở tới 100 kết nối; một máy chủ nhỏ + Atlas miễn phí chỉ cần vài kết nối.
  await mongoose.connect(config.mongo, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  await removeActivityLogs();
  // Dữ liệu của tính năng đã bỏ (Ca trực & Đối soát, chấm công & lương cũ): xoá hẳn, ghi lại đã xoá gì.
  const retired = await removeRetiredFeatureData();
  if (retired.removed.length)
    console.log(`Đã xoá dữ liệu tính năng đã bỏ: ${retired.removed.map((r) => `${r.collection} (${r.documents} bản ghi)`).join(", ")}.`);
  await migrateCounterIndexes();
  // Bỏ các khung màu cũ: khung giờ chỉ tạo bằng cách import ảnh.
  const { deletedCount } = await Frame.deleteMany({
    $or: [{ image: { $in: [null, ""] } }, { "slots.0": { $exists: false } }],
  });
  if (deletedCount) console.log(`Đã xóa ${deletedCount} khung ảnh cũ.`);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  await ensureDefaultPackages();
  await backfillImageHashes();
  const server = app.listen(config.port, () =>
    console.log(`API ready: http://localhost:${config.port}`),
  );
  // Ảnh xem nhanh cho khung / nhãn dán cũ: chạy nền sau khi máy chủ đã nhận khách.
  setTimeout(() => {
    backfillThumbs().then(
      (count) => count && console.log(`Đã tạo ảnh xem nhanh cho ${count} khung / nhãn dán.`),
      (error) => console.error("Tạo ảnh xem nhanh lỗi:", error.message),
    );
  }, 15_000).unref();
  // Proxy phía trước giữ kết nối lâu hơn 5 giây mặc định của Node: tránh cắt đúng lúc nó dùng lại
  // kết nối cũ (lỗi 502 thỉnh thoảng) và đỡ phải bắt tay lại mỗi yêu cầu.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  startMediaCleanup();
  const { startSessionSweeper, resumePrintSources } = await import("./services/capture.js");
  startSessionSweeper();
  // Nguồn in đang chờ của máy chủ trước (triển khai mới, hết RAM) đã mất: xếp lại sau 1 phút, khi
  // máy chủ cũ đã nghỉ hẳn và máy chụp đã gửi xong những ảnh dồn lại.
  setTimeout(() => {
    resumePrintSources().then(
      (count) => count && console.log(`Tạo lại nguồn in cho ${count} ảnh.`),
      (error) => console.error("Xếp lại nguồn in lỗi:", error.message),
    );
  }, 60_000).unref();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(async () => {
        await mongoose.disconnect();
        process.exit(0);
      }),
    );
} catch (e) {
  // Lỗi có thể ở bước kết nối hoặc ở các bước chuẩn bị dữ liệu sau đó: in đủ lỗi để biết bước nào.
  console.error(
    e.name === "MongooseServerSelectionError"
      ? "Không thể kết nối MongoDB — kiểm tra URI, IP allowlist và kết nối mạng:"
      : "Không khởi động được máy chủ:",
    e,
  );
  process.exit(1);
}
