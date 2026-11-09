import { before, beforeEach, after, test, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomUUID, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { config } from "../src/config.js";
import { app } from "../src/app.js";
import { Booking, PrintJob, Setting, User } from "../src/models/index.js";
import { appendCapture } from "../src/services/capture.js";
import {
  saveMedia,
  readMedia,
  deleteMedia,
  purgeExpiredMedia,
  MEDIA_TTL_MS,
} from "../src/services/media.js";
import { getStorageSummary } from "../src/services/media-storage.js";
import { whenPrintSourcesIdle } from "../src/services/print-source.js";
import { purgeStaleOrphans } from "../src/services/orphans.js";
import {
  r2Storage,
  invalidateR2Inventory,
  validateMediaStorage,
} from "../src/services/r2.js";

let memory, adminCookie, staffCookie;
const objects = new Map();
let calls = [],
  failPut,
  failDelete = false,
  failList = false;
const missing = () =>
  Object.assign(new Error("missing"), {
    name: "NoSuchKey",
    $metadata: { httpStatusCode: 404 },
  });
const transport = {
  async send(command) {
    const type = command.constructor.name;
    const input = command.input;
    calls.push({ type, input });
    assert.equal(input.Bucket, "test-media");
    if (type === "PutObjectCommand") {
      if (failPut?.(input)) throw new Error("put unavailable");
      await new Promise((resolve) => setTimeout(resolve, 5));
      objects.set(input.Key, {
        bytes: Buffer.from(input.Body),
        type: input.ContentType,
        modified: Date.now(),
      });
      return {};
    }
    if (type === "DeleteObjectCommand") {
      if (failDelete) throw new Error("delete unavailable");
      objects.delete(input.Key);
      return {};
    }
    if (type === "DeleteObjectsCommand") {
      if (failDelete) throw new Error("delete unavailable");
      for (const file of input.Delete.Objects) objects.delete(file.Key);
      return {};
    }
    if (type === "ListObjectsV2Command") {
      if (failList)
        throw new Error("list unavailable with sensitive upstream detail");
      const entries = [...objects].filter(([key]) =>
        key.startsWith(input.Prefix),
      );
      const offset = Number(input.ContinuationToken || 0);
      return {
        Contents: entries
          .slice(offset, offset + 2)
          .map(([Key, file]) => ({ Key, Size: file.bytes.length, LastModified: new Date(file.modified) })),
        IsTruncated: offset + 2 < entries.length,
        NextContinuationToken:
          offset + 2 < entries.length ? String(offset + 2) : undefined,
      };
    }
    const file = objects.get(input.Key);
    if (!file) throw missing();
    if (type === "HeadObjectCommand")
      return { ContentLength: file.bytes.length, ContentType: file.type };
    if (type === "GetObjectCommand") {
      const range = /bytes=(\d+)-(\d+)/.exec(input.Range || "");
      const bytes = range
        ? file.bytes.subarray(Number(range[1]), Number(range[2]) + 1)
        : file.bytes;
      const Body = Readable.from([bytes]);
      Body.transformToByteArray = async () => new Uint8Array(bytes);
      return { Body, ContentLength: bytes.length, ContentType: file.type,
        ...(range && { ContentRange: `bytes ${range[1]}-${Number(range[1]) + bytes.length - 1}/${file.bytes.length}` }) };
    }
    throw new Error("Unhandled S3 command " + type);
  },
};
const booking = () =>
  Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
    prints: 6,
  });
const photoId = (date) => {
  const id = new mongoose.Types.ObjectId();
  id.id.writeUInt32BE(Math.floor(date.getTime() / 1000), 0);
  return id;
};
const fileCount = () =>
  mongoose.connection.db.collection("media.files").countDocuments();
const asAdmin = (method, path) =>
  request(app)[method](path).set("Cookie", adminCookie);
const asStaff = (method, path) =>
  request(app)[method](path).set("Cookie", staffCookie);
const enableR2 = () => {
  config.mediaStorageProvider = "r2";
};

test("direct reads authorize one private file, respect expiry and preserve legacy HEAD/Range", async () => {
  enableR2();
  const b = await booking();
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#924658" } }).jpeg().toBuffer();
  const saved = await appendCapture(b._id, jpeg, { imported: true, clientKey: "direct-photo" });
  const photo = saved.photos[0];
  await whenPrintSourcesIdle();
  const url = `/api/albums/${b.accessToken}/photos/${photo._id}`;
  const signed = [];
  const signer = mock.method(r2Storage, "signedGet", async (file, seconds, response, signingDate) => {
    signed.push({ file, seconds, response, signingDate });
    return "https://private-r2.example.test/single-file?temporary=signature";
  });
  try {
    calls = [];
    const response = await request(app).get(`${url}?direct=1`).expect(302);
    assert.match(response.headers.location, /^https:\/\/private-r2/);
    // The same signed link is reused for a while, so the redirect itself can be cached
    // until shortly before the link expires (never longer than 5 minutes).
    const cached = Number(/^private, max-age=(\d+)$/.exec(response.headers["cache-control"])?.[1]);
    assert.ok(cached > 0 && cached <= 300 - 15, response.headers["cache-control"]);
    assert.ok(+signed[0].signingDate + signed[0].seconds * 1000 >= Date.now() + cached * 1000);
    assert.equal(signed[0].file, photo.file);
    assert.equal(signed[0].seconds, 300);
    assert.equal(signed[0].response.ResponseContentType, "image/jpeg");
    assert.deepEqual(calls, [], "signing does not download the original through Render");
    await request(app).get(`${url}?size=thumbnail&direct=1`).expect(302);
    assert.equal(signed[1].file, photo.thumbnailFile);
    const head = await request(app).head(`${url}?direct=1`).expect(200);
    assert.equal(Number(head.headers["content-length"]), jpeg.length);
    const range = await request(app).get(`${url}?direct=1`).set("Range", "bytes=0-9").expect(206);
    assert.deepEqual(range.body, jpeg.subarray(0, 10));
    assert.equal(signed.length, 2);
    const oldId = photoId(new Date(Date.now() - MEDIA_TTL_MS + 60000));
    await Booking.updateOne({ _id: b._id }, { $set: { "photos.0._id": oldId } });
    await request(app).get(`/api/albums/${b.accessToken}/photos/${oldId}?direct=1`).expect(302);
    // A link never outlives the photo itself.
    assert.ok(signed[2].seconds > 0);
    assert.ok(+signed[2].signingDate + signed[2].seconds * 1000 <= oldId.getTimestamp().getTime() + MEDIA_TTL_MS);
    await request(app).get(`/api/albums/wrong-token/photos/${oldId}?direct=1`).expect(404);
    await Booking.updateOne({ _id: b._id }, { $set: { "photos.0.deleted": true } });
    await request(app).get(`/api/albums/${b.accessToken}/photos/${oldId}?direct=1`).expect(404);
    assert.equal(signed.length, 3, "invalid album or hidden photos never get a link");
    const file = "r2:media/direct-print.png";
    const png = await sharp(jpeg).resize(1200, 1800).png().toBuffer();
    await saveMedia(file, png, "image/png");
    const job = await PrintJob.create({ booking: b._id, code: b.code,
      sheets: [{ file, width: 1200, height: 1800 }] });
    const print = `/api/albums/${b.accessToken}/prints/${job._id}`;
    await request(app).get(`${print}?direct=1&download=1`).expect(302);
    assert.equal(signed[3].file, file);
    assert.equal(signed[3].response.ResponseContentType, "image/png");
    assert.match(signed[3].response.ResponseContentDisposition, /\.png/);
    const link = await request(app).get(`${print}?direct=link&download=1`).expect(200);
    assert.equal(link.body.url, "https://private-r2.example.test/single-file?temporary=signature");
    assert.equal(link.headers["content-disposition"], undefined);
    assert.match(link.headers["cache-control"], /^private, (max-age=\d+|no-store)$/);
    const original = await request(app).get(print).expect(200);
    assert.deepEqual(original.body, png, "the fallback still serves lossless native print bytes");
    await PrintJob.collection.updateOne({ _id: job._id }, { $set: { createdAt: new Date(Date.now() - MEDIA_TTL_MS - 1000) } });
    await request(app).get(`${print}?direct=1`).expect(404);
    assert.equal(signed.length, 5);
  } finally { signer.mock.restore(); }
});

