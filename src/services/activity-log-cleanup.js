import mongoose from "mongoose";

// Activity logs only: current collection and the name used by the older app.
export const ACTIVITY_LOG_COLLECTIONS = Object.freeze(["audits", "hf_audits"]);
// Collection của các tính năng đã bỏ, xoá hẳn khi máy chủ khởi động (cả dữ liệu và index):
// Ca trực & Đối soát (`shifts`, bỏ 12/11/2026) và chấm công & lương cũ (`pay_adjustments`, `payrolls`).
// Chỉ đúng các tên này; vé, ảnh, doanh thu và mọi collection khác được giữ nguyên.
export const RETIRED_FEATURE_COLLECTIONS = Object.freeze(["shifts", "pay_adjustments", "payrolls"]);

// Xoá các collection có tên trong `names` (bỏ qua tên không có). Trả về số bản ghi đã xoá từng collection.
export async function dropCollections(names, db = mongoose.connection.db) {
  const removed = [];
  for (const name of names) {
    const [existing] = await db
      .listCollections({ name }, { nameOnly: true })
      .toArray();
    if (!existing) continue;
    const collection = db.collection(name);
    const documents = await collection.countDocuments();
    try {
      await collection.drop();
      removed.push({ collection: name, documents });
    } catch (error) {
      // A concurrent app startup may have already removed this collection.
      if (error.code !== 26) throw error;
    }
  }
  return {
    removed,
    deletedDocuments: removed.reduce(
      (total, item) => total + item.documents,
      0,
    ),
  };
}

export const removeActivityLogs = (db = mongoose.connection.db) => dropCollections(ACTIVITY_LOG_COLLECTIONS, db);
export const removeRetiredFeatureData = (db = mongoose.connection.db) => dropCollections(RETIRED_FEATURE_COLLECTIONS, db);
