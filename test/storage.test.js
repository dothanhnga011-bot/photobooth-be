import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { Booking, PrintJob, Setting, User } from "../src/models/index.js";
import { MEDIA_TTL_MS, readMedia, saveMedia } from "../src/services/media.js";
import {
  BYTES_PER_MB,
  STORAGE_SETTING_KEY,
  getStorageSummary,
  readClusterUsage,
  storageQuota,
} from "../src/services/media-storage.js";

let memory;
let mediaDirectory;
let adminCookie;
let staffCookie;
const photoId = (date) => {
  const id = new mongoose.Types.ObjectId();
  id.id.writeUInt32BE(Math.floor(date.getTime() / 1000), 0);
  return id;
};
const secondNow = () => new Date(Math.floor(Date.now() / 1000) * 1000);
const putFile = (name, size, type = "image/jpeg") =>
  saveMedia(name, Buffer.alloc(size, 0x61), type);
const asAdmin = (method, path) =>
  request(app)[method](path).set("Cookie", adminCookie);
const asStaff = (method, path) =>
  request(app)[method](path).set("Cookie", staffCookie);
const clusterStats = () => ({
  ok: 1,
  atlasSize: 44.75 * BYTES_PER_MB,
  totals: {
    dataSize: 44.5 * BYTES_PER_MB,
    indexSize: 0.25 * BYTES_PER_MB,
    numDatabases: 4,
  },
});
const withClusterStats = (stats) => {
  const db = mongoose.connection.db;
  return {
    databaseName: db.databaseName,
    collection: (name) => db.collection(name),
    command: async (command) =>
      command.atlasSize ? stats : db.command(command),
  };
};

before(async () => {
  config.secret = "storage-test-only-123456789-not-production";
  config.dnpPrinter = "";
  mediaDirectory = await mkdtemp(path.join(tmpdir(), "nxc-storage-test-"));
  config.uploadDir = mediaDirectory;
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  const users = await User.create([
    { name: "Admin", email: "storage-admin@test.local", role: "admin" },
    { name: "Staff", email: "storage-staff@test.local", role: "staff" },
  ]);
  [adminCookie, staffCookie] = users.map(
    (user) => `session=${jwt.sign({ sub: String(user._id) }, config.secret)}`,
  );
});

beforeEach(async () => {
  config.mediaStorageLimitMB = 512;
  await Promise.all([
    Booking.deleteMany({}),
    PrintJob.deleteMany({}),
    Setting.deleteMany({}),
    mongoose.connection.db.collection("media.files").deleteMany({}),
    mongoose.connection.db.collection("media.chunks").deleteMany({}),
  ]);
});

after(async () => {
  try {
    assert.deepEqual(
      await mongoose.connection.db
        .listCollections({ name: "audits" }, { nameOnly: true })
        .toArray(),
      [],
      "storage reads, quota edits and cleanup must never create activity logs",
    );
  } finally {
    await mongoose.disconnect();
    await memory?.stop();
    if (mediaDirectory)
      await rm(mediaDirectory, { recursive: true, force: true });
  }
});

test("storage is authenticated, staff can view, only admin can configure or clean", async () => {
  await request(app).get("/api/admin/storage").expect(401);
  await request(app)
    .put("/api/admin/storage/limit")
    .send({ limitMB: 10 })
    .expect(401);
  await request(app).post("/api/admin/storage/cleanup-expired").expect(401);
  const { body } = await asStaff("get", "/api/admin/storage").expect(200);
  assert.equal(body.bytesPerMB, 1048576);
  assert.deepEqual(body.retention, { nextImageExpiresAt: null });
  assert.equal(body.quota.limitMB, 512);
  assert.equal(body.quota.source, "config");
  assert.equal(body.quota.scope, "unknown");
  assert.equal(body.quota.remainingBytes, null);
  assert.equal(body.quota.level, "unknown");
  assert.equal(body.database.available, true);
  assert.equal(
    body.cluster.available,
    false,
    "local MongoDB does not expose Atlas-wide usage",
  );
  assert.equal(body.cluster.usedBytes, null);
  assert.equal(
    body.database.usedBytes,
    body.database.dataBytes + body.database.indexBytes,
  );
  await asStaff("put", "/api/admin/storage/limit")
    .send({ limitMB: 10 })
    .expect(403);
  await asStaff("post", "/api/admin/storage/cleanup-expired").expect(403);
  assert.equal(await Setting.countDocuments({}), 0);
});