test("the album hands out each photo's gallery and editor links, the same URLs the redirects use", async () => {
  enableR2();
  const b = await booking();
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#4a6b92" } }).jpeg().toBuffer();
  const saved = await appendCapture(b._id, jpeg, { imported: true, clientKey: "linked-photo" });
  await whenPrintSourcesIdle();
  const photo = (await Booking.findById(b._id)).photos[0];
  const albumUrl = `/api/albums/${b.accessToken}`;
  for (let attempt = 0; ; attempt++) {
    const window = Math.floor(Date.now() / 120000);
    const [{ body }, thumb, preview] = await Promise.all([
      request(app).get(albumUrl).expect(200),
      request(app).get(`${albumUrl}/photos/${photo._id}?size=thumbnail&direct=1`).expect(302),
      request(app).get(`${albumUrl}/photos/${photo._id}?size=preview&direct=1`).expect(302),
    ]);
    if (window !== Math.floor(Date.now() / 120000) && attempt < 2) continue; // crossed a signing window
    const { links } = body.photos[0];
    assert.equal(links.thumbnail, thumb.headers.location);
    assert.equal(links.preview, preview.headers.location);
    assert.deepEqual(Object.keys(links).sort(), ["original", "preview", "print", "thumbnail", "until"]);
    const print = await request(app).get(`${albumUrl}/photos/${photo._id}?size=print&direct=1`).expect(302);
    const original = await request(app).get(`${albumUrl}/photos/${photo._id}?direct=1`).expect(302);
    if (window !== Math.floor(Date.now() / 120000) && attempt < 2) continue;
    assert.equal(links.print, print.headers.location);
    assert.equal(links.original, original.headers.location);
    assert.match(new URL(links.print).pathname, new RegExp(`/${photo.printFile.slice(3)}$`));
    assert.match(new URL(links.thumbnail).pathname, new RegExp(`/${photo.thumbnailFile.slice(3)}$`));
    assert.match(new URL(links.preview).pathname, new RegExp(`/${photo.previewFile.slice(3)}$`));
    const until = Date.parse(links.until);
    assert.ok(until > Date.now() + 15000 && until <= Date.now() + 300000, links.until);
    break;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const window = Math.floor(Date.now() / 120000);
    const first = await request(app).get(albumUrl).expect(200);
    const again = await request(app).get(albumUrl).set("If-None-Match", first.headers.etag);
    if (window !== Math.floor(Date.now() / 120000)) continue;
    assert.equal(first.headers["cache-control"], "private, no-cache");
    assert.equal(again.status, 304, "an unchanged album poll sends no body");
    break;
  }
  // Uploads and other album responses carry links too, so the page never drops them.
  const second = await request(app).post(`${albumUrl}/photos`).set("Content-Type", "image/jpeg")
    .set("X-Photo-Key", "linked-photo-2").send(jpeg).expect(201);
  assert.ok(second.body.photos.every((p) => p.links?.thumbnail && p.links?.preview));
  // A photo about to expire, or one still in GridFS, gets no link: the page uses the API route.
  const old = new mongoose.Types.ObjectId();
  old.id.writeUInt32BE(Math.floor((Date.now() - MEDIA_TTL_MS + 5000) / 1000), 0);
  await Booking.updateOne({ _id: b._id }, { $set: { "photos.0._id": old, "photos.1.file": "legacy-gridfs.jpg" } });
  const { body } = await request(app).get(albumUrl).expect(200);
  assert.deepEqual(body.photos.map((p) => p.links), [undefined, undefined]);
  assert.equal(saved.photos.length, 1);
});

test("album videos and composed photos load directly from storage with unchanged fallback bytes", async () => {
  enableR2();
  const b = await booking();
  const video = randomBytes(4096);
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#527194" } })
    .jpeg().toBuffer();
  const thumbnail = await sharp(jpeg).resize(40).jpeg().toBuffer();
  await Promise.all([
    saveMedia("r2:media/shared.mp4", video, "video/mp4"),
    saveMedia("r2:media/shared.jpg", jpeg, "image/jpeg"),
    saveMedia("r2:media/shared.thumb.jpg", thumbnail, "image/jpeg"),
  ]);
  const early = photoId(new Date(Date.now() - MEDIA_TTL_MS + 60_000));
  const last = new mongoose.Types.ObjectId();
  await Booking.updateOne({ _id: b._id }, { $set: {
    photos: [{ _id: early, file: "legacy-first.jpg" }, { _id: last, file: "legacy-last.jpg" }],
    mediaExpiresAt: new Date(early.getTimestamp().getTime() + MEDIA_TTL_MS),
    video: { file: "r2:media/shared.mp4", mimeType: "video/mp4", size: video.length },
    composite: { file: "r2:media/shared.jpg", thumbnailFile: "r2:media/shared.thumb.jpg", width: 80, height: 60 },
  } });
  const base = `/api/albums/${b.accessToken}`;
  calls = [];
  for (let attempt = 0; ; attempt++) {
    const window = Math.floor(Date.now() / 120000);
    const [{ body }, clip, image, thumb] = await Promise.all([
      request(app).get(base).expect(200),
      request(app).get(`${base}/video?direct=1`).expect(302),
      request(app).get(`${base}/composite?direct=1`).expect(302),
      request(app).get(`${base}/composite?size=thumbnail&direct=1`).expect(302),
    ]);
    if (window !== Math.floor(Date.now() / 120000) && attempt < 2) continue;
    assert.equal(body.video.links.original, clip.headers.location);
    assert.equal(body.composite.links.original, image.headers.location);
    assert.equal(body.composite.links.thumbnail, thumb.headers.location);
    assert.equal(new URL(clip.headers.location).searchParams.get("response-content-type"), "video/mp4");
    assert.ok(Date.parse(body.video.links.until) > Date.now() + 60_000,
      "shared media stays available while a later photo is retained");
    assert.ok(Date.parse(body.video.links.until) <= last.getTimestamp().getTime() + MEDIA_TTL_MS);
    assert.deepEqual(calls, [], "album links and redirects do not relay any file through Render");
    break;
  }
  const download = await request(app).get(`${base}/video?download=1&direct=link`).expect(200);
  assert.match(new URL(download.body.url).searchParams.get("response-content-disposition"), /NXC-.*-video\.mp4/);
  assert.equal(download.headers["content-disposition"], undefined);
  assert.deepEqual((await request(app).get(`${base}/video`).expect(200)).body, video);
  assert.deepEqual((await request(app).get(`${base}/composite`).expect(200)).body, jpeg);
  assert.deepEqual((await request(app).get(`${base}/composite?size=thumbnail`).expect(200)).body, thumbnail);
  const range = await request(app).get(`${base}/video?direct=1`).set("Range", "bytes=10-29").expect(206);
  assert.deepEqual(range.body, video.subarray(10, 30), "older clients can still seek through the proxy");
  await request(app).head(`${base}/video?direct=1`).expect(200);
  await request(app).get("/api/albums/wrong-token/video?direct=1").expect(404);
  await Booking.updateOne({ _id: b._id }, { $set: { mediaDeleted: true } });
  const hidden = await request(app).get(base).expect(200);
  assert.equal(hidden.body.video.links, undefined);
  assert.equal(hidden.body.composite.links, undefined);
  await request(app).get(`${base}/video?direct=1`).expect(404);
  await request(app).get(`${base}/composite?direct=1`).expect(404);
});

