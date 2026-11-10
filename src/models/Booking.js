import mongoose from "mongoose";

const { Schema } = mongoose;
const bookingSchema = new Schema(
  {
    code: { type: String, unique: true, sparse: true },
    name: String,
    phone: String,
    room: { type: Schema.Types.ObjectId, ref: "Room" },
    package: { type: Schema.Types.ObjectId, ref: "Package" },
    roomName: String,
    branch: String,
    packageName: String,
    shots: Number,
    prints: Number,
    date: String,
    time: String,
    // kiosk: khách tự chọn gói và trả tiền ngay tại máy chụp.
    // polaroid: lượt chụp phòng Polaroid (chọn layout ở máy, trả tiền ở quầy).
    source: { type: String, enum: ["counter", "scheduled", "kiosk", "polaroid"] },
    // Tiền máy nhận tiền đã nhận (có thể dư so với giá gói) và từng tờ tiền.
    cashReceived: Number,
    cashBills: [{ _id: false, amount: Number, at: Date }],
    issuedBy: { type: Schema.Types.ObjectId, ref: "User" },
    total: Number,
    discount: Number,
    coupon: String,
    status: {
      type: String,
      enum: ["pending", "confirmed", "checked_in", "completed", "cancelled"],
      default: "pending",
    },
    paymentMethod: String,
    paid: { type: Boolean, default: false },
    paidAt: Date,
    codeExpiresAt: Date,
    active: { type: Boolean, default: true },
    accessToken: { type: String, unique: true, sparse: true, select: false },
    captureSession: { type: String, select: false },
    captureStartedAt: Date,
    captureEndsAt: Date,
    // folder: ảnh gốc máy ảnh (X Acquire) do máy chụp đọc từ thư mục — cách chụp duy nhất hiện nay.
    // camera / tether: chế độ cũ đã bỏ (chỉ còn trong vé cũ).
    captureMode: { type: String, enum: ["camera", "folder", "tether"] },
    // Snapshot at sale: later package edits must not change a paid ticket's time.
    captureDuration: Number,
    countdownSeconds: Number,
    selectCount: Number,
    printSize: { type: String, enum: ["full", "strip", "instax"] },
    // Máy chụp báo "còn sống" vài giây một lần; máy khác chỉ nhận lại mã khi máy cũ im lặng.
    captureSeenAt: Date,
    // Tình trạng máy chụp gửi kèm khi báo "còn sống" (thư mục ảnh, số ảnh thấy được, lỗi đọc…)
    // để quản trị biết vì sao ảnh máy ảnh không về. Không trả cho khách.
    captureDiag: { type: Schema.Types.Mixed, select: false },
    nextPhotoNumber: { type: Number, default: 0 },
    requestKey: { type: String, unique: true, sparse: true, select: false },
    requestFingerprint: { type: String, select: false },
    photos: [
      {
        file: String,
        originalFile: String,
        thumbnailFile: String,
        previewFile: String,
        // Guest JPEG: upright, always mirrored from the camera source, at most 20 MP.
        downloadFile: String,
        // Nguồn in 3000 px (đã xoay, lật như ảnh xem trước) — nhẹ hơn ảnh gốc 26 MP nhiều lần.
        printFile: String,
        originalName: String,
        kind: String,
        // Set on photos guests deleted while the album could still do that; kept so old albums read the same.
        deleted: Boolean,
        number: Number,
        clientKey: String,
        mirrored: Boolean,
        // Lets the uploader reuse its local JPEG only when no pixel conversion occurred.
        sourcePreserved: Boolean,
        // The booth sends its 1600 px preview first so the album shows the photo within seconds;
        // the camera original follows (POST /api/albums/:token/photos/original). Meanwhile `file`
        // is that preview (already flipped like the screen, hence mirrored = false) and
        // originalMirrored is how the coming original must be flipped.
        originalPending: Boolean,
        originalMirrored: Boolean,
      },
    ],
    video: { file: String, mimeType: String, size: Number },
    // Ảnh đã ghép khung ở máy chụp (bản chất lượng in, vd. 1200 × 1800) + bản xem nhanh: khách xem /
    // tải trong album, kể cả khi gói không kèm tờ in hay lệnh in chưa gửi xong.
    composite: { file: String, thumbnailFile: String, frameName: String, width: Number, height: Number },
    printed: { type: Boolean, default: false },
    // Bộ khung / chủ đề khách chọn lần gửi in gần nhất (xếp hạng chủ đề ở Tổng quan; lệnh in tự xóa sau 24 giờ).
    frameName: String,
    // prints: số tờ 10 × 15 cm được in (theo gói + mua thêm); printSheets: số tờ khách đã gửi in.
    printSheets: { type: Number, default: 0 },
    extraPrints: { type: Number, default: 0 },
    // Số tờ khách chọn thêm trên kiosk, chờ lễ tân thu tiền (bán thêm tờ in sẽ trừ dần).
    requestedExtraPrints: { type: Number, default: 0 },
    // Mỗi lần bán thêm tờ in: tiền và hình thức thu tại thời điểm bán (đối soát theo ca trực).
    extraSales: [{ _id: false, sheets: Number, amount: Number, paymentMethod: String, at: Date }],
    extraPrintKeys: { type: [String], select: false },
    mediaExpiresAt: Date,
    mediaDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

bookingSchema.index({ room: 1, date: 1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index({ date: 1, createdAt: -1 });
bookingSchema.index({ status: 1, createdAt: -1 });
// Thống kê doanh thu theo ngày & chi nhánh (báo cáo, tổng quan, biểu đồ).
bookingSchema.index({ paid: 1, date: 1, branch: 1 });
// Danh sách đơn hàng tại quầy theo chi nhánh và trạng thái.
bookingSchema.index({ branch: 1, status: 1, createdAt: -1 });
bookingSchema.index({ mediaExpiresAt: 1 });
// Tổng tiền đã thu trong ca trực của một chi nhánh (khung Ca trực làm mới 30 giây/lần).
bookingSchema.index({ branch: 1, paidAt: 1 });
bookingSchema.index({ branch: 1, "extraSales.at": 1 });
// Dọn ảnh hết hạn 15 phút/lần tìm vé có ảnh cũ (ObjectId ảnh mang thời điểm chụp).
bookingSchema.index({ "photos._id": 1 });

export default mongoose.model("Booking", bookingSchema, "bookings");