test("all GridFS bytes and duplicate-name versions count, groups deduplicate references", async () => {
  const now = secondNow();
  await Promise.all([
    putFile("shared.jpg", 10),
    putFile("shared.jpg", 20),
    putFile("photo.jpg", 12),
    putFile("original.original", 14),
    putFile("sheet.jpg", 18),
    putFile("clip.mp4", 21, "video/mp4"),
    putFile("unreferenced.png", 22, "image/png"),
  ]);
  await Booking.create({
    code: "800001",
    accessToken: "storage-total",
    photos: [
      { _id: photoId(now), file: "shared.jpg", originalFile: "shared.jpg" },
      {
        _id: photoId(now),
        file: "photo.jpg",
        originalFile: "original.original",
      },
    ],
    video: { file: "clip.mp4" },
  });
  await PrintJob.create({
    file: "sheet.jpg",
    sheets: [{ file: "sheet.jpg" }, { file: "sheet.jpg" }],
  });
  const summary = await getStorageSummary({ now });
  assert.equal(summary.media.files, 7);
  assert.equal(summary.media.bytes, 117);
  assert.deepEqual(summary.media.groups, {
    photos: { files: 1, bytes: 12 },
    originals: { files: 3, bytes: 44 },
    printSheets: { files: 1, bytes: 18 },
    videos: { files: 1, bytes: 21 },
    other: { files: 1, bytes: 22 },
  });
  assert.equal(
    Object.values(summary.media.groups).reduce(
      (sum, group) => sum + group.bytes,
      0,
    ),
    117,
  );
  assert.deepEqual(summary.expired, {
    photos: 0,
    printJobs: 0,
    orphans: 0,
    files: 0,
    bytes: 0,
  });
});

test("expiry estimates use each photo timestamp, exact boundary, job age and video rules", async () => {
  const now = secondNow();
  const cutoff = new Date(now - MEDIA_TTL_MS);
  const justFresh = new Date(cutoff.getTime() + 1000);
  const old = photoId(cutoff);
  const fresh = photoId(justFresh);
  await Promise.all([
    putFile("old.jpg", 10),
    putFile("old-original.original", 20),
    putFile("fresh.jpg", 30),
    putFile("fresh-original.original", 40),
    putFile("sheet1.jpg", 50),
    putFile("sheet2.jpg", 60),
    putFile("old-video.mp4", 70),
    putFile("retained-video.mp4", 80),
    putFile("no-expiry-video.mp4", 90),
  ]);
  await Booking.create([
    {
      code: "800002",
      accessToken: "storage-expiry-mixed",
      mediaExpiresAt: now,
      photos: [
        { _id: old, file: "old.jpg", originalFile: "old-original.original" },
        {
          _id: fresh,
          file: "fresh.jpg",
          originalFile: "fresh-original.original",
        },
      ],
      video: { file: "retained-video.mp4" },
    },
    {
      code: "800003",
      accessToken: "storage-expiry-video",
      photos: [],
      mediaExpiresAt: cutoff,
      video: { file: "old-video.mp4" },
    },
    {
      code: "800004",
      accessToken: "storage-expiry-video-no-date",
      photos: [],
      video: { file: "no-expiry-video.mp4" },
    },
  ]);
  await PrintJob.collection.insertMany([
    {
      file: "sheet1.jpg",
      sheets: [{ file: "sheet1.jpg" }, { file: "sheet2.jpg" }],
      createdAt: cutoff,
      status: "pending",
    },
    { file: "fresh.jpg", createdAt: justFresh, status: "printed" },
  ]);
  const summary = await getStorageSummary({ now });
  assert.deepEqual(summary.expired, {
    photos: 1,
    printJobs: 1,
    orphans: 0,
    files: 5,
    bytes: 210,
  });
  assert.equal(summary.retention.nextImageExpiresAt, now.toISOString());
  assert.equal(
    await mongoose.connection.db.collection("media.files").countDocuments({}),
    9,
    "GET-style summary must not purge expired media",
  );
  assert.equal((await Booking.findOne({ code: "800002" })).photos.length, 2);
  assert.equal(await PrintJob.countDocuments({}), 2);
});