test("shared media links are omitted for old storage and photos close to their final expiry", async () => {
  enableR2();
  const b = await booking();
  await Booking.updateOne({ _id: b._id }, { $set: {
    photos: [{ file: "legacy.jpg" }],
    video: { file: "legacy.mp4", mimeType: "video/mp4", size: 10 },
    composite: { file: "legacy-composite.jpg" },
  } });
  const base = `/api/albums/${b.accessToken}`;
  const legacy = await request(app).get(base).expect(200);
  assert.equal(legacy.body.video.links, undefined);
  assert.equal(legacy.body.composite.links, undefined);
  const nearExpiry = photoId(new Date(Date.now() - MEDIA_TTL_MS + 5000));
  await Booking.updateOne({ _id: b._id }, { $set: {
    "photos.0._id": nearExpiry,
    "video.file": "r2:media/shared.mp4",
    "composite.file": "r2:media/shared.jpg",
  } });
  const expiring = await request(app).get(base).expect(200);
  assert.equal(expiring.body.video.links, undefined);
  assert.equal(expiring.body.composite.links, undefined);
});

before(async () => {
  config.secret = "r2-test-secret-only-123456789-not-production";
  config.dnpPrinter = "";
  config.r2 = {
    accountId: "a".repeat(32),
    accessKeyId: "test-only",
    secretAccessKey: "test-only",
    bucket: "test-media",
    prefix: "media/",
    limitGB: 10,
  };
  mock.method(r2Storage, "client", () => transport);
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  const users = await User.create([
    { name: "Admin", email: "r2-admin@test.local", role: "admin" },
    { name: "Staff", email: "r2-staff@test.local", role: "staff" },
  ]);
  [adminCookie, staffCookie] = users.map(
    (user) => "session=" + jwt.sign({ sub: String(user._id) }, config.secret),
  );
});
beforeEach(async () => {
  await whenPrintSourcesIdle();
  config.mediaStorageProvider = "gridfs";
  config.r2.secretAccessKey = "test-only";
  objects.clear();
  calls = [];
  failPut = undefined;
  failDelete = failList = false;
  invalidateR2Inventory();
  await Promise.all([
    Booking.deleteMany({}),
    PrintJob.deleteMany({}),
    Setting.deleteMany({}),
    mongoose.connection.db.collection("media.files").deleteMany({}),
    mongoose.connection.db.collection("media.chunks").deleteMany({}),
  ]);
});
after(async () => {
  mock.restoreAll();
  await mongoose.disconnect();
  await memory?.stop();
});

test("guest downloads prepare one mirrored R2 file, sign that file and protect it from orphan cleanup", async () => {
  enableR2();
  const source = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ed1923" } })
    .composite([{ input: { create: { width: 60, height: 80, channels: 3, background: "#1e32e1" } }, left: 60, top: 0 }])
    .jpeg({ quality: 96 }).toBuffer();
  const file = await saveMedia("camera-guest.jpg", source, "image/jpeg");
  const b = await Booking.create({ code: randomUUID(), accessToken: randomUUID(), status: "completed",
    photos: [{ file, kind: "original", number: 1 }] });
  const url = `/api/albums/${b.accessToken}/photos/${b.photos[0]._id}?download=1`;
  const first = await request(app).get(url).expect(200);
  const saved = (await Booking.findById(b._id)).photos[0];
  assert.notEqual(saved.downloadFile, file);
  const px = await sharp(first.body).resize(2, 1).raw().toBuffer();
  assert.ok(px[2] > px[0], "guest file is mirrored");
  assert.deepEqual(await readMedia(file), source, "camera source is unchanged");
  calls = [];
  const second = await request(app).get(url + "&direct=1").expect(302);
  const album = await request(app).get(`/api/albums/${b.accessToken}`).expect(200);
  const links = album.body.photos[0].links;
  assert.ok(second.headers.location.includes(saved.downloadFile.slice(3)));
  assert.ok(links.download.includes(saved.downloadFile.slice(3)));
  assert.ok(links.original.includes(file.slice(3)));
  assert.deepEqual(calls, [], "cached downloads and album links do not relay or re-encode image bytes");
  const guest = objects.get(saved.downloadFile.slice(3));
  guest.modified = Date.now() - MEDIA_TTL_MS - 3 * 3600000;
  assert.equal(await purgeStaleOrphans(), 0, "referenced guest file survives orphan cleanup");
  assert.ok(objects.has(saved.downloadFile.slice(3)));
});

test("R2 requires complete configuration and never silently stores failed R2 writes in MongoDB", async () => {
  enableR2();
  config.r2.secretAccessKey = "";
  assert.throws(validateMediaStorage, /R2 chưa cấu hình đủ/);
  await assert.rejects(
    saveMedia("new.jpg", Buffer.from("photo"), "image/jpeg"),
    /R2 chưa cấu hình đủ/,
  );
  assert.equal(await fileCount(), 0);
  config.r2.secretAccessKey = "test-only";
  failPut = () => true;
  await assert.rejects(
    saveMedia("new.jpg", Buffer.from("photo"), "image/jpeg"),
    /put unavailable/,
  );
  assert.equal(await fileCount(), 0);
  assert.equal(objects.size, 0);
});

test("new R2 captures keep full dimensions, store only the photo plus a lightweight preview and retry without duplicates", async () => {
  enableR2();
  const original = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: "#925341" },
  })
    .png()
    .toBuffer();
  const b = await booking();
  const saved = await appendCapture(b._id, original, {
    imported: true,
    clientKey: "phone-one",
  });
  const p = saved.photos[0];
  assert.match(p.file, /^r2:media\//);
  assert.equal(p.originalFile, undefined, "no second copy of the upload");
  const full = await sharp(await readMedia(p.file)).metadata();
  const thumb = await sharp(await readMedia(p.thumbnailFile)).metadata();
  assert.deepEqual([full.width, full.height], [1200, 900]);
  assert.deepEqual([thumb.width, thumb.height], [640, 480]);
  assert.equal(await fileCount(), 0);
  assert.equal(objects.size, 3, "saved photo: original, library thumbnail and editor preview");
  await whenPrintSourcesIdle();
  assert.equal(objects.size, 4, "the 3000 px print source follows in the background");
  await appendCapture(b._id, original, {
    imported: true,
    clientKey: "phone-one",
  });
  await whenPrintSourcesIdle();
  assert.equal(objects.size, 4, "a retry stores nothing new");
  assert.equal(
    calls.filter((call) => call.type === "PutObjectCommand").length,
    4,
  );
  const fullResponse = await request(app)
    .get("/api/albums/" + b.accessToken + "/photos/" + p._id)
    .expect(200);
  const thumbResponse = await request(app)
    .get(
      "/api/albums/" + b.accessToken + "/photos/" + p._id + "?size=thumbnail",
    )
    .expect(200);
  assert.equal((await sharp(fullResponse.body).metadata()).width, 1200);
  assert.equal((await sharp(thumbResponse.body).metadata()).width, 640);
  await request(app)
    .get("/api/albums/not-the-token/photos/" + p._id)
    .expect(404);
  assert.equal(objects.size, 4, "read routes must not delete anything");
});

