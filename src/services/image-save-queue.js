import { budget, memoryUse, MEMORY_BUSY } from "./capacity.js";

// Bound large image processing/writes across all booths and phone imports. How many run at once
// follows the RAM the server really has (capacity.js: 1 on 512 MB, 3 on 2 GB), so booths can
// overlap uploads without running more full-resolution decoders than the memory holds.
function taskQueue(limit) {
  const waiting = [];
  let active = 0;
  return {
    busy: () => active > 0 || waiting.length > 0,
    async run(action) {
      if (active >= limit) await new Promise(resolve => waiting.push(resolve));
      else active++;
      try { return await action(); }
      finally {
        const next = waiting.shift();
        if (next) next(); else active--;
      }
    },
  };
}

// A validated booth preview is at most 2048 px, not a 26 MP camera decoder.
// Let just one such job bypass a large encode/storage wait. Under memory
// pressure it rejoins the normal queue; never bypass the large-image limit.
export function createImageSaveQueues({ fullLimit = budget.saves, previewLimit = 1, use = memoryUse } = {}) {
  const full = taskQueue(fullLimit), previews = taskQueue(previewLimit);
  return {
    saveImageTask: action => full.run(action),
    savePreviewTask: action => previews.run(() => use() >= MEMORY_BUSY ? full.run(action) : action()),
    isSaveQueueBusy: () => full.busy() || previews.busy(),
  };
}
const queues = createImageSaveQueues();

// True while any photo is being saved or waits to be: background work yields to it.
export const isSaveQueueBusy = queues.isSaveQueueBusy;

// Thời gian một ảnh chờ + xử lý + lưu, để trả về header Server-Timing (xem ở tab Network của
// trình duyệt hoặc trong chẩn đoán máy chụp): biết ảnh lưu chậm ở khâu nào.
export const timed = async (res, name, promise) => {
  const started = performance.now();
  try {
    return await promise;
  } finally {
    const ms = (performance.now() - started).toFixed(0);
    const previous = res.getHeader("Server-Timing");
    res.set("Server-Timing", [previous, `${name};dur=${ms}`].filter(Boolean).join(", "));
  }
};

export const saveImageTask = queues.saveImageTask;
export const savePreviewTask = queues.savePreviewTask;