test("reprint storage uses the source file's expiry instead of a fresh retention period", async () => {
  const now = secondNow();
  const expiresAt = new Date(now.getTime() + 30_000);
  await putFile("reprint-expiry.png", 10, "image/png");
  await PrintJob.create({ file: "reprint-expiry.png", fileExpiresAt: expiresAt, operatorPrint: true });
  const fresh = await getStorageSummary({ now });
  assert.equal(fresh.retention.nextImageExpiresAt, expiresAt.toISOString());
  const expired = await getStorageSummary({ now: new Date(expiresAt.getTime() + 1000) });
  assert.equal(expired.expired.printJobs, 1);
  assert.equal(expired.expired.files, 1);
});

test("nearest stored image expiry uses each album photo age before newer print jobs", async () => {
  const now = secondNow();
  const olderPhoto = new Date(now.getTime() - 3 * 3_600_000);
  const newerPhoto = new Date(now.getTime() - 3_600_000);
  await Promise.all([
    putFile("older-album.jpg", 10),
    putFile("older-original.original", 11),
    putFile("newer-album.jpg", 12),
    putFile("newer-print.jpg", 13),
  ]);
  await Booking.create({
    code: "810001",
    accessToken: "nearest-album-before-print",
    // This summary date must not override individual photo timestamps.
    mediaExpiresAt: new Date(now.getTime() + MEDIA_TTL_MS),
    photos: [
      { _id: photoId(newerPhoto), file: "newer-album.jpg" },
      {
        _id: photoId(olderPhoto),
        file: "older-album.jpg",
        originalFile: "older-original.original",
      },
    ],
  });
  await PrintJob.collection.insertOne({
    file: "newer-print.jpg",
    createdAt: newerPhoto,
    status: "pending",
  });
  const result = await asStaff("get", "/api/admin/storage").expect(200);
  assert.equal(
    result.body.retention.nextImageExpiresAt,
    new Date(olderPhoto.getTime() + MEDIA_TTL_MS).toISOString(),
  );
  assert.equal(await PrintJob.countDocuments({}), 1);
  assert.equal((await Booking.findOne({ code: "810001" })).photos.length, 2);
});

test("nearest image expiry includes printed sheets and shared filename versions once", async () => {
  const now = secondNow();
  const printedAt = new Date(now.getTime() - 2 * 3_600_000);
  await Promise.all([
    putFile("printed-sheet.jpg", 10),
    putFile("printed-sheet.jpg", 11),
    putFile("pending-sheet.jpg", 12),
  ]);
  await PrintJob.collection.insertMany([
    {
      file: "pending-sheet.jpg",
      sheets: [{ file: "printed-sheet.jpg" }, { file: "pending-sheet.jpg" }],
      createdAt: now,
      status: "pending",
    },
    {
      sheets: [{ file: "printed-sheet.jpg" }],
      createdAt: printedAt,
      status: "printed",
    },
    {
      file: "missing-older-sheet.jpg",
      createdAt: new Date(now.getTime() - 4 * 3_600_000),
      status: "printed",
    },
  ]);
  const result = await getStorageSummary({ now });
  assert.equal(
    result.retention.nextImageExpiresAt,
    new Date(printedAt.getTime() + MEDIA_TTL_MS).toISOString(),
  );
  assert.deepEqual(result.media.groups.printSheets, { files: 3, bytes: 33 });
});