test("old GridFS files stay readable after enabling R2 and missing remote refs cannot return another store's file", async () => {
  const bytes = Buffer.from("old image bytes");
  await saveMedia("legacy.jpg", bytes, "image/jpeg");
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
    photos: [{ file: "legacy.jpg", kind: "original" }],
  });
  enableR2();
  assert.deepEqual(await readMedia("legacy.jpg"), bytes);
  const response = await request(app)
    .get(
      "/api/albums/" +
        b.accessToken +
        "/photos/" +
        b.photos[0]._id +
        "?size=thumbnail",
    )
    .expect(200);
  assert.deepEqual(response.body, bytes);
  assert.equal(await readMedia("r2:media/legacy.jpg"), null);
  await deleteMedia(["legacy.jpg"]);
  assert.equal(await fileCount(), 0);
});

test("camera-size JPEG and ICC survive the binary upload, private R2 storage and full download unchanged", async () => {
  enableR2();
  const original = await sharp(randomBytes(6240 * 4160 * 3), {
    raw: { width: 6240, height: 4160, channels: 3 },
  }).withIccProfile("srgb").jpeg({ quality: 70 }).toBuffer();
  assert.ok(original.length > 8_000_000 && original.length < 20_000_000,
    "exercise a real camera-size payload rather than a tiny solid-colour JPEG");
  const b = await booking();
  const response = await request(app).post(`/api/albums/${b.accessToken}/photos`)
    .set("Content-Type", "image/jpeg").set("X-Photo-Key", "r2-camera-original")
    .send(original).expect(201);
  const photo = response.body.photos[0];
  assert.equal(photo.sourcePreserved, true);
  const saved = await Booking.findById(b._id);
  assert.ok(objects.get(saved.photos[0].file.slice(3)).bytes.equals(original));
  const downloaded = await request(app).get(`/api/albums/${b.accessToken}/photos/${photo.id}`)
    .expect(200).expect("Content-Type", /image\/jpeg/);
  assert.ok(downloaded.body.equals(original), "download keeps every camera JPEG byte");
  const metadata = await sharp(downloaded.body).metadata();
  assert.deepEqual([metadata.width, metadata.height], [6240, 4160]);
  assert.deepEqual(metadata.icc, (await sharp(original).metadata()).icc);
  const preview = await request(app).get(`/api/albums/${b.accessToken}/photos/${photo.id}?size=preview`).expect(200);
  const previewMeta = await sharp(preview.body).metadata();
  assert.deepEqual([previewMeta.width, previewMeta.height], [1600, 1067]);
  assert.ok(preview.body.length < original.length / 2);
  assert.notDeepEqual(preview.body, downloaded.body, "display bytes can never replace the camera original");
  const previewKey = saved.photos[0].previewFile.slice(3);
  assert.ok(objects.has(previewKey));
  await whenPrintSourcesIdle();
  const storage = await getStorageSummary();
  assert.equal(storage.media.groups.thumbnails.files, 3,
    "storage monitoring includes library/editor previews and the print source");
  const expired = photoId(new Date(Date.now() - MEDIA_TTL_MS - 1000));
  await Booking.updateOne({ _id: b._id }, { $set: { "photos.0._id": expired } });
  await request(app).get(`/api/albums/${b.accessToken}/photos/${expired}?size=preview&direct=1`).expect(404);
  await purgeExpiredMedia();
  assert.equal(objects.size, 0, "TTL removes the original and both preview sizes together");
});

test("private R2 responses support ranges, HEAD, missing objects and invalid offsets", async () => {
  enableR2();
  const file = await saveMedia(
    "range.jpg",
    Buffer.from("0123456789"),
    "image/jpeg",
  );
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
    photos: [{ file }],
  });
  const url = "/api/albums/" + b.accessToken + "/photos/" + b.photos[0]._id;
  const range = await request(app)
    .get(url)
    .set("Range", "bytes=2-5")
    .expect(206);
  assert.equal(range.headers["content-range"], "bytes 2-5/10");
  assert.equal(range.body.toString(), "2345");
  const suffix = await request(app)
    .get(url)
    .set("Range", "bytes=-3")
    .expect(206);
  assert.equal(suffix.body.toString(), "789");
  const invalid = await request(app)
    .get(url)
    .set("Range", "bytes=20-")
    .expect(416);
  assert.equal(invalid.headers["content-range"], "bytes */10");
  const reads = calls.filter((call) => call.type === "GetObjectCommand").length;
  const head = await request(app).head(url).expect(200);
  assert.equal(head.headers["content-length"], "10");
  assert.equal(
    calls.filter((call) => call.type === "GetObjectCommand").length,
    reads,
  );
  await deleteMedia([file]);
  await request(app).get(url).expect(404);
});

test("a full R2 image read needs a single GET, while ranges and HEAD still look the object up first", async () => {
  enableR2();
  const file = await saveMedia("single.jpg", Buffer.from("0123456789"), "image/jpeg");
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
    photos: [{ file }],
  });
  const url = "/api/albums/" + b.accessToken + "/photos/" + b.photos[0]._id;
  calls = [];
  const full = await request(app).get(url).expect(200);
  assert.equal(full.body.toString(), "0123456789");
  assert.equal(full.headers["content-length"], "10");
  assert.equal(full.headers["content-type"], "image/jpeg");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.deepEqual(
    calls.map((call) => call.type),
    ["GetObjectCommand"],
  );
  calls = [];
  await request(app).get(url).set("Range", "bytes=1-3").expect(206);
  await request(app).head(url).expect(200);
  assert.deepEqual(
    calls.map((call) => call.type),
    ["HeadObjectCommand", "GetObjectCommand", "HeadObjectCommand"],
  );
  await deleteMedia([file]);
  await request(app).get(url).expect(404);
});

test("a failed R2 sibling upload or booking commit waits for remaining writes then cleans all uncommitted files", async () => {
  enableR2();
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#925341" },
  })
    .jpeg()
    .toBuffer();
  const b = await booking();
  for (const suffix of [".thumb.jpg", ".preview.jpg"]) {
    failPut = (input) => input.Key.endsWith(suffix);
    await assert.rejects(
      appendCapture(b._id, bytes, { imported: true }),
      /put unavailable/,
    );
    assert.equal(objects.size, 0);
    assert.equal((await Booking.findById(b._id)).photos.length, 0);
  }
  failPut = undefined;
  const failingCommit = mock.method(Booking, "findOneAndUpdate", async () => {
    throw new Error("commit failed");
  });
  try {
    await assert.rejects(
      appendCapture(b._id, bytes, { imported: true }),
      /commit failed/,
    );
  } finally {
    failingCommit.mock.restore();
  }
  assert.equal(objects.size, 0);
  assert.equal(await fileCount(), 0);
});

