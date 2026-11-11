// Small in-process caches for data read on almost every request but changed rarely. On the free
// plans the database is far from the server (each query crosses an ocean), so skipping a read
// saves a whole round trip. Model hooks clear a cache on every write made through Mongoose in
// this process (the only process); a short lifetime covers anything edited elsewhere.
export function createReadCache({ ttl = 60_000, max = 200 } = {}) {
  const entries = new Map();
  const loading = new Map();
  let generation = 0;
  return {
    async get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      if (loading.has(key)) return loading.get(key);
      const started = generation;
      const task = Promise.resolve().then(load).then((value) => {
        // A write that happened while loading may not be in this result: do not keep it.
        if (started === generation) {
          if (entries.size >= max) entries.delete(entries.keys().next().value);
          entries.set(key, { value, expires: Date.now() + ttl });
        }
        return value;
      }).finally(() => {
        if (loading.get(key) === task) loading.delete(key);
      });
      loading.set(key, task);
      return task;
    },
    clear() {
      generation++;
      entries.clear();
      loading.clear();
    },
  };
}

const WRITES = [
  "save", "insertMany", "updateOne", "updateMany", "findOneAndUpdate", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace", "bulkWrite",
];
// Clear `cache` after any write made through the given schemas (register before compiling the
// model). A read that started before the write finished is never stored (see get()).
export function clearOnWrite(cache, schema) {
  for (const op of WRITES) schema.post(op, () => cache.clear());
}

// Catalog: rooms, packages, frames and studio settings. Users: the session check of every admin request.
export const catalogCache = createReadCache({ ttl: 60_000, max: 4 });
export const userCache = createReadCache({ ttl: 60_000, max: 100 });
// Cache thống kê tổng quan (TTL ngắn 10 giây để giảm tải MongoDB khi nhiều nhân viên cùng mở dashboard).
export const statsCache = createReadCache({ ttl: 10_000, max: 50 });