test("nearest image expiry is null for empty storage, video, orphans and dangling refs", async () => {
  const now = secondNow();
  assert.deepEqual((await getStorageSummary({ now })).retention, {
    nextImageExpiresAt: null,
  });
  await putFile("video-only.mp4", 20, "video/mp4");
  await Booking.create({
    code: "810002",
    accessToken: "nearest-video-only",
    video: { file: "video-only.mp4" },
    mediaExpiresAt: new Date(now.getTime() - 60000),
  });
  assert.equal(
    (await getStorageSummary({ now })).retention.nextImageExpiresAt,
    null,
    "video expiry is not an image expiry",
  );
  await putFile("unknown-orphan.jpg", 21);
  await Booking.create({
    code: "810003",
    accessToken: "nearest-missing-images",
    photos: [
      {
        _id: photoId(new Date(now.getTime() - MEDIA_TTL_MS - 60000)),
        file: "missing-photo.jpg",
        originalFile: "missing-original.original",
      },
    ],
  });
  await PrintJob.collection.insertOne({
    file: "missing-sheet.jpg",
    createdAt: now,
    status: "pending",
  });
  const result = await getStorageSummary({ now });
  assert.equal(result.retention.nextImageExpiresAt, null);
  assert.equal(result.media.files, 2);
  assert.equal(result.media.bytes, 41);
});

test("overdue deleted photos retain original expiry until their stored files are cleaned", async () => {
  const now = secondNow();
  const originalTime = new Date(now.getTime() - MEDIA_TTL_MS - 60000);
  await Promise.all([
    putFile("overdue-original.original", 10),
    putFile("fresh-retention-sheet.jpg", 11),
  ]);
  await Booking.create({
    code: "810004",
    accessToken: "nearest-overdue-original",
    photos: [
      {
        _id: photoId(originalTime),
        file: "missing-processed.jpg",
        originalFile: "overdue-original.original",
        deleted: true,
      },
      {
        _id: photoId(new Date(originalTime.getTime() - 60000)),
        file: "missing-even-older.jpg",
      },
    ],
  });
  await PrintJob.collection.insertOne({
    file: "fresh-retention-sheet.jpg",
    createdAt: now,
    status: "printed",
  });
  const result = await asAdmin("get", "/api/admin/storage").expect(200);
  assert.equal(
    result.body.retention.nextImageExpiresAt,
    new Date(originalTime.getTime() + MEDIA_TTL_MS).toISOString(),
  );
  assert.equal((await readMedia("overdue-original.original")).length, 10);
  assert.equal((await Booking.findOne({ code: "810004" })).photos.length, 2);
});

test("admin quota is separate from studio settings, validates input and supports removal", async () => {
  const studio = { name: "Studio preserved", extraPrintPrice: 20000 };
  await Setting.create({ key: "studio", value: studio });
  const { body } = await asAdmin("put", "/api/admin/storage/limit")
    .send({ limitMB: 512.5 })
    .expect(200);
  assert.equal(body.quota.limitMB, 512.5);
  assert.equal(body.quota.limitBytes, 512.5 * BYTES_PER_MB);
  assert.equal(body.quota.remainingBytes, null);
  assert.equal(body.quota.source, "setting");
  assert.deepEqual((await Setting.findOne({ key: "studio" })).value, studio);
  assert.equal(
    (await Setting.findOne({ key: STORAGE_SETTING_KEY })).value.limitMB,
    512.5,
  );
  for (const invalid of [
    {},
    { limitMB: 0 },
    { limitMB: -1 },
    { limitMB: "512" },
    { limitMB: 1e30 },
    { limitMB: 1e-20 },
    { limitMB: 512, extra: true },
  ])
    await asAdmin("put", "/api/admin/storage/limit").send(invalid).expect(400);
  assert.equal(
    (await Setting.findOne({ key: STORAGE_SETTING_KEY })).value.limitMB,
    512.5,
  );
  const removed = await asAdmin("put", "/api/admin/storage/limit")
    .send({ limitMB: null })
    .expect(200);
  assert.equal(removed.body.quota.limitBytes, null);
  assert.equal(removed.body.quota.remainingBytes, null);
  assert.equal(removed.body.quota.source, "setting");
  const afterRemoval = await asAdmin("get", "/api/admin/storage").expect(200);
  assert.equal(
    afterRemoval.body.quota.limitMB,
    null,
    "saved null must override the configured 512 MB default",
  );
});