test("combined storage includes paginated R2 metadata and legacy bytes, keeping thumbnails and expiry accurate", async () => {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const old = photoId(new Date(now - MEDIA_TTL_MS - 1000));
  await saveMedia("legacy.jpg", Buffer.alloc(11), "image/jpeg");
  enableR2();
  const names = [];
  for (const [name, size] of [
    ["photo.jpg", 13],
    ["original.original", 17],
    ["thumb.jpg", 7],
    ["sheet.jpg", 19],
    ["orphan.jpg", 23],
  ])
    names.push(await saveMedia(name, Buffer.alloc(size), "image/jpeg"));
  objects.set("outside-prefix/private.jpg", {
    bytes: Buffer.alloc(100),
    type: "image/jpeg",
  });
  await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    photos: [
      {
        _id: old,
        file: names[0],
        originalFile: names[1],
        thumbnailFile: names[2],
        deleted: true,
      },
      { file: "legacy.jpg" },
    ],
  });
  await PrintJob.create({
    file: names[3],
    sheets: [{ file: names[3] }],
    status: "printed",
  });
  calls = [];
  const summary = await getStorageSummary({ now });
  assert.equal(summary.media.bytes, 90);
  assert.equal(summary.media.files, 6);
  assert.equal(summary.media.stores.gridfs.bytes, 11);
  assert.equal(summary.r2.usedBytes, 79);
  assert.equal(summary.r2.files, 5);
  assert.equal(summary.r2.quota.limitBytes, 10_000_000_000);
  assert.deepEqual(summary.media.groups.thumbnails, { bytes: 7, files: 1 });
  assert.deepEqual(summary.expired, {
    bytes: 37,
    files: 3,
    photos: 1,
    printJobs: 0,
    orphans: 0,
  });
  assert.equal(
    summary.retention.nextImageExpiresAt,
    new Date(old.getTimestamp().getTime() + MEDIA_TTL_MS).toISOString(),
  );
  assert.equal(
    calls.filter((call) => call.type === "ListObjectsV2Command").length,
    3,
  );
  assert.equal(
    calls.filter((call) => call.type === "GetObjectCommand").length,
    0,
    "statistics never read image payloads",
  );
});

test("R2 metadata caching shares reads and invalidates after save/delete", async () => {
  enableR2();
  await saveMedia("one.jpg", Buffer.alloc(12), "image/jpeg");
  calls = [];
  await Promise.all([getStorageSummary(), getStorageSummary()]);
  const first = calls.filter(
    (call) => call.type === "ListObjectsV2Command",
  ).length;
  assert.equal(first, 1);
  await getStorageSummary();
  assert.equal(
    calls.filter((call) => call.type === "ListObjectsV2Command").length,
    first,
  );
  const second = await saveMedia("two.jpg", Buffer.alloc(15), "image/jpeg");
  assert.equal((await getStorageSummary()).r2.usedBytes, 27);
  await deleteMedia([second]);
  assert.equal((await getStorageSummary()).r2.usedBytes, 12);
});

test("unavailable R2 statistics stay unknown, preserve legacy totals and hide sensitive upstream errors", async () => {
  await saveMedia("legacy.jpg", Buffer.alloc(12), "image/jpeg");
  enableR2();
  failList = true;
  const summary = await getStorageSummary();
  assert.equal(summary.media.available, false);
  assert.equal(summary.media.stores.gridfs.bytes, 12);
  assert.equal(summary.r2.usedBytes, null);
  assert.equal(summary.r2.quota.remainingBytes, null);
  assert.equal(summary.r2.quota.level, "unknown");
  assert.equal(summary.retention.available, false);
  assert.equal(summary.retention.nextImageExpiresAt, null);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /sensitive upstream|test-only|secretAccessKey/,
  );
});

test("R2 quota edits are admin-only and independent from MongoDB quota, with explicit removal", async () => {
  enableR2();
  await request(app)
    .put("/api/admin/storage/r2-limit")
    .send({ limitGB: 2 })
    .expect(401);
  await asStaff("put", "/api/admin/storage/r2-limit")
    .send({ limitGB: 2 })
    .expect(403);
  const saved = await asAdmin("put", "/api/admin/storage/r2-limit")
    .send({ limitGB: 2 })
    .expect(200);
  assert.equal(saved.body.r2.quota.limitGB, 2);
  assert.equal(saved.body.quota.limitMB, 512);
  for (const invalid of [
    { limitGB: 0 },
    { limitGB: -1 },
    { limitGB: "2" },
    { limitGB: 2, unknown: true },
  ])
    await asAdmin("put", "/api/admin/storage/r2-limit")
      .send(invalid)
      .expect(400);
  const removed = await asAdmin("put", "/api/admin/storage/r2-limit")
    .send({ limitGB: null })
    .expect(200);
  assert.equal(removed.body.r2.quota.limitGB, null);
  assert.equal(removed.body.r2.quota.remainingBytes, null);
  assert.equal(
    (await asStaff("get", "/api/admin/storage").expect(200)).body.r2.quota
      .limitGB,
    null,
  );
});

test("TTL cleanup retries failed R2 deletes, then removes only expired originals/previews/sheets and keeps revenue", async () => {
  enableR2();
  const old = photoId(new Date(Date.now() - MEDIA_TTL_MS - 10000));
  const files = [];
  for (const name of [
    "old.jpg",
    "old.original",
    "old.thumb.jpg",
    "fresh.jpg",
    "print.jpg",
  ])
    files.push(await saveMedia(name, Buffer.from(name), "image/jpeg"));
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    total: 60000,
    photos: [
      {
        _id: old,
        file: files[0],
        originalFile: files[1],
        thumbnailFile: files[2],
      },
      { file: files[3] },
    ],
  });
  await PrintJob.create({
    file: files[4],
    createdAt: new Date(Date.now() - MEDIA_TTL_MS - 10000),
  });
  failDelete = true;
  await assert.rejects(purgeExpiredMedia(), /delete unavailable/);
  assert.equal((await Booking.findById(b._id)).photos.length, 2);
  assert.equal(await PrintJob.countDocuments(), 1);
  failDelete = false;
  const response = await asAdmin(
    "post",
    "/api/admin/storage/cleanup-expired",
  ).expect(200);
  assert.equal(
    response.body.freedBytes,
    files
      .filter((_, i) => i !== 3)
      .reduce(
        (sum, file) => sum + Buffer.byteLength(file.slice("r2:media/".length)),
        0,
      ),
  );
  assert.equal(objects.size, 1);
  const remaining = await Booking.findById(b._id);
  assert.equal(remaining.photos.length, 1);
  assert.equal(remaining.total, 60000);
  assert.ok(await readMedia(files[3]));
  assert.equal(await PrintJob.countDocuments(), 0);
});

test("print cancellation keeps the job and quota on R2 outage, then releases sheets once after retry", async () => {
  enableR2();
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    printSheets: 1,
  });
  const file = await saveMedia("sheet.jpg", Buffer.from("print"), "image/jpeg");
  const job = await PrintJob.create({
    booking: b._id,
    file,
    sheets: [{ file }],
  });
  failDelete = true;
  await asStaff("delete", "/api/admin/print-jobs/" + job._id).expect(403);
  await asAdmin("delete", "/api/admin/print-jobs/" + job._id).expect(500);
  assert.ok(await PrintJob.findById(job._id));
  assert.equal((await Booking.findById(b._id)).printSheets, 1);
  failDelete = false;
  await asAdmin("delete", "/api/admin/print-jobs/" + job._id).expect(200);
  assert.equal(await PrintJob.findById(job._id), null);
  assert.equal((await Booking.findById(b._id)).printSheets, 0);
  await asAdmin("delete", "/api/admin/print-jobs/" + job._id).expect(404);
});

