// Tests never use a production R2 account, even when .env enables R2 locally.
process.env.MEDIA_STORAGE_PROVIDER = "gridfs";
process.env.MEDIA_TTL_HOURS = "72";
// Tests opt in to background derivatives explicitly and wait for them before closing MongoDB.
process.env.PHOTO_DOWNLOAD_PREWARM = "0";
// …and never call the real Cloudflare analytics API (R2 GB-month figures).
for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "USD_VND_RATE"])
  process.env[key] = "";
// Tests sign their own tokens with a test-only secret: never the real JWT_SECRET from .env, and the same on
// GitHub Actions, where there is no .env (photo-download / print-quality failed there without it).
process.env.JWT_SECRET = "test-only-jwt-secret-not-used-in-production-0123456789";