test("quota warning boundaries use cluster data plus indexes and never show negative space", () => {
  const limit = 100 * BYTES_PER_MB;
  assert.equal(storageQuota(100, limit * 0.799).level, "normal");
  assert.equal(storageQuota(100, limit * 0.8).level, "warning");
  assert.equal(storageQuota(100, limit * 0.899).level, "warning");
  assert.equal(storageQuota(100, limit * 0.9).level, "critical");
  assert.equal(storageQuota(100, limit * 1.1).remainingBytes, 0);
  assert.equal(storageQuota(100, null).level, "unknown");
  assert.equal(storageQuota(null, 1).remainingBytes, null);
});

test("Atlas cluster totals include all databases and yield 44.75 of 512 MB usage", async () => {
  await putFile("atlas-fixture.jpg", 38);
  const summary = await getStorageSummary({
    db: withClusterStats(clusterStats()),
  });
  assert.deepEqual(summary.cluster, {
    available: true,
    dataBytes: 44.5 * BYTES_PER_MB,
    indexBytes: 0.25 * BYTES_PER_MB,
    usedBytes: 44.75 * BYTES_PER_MB,
    databaseCount: 4,
    error: null,
  });
  assert.equal(summary.database.available, true);
  assert.ok(summary.database.usedBytes < summary.cluster.usedBytes);
  assert.equal(summary.media.bytes, 38);
  assert.equal(summary.quota.limitMB, 512);
  assert.equal(summary.quota.remainingBytes, 467.25 * BYTES_PER_MB);
  assert.equal(summary.quota.usagePercent, (44.75 / 512) * 100);
  assert.equal(summary.quota.scope, "cluster");
  assert.equal(summary.quota.source, "config");
});

test("Atlas BSON NumberLong counters are converted without losing byte precision", async () => {
  const Long = mongoose.mongo.Long;
  const stats = clusterStats();
  stats.atlasSize = Long.fromNumber(stats.atlasSize);
  stats.totals.dataSize = Long.fromNumber(stats.totals.dataSize);
  stats.totals.indexSize = Long.fromNumber(stats.totals.indexSize);
  stats.totals.numDatabases = Long.fromNumber(4);
  const cluster = await readClusterUsage(withClusterStats(stats));
  assert.equal(cluster.available, true);
  assert.equal(cluster.usedBytes, 44.75 * BYTES_PER_MB);
  assert.equal(cluster.databaseCount, 4);
  assert.equal(typeof cluster.dataBytes, "number");
});

test("malformed Atlas results cannot fabricate remaining capacity", async () => {
  const malformed = [
    {},
    { ...clusterStats(), ok: 0 },
    { ...clusterStats(), atlasSize: 0 },
    { ...clusterStats(), atlasSize: Infinity },
    { ...clusterStats(), atlasSize: "46923776" },
    {
      ...clusterStats(),
      atlasSize: mongoose.mongo.Long.fromString("9007199254740993"),
    },
    { ...clusterStats(), totals: { ...clusterStats().totals, dataSize: -1 } },
    {
      ...clusterStats(),
      totals: { ...clusterStats().totals, indexSize: undefined },
    },
    {
      ...clusterStats(),
      totals: { ...clusterStats().totals, numDatabases: 1.5 },
    },
  ];
  for (const stats of malformed) {
    const summary = await getStorageSummary({ db: withClusterStats(stats) });
    assert.equal(summary.cluster.available, false);
    assert.equal(summary.cluster.usedBytes, null);
    assert.equal(summary.quota.remainingBytes, null);
    assert.equal(summary.quota.scope, "unknown");
    assert.equal(summary.database.available, true);
  }
});