test("print sheets store R2 refs and retain 10x15 dimensions and 300dpi for download/ZIP", async () => {
  enableR2();
  const photo = await saveMedia(
    "original.jpg",
    await sharp({ create: { width: 80, height: 60, channels: 3, background: "#925341" } }).jpeg().toBuffer(),
    "image/jpeg",
  );
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
    prints: 3,
    photos: [{ file: photo, kind: "original" }],
  });
  const sheet = await sharp({
    create: { width: 1181, height: 1772, channels: 3, background: "#925341" },
  })
    .withMetadata({ density: 300 })
    .jpeg()
    .toBuffer();
  const response = await request(app)
    .post("/api/albums/" + b.accessToken + "/print-pack")
    .send({
      images: ["data:image/jpeg;base64," + sheet.toString("base64")],
      frameName: "Test",
      requestKey: randomUUID(),
    })
    .expect(201);
  const job = await PrintJob.findById(response.body._id);
  assert.match(job.file, /^r2:media\//);
  const metadata = await sharp(await readMedia(job.file)).metadata();
  assert.deepEqual(await readMedia(job.file), sheet, "the original print bytes and DPI tag survive");
  assert.deepEqual(
    [metadata.width, metadata.height, metadata.density],
    [1181, 1772, 300],
  );
  assert.equal(await fileCount(), 0);
  await request(app)
    .get("/api/albums/" + b.accessToken + "/prints/" + job._id + "?download=1")
    .expect(200);
  await request(app)
    .get("/api/albums/" + b.accessToken + "/download")
    .expect(200)
    .expect("Content-Type", /application\/zip/);
});

test("expired or hidden R2 photos cannot be viewed or downloaded while physical cleanup is pending", async () => {
  enableR2();
  const file = await saveMedia(
    "expired.jpg",
    Buffer.from("image"),
    "image/jpeg",
  );
  const old = photoId(new Date(Date.now() - MEDIA_TTL_MS - 10000));
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    status: "completed",
    photos: [{ _id: old, file, kind: "original" }],
  });
  const url = "/api/albums/" + b.accessToken;
  await request(app)
    .get(url + "/photos/" + old)
    .expect(404);
  await request(app)
    .get(url + "/photos/" + old + "?size=thumbnail")
    .expect(404);
  await request(app)
    .get(url + "/download")
    .expect(404);
  const job = await PrintJob.create({
    booking: b._id,
    file,
    createdAt: new Date(Date.now() - MEDIA_TTL_MS - 10000),
  });
  await request(app)
    .get(url + "/prints/" + job._id)
    .expect(404);
  assert.ok(
    await readMedia(file),
    "blocked access does not delete stored bytes",
  );
  await Booking.updateOne(
    { _id: b._id },
    { photos: [{ file, deleted: true }] },
  );
  const hidden = (await Booking.findById(b._id)).photos[0];
  await request(app)
    .get(url + "/photos/" + hidden._id)
    .expect(404);
});

test("incomplete or cyclic R2 pagination cannot report a misleading partial total", async () => {
  enableR2();
  const original = transport.send;
  const transportMock = mock.method(
    transport,
    "send",
    async function (command) {
      if (command.constructor.name !== "ListObjectsV2Command")
        return original.call(this, command);
      const token = command.input.ContinuationToken;
      return {
        Contents: [{ Key: "media/one.jpg", Size: 12 }],
        IsTruncated: true,
        NextContinuationToken: token === "a" ? "b" : "a",
      };
    },
  );
  try {
    const summary = await getStorageSummary();
    assert.equal(summary.r2.usedBytes, null);
    assert.equal(summary.media.available, false);
  } finally {
    transportMock.mock.restore();
  }
});

test("bulk R2 cleanup deduplicates keys and respects 1000-object batches", async () => {
  enableR2();
  const files = [];
  for (let i = 0; i < 2001; i++) {
    const file = "r2:media/expired-" + i + ".jpg";
    files.push(file);
    objects.set(file.slice(3), {
      bytes: Buffer.from("image"),
      type: "image/jpeg",
    });
  }
  objects.set("media/fresh.jpg", {
    bytes: Buffer.from("fresh"),
    type: "image/jpeg",
  });
  await deleteMedia([...files, files[0]]);
  const deletions = calls.filter(
    (call) => call.type === "DeleteObjectsCommand",
  );
  assert.deepEqual(
    deletions.map((call) => call.input.Delete.Objects.length),
    [1000, 1000, 1],
  );
  assert.equal(objects.size, 1);
  assert.ok(objects.has("media/fresh.jpg"));
});

test("a partial bulk delete response cannot discard booking references or claim cleanup succeeded", async () => {
  enableR2();
  const file = await saveMedia("old.jpg", Buffer.from("image"), "image/jpeg");
  const old = photoId(new Date(Date.now() - MEDIA_TTL_MS - 10000));
  const b = await Booking.create({
    code: randomUUID(),
    accessToken: randomUUID(),
    photos: [{ _id: old, file }],
  });
  const send = transport.send;
  const transportMock = mock.method(
    transport,
    "send",
    async function (command) {
      if (command.constructor.name === "DeleteObjectsCommand")
        return { Errors: [{ Key: file.slice(3), Code: "AccessDenied" }] };
      return send.call(this, command);
    },
  );
  try {
    await assert.rejects(purgeExpiredMedia(), /Chưa xóa được/);
    assert.equal((await Booking.findById(b._id)).photos.length, 1);
    assert.ok(await readMedia(file));
  } finally {
    transportMock.mock.restore();
  }
  await purgeExpiredMedia();
  assert.equal((await Booking.findById(b._id)).photos.length, 0);
});

test("bucket files nothing uses any more are counted as cleanable once past retention, then removed", async () => {
  enableR2();
  const now = Date.now();
  const longAgo = now - MEDIA_TTL_MS - 3 * 60 * 60 * 1000;
  const stale = await saveMedia("switched-db-photo.jpg", Buffer.alloc(40), "image/jpeg");
  const recent = await saveMedia("upload-in-progress.jpg", Buffer.alloc(30), "image/jpeg");
  const used = await saveMedia("still-used.jpg", Buffer.alloc(20), "image/jpeg");
  objects.get(stale.slice(3)).modified = longAgo;
  objects.get(used.slice(3)).modified = longAgo;
  // An old file still referenced by a print job keeps following the job's own retention.
  await PrintJob.create({ file: used, sheets: [{ file: used }], status: "pending" });
  invalidateR2Inventory();
  const before = await getStorageSummary({ freshR2: true });
  assert.equal(before.expired.orphans, 1, "only the old, unreferenced file");
  assert.equal(before.expired.bytes, 40);
  const cleaned = await asAdmin("post", "/api/admin/storage/cleanup-expired").expect(200);
  assert.equal(cleaned.body.freedBytes, 40);
  assert.equal(objects.has(stale.slice(3)), false, "the stale orphan is deleted");
  assert.equal(objects.has(recent.slice(3)), true, "a fresh upload that is not committed yet stays");
  assert.equal(objects.has(used.slice(3)), true, "a referenced file is never treated as an orphan");
  assert.equal(cleaned.body.summary.expired.orphans, 0);
  // The automatic 15-minute purge never deletes them: only an admin's cleanup does.
  const again = await saveMedia("another-old-file.jpg", Buffer.alloc(9), "image/jpeg");
  objects.get(again.slice(3)).modified = longAgo;
  invalidateR2Inventory();
  await purgeExpiredMedia();
  assert.equal(objects.has(again.slice(3)), true);
});

