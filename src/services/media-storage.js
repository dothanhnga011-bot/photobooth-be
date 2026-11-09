import mongoose from "mongoose";
import { config } from "../config.js";
import { Booking, PrintJob, Setting } from "../models/index.js";
import { MEDIA_TTL_MS, photoTime } from "./media.js";

// A file in the bucket that no booking or print job refers to, older than the retention period
// plus a safety margin, can never be shown or printed again (photo/print data the database no
// longer has: an expired album, a switched database, an upload that never finished). It is the
// same rule as the recommended R2 lifecycle rule; files still being saved are minutes old.
export const ORPHAN_GRACE_MS = 2 * 60 * 60 * 1000;
export const isStaleOrphan = (file, referenced, now = Date.now()) =>
  !referenced.has(file.filename) &&
  Number.isFinite(file.modified) &&
  file.modified <= now - MEDIA_TTL_MS - ORPHAN_GRACE_MS;
import { BYTES_PER_GB, isR2File, r2Configured, readR2Inventory } from "./r2.js";

export const BYTES_PER_MB = 1024 * 1024;
export const STORAGE_SETTING_KEY = "media-storage";
export const R2_STORAGE_SETTING_KEY = "media-storage-r2";

const emptySize = () => ({ files: 0, bytes: 0 });
const addNames = (set, names) => {
  for (const name of names) if (name) set.add(name);
};
const fileTotals = () => [
  { $group: { _id: null, files: { $sum: 1 }, bytes: { $sum: "$length" } } },
  { $project: { _id: 0, files: 1, bytes: 1 } },
];
const matchingTotals = (names) => [
  { $match: { filename: { $in: [...names] } } },
  ...fileTotals(),
];