test("Atlas denial retains application detail without treating it as cluster capacity", async () => {
  await putFile("cluster-denied.jpg", 18);
  const db = mongoose.connection.db;
  const wrapper = {
    databaseName: db.databaseName,
    collection: (name) => db.collection(name),
    command: async (command) => {
      if (command.atlasSize)
        throw new Error(
          "mongo://secret:password@private-host: atlasSize unauthorized",
        );
      return db.command(command);
    },
  };
  const summary = await getStorageSummary({ db: wrapper });
  assert.equal(summary.cluster.available, false);
  assert.equal(summary.database.available, true);
  assert.equal(summary.media.bytes, 18);
  assert.equal(summary.quota.limitMB, 512);
  assert.equal(summary.quota.remainingBytes, null);
  assert.equal(summary.quota.level, "unknown");
  assert.ok(!/private-host|password|unauthorized/.test(summary.cluster.error));
});

test("configured defaults respect existing custom limits and explicit null on Atlas", async () => {
  const db = withClusterStats(clusterStats());
  config.mediaStorageLimitMB = 1024;
  assert.equal((await getStorageSummary({ db })).quota.limitMB, 1024);
  const setting = await Setting.create({
    key: STORAGE_SETTING_KEY,
    value: { limitMB: 256 },
  });
  const configured = await getStorageSummary({ db });
  assert.equal(configured.quota.limitMB, 256);
  assert.equal(configured.quota.remainingBytes, (256 - 44.75) * BYTES_PER_MB);
  assert.equal(configured.quota.source, "setting");
  await Setting.updateOne({ _id: setting._id }, { value: { limitMB: null } });
  const cleared = await getStorageSummary({ db });
  assert.equal(cleared.quota.limitMB, null);
  assert.equal(cleared.quota.remainingBytes, null);
  assert.equal(cleared.quota.scope, "cluster");
  assert.equal(cleared.quota.source, "setting");
});

test("unavailable dbStats keeps media counts, avoids false remaining bytes, hides server details", async () => {
  await putFile("unknown-stat.jpg", 38);
  await Setting.create({ key: STORAGE_SETTING_KEY, value: { limitMB: 512 } });
  const realDB = mongoose.connection.db;
  const db = {
    databaseName: realDB.databaseName,
    collection: (name) => realDB.collection(name),
    command: async () => {
      throw new Error("Unauthorized mongo://secret:password@private-host");
    },
  };
  const summary = await getStorageSummary({ db });
  assert.equal(summary.media.bytes, 38);
  assert.equal(summary.database.available, false);
  assert.equal(summary.database.usedBytes, null);
  assert.equal(summary.database.indexBytes, null);
  assert.equal(summary.quota.limitMB, 512);
  assert.equal(summary.quota.remainingBytes, null);
  assert.equal(summary.quota.usagePercent, null);
  assert.equal(summary.quota.level, "unknown");
  assert.ok(!/private-host|password|Unauthorized/.test(summary.database.error));
});