test("a booth uploads the camera original straight to storage and commits only its preview", async () => {
  enableR2();
  const { cleanJpegMetadata } = await import("../src/services/jpeg-metadata.js");
  const sessionId = "direct-session";
  const b = await Booking.create({
    code: randomUUID(), accessToken: randomUUID(), status: "checked_in",
    captureStartedAt: new Date(), captureEndsAt: new Date(Date.now() + 600000), captureSession: sessionId,
  });
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id), sessionId }, config.secret);
  // A camera JPEG with private EXIF; the booth strips it the same way the server does.
  const camera = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#7a4b5c" } })
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "FUJIFILM", Artist: "private" } } })
    .jpeg({ quality: 90 }).toBuffer();
  const cleaned = cleanJpegMetadata(camera, 6);
  assert.ok(cleaned.length < camera.length);
  const preview = await sharp(camera).rotate().resize(1067, 1600).jpeg().toBuffer(); // upright 2:3
  const puts = [];
  const signer = mock.method(r2Storage, "signedPut", async (file, seconds, type, size) => {
    puts.push({ file, seconds, type, size });
    return `https://test-media.${"a".repeat(32)}.r2.cloudflarestorage.com/${file.slice(3)}?X-Amz-Signature=test`;
  });
  const ticket = (clientKey, size = cleaned.length) => request(app).post("/api/kiosk/photo/upload-url")
    .send({ captureToken, clientKey, size });
  const browserPut = (file, bytes) =>
    objects.set(file.slice(3), { bytes: Buffer.from(bytes), type: "image/jpeg", modified: Date.now() });
  const commit = (clientKey, stored, body = preview) => request(app).post("/api/kiosk/photo")
    .set("Content-Type", "image/jpeg").set("X-Capture-Token", captureToken)
    .set("X-Photo-Key", clientKey).set("X-Photo-Mirrored", "0").set("X-Photo-Stored", stored).send(body);
  try {
    const { body: first } = await ticket("direct-photo-1").expect(200);
    assert.equal(puts[0].type, "image/jpeg");
    assert.equal(puts[0].size, cleaned.length, "the URL only accepts exactly these bytes");
    assert.ok(puts[0].seconds <= 15 * 60);
    assert.match(first.upload.url, /\.r2\.cloudflarestorage\.com\//);
    const file = puts[0].file;
    browserPut(file, cleaned);
    calls = [];
    const saved = await commit("direct-photo-1", first.upload.stored).expect(200);
    assert.equal(saved.body.photos.length, 1);
    const photo = (await Booking.findById(b._id)).photos[0];
    assert.equal(photo.file, file, "the stored original becomes the photo");
    assert.equal(photo.sourcePreserved, true);
    assert.deepEqual(objects.get(file.slice(3)).bytes, cleaned, "the camera bytes are kept untouched");
    const written = calls.filter((c) => c.type === "PutObjectCommand").map((c) => c.input.Key);
    assert.deepEqual(written.sort(), [photo.previewFile.slice(3), photo.thumbnailFile.slice(3)].sort(),
      "the server writes only the small copies, never the original");
    assert.ok(calls.some((c) => c.type === "GetObjectCommand" && c.input.Range === "bytes=0-131071"),
      "it reads only the header of the stored original");
    assert.deepEqual(objects.get(photo.previewFile.slice(3)).bytes, preview, "the booth preview is the editor preview");
    await whenPrintSourcesIdle();
    const withPrint = (await Booking.findById(b._id)).photos[0];
    assert.ok(withPrint.printFile, "the print source is made from the stored original in the background");
    const print = await sharp(objects.get(withPrint.printFile.slice(3)).bytes).metadata();
    assert.deepEqual([print.width, print.height], [600, 900], "upright, from the camera pixels");
    // A lost reply: committing again, or asking for a URL again, returns the saved photo.
    assert.equal((await commit("direct-photo-1", first.upload.stored).expect(200)).body.photos.length, 1);
    assert.ok(objects.has(file.slice(3)), "a repeated commit never deletes the saved original");
    const again = await ticket("direct-photo-1").expect(200);
    assert.equal(again.body.upload, undefined);
    assert.equal(again.body.saved, true);
    assert.equal(again.body.booking.photos[0].clientKey, "direct-photo-1");
    // Tokens only fit their own session and photo key.
    const { body: second } = await ticket("direct-photo-2").expect(200);
    await commit("direct-photo-3", second.upload.stored).expect(422);
    await commit("direct-photo-2", second.upload.stored.slice(0, -1) + "A").expect(422);
    await commit("direct-photo-2", "not-a-token").expect(422);
    // Not uploaded yet, or uploaded with private metadata: refused (422) so the booth sends it
    // the usual way; the unusable upload is removed.
    await commit("direct-photo-2", second.upload.stored).expect(422);
    browserPut(puts[1].file, camera);
    await commit("direct-photo-2", second.upload.stored).expect(422);
    assert.equal(objects.has(puts[1].file.slice(3)), false);
    await ticket("direct-photo-4", 41 * 1024 * 1024).expect(400);
    // A preview that does not match the photo: both copies come from the stored original.
    const { body: third } = await ticket("direct-photo-5").expect(200);
    browserPut(puts[puts.length - 1].file, cleaned);
    const square = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#000" } }).jpeg().toBuffer();
    await commit("direct-photo-5", third.upload.stored, square).expect(200);
    const fifth = (await Booking.findById(b._id)).photos.find((p) => p.clientKey === "direct-photo-5");
    const made = await sharp(objects.get(fifth.previewFile.slice(3)).bytes).metadata();
    assert.deepEqual([made.width, made.height], [600, 900]);
    // After the session: the album route works the same way.
    await Booking.updateOne({ _id: b._id }, { status: "completed" });
    const { body: late } = await request(app).post(`/api/albums/${b.accessToken}/photos/upload-url`)
      .send({ clientKey: "direct-photo-6", size: cleaned.length }).expect(200);
    browserPut(puts[puts.length - 1].file, cleaned);
    const imported = await request(app).post(`/api/albums/${b.accessToken}/photos`)
      .set("Content-Type", "image/jpeg").set("X-Photo-Key", "direct-photo-6")
      .set("X-Photo-Stored", late.upload.stored).send(preview).expect(201);
    assert.equal(imported.body.photos.length, 3);
    await request(app).post("/api/kiosk/photo/upload-url")
      .send({ captureToken, clientKey: "direct-photo-7", size: 10 }).expect(409);
    // GridFS storage has no direct uploads: the booth keeps the usual path.
    config.mediaStorageProvider = "gridfs";
    await request(app).post(`/api/albums/${b.accessToken}/photos/upload-url`)
      .send({ clientKey: "direct-photo-8", size: 10 }).expect(404);
  } finally { signer.mock.restore(); }
});