// Atlas may return BSON NumberLong values. Reject unsafe precision instead of
// rounding a large BSON counter or accepting malformed statistics as zero.
const byteCount = (value) => {
  if (mongoose.mongo.Long.isLong(value)) {
    const exact = value.toBigInt();
    if (exact < 0n || exact > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Unsafe statistics value");
    return Number(exact);
  }
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid statistics value");
  return value;
};

// Application database detail; never used as a substitute for cluster quota.
export async function readDatabaseUsage(db = mongoose.connection.db) {
  try {
    const stats = await db.command({ dbStats: 1, scale: 1 });
    const dataBytes = byteCount(stats.dataSize);
    const indexBytes = byteCount(stats.indexSize);
    const usedBytes = byteCount(dataBytes + indexBytes);
    return {
      available: true,
      name: db.databaseName,
      dataBytes,
      indexBytes,
      usedBytes,
      error: null,
    };
  } catch {
    return {
      available: false,
      name: db?.databaseName || null,
      dataBytes: null,
      indexBytes: null,
      usedBytes: null,
      error: "Không đọc được dung lượng cơ sở dữ liệu. Vui lòng thử lại.",
    };
  }
}

// Atlas Free/Flex atlasSize includes data and indexes across ALL databases.
// https://www.mongodb.com/docs/atlas/free-tier-commands/#atlassize
export async function readClusterUsage(db = mongoose.connection.db) {
  try {
    const stats = await db.command({ atlasSize: 1 });
    if (byteCount(stats.ok) !== 1)
      throw new Error("Atlas statistics unavailable");
    const dataBytes = byteCount(stats.totals?.dataSize);
    const indexBytes = byteCount(stats.totals?.indexSize);
    const usedBytes = byteCount(stats.atlasSize);
    const databaseCount = byteCount(stats.totals?.numDatabases);
    if (usedBytes !== byteCount(dataBytes + indexBytes))
      throw new Error("Inconsistent Atlas statistics");
    return {
      available: true,
      dataBytes,
      indexBytes,
      usedBytes,
      databaseCount,
      error: null,
    };
  } catch {
    return {
      available: false,
      dataBytes: null,
      indexBytes: null,
      usedBytes: null,
      databaseCount: null,
      error:
        "Không đọc được dung lượng toàn cluster MongoDB Atlas. Vui lòng thử lại.",
    };
  }
}

export function storageQuota(limitMB, usedBytes) {
  const configured =
    Number.isFinite(limitMB) &&
    limitMB > 0 &&
    limitMB <= Number.MAX_SAFE_INTEGER / BYTES_PER_MB &&
    Math.round(limitMB * BYTES_PER_MB) >= 1;
  const limitBytes = configured ? Math.round(limitMB * BYTES_PER_MB) : null;
  const known =
    limitBytes !== null && Number.isFinite(usedBytes) && usedBytes >= 0;
  const usagePercent = known ? (usedBytes / limitBytes) * 100 : null;
  return {
    limitMB: configured ? limitMB : null,
    limitBytes,
    remainingBytes: known ? Math.max(0, limitBytes - usedBytes) : null,
    usagePercent,
    level: !known
      ? "unknown"
      : usagePercent >= 90
        ? "critical"
        : usagePercent >= 80
          ? "warning"
          : "normal",
  };
}

// Only file metadata is counted; media.chunks and image payloads are never read.
// Every GridFS version counts, even if several versions have the same filename.
export async function getStorageSummary({
  now = new Date(),
  db = mongoose.connection.db,
  freshR2 = false,
} = {}) {
  const cutoff = now.getTime() - MEDIA_TTL_MS;
  const [bookings, jobs, setting, r2Setting, database, cluster] =
    await Promise.all([
      // Admin mở trang là đo 30 giây/lần: chỉ lấy vé còn ảnh / video và đúng các trường cần đo
      // (vé cũ đã dọn hết ảnh chiếm phần lớn bảng, không cần tải về).
      Booking.find({
        $or: [
          { "photos.0": { $exists: true } },
          { "video.file": { $exists: true } },
        ],
      })
        .select(
          "photos._id photos.file photos.originalFile photos.thumbnailFile photos.previewFile photos.printFile photos.downloadFile video.file mediaExpiresAt",
        )
        .lean(),
      PrintJob.find().select("file sheets.file createdAt").lean(),
      Setting.findOne({ key: STORAGE_SETTING_KEY }).lean(),
      Setting.findOne({ key: R2_STORAGE_SETTING_KEY }).lean(),
      readDatabaseUsage(db),
      readClusterUsage(db),
    ]);
  const names = {
    originals: new Set(),
    printSheets: new Set(),
    photos: new Set(),
    thumbnails: new Set(),
    videos: new Set(),
  };
  const expiredNames = new Set();
  const imageExpiries = new Map();
  const addImageExpiry = (files, expiry) => {
    if (!Number.isFinite(expiry)) return;
    for (const file of files) {
      if (!file) continue;
      imageExpiries.set(
        file,
        Math.min(imageExpiries.get(file) ?? Infinity, expiry),
      );
    }
  };
  let expiredPhotos = 0;
  let expiredJobs = 0;
  for (const booking of bookings) {
    const photos = booking.photos || [];
    const old = photos.filter((photo) => photoTime(photo) <= cutoff);
    const hasFreshPhotos = photos.some((photo) => photoTime(photo) > cutoff);
    addNames(
      names.photos,
      photos.flatMap((photo) => [photo.file, photo.downloadFile]),
    );
    addNames(
      names.originals,
      photos.map((photo) => photo.originalFile),
    );
    addNames(
      names.thumbnails,
      photos.flatMap((photo) => [photo.thumbnailFile, photo.previewFile, photo.printFile]),
    );
    // Hidden/deleted album photos still occupy storage until TTL cleanup.
    for (const photo of photos)
      addImageExpiry(
        [photo.file, photo.originalFile, photo.thumbnailFile, photo.previewFile, photo.printFile, photo.downloadFile],
        photoTime(photo) + MEDIA_TTL_MS,
      );
    addNames(names.videos, [booking.video?.file]);
    expiredPhotos += old.length;
    addNames(
      expiredNames,
      old.flatMap((photo) => [
        photo.file,
        photo.originalFile,
        photo.thumbnailFile,
        photo.previewFile,
        photo.printFile,
        photo.downloadFile,
      ]),
    );
    // Match purgeExpiredMedia: an old photo also makes a video-only remainder
    // eligible; a video is retained whenever a fresh photo remains in the album.
    if (
      booking.video?.file &&
      !hasFreshPhotos &&
      (old.length || booking.mediaExpiresAt?.getTime() <= now.getTime())
    )
      addNames(expiredNames, [booking.video.file]);
  }
  for (const job of jobs) {
    const files = [job.file, ...(job.sheets || []).map((sheet) => sheet.file)];
    addNames(names.printSheets, files);
    addImageExpiry(files, job.createdAt?.getTime() + MEDIA_TTL_MS);
    if (job.createdAt?.getTime() <= cutoff) {
      expiredJobs++;
      addNames(expiredNames, files);
    }
  }
  // A filename referenced in several places is counted once in the breakdown.
  // Originals take precedence, then print sheets, photos, and videos.
  const referencedNames = new Set();
  for (const group of Object.values(names)) {
    for (const name of group) {
      if (referencedNames.has(name)) group.delete(name);
      else referencedNames.add(name);
    }
  }
  const facets = {
    total: fileTotals(),
    expired: matchingTotals(expiredNames),
    // Count down only image files that are still stored. Ignore orphan files,
    // videos and dangling references; no media.chunks or file payload is read.
    retainedImages: [
      { $match: { filename: { $in: [...imageExpiries.keys()] } } },
      { $group: { _id: "$filename" } },
    ],
    other: [
      { $match: { filename: { $nin: [...referencedNames] } } },
      ...fileTotals(),
    ],
    ...Object.fromEntries(
      Object.entries(names).map(([key, group]) => [key, matchingTotals(group)]),
    ),
  };
  const [sizes] = await db
    .collection("media.files")
    .aggregate([{ $facet: facets }])
    .toArray();
  const configured = r2Configured();
  const active = config.mediaStorageProvider === "r2";
  const hasR2References = [...referencedNames].some(isR2File);
  let r2Files = [];
  let r2Error = null;
  if (configured) {
    try {
      r2Files = await readR2Inventory({ fresh: freshR2 });
    } catch {
      r2Error =
        "Không đọc được kho ảnh R2. Kiểm tra bucket và khóa truy cập trên backend.";
    }
  } else if (active || hasR2References) {
    r2Error = "Kho ảnh R2 chưa được cấu hình đầy đủ trên backend.";
  }
  const r2Available = configured && !r2Error;
  const r2Sizes = {
    total: emptySize(),
    expired: emptySize(),
    other: emptySize(),
    ...Object.fromEntries(
      Object.keys(names).map((name) => [name, emptySize()]),
    ),
  };
  let staleOrphans = 0;
  let nextImageExpiry = (sizes?.retainedImages || []).reduce(
    (soonest, file) =>
      Math.min(soonest, imageExpiries.get(file._id) ?? Infinity),
    Infinity,
  );
  for (const file of r2Files) {
    const group =
      Object.keys(names).find((name) => names[name].has(file.filename)) ||
      "other";
    const orphan = isStaleOrphan(file, referencedNames, now.getTime());
    if (orphan) staleOrphans++;
    for (const total of [
      r2Sizes.total,
      r2Sizes[group],
      ...(expiredNames.has(file.filename) || orphan ? [r2Sizes.expired] : []),
    ]) {
      total.files++;
      total.bytes += file.length;
    }
    nextImageExpiry = Math.min(
      nextImageExpiry,
      imageExpiries.get(file.filename) ?? Infinity,
    );
  }
  const size = (name) => {
    const local = sizes?.[name]?.[0] || emptySize();
    const remote = r2Sizes[name] || emptySize();
    return {
      files: local.files + remote.files,
      bytes: local.bytes + remote.bytes,
    };
  };
  const r2LimitGB = r2Setting ? r2Setting.value?.limitGB : config.r2.limitGB;
  const r2Quota = storageQuota(
    r2LimitGB === null ? null : (r2LimitGB * BYTES_PER_GB) / BYTES_PER_MB,
    r2Available ? r2Sizes.total.bytes : null,
  );
  return {
    checkedAt: now.toISOString(),
    bytesPerMB: BYTES_PER_MB,
    ttlHours: MEDIA_TTL_MS / 3_600_000,
    retention: {
      ...(r2Error && { available: false }),
      nextImageExpiresAt:
        !r2Error && Number.isFinite(nextImageExpiry)
          ? new Date(nextImageExpiry).toISOString()
          : null,
    },
    media: {
      ...size("total"),
      available: !r2Error,
      stores: {
        gridfs: sizes?.total?.[0] || emptySize(),
        r2: r2Available ? r2Sizes.total : null,
      },
      groups: Object.fromEntries(
        [
          "photos",
          "originals",
          "printSheets",
          "videos",
          "other",
          ...(names.thumbnails.size ? ["thumbnails"] : []),
        ].map((name) => [name, size(name)]),
      ),
    },
    database,
    cluster,
    r2: {
      active,
      configured,
      available: r2Available,
      bucket: config.r2.bucket,
      files: r2Available ? r2Sizes.total.files : null,
      usedBytes: r2Available ? r2Sizes.total.bytes : null,
      error: r2Error,
      quota: {
        ...r2Quota,
        limitGB: r2Quota.limitMB === null ? null : r2LimitGB,
        source: r2Setting ? "setting" : "config",
        scope: "r2",
      },
    },
    quota: {
      ...storageQuota(
        setting ? setting.value?.limitMB : config.mediaStorageLimitMB,
        cluster.usedBytes,
      ),
      scope: cluster.available ? "cluster" : "unknown",
      source: setting ? "setting" : "config",
    },
    expired: {
      photos: expiredPhotos,
      printJobs: expiredJobs,
      // Files no album or print job uses any more (see isStaleOrphan); cleaned with the rest.
      orphans: staleOrphans,
      ...size("expired"),
    },
  };
}