test("expired cleanup remains usable when database capacity statistics are unavailable", async () => {
  await putFile("expiry-no-stats.jpg", 19);
  await Booking.create({
    code: "800006",
    accessToken: "storage-cleanup-no-stats",
    total: 88000,
    photos: [
      {
        _id: photoId(new Date(Date.now() - MEDIA_TTL_MS - 10000)),
        file: "expiry-no-stats.jpg",
      },
    ],
  });
  await Setting.create({ key: STORAGE_SETTING_KEY, value: { limitMB: 512 } });
  const db = mongoose.connection.db;
  const originalCommand = db.command;
  db.command = function (command, ...args) {
    if (command.dbStats)
      return Promise.reject(new Error("stats permission denied"));
    return originalCommand.call(this, command, ...args);
  };
  try {
    const result = await asAdmin(
      "post",
      "/api/admin/storage/cleanup-expired",
    ).expect(200);
    assert.equal(result.body.freedBytes, 19);
    assert.equal(result.body.summary.media.bytes, 0);
    assert.equal(result.body.summary.database.available, false);
    assert.equal(result.body.summary.quota.remainingBytes, null);
    assert.equal((await Booking.findOne({ code: "800006" })).total, 88000);
    assert.equal(await readMedia("expiry-no-stats.jpg"), null);
  } finally {
    db.command = originalCommand;
  }
});

test("manual cleanup removes only expired refs, reports measured bytes, preserves fresh photos and ticket data", async () => {
  const now = secondNow();
  const expiredTime = new Date(now - MEDIA_TTL_MS - 10000);
  const freshId = photoId(now);
  await Promise.all([
    putFile("expired.jpg", 10),
    putFile("expired.jpg", 11),
    putFile("expired-original.original", 20),
    putFile("fresh.jpg", 30),
    putFile("fresh-original.original", 40),
    putFile("expired-sheet.jpg", 50),
    putFile("fresh-sheet.jpg", 60),
    putFile("untouched-orphan.jpg", 70),
  ]);
  const booking = await Booking.create({
    code: "800005",
    accessToken: "storage-cleanup",
    total: 123000,
    name: "Keep customer",
    photos: [
      {
        _id: photoId(expiredTime),
        file: "expired.jpg",
        originalFile: "expired-original.original",
      },
      {
        _id: freshId,
        file: "fresh.jpg",
        originalFile: "fresh-original.original",
      },
    ],
  });
  const jobs = await PrintJob.collection.insertMany([
    {
      file: "expired-sheet.jpg",
      sheets: [{ file: "expired-sheet.jpg" }],
      createdAt: expiredTime,
      status: "pending",
    },
    {
      file: "fresh-sheet.jpg",
      sheets: [{ file: "fresh-sheet.jpg" }],
      createdAt: now,
      status: "printed",
    },
  ]);
  const before = await asAdmin("get", "/api/admin/storage").expect(200);
  assert.equal(before.body.expired.bytes, 91);
  const cleaned = await asAdmin(
    "post",
    "/api/admin/storage/cleanup-expired",
  ).expect(200);
  assert.equal(cleaned.body.freedBytes, 91);
  assert.equal(cleaned.body.summary.media.bytes, before.body.media.bytes - 91);
  assert.deepEqual(cleaned.body.summary.expired, {
    photos: 0,
    printJobs: 0,
    orphans: 0,
    files: 0,
    bytes: 0,
  });
  const preserved = await Booking.findById(booking._id);
  assert.equal(preserved.total, 123000);
  assert.equal(preserved.name, "Keep customer");
  assert.equal(preserved.mediaDeleted, false);
  assert.equal(preserved.photos.length, 1);
  assert.equal(String(preserved.photos[0]._id), String(freshId));
  assert.equal(await PrintJob.findById(jobs.insertedIds[0]), null);
  assert.ok(await PrintJob.findById(jobs.insertedIds[1]));
  assert.equal(await readMedia("expired.jpg"), null);
  assert.equal((await readMedia("fresh-original.original")).length, 40);
  assert.equal((await readMedia("untouched-orphan.jpg")).length, 70);
  const twice = await asAdmin(
    "post",
    "/api/admin/storage/cleanup-expired",
  ).expect(200);
  assert.equal(twice.body.freedBytes, 0);
});
