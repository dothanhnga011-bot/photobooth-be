import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { removeActivityLogs, removeRetiredFeatureData } from "../src/services/activity-log-cleanup.js";

let memory;
let connection;
let db;

before(async () => {
  memory = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(memory.getUri()).asPromise();
  db = connection.db;
});

after(async () => {
  await connection?.close();
  await memory?.stop();
});

test("cleanup deletes current and legacy logs while preserving all other data and indexes", async () => {
  const preservedNames = [
    "bookings",
    "print_jobs",
    "users",
    "rooms",
    "packages",
    "frames",
    "settings",
    "media.files",
    "media.chunks",
    "audit_notes",
    "audits_archive",
  ];
  const snapshots = new Map();
  for (const name of preservedNames) {
    const collection = db.collection(name);
    await collection.insertOne({
      _id: "keep",
      value: name,
      photo: Buffer.from("original image bytes"),
    });
    await collection.createIndex({ value: 1 });
    snapshots.set(name, {
      documents: await collection.find({}).toArray(),
      indexes: await collection.indexes(),
    });
  }
  await db.collection("audits").insertMany([{ action: "a" }, { action: "b" }]);
  await db.collection("audits").createIndex({ action: 1 });
  await db.collection("hf_audits").insertOne({ action: "legacy" });

  assert.deepEqual(await removeActivityLogs(db), {
    removed: [
      { collection: "audits", documents: 2 },
      { collection: "hf_audits", documents: 1 },
    ],
    deletedDocuments: 3,
  });
  const remaining = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    .sort();
  assert.deepEqual(remaining, [...preservedNames].sort());
  for (const [name, snapshot] of snapshots) {
    assert.deepEqual(
      await db.collection(name).find({}).toArray(),
      snapshot.documents,
    );
    assert.deepEqual(await db.collection(name).indexes(), snapshot.indexes);
  }
  assert.deepEqual(await removeActivityLogs(db), {
    removed: [],
    deletedDocuments: 0,
  });
  assert.deepEqual(
    (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((collection) => collection.name)
      .sort(),
    remaining,
  );
});

test("retired features' data (Ca trực, chấm công & lương) is dropped; live collections keep their data and indexes", async () => {
  const live = ["users", "rooms", "packages", "frames", "settings", "bookings", "print_jobs", "revenue_entries",
    "screens", "stickers", "kiosk_attempts", "shifts_archive", "payrolls_2025"];
  const snapshots = new Map();
  for (const name of live) {
    const collection = db.collection(name);
    await collection.insertOne({ _id: "live-data", value: name });
    await collection.createIndex({ value: 1 });
    snapshots.set(name, { documents: await collection.find({}).toArray(), indexes: await collection.indexes() });
  }
  await db.collection("shifts").insertMany([{ branch: "A", openingCash: 0 }, { branch: "B", openingCash: 500000 }]);
  await db.collection("shifts").createIndex({ branch: 1, open: 1 });
  await db.collection("payrolls").insertOne({ month: "2026-09" });
  await db.collection("pay_adjustments").insertMany([{ amount: 1 }, { amount: 2 }, { amount: 3 }]);

  assert.deepEqual(await removeRetiredFeatureData(db), {
    removed: [
      { collection: "shifts", documents: 2 },
      { collection: "pay_adjustments", documents: 3 },
      { collection: "payrolls", documents: 1 },
    ],
    deletedDocuments: 6,
  });
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  for (const gone of ["shifts", "pay_adjustments", "payrolls"]) assert.equal(names.includes(gone), false, `${gone} dropped`);
  for (const [name, snapshot] of snapshots) {
    assert.deepEqual(await db.collection(name).find({}).toArray(), snapshot.documents, `${name} kept`);
    assert.deepEqual(await db.collection(name).indexes(), snapshot.indexes, `${name} indexes kept`);
  }
  assert.deepEqual(await removeRetiredFeatureData(db), { removed: [], deletedDocuments: 0 }, "a second start does nothing");
});
