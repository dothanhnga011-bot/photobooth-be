import mongoose from "mongoose";

const { Schema } = mongoose;
// Lệnh in khách gửi từ Web App: file khung đã ghép (độ phân giải cao) chờ lễ tân in.
const printJobSchema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", index: true },
    code: String,
    name: String,
    roomName: String,
    // Phòng chụp của lượt chụp: máy in DNP cài cho phòng (Quản lý máy → Cài máy in) chỉ nhận lệnh
    // của đúng phòng đó.
    room: { type: Schema.Types.ObjectId, ref: "Room" },
    branch: String,
    copies: Number,
    frameName: String,
    printSize: { type: String, enum: ["full", "strip", "instax"], default: "full" },
    file: String,
    sheets: [{ file: String, width: Number, height: Number }],
    requestKey: { type: String, unique: true, sparse: true },
    requestFingerprint: { type: String, select: false },
    // Operator recovery never consumes the guest's purchased print allowance.
    operatorPrint: Boolean,
    reprintOf: { type: Schema.Types.ObjectId, ref: "PrintJob" },
    // A reprint shares its source bytes and must not extend their retention period.
    fileExpiresAt: Date,
    spoolStatus: { type: String, default: "idle" },
    spoolMessage: String,
    spoolLeaseId: { type: String, select: false },
    spoolLeaseUntil: { type: Date, select: false },
    width: Number,
    height: Number,
    status: {
      type: String,
      enum: ["pending", "printed"],
      default: "pending",
    },
    printedAt: Date,
    printedBy: String,
  },
  { timestamps: true },
);

printJobSchema.index({ status: 1, createdAt: -1 });
printJobSchema.index({ booking: 1, createdAt: -1 });
printJobSchema.index({ room: 1, status: 1, spoolStatus: 1, createdAt: 1 });

export default mongoose.model("PrintJob", printJobSchema, "print_jobs");
