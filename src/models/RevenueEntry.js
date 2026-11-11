import mongoose from "mongoose";
import { clearOnWrite, statsCache } from "../services/read-cache.js";

// One financial record per expired booking, with the same _id for retry/deduplication.
// No customer identity, album token, capture data, photos or print files are stored here.
const schema = new mongoose.Schema({
  date: String, branch: String, room: mongoose.Schema.Types.ObjectId, roomName: String,
  package: mongoose.Schema.Types.ObjectId, packageName: String, frameName: String,
  source: String, status: String, paid: Boolean, total: Number, discount: Number,
  paymentMethod: String, paidAt: Date, cashReceived: Number,
  printSize: String, prints: Number, printSheets: Number, extraPrints: Number,
  extraSales: [{ _id: false, sheets: Number, amount: Number, paymentMethod: String, at: Date }],
  createdAt: Date, archivedAt: Date,
  requestKey: { type: String, select: false },
  snapshotHash: { type: String, required: true },
}, { versionKey: false });
schema.index({ paid: 1, date: 1, branch: 1 });
schema.index({ branch: 1, paidAt: 1 });
schema.index({ branch: 1, "extraSales.at": 1 });
schema.index({ requestKey: 1 }, { unique: true, sparse: true });
clearOnWrite(statsCache, schema);
export default mongoose.model("RevenueEntry", schema, "revenue_entries");