test("a booth uploads the timelapse video straight to storage; the server only checks and attaches it", async () => {
  enableR2();
  const sessionId = "video-session";
  const b = await Booking.create({
    code: randomUUID(), accessToken: randomUUID(), status: "completed", captureSession: sessionId,
    video: { file: "r2:media/old-video.webm", mimeType: "video/webm", size: 3 },
  });
  objects.set("media/old-video.webm", { bytes: Buffer.from("old"), type: "video/webm", modified: Date.now() });
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id), sessionId }, config.secret);
  const puts = [];
  const signer = mock.method(r2Storage, "signedPut", async (file, seconds, type, size) => {
    puts.push({ file, seconds, type, size });
    return `https://test-media.${"a".repeat(32)}.r2.cloudflarestorage.com/${file.slice(3)}?X-Amz-Signature=test`;
  });
  const video = Buffer.alloc(4096, 7);
  const ticket = (body) => request(app).post("/api/kiosk/video/upload-url").send({ captureToken, ...body });
  const commit = (stored, token = captureToken) =>
    request(app).post("/api/kiosk/video/commit").send({ captureToken: token, stored });
  try {
    const { body: first } = await ticket({ type: "video/mp4", size: video.length }).expect(200);
    assert.equal(puts[0].type, "video/mp4");
    assert.equal(puts[0].size, video.length, "the URL only accepts exactly this video");
    assert.ok(puts[0].seconds <= 15 * 60);
    assert.match(puts[0].file, /^r2:media\/[0-9a-f-]{36}\.mp4$/);
    assert.match(first.upload.url, /\.r2\.cloudflarestorage\.com\//);
    // Chưa tải lên kho: 422, máy chụp gửi video qua máy chủ.
    await commit(first.upload.stored).expect(422);
    objects.set(puts[0].file.slice(3), { bytes: video, type: "video/mp4", modified: Date.now() });
    calls = [];
    assert.deepEqual((await commit(first.upload.stored).expect(201)).body, { ok: true, size: video.length });
    assert.equal(calls.some((c) => c.type === "PutObjectCommand"), false, "the server never uploads the video itself");
    const stored = await Booking.findById(b._id).lean();
    assert.deepEqual(stored.video, { file: puts[0].file, mimeType: "video/mp4", size: video.length });
    assert.equal(objects.has("media/old-video.webm"), false, "the replaced video is removed");
    const served = await request(app).get(`/api/albums/${b.accessToken}/video`).expect(200);
    assert.equal(served.headers["content-type"], "video/mp4");
    assert.equal(served.body.length, video.length);
    // Mã tải lên chỉ dùng cho đúng phiên chụp đã xin.
    await commit(first.upload.stored.slice(0, -1) + (first.upload.stored.endsWith("A") ? "B" : "A")).expect(422);
    await commit("not-a-token").expect(422);
    const other = await Booking.create({
      code: randomUUID(), accessToken: randomUUID(), status: "completed", captureSession: "other-session",
    });
    const otherToken = jwt.sign({ type: "capture", booking: String(other._id), sessionId: "other-session" }, config.secret);
    await commit(first.upload.stored, otherToken).expect(422);
    assert.equal((await Booking.findById(other._id).lean()).video, undefined);
    // Quá 60 MB, sai loại, hoặc kho MongoDB (không tải thẳng): không cấp URL.
    await ticket({ type: "video/mp4", size: 61 * 1024 * 1024 }).expect(400);
    await ticket({ type: "video/quicktime", size: 10 }).expect(400);
    config.mediaStorageProvider = "gridfs";
    await ticket({ type: "video/mp4", size: 10 }).expect(404);
  } finally { signer.mock.restore(); }
});

test("preview first on R2: the album shows the preview at once, then the camera original goes straight to storage and is attached", async () => {
  enableR2();
  const { cleanJpegMetadata } = await import("../src/services/jpeg-metadata.js");
  const sessionId = "preview-first-session";
  const b = await Booking.create({
    code: randomUUID(), accessToken: randomUUID(), status: "checked_in",
    captureStartedAt: new Date(), captureEndsAt: new Date(Date.now() + 600000), captureSession: sessionId,
  });
  const captureToken = jwt.sign({ type: "capture", booking: String(b._id), sessionId }, config.secret);
  const camera = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#3a6b8c" } })
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "FUJIFILM", Artist: "private" } } })
    .jpeg({ quality: 90 }).toBuffer();
  const cleaned = cleanJpegMetadata(camera, 6);
  const preview = await sharp(camera).rotate().resize(1067, 1600).jpeg().toBuffer();
  const puts = [];
  const signer = mock.method(r2Storage, "signedPut", async (file, seconds, type, size) => {
    puts.push({ file, seconds, type, size });
    return `https://test-media.${"a".repeat(32)}.r2.cloudflarestorage.com/${file.slice(3)}?X-Amz-Signature=test`;
  });
  const albumPath = `/api/albums/${b.accessToken}/photos`;
  try {
    // 1) Ảnh xem trước: chỉ ~0,3 MB qua máy chủ, album có ảnh ngay.
    await request(app).post("/api/kiosk/photo").set("Content-Type", "image/jpeg").set("X-Capture-Token", captureToken)
      .set("X-Photo-Key", "early-photo-1").set("X-Photo-Mirrored", "0").set("X-Photo-Original", "later")
      .send(preview).expect(200);
    const pending = (await Booking.findById(b._id)).photos[0];
    assert.equal(pending.originalPending, true);
    assert.equal(pending.file, pending.previewFile);
    // Khách bấm Chụp xong: ảnh gốc vẫn gắn được vào album sau đó.
    await Booking.updateOne({ _id: b._id }, { status: "completed" });
    // 2) Ảnh gốc thẳng lên kho R2 (máy chủ không nhận 15 MB), rồi gắn vào ảnh.
    const { body: ticket } = await request(app).post(`${albumPath}/original-url`)
      .send({ clientKey: "early-photo-1", size: cleaned.length }).expect(200);
    assert.equal(puts.at(-1).size, cleaned.length);
    const file = puts.at(-1).file;
    objects.set(file.slice(3), { bytes: Buffer.from(cleaned), type: "image/jpeg", modified: Date.now() });
    calls = [];
    await request(app).post(`${albumPath}/original`)
      .send({ clientKey: "early-photo-1", stored: ticket.upload.stored.slice(0, -1) + "A" }).expect(422);
    assert.deepEqual((await request(app).post(`${albumPath}/original`)
      .send({ clientKey: "early-photo-1", stored: ticket.upload.stored }).expect(200)).body, { attached: true });
    const photo = (await Booking.findById(b._id)).photos[0];
    assert.equal(photo.file, file, "the stored original becomes the photo");
    assert.deepEqual([photo.originalPending, photo.sourcePreserved], [undefined, true]);
    assert.equal(calls.filter((c) => c.type === "PutObjectCommand").length, 0, "the server never re-uploads the original");
    await whenPrintSourcesIdle();
    const print = await sharp(objects.get((await Booking.findById(b._id)).photos[0].printFile.slice(3)).bytes).metadata();
    assert.deepEqual([print.width, print.height], [600, 900], "the print source comes from the camera pixels, upright");
    // Đã có ảnh gốc: xin URL lần nữa không tải lại.
    assert.deepEqual((await request(app).post(`${albumPath}/original-url`)
      .send({ clientKey: "early-photo-1", size: cleaned.length }).expect(200)).body, { saved: true });
  } finally { signer.mock.restore(); }
});
