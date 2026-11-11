import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadCache } from "../src/services/read-cache.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("concurrent readers share one load per key; a failed load remains retryable", async () => {
  const cache = createReadCache();
  const waiting = deferred();
  let calls = 0;
  const load = () => { calls++; return waiting.promise; };
  const readers = Array.from({ length: 12 }, () => cache.get("catalog", load));
  await Promise.resolve();
  assert.equal(calls, 1);
  waiting.resolve({ version: 1 });
  const values = await Promise.all(readers);
  assert.ok(values.every(value => value === values[0]));
  await cache.get("catalog", () => { throw new Error("Must hit cache"); });
  const failure = deferred();
  const failed = [cache.get("user", () => failure.promise), cache.get("user", () => failure.promise)];
  failure.reject(new Error("Database offline"));
  assert.ok((await Promise.allSettled(failed)).every(row => row.status === "rejected"));
  assert.equal(await cache.get("user", async () => "recovered"), "recovered");
});

test("a write starts a fresh load; an older result cannot overwrite it or release the newer pending read", async () => {
  const cache = createReadCache();
  const old = deferred(), fresh = deferred();
  const first = cache.get("catalog", () => old.promise);
  cache.clear();
  const second = cache.get("catalog", () => fresh.promise);
  old.resolve("old catalog");
  assert.equal(await first, "old catalog");
  const third = cache.get("catalog", () => { throw new Error("Must join fresh read"); });
  fresh.resolve("updated catalog");
  assert.deepEqual(await Promise.all([second, third]), ["updated catalog", "updated catalog"]);
  assert.equal(await cache.get("catalog", () => "wrong"), "updated catalog");
});
