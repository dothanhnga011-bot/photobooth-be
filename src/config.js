import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
dotenv.config({ path: path.join(root, ".env"), quiet: true });
export const config = {
  port: Number(process.env.PORT || 8080),
  mongo: process.env.MONGO_URI,
  secret: process.env.JWT_SECRET,
  expires: process.env.JWT_EXPIRES_IN || "1d",
  production: process.env.NODE_ENV === "production",
  origin: process.env.CLIENT_URL || "http://localhost:5173",
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || "uploads"),
  dnpPrinter: process.env.DNP_PRINTER_NAME || "",
  dnpStripPrinter: process.env.DNP_STRIP_PRINTER_NAME || "",
  printAgentToken: process.env.PRINT_AGENT_TOKEN || "",
  // Web Selfbooth của tiệm: quản trị chép khung từ danh sách khung công khai của web đó (Khung ảnh →
  // "Chép khung từ Selfbooth").
  selfboothApi: (process.env.SELFBOOTH_API_URL || "https://photo-be-drja.onrender.com").replace(/\/+$/, ""),
  // Giới hạn Atlas Free của tiệm; quản trị có thể ghi đè hoặc bỏ trong Hàng chờ in.
  mediaStorageLimitMB: Number(process.env.MEDIA_STORAGE_LIMIT_MB || 512),
  // Opt in only after the private R2 bucket and backend credentials exist.
  mediaStorageProvider: process.env.MEDIA_STORAGE_PROVIDER || "gridfs",
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucket: process.env.R2_BUCKET || "nxc-media",
    prefix: process.env.R2_PREFIX || "media/",
    limitGB: Number(process.env.R2_STORAGE_LIMIT_GB || 10),
  },
  // Trang thử API (Swagger) ở /api/docs và /api/openapi.json: ẩn mặc định, đặt API_DOCS=true để mở.
  apiDocs: process.env.API_DOCS === "true",
  frontendDist: process.env.FRONTEND_DIST
    ? path.resolve(root, process.env.FRONTEND_DIST)
    : "",
};
