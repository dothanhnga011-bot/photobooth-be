// Tài liệu API (OpenAPI 3) cho Swagger UI ở /api/docs — để thử API ngay trên trình duyệt.
// Đăng nhập bằng POST /api/auth/login trong Swagger: cookie phiên được lưu, các API quản trị
// sau đó tự gửi kèm cookie (Swagger chạy cùng địa chỉ với máy chủ).

const json = (schema, example) => ({
  content: {
    "application/json": { schema, ...(example !== undefined && { example }) },
  },
});
const object = (properties, required = []) => ({
  type: "object",
  properties,
  ...(required.length && { required }),
});
const body = (properties, required, example) => ({
  required: true,
  ...json(object(properties, required), example),
});
const photoBody = (properties, required) => {
  const request = body(properties, required);
  for (const type of ["image/jpeg", "image/png", "image/webp"])
    request.content[type] = { schema: { type: "string", format: "binary" } };
  return request;
};
const photoHeaders = (capture = false) => [
  { name: "X-Photo-Key", in: "header", required: false, description: "Bắt buộc khi gửi file nhị phân; mã chống gửi trùng (8–160 ký tự).", schema: { type: "string", minLength: 8, maxLength: 160 } },
  { name: "X-Photo-Name", in: "header", required: false, description: "Tên tệp mã hóa bằng encodeURIComponent, tối đa 250 ký tự sau giải mã.", schema: { type: "string" } },
  { name: "X-Photo-Preview-Length", in: "header", required: false, description: "Tùy chọn: số byte cuối thân là ảnh xem trước JPEG (đã xoay đúng chiều, đã lật nếu chụp lật, cạnh dài 640–2048 px, ≤ 6 MB) nối ngay sau ảnh gốc. Máy chủ dùng nó làm ảnh xem/ảnh nhỏ nên lưu nhanh hơn; ảnh gốc vẫn lưu nguyên byte và nguồn in vẫn làm từ ảnh gốc. Ảnh xem trước sai khung hình/định dạng thì bị bỏ qua.", schema: { type: "integer", minimum: 1 } },
  { name: "X-Photo-Stored", in: "header", required: false, description: "Ảnh gốc đã được máy chụp tải thẳng lên R2 (mã `stored` từ …/upload-url): thân chỉ là ảnh xem trước JPEG. Mã sai, ảnh chưa lên kho hoặc còn metadata riêng tư → 422 (máy chụp gửi lại cách thường).", schema: { type: "string" } },
  ...(capture ? [{ name: "X-Capture-Token", in: "header", required: false, description: "Bắt buộc khi kiosk gửi file nhị phân: token phiên chụp.", schema: { type: "string" } }] : []),
];
const uploadUrlResponse = {
  200: {
    description: "{ upload: { url, stored } } — PUT ảnh gốc (image/jpeg, đúng số byte) tới url trong 15 phút rồi gửi ảnh xem trước kèm X-Photo-Stored = stored. Ảnh đã lưu trước đó: { saved: true, booking }.",
    ...json({ type: "object" }),
  },
};
const ok = (description, schema = { type: "object" }, status = 200) => ({
  [status]: { description, ...json(schema) },
});
const errors = (...codes) =>
  Object.fromEntries(
    codes.map((c) => [c, { $ref: `#/components/responses/E${c}` }]),
  );
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const list = (name) => ({ type: "array", items: ref(name) });
const str = (description, extra = {}) => ({
  type: "string",
  description,
  ...extra,
});
const int = (description, extra = {}) => ({
  type: "integer",
  description,
  ...extra,
});
const bool = (description) => ({ type: "boolean", description });
const enumOf = (values, description) => ({
  type: "string",
  enum: values,
  description,
});
const objectId = {
  type: "string",
  pattern: "^[a-f0-9]{24}$",
  example: "6ab5e9c5e82e4d5ba43b63be",
};
const uuid = {
  type: "string",
  format: "uuid",
  description:
    "Mã chống gửi trùng: tạo mới cho mỗi lần bấm, gửi lại đúng mã này nếu mất phản hồi.",
  example: "0b6f1c1e-6d7a-4f55-9a43-2f1a3c5d7e90",
};
const pathParam = (name, description, schema = objectId) => ({
  name,
  in: "path",
  required: true,
  description,
  schema,
});
const query = (name, description, schema) => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});
const tokenParam = pathParam(
  "token",
  "Mã truy cập album (48 ký tự, trong mã QR khách quét).",
  { type: "string", minLength: 48, maxLength: 48 },
);
const month = {
  type: "string",
  pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
  example: "2026-10",
};
const imageData = str("Ảnh dạng data URL (base64).", {
  example: "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
});
const captureToken = str("Mã phiên chụp nhận được khi nhập mã vé ở kiosk.");
const adminOnly = " Chỉ tài khoản quản trị (admin).";
const loggedIn = [{ cookieAuth: [] }];

// Tài nguyên quản trị dùng chung một kiểu API: danh sách / tạo / sửa / tắt.
const resources = {
  rooms: ["phòng chụp", "Room"],
  packages: ["gói chụp", "Package"],
  frames: ["khung ảnh", "Frame"],
  stickers: ["sticker", "Sticker"],
  users: ["tài khoản nhân viên", "UserInput"],
};
const resourcePaths = Object.fromEntries(
  Object.entries(resources).flatMap(([route, [label, input]]) => [
    [
      `/api/admin/${route}`,
      {
        get: {
          tags: ["Danh mục & cài đặt"],
          summary: `Danh sách ${label}`,
          description:
            route === "rooms"
              ? "Lễ tân (staff) xem phòng đang hoạt động để mở kiosk; quản trị xem tất cả phòng, gồm phòng đã tắt. Cần đăng nhập."
              : route === "frames"
                ? adminOnly +
                  " Danh sách không kèm ảnh base64: image là địa chỉ ảnh (/api/frames/{id}/image?v=…) để cache, thumb là ảnh xem nhanh (…&size=thumb); lấy đủ ảnh của một khung bằng GET /api/admin/frames/{id}."
                : adminOnly,
          security: loggedIn,
          responses: {
            ...ok("Danh sách", { type: "array", items: { type: "object" } }),
            ...errors(...(route === "rooms" ? [401] : [401, 403])),
          },
        },
        post: {
          tags: ["Danh mục & cài đặt"],
          summary: `Thêm ${label}`,
          description: adminOnly,
          security: loggedIn,
          requestBody: { required: true, ...json(ref(input)) },
          responses: { ...ok("Đã lưu"), ...errors(400, 401, 403) },
        },
      },
    ],
    [
      `/api/admin/${route}/{id}`,
      {
        parameters: [pathParam("id", `Mã ${label}`)],
        ...(route === "frames" && {
          get: {
            tags: ["Danh mục & cài đặt"],
            summary: "Một khung ảnh, kèm ảnh đầy đủ dạng data URL (để sửa)",
            description: adminOnly,
            security: loggedIn,
            responses: { ...ok("Khung ảnh"), ...errors(400, 401, 403, 404) },
          },
        }),
        put: {
          tags: ["Danh mục & cài đặt"],
          summary: `Sửa ${label}`,
          description: adminOnly,
          security: loggedIn,
          requestBody: { required: true, ...json(ref(input)) },
          responses: { ...ok("Đã lưu"), ...errors(400, 401, 403, 404) },
        },
        delete: {
          tags: ["Danh mục & cài đặt"],
          summary:
            route === "frames" ? "Xóa khung ảnh"
              : route === "stickers" ? "Xóa sticker" : `Tắt ${label} (không xóa)`,
          description: adminOnly,
          security: loggedIn,
          responses: {
            ...ok("Xong", object({ ok: { type: "boolean" } })),
            ...errors(400, 401, 403, 404),
          },
        },
      },
    ],
  ]),
);

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "NXC Photobooth API",
    version: "1.0.0",
    description: [
      "API của hệ thống photobooth nội bộ: quầy cấp mã vé, máy chụp (kiosk) nhận ảnh gốc từ máy ảnh, album của khách, in ảnh.",
      "",
      "**Cách thử:**",
      "1. Mở **Đăng nhập → POST /api/auth/login**, bấm *Try it out*, nhập email / mật khẩu rồi *Execute*. Trình duyệt lưu cookie phiên (`session`).",
      "2. Các API có ổ khóa 🔒 sau đó tự gửi kèm cookie. Lễ tân (staff) không gọi được API chỉ dành cho quản trị và không thấy tiền.",
      "3. Máy chụp: lấy `device` ở **POST /api/admin/rooms/{id}/device**, cấp mã vé ở **POST /api/admin/tickets**, rồi **POST /api/kiosk/claim** để nhận `captureToken`.",
      "",
      "Lưu ý: đây là dữ liệu thật của tiệm — tạo vé thử sẽ tính vào doanh thu, nên hủy vé thử sau khi xong (PATCH /api/admin/bookings/{id} với `status: cancelled`).",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "Máy chủ đang mở trang này" }],
  tags: [
    { name: "Hệ thống", description: "Tình trạng máy chủ, dữ liệu công khai" },
    { name: "Đăng nhập", description: "Phiên đăng nhập bằng cookie" },
    {
      name: "Quầy & vé",
      description: "Cấp mã vé, danh sách vé, bán thêm tờ in, thống kê",
    },
    {
      name: "Máy chụp (kiosk)",
      description:
        "Nhập mã vé, bắt đầu phiên, gửi ảnh, báo trạng thái, kết thúc",
    },
    {
      name: "Album khách",
      description: "Khách mở bằng mã truy cập trong QR — không cần đăng nhập",
    },
    { name: "In ảnh", description: "Hàng đợi in tại quầy" },
    { name: "Danh mục & cài đặt", description: "Phòng, gói, khung, tài khoản" },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "session",
        description:
          "Đặt tự động khi gọi POST /api/auth/login trong trang này (cookie HttpOnly).",
      },
    },
    responses: {
      E400: {
        description: "Dữ liệu không hợp lệ",
        ...json(ref("Error"), { message: "Mã vé gồm 6 chữ số." }),
      },
      E401: {
        description: "Chưa đăng nhập / phiên hết hạn",
        ...json(ref("Error"), { message: "Vui lòng đăng nhập." }),
      },
      E403: {
        description: "Không có quyền",
        ...json(ref("Error"), {
          message: "Chỉ quản trị viên được thực hiện thao tác này.",
        }),
      },
      E404: {
        description: "Không tìm thấy",
        ...json(ref("Error"), { message: "Không tìm thấy dữ liệu." }),
      },
      E409: {
        description: "Xung đột trạng thái (đã thay đổi, đã dùng, hết giờ…)",
        ...json(ref("Error"), { message: "Phiên chụp không còn hợp lệ." }),
      },
      E429: {
        description: "Thử quá nhiều lần",
        ...json(ref("Error"), {
          message:
            "Quá nhiều lần thử không thành công. Vui lòng thử lại sau 15 phút.",
        }),
      },
    },
    schemas: {
      Error: object({ message: { type: "string" } }),
      Photo: object({
        id: objectId,
        number: int("Số thứ tự ảnh (#01, #02…)"),
        kind: str("Loại ảnh", { example: "original" }),
        clientKey: str("Mã máy chụp gắn cho ảnh (chống gửi trùng)"),
        expiresAt: str("Ảnh tự xóa lúc này (24 giờ sau khi chụp)", {
          format: "date-time",
        }),
        printSource: bool("Đã có nguồn in 3000 px riêng (size=print)"),
        links: {
          ...object({
            thumbnail: str("Link R2 ký sẵn của ảnh nhỏ thư viện"),
            preview: str("Link R2 ký sẵn của ảnh xem khi chỉnh"),
            print: str("Link R2 ký sẵn của nguồn in 3000 px (chỉ khi printSource)"),
            original: str("Link R2 ký sẵn của ảnh gốc máy ảnh"),
            until: str("Link hết hạn lúc này (tối đa 5 phút)", { format: "date-time" }),
          }),
          description:
            "Chỉ có trong phản hồi album (ảnh lưu trên R2, còn hạn): trình duyệt tải thẳng từ R2, không hỏi máy chủ cho từng ảnh. Cùng một cửa sổ 2 phút, link trùng với link mà /photos/{photo}?size=…&direct=1 chuyển tới. Hết hạn thì dùng lại /photos/{photo}.",
        },
      }),
      Booking: object({
        _id: objectId,
        code: str("Mã vé 6 số", { example: "740787" }),
        branch: str("Chi nhánh áp dụng cho mã chụp"),
        paid: bool("Đã xác nhận thu tiền"),
        paidAt: str("Thời điểm xác nhận thu tiền", { format: "date-time" }),
        codeExpiresAt: str("Mã chụp hết hạn sau hai giờ kể từ paidAt", { format: "date-time" }),
        shots: int("Số ảnh được chụp của gói tại lúc bán"),
        countdownSeconds: int("Giây đếm ngược trước mỗi ảnh"),
        printSize: enumOf(["full", "strip", "instax"]),
        name: { type: "string" },
        phone: { type: "string" },
        status: enumOf(
          ["pending", "confirmed", "checked_in", "completed", "cancelled"],
          "confirmed: đã cấp mã · checked_in: đang chụp · completed: đã chụp xong",
        ),
        packageName: { type: "string" },
        roomName: { type: "string" },
        date: str("Ngày cấp (giờ Việt Nam)", { example: "2026-10-06" }),
        total: int("Tổng tiền phiếu (VND); nhân viên thấy để thu tiền"),
        paymentMethod: enumOf(["cash", "transfer"]),
        prints: int("Số tờ 10 × 15 cm được in"),
        printSheets: int("Số tờ đã gửi in"),
        captureMode: str(
          "folder = ảnh gốc máy ảnh qua X Acquire (vé cũ có thể là camera / tether)",
          { example: "folder" },
        ),
        captureStartedAt: { type: "string", format: "date-time" },
        captureEndsAt: { type: "string", format: "date-time" },
        mediaExpiresAt: str(
          "Lúc ảnh sớm nhất còn lại tự xóa (mỗi ảnh lưu 24 giờ kể từ lúc chụp)",
          {
            format: "date-time",
          },
        ),
        photos: list("Photo"),
        captureDiag: {
          ...object({
            mode: str("Chế độ chụp", { example: "folder" }),
            camera: str(
              "Camera đang làm hình trực tiếp (trống = chưa có hình máy ảnh)",
              { example: "USB Video (345f:2109)" },
            ),
            cameras: str("Các camera máy tính thấy", {
              example: "USB Video (345f:2109), Camera FaceTime HD",
            }),
            cameraError: str("Lỗi mở hình trực tiếp gần nhất"),
            folder: str("Thư mục ảnh máy ảnh đang đọc", {
              example: "FUJIFILM",
            }),
            access: str("Quyền đọc thư mục", { example: "granted" }),
            jpegs: int("Số ảnh JPG thấy trong thư mục"),
            raws: int("Số tệp RAW"),
            fresh: int("Ảnh JPG mới xuất hiện trong phiên"),
            imported: int("Ảnh đã nhận vào phiên"),
            scans: int("Số lượt quét thư mục"),
            newest: str("Tệp mới nhất thấy được"),
            error: str("Lỗi đọc gần nhất (trống = không lỗi)"),
            at: str("Lần máy chụp báo gần nhất", { format: "date-time" }),
          }),
          description:
            "Chỉ có trong danh sách vé của quản trị: tình trạng máy chụp gửi lên khi đang chụp.",
        },
      }),
      Room: object(
        {
          name: str("Tên phòng", { example: "Room 01" }),
          description: { type: "string", example: "" },
          branch: str("Chi nhánh", { example: "NXC" }),
          machineCode: str("Mã máy"),
          model: str("Dòng máy"),
          flip: enumOf(["device", "on", "off"], "Chế độ lật ảnh: theo máy / luôn lật / không lật"),
          payment: enumOf(["counter", "cash"], "Trả tiền: mua mã ở quầy / đút tiền tại máy"),
          paymentTest: bool("Chế độ thử: có nút bỏ qua trả tiền"),
          active: { type: "boolean", example: true },
        },
        ["name", "description", "branch", "active"],
      ),
      Package: object(
        {
          name: { type: "string", example: "Chụp đơn" },
          description: { type: "string", example: "5 phút, 1 tờ in" },
          price: int("Giá (VND)", { example: 60000 }),
          duration: int("Thời gian chụp (phút, 1–30)", { example: 5 }),
          shots: int("Số ảnh bắt buộc chụp (1–40)", { example: 12 }),
          countdownSeconds: int("Giây đếm ngược trước mỗi ảnh (1–30)", { example: 10 }),
          selectCount: int("Số ảnh khách chọn để ghép khung trên máy chụp (1–12)", { example: 4 }),
          printSize: enumOf(["full", "strip", "instax"]),
          prints: int("Số tờ in kèm gói (0–20)", { example: 1 }),
          branches: { type: "array", items: { type: "string" }, description: "Chi nhánh áp dụng; để trống = mọi chi nhánh" },
          active: { type: "boolean", example: true },
        },
        ["name", "description", "price", "duration", "prints", "active"],
      ),
      Frame: object(
        {
          name: { type: "string", example: "Khung sinh nhật" },
          themeName: { type: "string", example: "" },
          order: { type: "integer", example: 0 },
          printSize: enumOf(["full", "strip", "instax"]),
          image: str("Ảnh khung PNG/JPG dạng data URL (≤ 3 MB)"),
          slots: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            description: "Ô đặt ảnh, toạ độ 0–1 theo khung",
            items: object({
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            }),
            example: [{ x: 0.05, y: 0.05, w: 0.9, h: 0.6 }],
          },
          active: { type: "boolean", example: true },
        },
        ["name", "image", "slots", "active"],
      ),
      Sticker: object(
        {
          name: { type: "string", example: "Ngôi sao" },
          order: { type: "integer", example: 0 },
          image: str("Ảnh PNG/WebP nền trong suốt dạng data URL (≤ 500 KB)"),
          active: { type: "boolean", example: true },
        },
        ["name", "image", "active"],
      ),
      UserInput: object(
        {
          name: { type: "string", example: "Lễ tân Mai" },
          email: { type: "string", format: "email", example: "mai@nxc.local" },
          password: str("Bắt buộc khi tạo mới (≥ 10 ký tự); bỏ trống khi sửa"),
          role: enumOf(["admin", "staff"]),
          branch: str("Chi nhánh (bắt buộc với nhân viên)"),
          permissions: {
            type: "array",
            description: "Quyền của nhân viên; bỏ trống để giữ quyền đang có.",
            items: enumOf(["revenue:view", "orders:export", "orders:cancel", "print:operate", "shift:operate", "rooms:setup"]),
          },
          active: { type: "boolean", example: true },
        },
        ["name", "email", "role", "active"],
      ),
      ScreenInput: object(
        {
          name: str("Tên cấu hình (cấu hình riêng)"),
          rooms: { type: "array", items: objectId, description: "Máy áp dụng (cấu hình riêng)" },
          title: str("Dòng chữ lớn"),
          subtitle: str("Dòng chữ nhỏ"),
          interval: int("Số giây mỗi ảnh (2–60)"),
          images: { type: "array", items: { type: "object" }, description: "{ _id } giữ ảnh cũ hoặc { data } ảnh mới (≤ 6 ảnh)" },
          active: bool("Đang dùng"),
        },
        ["images"],
      ),
      Settings: object(
        {
          name: { type: "string", example: "NXC Photobooth" },
          address: { type: "string", example: "12 Lý Thường Kiệt" },
          phone: { type: "string", example: "0912345678" },
          bank: { type: "string", example: "VCB" },
          bankAccount: { type: "string", example: "0123456789" },
          bankOwner: { type: "string", example: "NXC" },
          bankQrImage: str("URL hoặc ảnh base64, có thể để trống", {
            example: "",
          }),
          extraPrintPrice: int("Giá bán thêm mỗi tờ in (VND)", {
            example: 20000,
          }),
        },
        ["name", "address", "phone", "bank", "bankAccount", "bankOwner"],
      ),
      StorageSize: object({
        files: int("Số file (GridFS tính riêng từng phiên bản)", {
          minimum: 0,
        }),
        bytes: int("Tổng byte nội dung file", { minimum: 0 }),
      }),
      StorageSummary: object({
        checkedAt: { type: "string", format: "date-time" },
        bytesPerMB: int("1 MB = 1.048.576 byte", { example: 1048576 }),
        ttlHours: { type: "number" },
        retention: object({
          nextImageExpiresAt: {
            type: "string",
            format: "date-time",
            nullable: true,
            description:
              "Hạn lưu gần nhất của ảnh album, ảnh gốc, ảnh nhỏ hoặc tờ in còn trong GridFS/R2. Bao gồm ảnh hết hạn đang chờ dọn. Khi không đọc được R2 trả null kèm available=false; không giả định hết ảnh.",
          },
        }),
        media: object({
          files: int("Tổng file GridFS + R2, kể cả file chưa có tham chiếu"),
          bytes: int("Tổng byte ảnh, ảnh gốc, tờ in, video và file khác"),
          available: {
            type: "boolean",
            description: "false nếu chỉ đo được phần GridFS khi R2 lỗi",
          },
          stores: object({
            gridfs: ref("StorageSize"),
            r2: { ...ref("StorageSize"), nullable: true },
          }),
          groups: object(
            Object.fromEntries(
              [
                "photos",
                "originals",
                "printSheets",
                "videos",
                "other",
                "thumbnails",
              ].map((name) => [name, ref("StorageSize")]),
            ),
          ),
        }),
        database: object({
          available: { type: "boolean" },
          name: { type: "string", nullable: true },
          dataBytes: { type: "number", nullable: true },
          indexBytes: { type: "number", nullable: true },
          usedBytes: {
            type: "number",
            nullable: true,
            description:
              "dbStats.dataSize + indexSize của database ứng dụng, không phải toàn cluster",
          },
          error: { type: "string", nullable: true },
        }),
        r2: object({
          active: { type: "boolean", description: "Ảnh mới được ghi vào R2" },
          configured: { type: "boolean" },
          available: { type: "boolean" },
          bucket: { type: "string" },
          files: { type: "integer", nullable: true },
          usedBytes: { type: "number", nullable: true },
          error: { type: "string", nullable: true },
          quota: object({
            limitGB: {
              type: "number",
              nullable: true,
              description:
                "Mức cảnh báo GB thập phân, không phải hóa đơn hoặc giới hạn cứng",
            },
            remainingBytes: { type: "number", nullable: true },
            usagePercent: { type: "number", nullable: true },
            level: enumOf(["unknown", "normal", "warning", "critical"]),
            source: enumOf(["config", "setting"]),
            scope: enumOf(["r2"]),
          }),
        }),
        cluster: object({
          available: { type: "boolean" },
          dataBytes: { type: "number", nullable: true },
          indexBytes: { type: "number", nullable: true },
          usedBytes: {
            type: "number",
            nullable: true,
            description:
              "atlasSize: tổng dataSize + indexSize của tất cả database trong cluster Atlas Free/Flex",
          },
          databaseCount: { type: "integer", nullable: true },
          error: { type: "string", nullable: true },
        }),
        quota: object({
          limitMB: {
            type: "number",
            nullable: true,
            description:
              "Giới hạn quản trị đã lưu hoặc MEDIA_STORAGE_LIMIT_MB; mặc định 512 MB. Giá trị đã lưu null bỏ giới hạn.",
          },
          limitBytes: { type: "number", nullable: true },
          remainingBytes: {
            type: "number",
            nullable: true,
            description:
              "max(0, limitBytes − cluster.usedBytes); null nếu thiếu giới hạn hoặc không đọc được atlasSize. Không thay bằng số liệu một database.",
          },
          usagePercent: { type: "number", nullable: true },
          level: enumOf(
            ["unknown", "normal", "warning", "critical"],
            "Cảnh báo từ 80%, nguy cấp từ 90%",
          ),
          scope: enumOf(["cluster", "unknown"], "Phạm vi đo dung lượng quota"),
          source: enumOf(
            ["config", "setting"],
            "Giới hạn từ cấu hình mặc định hoặc cài đặt quản trị đã lưu",
          ),
        }),
        expired: object({
          photos: int("Số ảnh hết hạn, theo thời gian ObjectId riêng từng ảnh"),
          printJobs: int("Số lệnh in hết hạn, theo createdAt"),
          files: int("Số file GridFS được tham chiếu bởi dữ liệu hết hạn"),
          bytes: int(
            "Tổng byte có thể dọn theo cơ chế TTL hiện tại, không đếm trùng tham chiếu",
          ),
        }),
      }),
    },
  },
  paths: {
    // ── Hệ thống ──
    "/api/health": {
      get: {
        tags: ["Hệ thống"],
        summary: "Máy chủ và cơ sở dữ liệu còn chạy",
        responses: {
          ...ok("Đang chạy", object({ ok: { type: "boolean" } })),
          503: { description: "Mất kết nối cơ sở dữ liệu" },
        },
      },
    },
    "/api/catalog": {
      get: {
        tags: ["Hệ thống"],
        summary: "Phòng, gói, khung, cài đặt tiệm đang hoạt động (công khai)",
        description:
          "Ảnh khung (frames[].image) và mã QR (settings.bankQrImage) trả về dạng địa chỉ ảnh có ?v=… " +
          "để trình duyệt cache lâu dài, không nhúng base64 vào đây (nhẹ hơn ~99%).",
        responses: ok(
          "Dữ liệu tiệm",
          object({
            rooms: { type: "array", items: { type: "object" } },
            packages: { type: "array", items: { type: "object" } },
            frames: { type: "array", items: { type: "object" } },
            settings: { type: "object" },
            devices: object({
              printerAvailable: { type: "boolean" },
            }),
          }),
        ),
      },
    },
    "/api/frames/{id}/image": {
      get: {
        tags: ["Hệ thống"],
        summary: "Ảnh khung đang hoạt động (PNG/JPG/WebP, công khai)",
        description:
          "Có ?v=… (lấy từ /api/catalog) thì cache 1 năm; đổi ảnh khung thì v đổi nên tự tải lại. " +
          "?size=thumb trả ảnh xem nhanh WebP cạnh dài 720 px (frames[].thumb) cho bộ chọn chủ đề / danh sách; " +
          "khung cũ chưa có thì tạo một lần, ảnh không đọc được thì trả ảnh gốc. Ghép ảnh và in luôn dùng ảnh gốc.",
        parameters: [
          pathParam("id", "Mã khung"),
          query("v", "Phiên bản ảnh (từ /api/catalog)", { type: "string" }),
          query("size", "thumb: ảnh xem nhanh WebP", { type: "string", enum: ["thumb"] }),
        ],
        responses: {
          200: {
            description: "Ảnh khung",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
            },
          },
          ...errors(404),
        },
      },
    },
    "/api/albums/{token}/video": {
      get: {
        tags: ["Album khách"],
        summary: "Video tua nhanh của lượt chụp (hỗ trợ Range; ?download=1 để tải về)",
        parameters: [tokenParam, query("download", "1 = tải về máy", { type: "string" })],
        responses: {
          200: { description: "Video", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
          ...errors(404),
        },
      },
    },
    "/api/albums/{token}/composite": {
      get: {
        tags: ["Album khách"],
        summary: "Ảnh đã ghép khung ở máy chụp (?size=thumbnail bản xem nhanh 720 px; ?download=1 để tải về)",
        parameters: [
          tokenParam,
          query("size", "thumbnail: bản xem nhanh", { type: "string", enum: ["thumbnail"] }),
          query("download", "1 = tải về máy", { type: "string" }),
        ],
        responses: {
          200: { description: "Ảnh JPEG", content: { "image/jpeg": { schema: { type: "string", format: "binary" } } } },
          ...errors(404),
        },
      },
    },
    "/api/screens/{id}/images/{imageId}": {
      get: {
        tags: ["Hệ thống"],
        summary: "Ảnh màn hình chờ (công khai)",
        description: "Có ?v=… (lấy từ /api/catalog) thì cache 1 năm.",
        parameters: [
          pathParam("id", "Mã màn hình chờ"),
          pathParam("imageId", "Mã ảnh"),
          query("v", "Phiên bản ảnh", { type: "string" }),
        ],
        responses: {
          200: { description: "Ảnh", content: { "image/jpeg": { schema: { type: "string", format: "binary" } } } },
          ...errors(400, 404),
        },
      },
    },
    "/api/stickers/{id}/image": {
      get: {
        tags: ["Hệ thống"],
        summary: "Ảnh sticker (công khai)",
        description: "Có ?v=… (lấy từ /api/catalog) thì cache 1 năm.",
        parameters: [pathParam("id", "Mã sticker"), query("v", "Phiên bản ảnh", { type: "string" })],
        responses: {
          200: { description: "Ảnh sticker", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
          ...errors(404),
        },
      },
    },
    "/api/studio/kiosk-idle": {
      get: {
        tags: ["Hệ thống"],
        summary: "Ảnh nền màn hình chờ của máy chụp (công khai)",
        parameters: [query("v", "Phiên bản ảnh", { type: "string" })],
        responses: {
          200: { description: "Ảnh nền", content: { "image/jpeg": { schema: { type: "string", format: "binary" } } } },
          ...errors(404),
        },
      },
    },
    "/api/studio/qr": {
      get: {
        tags: ["Hệ thống"],
        summary: "Ảnh QR chuyển khoản của tiệm (công khai)",
        parameters: [
          query("v", "Phiên bản ảnh (từ /api/catalog)", { type: "string" }),
        ],
        responses: {
          200: {
            description: "Ảnh QR",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
            },
          },
          ...errors(404),
        },
      },
    },

    // ── Đăng nhập ──
    "/api/auth/login": {
      post: {
        tags: ["Đăng nhập"],
        summary: "Đăng nhập (đặt cookie phiên)",
        description:
          "Sai 25 lần trong 15 phút thì bị khóa tạm. Đăng nhập xong, các API 🔒 tự gửi kèm cookie.",
        requestBody: body(
          {
            email: { type: "string", format: "email" },
            password: { type: "string", format: "password" },
          },
          ["email", "password"],
          { email: "admin@nxc.local", password: "" },
        ),
        responses: {
          ...ok(
            "Đã đăng nhập",
            object({
              name: { type: "string" },
              email: { type: "string" },
              role: enumOf(["admin", "staff"]),
            }),
          ),
          ...errors(400, 401, 429),
        },
      },
    },
    "/api/auth/me": {
      get: {
        tags: ["Đăng nhập"],
        summary: "Tài khoản đang đăng nhập",
        security: loggedIn,
        responses: { ...ok("Tài khoản"), ...errors(401) },
      },
    },
    "/api/auth/logout": {
      post: {
        tags: ["Đăng nhập"],
        summary: "Đăng xuất (xóa cookie)",
        responses: ok("Đã đăng xuất", object({ ok: { type: "boolean" } })),
      },
    },
    "/api/auth/password": {
      post: {
        tags: ["Đăng nhập"],
        summary: "Đổi mật khẩu của chính mình",
        description: "Đổi xong, các phiên đăng nhập khác bị đăng xuất.",
        security: loggedIn,
        requestBody: body(
          {
            current: { type: "string", format: "password" },
            password: { type: "string", format: "password", minLength: 10 },
          },
          ["current", "password"],
        ),
        responses: { ...ok("Đã đổi"), ...errors(400, 401) },
      },
    },

    // ── Quầy & vé ──
    "/api/admin/tickets/draft": {
      post: {
        tags: ["Quầy & vé"],
        summary: "Tạo phiếu chờ thanh toán, chưa có mã chụp",
        security: loggedIn,
        requestBody: body({
          package: objectId, requestKey: uuid,
          room: objectId, branch: str("Chi nhánh, dùng khi không chọn phòng"),
          name: str("Tên khách (bắt buộc)"), phone: str("SĐT Việt Nam của khách (bắt buộc)"),
          expectedTotal: int("Giá đang hiển thị cho thu ngân"),
        }, ["package", "requestKey", "name", "phone"]),
        responses: { ...ok("Phiếu chưa thanh toán", ref("Booking"), 201), ...errors(400, 401, 403, 409, 429) },
      },
    },
    "/api/admin/tickets/{id}/activate": {
      patch: {
        tags: ["Quầy & vé"],
        summary: "Xác nhận đã thu tiền và cấp mã sáu số dùng một lần",
        security: loggedIn,
        parameters: [pathParam("id", "ID phiếu chờ thanh toán")],
        requestBody: body({
          paymentReceived: { type: "boolean", enum: [true] },
          paymentMethod: enumOf(["cash", "transfer"]),
          expectedTotal: int("Tổng tiền đã thu"),
        }, ["paymentReceived", "paymentMethod", "expectedTotal"]),
        responses: { ...ok("Đã cấp mã, hết hạn sau hai giờ", ref("Booking")), ...errors(400, 401, 403, 404, 409) },
      },
    },
    "/api/admin/tickets/quote": {
      post: {
        tags: ["Quầy & vé"],
        summary: "Báo giá gói chụp trước khi cấp mã",
        security: loggedIn,
        requestBody: body({ package: objectId }, ["package"]),
        responses: {
          ...ok(
            "Giá",
            object({
              total: { type: "integer" },
              discount: { type: "integer" },
            }),
          ),
          ...errors(400, 401),
        },
      },
    },
    "/api/admin/tickets": {
      post: {
        tags: ["Quầy & vé"],
        summary: "Cấp mã vé tại quầy (đã thu tiền)",
        description:
          "Trả về mã vé 6 số và `accessToken` (album của khách). Gửi lại cùng `requestKey` khi mất phản hồi sẽ nhận lại đúng vé cũ.",
        security: loggedIn,
        requestBody: body(
          {
            package: objectId,
            paymentMethod: enumOf(["cash", "transfer"]),
            paymentReceived: {
              type: "boolean",
              enum: [true],
              description: "Phải là true: đã nhận đủ tiền",
            },
            requestKey: uuid,
            name: str("Tên khách (bắt buộc)"),
            phone: str("SĐT Việt Nam của khách (bắt buộc)"),
            room: str(
              "Mã phòng gợi ý hoặc để trống (dùng phòng nào cũng được)",
            ),
            expectedTotal: int(
              "Giá lễ tân thấy — lệch giá hiện tại thì báo 409",
            ),
          },
          ["package", "paymentMethod", "paymentReceived", "requestKey", "name", "phone"],
          {
            package: "6ab5e9c5e82e4d5ba43b63be",
            paymentMethod: "cash",
            paymentReceived: true,
            requestKey: "0b6f1c1e-6d7a-4f55-9a43-2f1a3c5d7e90",
            name: "Chị Lan",
            phone: "0912345678",
            room: "",
          },
        ),
        responses: {
          ...ok(
            "Đã cấp mã",
            {
              allOf: [
                ref("Booking"),
                object({ accessToken: str("Mã truy cập album (48 ký tự)") }),
              ],
            },
            201,
          ),
          ...errors(400, 401, 409, 429),
        },
      },
    },
    "/api/admin/bookings": {
      get: {
        tags: ["Quầy & vé"],
        summary: "Danh sách đơn hàng (500 đơn mới nhất)",
        description:
          "Lễ tân không thấy tổng tiền.\n\n**Kiểm tra máy chụp có thấy ảnh máy ảnh không:** nhập `code` = mã vé đang chụp → xem `captureDiag`: `folder` (thư mục đang đọc), `jpegs` (số ảnh JPG thấy trong thư mục), `fresh` / `imported` (ảnh mới trong phiên / đã nhận), `access` (quyền đọc), `error` (lỗi đọc), `at` (lần báo gần nhất — máy chụp báo 2 giây/lần).",
        security: loggedIn,
        parameters: [
          query("code", "Mã vé 6 số", { type: "string", example: "518057" }),
          query("date", "Lọc theo ngày cấp", {
            type: "string",
            example: "2026-10-06",
          }),
          query("from", "Từ ngày", { type: "string", example: "2026-10-01" }),
          query("to", "Đến ngày", { type: "string", example: "2026-10-31" }),
          query("room", "Tên máy / phòng", { type: "string", example: "Phòng 01" }),
          query("paymentMethod", "Hình thức thanh toán", enumOf(["cash", "transfer"])),
          query(
            "status",
            "Lọc theo trạng thái",
            enumOf([
              "pending",
              "confirmed",
              "checked_in",
              "completed",
              "cancelled",
            ]),
          ),
        ],
        responses: { ...ok("Danh sách vé", list("Booking")), ...errors(401) },
      },
    },
    "/api/admin/bookings/{id}": {
      patch: {
        tags: ["Quầy & vé"],
        summary: "Đổi trạng thái vé (vd. hủy vé thử) / đánh dấu đã in",
        security: loggedIn,
        parameters: [pathParam("id", "Mã vé (_id)")],
        requestBody: body(
          {
            status: enumOf([
              "confirmed",
              "checked_in",
              "completed",
              "cancelled",
            ]),
            printed: { type: "boolean" },
          },
          [],
          { status: "cancelled" },
        ),
        responses: {
          ...ok("Đã cập nhật", ref("Booking")),
          ...errors(400, 401, 404, 409),
        },
      },
    },
    "/api/admin/bookings/{id}/prints": {
      post: {
        tags: ["Quầy & vé"],
        summary: "Bán thêm tờ in cho vé",
        description:
          "Số tiền = số tờ × giá bán thêm trong cài đặt; `expectedTotal` phải khớp.",
        security: loggedIn,
        parameters: [pathParam("id", "Mã vé (_id)")],
        requestBody: body(
          {
            sheets: int("Số tờ (1–20)", { minimum: 1, maximum: 20 }),
            paymentMethod: enumOf(["cash", "transfer"]),
            paymentReceived: { type: "boolean", enum: [true] },
            expectedTotal: int("Số tiền lễ tân thu"),
            requestKey: uuid,
          },
          [
            "sheets",
            "paymentMethod",
            "paymentReceived",
            "expectedTotal",
            "requestKey",
          ],
        ),
        responses: {
          ...ok("Đã cộng tờ in", ref("Booking")),
          ...errors(400, 401, 404, 409),
        },
      },
    },
    "/api/admin/bookings/{id}/reprint": {
      post: {
        tags: ["Quầy & vé"],
        summary: "In lại file ảnh đã ghép của một đơn hàng",
        description:
          "Tạo lệnh in mới từ file còn hạn của lệnh cũ; không trừ thêm hạn mức album.",
        security: loggedIn,
        parameters: [pathParam("id", "Mã đơn hàng (_id)")],
        requestBody: body(
          {
            jobId: str("Mã lệnh in nguồn"),
            copies: int("Số bản (1–20)", { minimum: 1, maximum: 20 }),
          },
          ["jobId", "copies"],
        ),
        responses: {
          ...ok("Lệnh in lại đã tạo"),
          ...errors(400, 401, 404),
        },
      },
    },
    "/api/admin/rooms/live": {
      get: {
        tags: ["Quầy & vé"],
        summary:
          "Bảng phòng: phòng nào trống, phòng nào đang chụp, còn bao lâu",
        security: loggedIn,
        responses: { ...ok("Bảng phòng"), ...errors(401) },
      },
    },
    "/api/admin/stats": {
      get: {
        tags: ["Quầy & vé"],
        summary: "Số liệu tổng quan (lễ tân không có doanh thu)",
        security: loggedIn,
        responses: { ...ok("Số liệu"), ...errors(401) },
      },
    },
    "/api/admin/stats/revenue": {
      get: {
        tags: ["Quầy & vé"],
        summary: "Doanh thu từng ngày trong tháng",
        description: adminOnly,
        security: loggedIn,
        parameters: [query("month", "Tháng (mặc định tháng này)", month)],
        responses: { ...ok("Doanh thu"), ...errors(400, 401, 403) },
      },
    },

    // ── Máy chụp ──
    "/api/print-agent/claim": {
      post: {
        tags: ["Máy in tại tiệm"],
        summary: "Máy in tại tiệm (Windows / Mac) nhận một lệnh in thuộc chi nhánh",
        description: "Dùng Authorization: Bearer PRINT_AGENT_TOKEN; mỗi lệnh được cấp một lease 5 phút.",
        requestBody: body({ branch: str("Chi nhánh đặt máy in") }, ["branch"]),
        responses: { ...ok("Lệnh in hoặc job: null"), ...errors(400, 403) },
      },
    },
    "/api/print-agent/jobs/{id}/sheets/{index}": {
      get: {
        tags: ["Máy in tại tiệm"],
        summary: "Tải một tờ in trong lease hiện tại",
        parameters: [pathParam("id", "ID lệnh in"), pathParam("index", "Số thứ tự tờ", { type: "integer" })],
        responses: { ...ok("Dữ liệu PNG/JPEG"), ...errors(400, 403, 404) },
      },
    },
    "/api/print-agent/jobs/{id}/complete": {
      post: {
        tags: ["Máy in tại tiệm"],
        summary: "Báo kết quả gửi vào hàng đợi máy in (Windows / CUPS trên Mac)",
        parameters: [pathParam("id", "ID lệnh in")],
        requestBody: body({ leaseId: uuid, sent: bool("Đã gửi thành công"), message: str("Lỗi nếu thất bại") }, ["leaseId", "sent"]),
        responses: { ...ok("Trạng thái spool"), ...errors(400, 403, 409) },
      },
    },
    "/api/kiosk/sale": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Khách mua lượt chụp ngay tại máy (đút tiền) hoặc bỏ qua trả tiền ở chế độ thử",
        description: "Chỉ phòng photobooth (kind = photobooth), chỉ gói tờ bé / tờ to (không bán gói Instax); skip = true cần thêm Chế độ thử (paymentTest). " +
          "prints: số tờ 10 × 15 khách chọn (khổ nhỏ: 1 tờ cắt đôi = 2 tờ nhỏ), tối thiểu 2 tờ nhỏ hoặc 2 tờ lớn; " +
          "tờ vượt số tờ của gói tính theo giá in thêm. bills: các tờ tiền máy nhận tiền đã nhận; tổng phải ≥ giá gói + tờ in thêm " +
          "(409 nếu expectedTotal khác giá máy chủ và chưa đủ tiền). Gửi lại cùng requestKey trả đúng lượt chụp đã tạo.",
        requestBody: body({
          device: str("Mã máy chụp của phòng"),
          package: str("ID gói chụp"),
          requestKey: uuid,
          skip: bool("Bỏ qua trả tiền (chế độ thử, không tính doanh thu)"),
          bills: { type: "array", items: object({ amount: int("Mệnh giá (VND)"), at: str("Thời điểm nhận (ISO)") }, ["amount"]) },
          prints: int("Số tờ 10 × 15 khách chọn; không gửi = mức tối thiểu của gói"),
          expectedTotal: int("Tổng tiền máy chụp đang hiển thị"),
        }, ["device", "package", "requestKey"]),
        responses: { ...ok("Lượt chụp đã mở: { booking, accessToken, captureToken, flip }", { type: "object" }, 201), ...errors(400, 403, 409, 429) },
      },
    },
    "/api/kiosk/polaroid": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Phòng Polaroid: khách chọn layout rồi vào chụp luôn (trả tiền ở quầy)",
        description: "Chỉ phòng kind = polaroid, package là gói khổ Instax (layout). Đơn ghi source = polaroid, paid = false; " +
          "nhân viên ghi nhận đã thu bằng PATCH /api/admin/bookings/{id} { collected: cash | transfer }. " +
          "Gửi lại cùng requestKey trả đúng lượt chụp đã tạo.",
        requestBody: body({
          device: str("Mã máy chụp của phòng"),
          package: str("ID gói khổ Instax (layout)"),
          requestKey: uuid,
        }, ["device", "package", "requestKey"]),
        responses: { ...ok("Lượt chụp đã mở: { booking, accessToken, captureToken, flip }", { type: "object" }, 201), ...errors(400, 403, 409, 429) },
      },
    },
    "/api/kiosk/video": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Gửi video tua nhanh của lượt chụp (thay video cũ nếu gửi lại)",
        description: "Thân là tệp video/webm hoặc video/mp4 (≤ 60 MB); header X-Capture-Token là mã phiên chụp.",
        parameters: [{ name: "X-Capture-Token", in: "header", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "video/webm": { schema: { type: "string", format: "binary" } },
            "video/mp4": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: { ...ok("Đã lưu", { type: "object" }, 201), ...errors(400, 401, 403, 409, 413) },
      },
    },
    "/api/kiosk/video/upload-url": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Xin URL tải video tua nhanh thẳng lên kho R2",
        description:
          "Chỉ có khi kho ảnh là R2 (kho MongoDB trả 404 — máy chụp gửi qua POST /api/kiosk/video). URL hết hạn sau 15 phút " +
          "và chỉ nhận đúng loại, đúng kích thước đã xin. Tải lên xong gọi POST /api/kiosk/video/commit với `stored`.",
        requestBody: body(
          { captureToken: str("Mã phiên chụp"), type: enumOf(["video/mp4", "video/webm"]), size: int("Số byte (≤ 60 MB)") },
          ["captureToken", "type", "size"],
        ),
        responses: {
          ...ok("{ upload: { url, stored } }", { type: "object" }),
          ...errors(400, 401, 404, 409),
        },
      },
    },
    "/api/kiosk/video/commit": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Báo đã tải video lên kho: máy chủ kiểm tra rồi gắn vào album (thay video cũ)",
        description:
          "`stored` lấy từ /api/kiosk/video/upload-url của đúng phiên chụp. Tệp chưa có trên kho, quá 60 MB hoặc mã không khớp phiên " +
          "thì trả 422 — máy chụp gửi video qua POST /api/kiosk/video.",
        requestBody: body({ captureToken: str("Mã phiên chụp"), stored: str("Mã tệp đã tải lên") }, ["captureToken", "stored"]),
        responses: { ...ok("{ ok, size }", { type: "object" }, 201), ...errors(400, 401, 409, 422) },
      },
    },
    "/api/kiosk/composite": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Gửi ảnh đã ghép khung của lượt chụp vào album (thay ảnh cũ nếu gửi lại)",
        description:
          "Thân là ảnh image/jpeg (≤ 20 MB, cạnh dài ≤ 6000 px) — bản chất lượng in máy chụp ghép sau khi khách chọn khung; " +
          "khách xem / tải ở /api/albums/{token}/composite kể cả khi gói không kèm tờ in. Header X-Capture-Token là mã phiên " +
          "chụp, X-Frame-Name (tùy chọn, encodeURIComponent) là tên chủ đề / khung (tính vào xếp hạng chủ đề).",
        parameters: [
          { name: "X-Capture-Token", in: "header", required: true, schema: { type: "string" } },
          { name: "X-Frame-Name", in: "header", required: false, schema: { type: "string" } },
        ],
        requestBody: { required: true, content: { "image/jpeg": { schema: { type: "string", format: "binary" } } } },
        responses: { ...ok("{ ok, width, height }", { type: "object" }, 201), ...errors(400, 401, 403, 409, 413) },
      },
    },
    "/api/kiosk/ping": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Máy chụp báo còn mở (mỗi phút), nhận tên phòng, chế độ lật ảnh và loại phòng",
        description: "kind là loại phòng: photobooth (Chạm → Nhập mã / Tiền mặt, in DNP), polaroid (Chạm → chọn layout → chụp, trả tiền ở quầy, in Instax). " +
          "cashCheckoutReady = máy chủ nhận bán lượt chụp bằng tiền mặt tại máy cho phòng này.",
        requestBody: body({ device: str("Mã máy chụp của phòng") }, ["device"]),
        responses: { ...ok("{ room: { _id, name, branch, flip, kind, paymentTest, cashCheckoutReady, printers } }"), ...errors(400, 403) },
      },
    },
    "/api/kiosk/claim": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Khách nhập mã vé ở máy chụp",
        description:
          "`device` lấy từ POST /api/admin/rooms/{id}/device. Vé đã chụp xong thì trả `completed: true` để hiện lại QR. " +
          "Mã do nhân viên tạo ở quầy sau khi khách chuyển khoản; gói chụp, khổ ảnh và số tờ in lấy từ vé đó. Nhập đúng là vào chụp luôn.",
        requestBody: body(
          {
            code: str("Mã vé 6 số", { pattern: "^\\d{6}$" }),
            device: str("Mã máy chụp của phòng"),
          },
          ["code", "device"],
          { code: "123456", device: "" },
        ),
        responses: {
          ...ok(
            "Mã hợp lệ",
            object({
              booking: ref("Booking"),
              accessToken: { type: "string" },
              captureToken: { type: "string" },
              completed: { type: "boolean" },
            }),
          ),
          ...errors(400, 403, 409, 429),
        },
      },
    },
    "/api/kiosk/start": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Bắt đầu tính giờ chụp",
        description:
          "Khách chỉ chụp bằng nút chụp / remote của máy ảnh: ảnh gốc về thư mục X Acquire, máy chụp đọc rồi gửi lên bằng POST /api/kiosk/photo.",
        requestBody: body({ captureToken }, ["captureToken"]),
        responses: {
          ...ok("Đã bắt đầu", object({ booking: ref("Booking") })),
          ...errors(401, 403, 409),
        },
      },
    },
    "/api/kiosk/state": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Máy chụp báo còn hoạt động (2 giây/lần) + tình trạng",
        requestBody: body(
          {
            captureToken,
            diag: object({
              mode: { type: "string" },
              camera: str("Tên camera live view"),
              cameras: str("Các camera máy tính thấy"),
              cameraError: str("Lỗi mở hình trực tiếp gần nhất"),
              folder: str("Thư mục ảnh máy ảnh đang đọc"),
              access: str("Quyền đọc thư mục: granted / prompt"),
              jpegs: int("Số ảnh JPG thấy trong thư mục"),
              raws: int("Số tệp RAW"),
              fresh: int("Ảnh JPG mới xuất hiện trong phiên"),
              imported: int("Ảnh đã nhận vào phiên"),
              scans: int("Số lượt quét"),
              newest: str("Tệp mới nhất thấy được"),
              newestAt: { type: "number" },
              error: str("Lỗi đọc thư mục gần nhất"),
            }),
          },
          ["captureToken"],
        ),
        responses: {
          ...ok(
            "Trạng thái phiên",
            object({
              booking: ref("Booking"),
            }),
          ),
          ...errors(401, 403, 409),
        },
      },
    },
    "/api/kiosk/photo/upload-url": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Xin URL tải ảnh gốc thẳng lên R2",
        description: "Chỉ khi kho ảnh là R2 (khác: 404). Phiên phải còn giờ chụp (409). URL ký cho đúng một khóa, image/jpeg và đúng size byte.",
        requestBody: body({ captureToken, clientKey: str("Mã riêng của ảnh (8–160 ký tự)"), size: int("Số byte ảnh gốc đã bỏ metadata (≤ 40 MB)") },
          ["captureToken", "clientKey", "size"]),
        responses: { ...uploadUrlResponse, ...errors(400, 401, 404, 409) },
      },
    },
    "/api/kiosk/photo": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Gửi một ảnh vừa chụp",
        description:
          "Gửi trực tiếp file JPEG/PNG/WebP (tối đa 40 MB) với các header X-Photo-Key và X-Capture-Token; vẫn nhận JSON base64 của kiosk cũ. Gửi lại cùng mã không bị trùng ảnh. Hết giờ chụp thì báo 409.",
        parameters: photoHeaders(true),
        requestBody: photoBody(
          {
            captureToken,
            image: imageData,
            clientKey: str("Mã riêng của ảnh (8–160 ký tự)"),
          },
          ["captureToken", "image", "clientKey"],
        ),
        responses: {
          ...ok("Ảnh đã lưu", ref("Booking")),
          ...errors(400, 401, 409),
        },
      },
    },
    "/api/kiosk/finish": {
      post: {
        tags: ["Máy chụp (kiosk)"],
        summary: "Kết thúc phiên chụp",
        requestBody: body({ captureToken }, ["captureToken"]),
        responses: {
          ...ok("Đã kết thúc", ref("Booking")),
          ...errors(401, 409),
        },
      },
    },

    // ── Album khách ──
    "/api/albums/{token}": {
      get: {
        tags: ["Album khách"],
        summary: "Thông tin album",
        parameters: [tokenParam],
        responses: { ...ok("Album", ref("Booking")), ...errors(404) },
      },
    },
    "/api/albums/{token}/photos/upload-url": {
      post: {
        tags: ["Album khách"],
        summary: "Xin URL tải ảnh gốc thẳng lên R2 (máy chụp gửi nốt ảnh sau buổi chụp)",
        description: "Như /api/kiosk/photo/upload-url nhưng cho album đã chụp xong; gửi xác nhận tới POST /api/albums/{token}/photos.",
        parameters: [tokenParam],
        requestBody: body({ clientKey: str("Mã riêng của ảnh (8–160 ký tự)"), size: int("Số byte ảnh gốc (≤ 40 MB)") }, ["clientKey", "size"]),
        responses: { ...uploadUrlResponse, ...errors(400, 404, 409) },
      },
    },
    "/api/albums/{token}/photos/{photo}": {
      get: {
        tags: ["Album khách"],
        summary: "Tải một ảnh (JPEG)",
        parameters: [
          tokenParam,
          pathParam("photo", "Mã ảnh"),
          query(
            "size",
            "thumbnail: ảnh nhỏ thư viện (640 px); preview: ảnh xem khi chỉnh (1600 px); print: nguồn in 3000 px, màu đầy đủ 4:4:4 (ảnh có printSource); mặc định: ảnh gốc của máy ảnh. Ảnh cũ thiếu bản nào thì trả ảnh gốc.",
            enumOf(["thumbnail", "preview", "print", "full"]),
          ),
        ],
        responses: {
          200: {
            description: "Ảnh",
            content: {
              "image/jpeg": { schema: { type: "string", format: "binary" } },
            },
          },
          ...errors(404),
        },
      },
    },
    "/api/albums/{token}/photos": {
      post: {
        tags: ["Album khách"],
        summary: "Máy chụp gửi bổ sung ảnh vào album (ảnh còn kẹt do mất mạng, gửi sau khi chụp xong)",
        description: "Ưu tiên gửi file JPEG/PNG/WebP trực tiếp (tối đa 40 MB) với X-Photo-Key, X-Photo-Name; JSON base64 cũ vẫn được hỗ trợ.",
        parameters: [tokenParam, ...photoHeaders()],
        requestBody: photoBody(
          {
            image: imageData,
            clientKey: str("Mã riêng của ảnh (8–160 ký tự)"),
            name: str("Tên tệp gốc"),
          },
          ["image", "clientKey"],
        ),
        responses: {
          ...ok("Đã thêm", ref("Booking"), 201),
          ...errors(400, 404, 409),
        },
      },
    },
    "/api/albums/{token}/download": {
      get: {
        tags: ["Album khách"],
        summary: "Tải tất cả ảnh gốc (ZIP)",
        parameters: [tokenParam],
        responses: {
          200: {
            description: "Tệp ZIP",
            content: {
              "application/zip": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...errors(404),
        },
      },
    },
    "/api/albums/{token}/print": {
      get: {
        tags: ["Album khách"],
        summary: "Lệnh in gần nhất của album",
        parameters: [
          tokenParam,
          query(
            "requestKey",
            "Tìm đúng yêu cầu khi mất phản hồi; bỏ trống để xem lệnh gần nhất",
            uuid,
          ),
        ],
        responses: {
          ...ok("Lệnh in kèm số tờ trên vé, hoặc null nếu chưa có yêu cầu"),
          ...errors(400, 404),
        },
      },
    },
    "/api/albums/{token}/prints/{job}": {
      get: {
        tags: ["Album khách"],
        summary: "Ảnh một tờ in (JPEG)",
        parameters: [
          tokenParam,
          pathParam("job", "Mã lệnh in"),
          query("sheet", "Tờ thứ mấy (từ 0)", { type: "integer", default: 0 }),
          query("download", "1 = tải về", { type: "string", enum: ["1"] }),
          query(
            "size",
            "thumbnail = bản xem trước nhỏ (cạnh dài 512 px) cho hàng chờ in; mặc định là tờ đầy đủ 1181 × 1772 px.",
            enumOf(["thumbnail"]),
          ),
        ],
        responses: {
          200: {
            description: "Tờ in",
            content: {
              "image/jpeg": { schema: { type: "string", format: "binary" } },
            },
          },
          ...errors(404),
        },
      },
    },
    "/api/albums/{token}/print-pack": {
      post: {
        tags: ["Album khách"],
        summary: "Gửi in các tờ đã ghép khung",
        description:
          "Trừ vào số tờ in của vé. Thử lại bằng cùng requestKey và đúng ảnh/thứ tự/tên bộ sẽ trả về lệnh cũ, không trừ thêm tờ. Cùng mã nhưng khác nội dung bị từ chối (409). Tối đa 10 lần / 10 phút mỗi album.\n\n**Nên gửi nhị phân** (nhỏ hơn base64 khoảng 1/4): `Content-Type: application/octet-stream`, thân là các tờ PNG/JPEG nối liền theo thứ tự, header `X-Print-Sheets` = số byte từng tờ cách nhau dấu phẩy, `X-Print-Key` = requestKey, `X-Print-Frame` = tên bộ (encodeURIComponent). JSON data URL cũ vẫn nhận; hai cách được nhận diện như nhau khi gửi lại.",
        parameters: [
          tokenParam,
          { name: "X-Print-Key", in: "header", required: false, description: "Khi gửi nhị phân: mã yêu cầu (UUID) chống in trùng.", schema: uuid },
          { name: "X-Print-Frame", in: "header", required: false, description: "Khi gửi nhị phân: tên bộ khung, mã hóa encodeURIComponent (tối đa 100 ký tự).", schema: { type: "string" } },
          { name: "X-Print-Sheets", in: "header", required: false, description: "Khi gửi nhị phân: số byte của từng tờ theo thứ tự, ví dụ 3145728,2981234 (1–100 tờ, mỗi tờ ≤ 9 MB).", schema: { type: "string" } },
        ],
        requestBody: (() => {
          const request = body(
            {
              images: { type: "array", items: imageData, minItems: 1 },
              frameName: { type: "string" },
              requestKey: uuid,
            },
            ["images", "frameName", "requestKey"],
          );
          request.content["application/octet-stream"] = { schema: { type: "string", format: "binary" } };
          return request;
        })(),
        responses: { ...ok("Đã gửi in"), ...errors(400, 404, 409, 429) },
      },
    },

    "/api/admin/frames/{id}/move": {
      post: {
        tags: ["Danh mục"],
        summary: "Đổi thứ tự khung lên trước hoặc xuống sau trong bộ",
        description:
          "Chỉ quản trị viên. expectedIds là toàn bộ ID trong bộ theo thứ tự hiện tại, gồm khung đã tắt. Danh sách cũ hoặc lẫn bộ bị từ chối (409). Thành công trả danh mục đầy đủ với thứ tự đã lưu.",
        security: loggedIn,
        parameters: [pathParam("id", "ID khung")],
        requestBody: body(
          {
            direction: { type: "string", enum: ["up", "down"] },
            expectedIds: {
              type: "array",
              items: objectId,
              minItems: 1,
              maxItems: 1000,
            },
          },
          ["direction", "expectedIds"],
        ),
        responses: {
          ...ok("Danh mục khung sau khi đổi thứ tự"),
          ...errors(400, 401, 403, 404, 409),
        },
      },
    },
    // ── In ảnh ──
    "/api/admin/print-jobs": {
      get: {
        tags: ["In ảnh"],
        summary: "Hàng đợi in",
        security: loggedIn,
        parameters: [
          query(
            "status",
            "Lọc theo trạng thái",
            enumOf(["pending", "printed"]),
          ),
        ],
        responses: {
          ...ok("Danh sách lệnh in", {
            type: "array",
            items: { type: "object" },
          }),
          ...errors(401),
        },
      },
    },
    "/api/admin/print-jobs/stream": {
      get: {
        tags: ["In ảnh"],
        summary: "Luồng sự kiện khi có lệnh in mới (Server-Sent Events)",
        security: loggedIn,
        responses: {
          200: { description: "text/event-stream" },
          ...errors(401),
        },
      },
    },
    "/api/admin/print-jobs/{id}": {
      parameters: [pathParam("id", "Mã lệnh in")],
      patch: {
        tags: ["In ảnh"],
        summary: "Đánh dấu đã in / chưa in",
        security: loggedIn,
        requestBody: body({ status: enumOf(["pending", "printed"]) }, [
          "status",
        ]),
        responses: { ...ok("Đã cập nhật"), ...errors(400, 401, 404) },
      },
      delete: {
        tags: ["In ảnh"],
        summary: "Hủy lệnh in (trả lại tờ cho vé nếu chưa in)",
        security: loggedIn,
        responses: { ...ok("Đã hủy"), ...errors(401, 404) },
      },
    },

    "/api/admin/storage": {
      get: {
        tags: ["In ảnh"],
        summary: "Dung lượng lưu ảnh cho Trợ lí Minh",
        description:
          "Lễ tân và quản trị được xem. Chỉ đọc metadata GridFS/R2, dbStats và atlasSize, không tải ảnh hoặc tự xóa. R2 liệt kê trong R2_PREFIX và cache tối đa 30 giây, báo quota riêng bằng GB thập phân. MongoDB giữ quota toàn cluster bằng MB = 1024² byte; mặc định 512 MB. Khi kho R2 lỗi, media.available=false; không coi dung lượng chưa biết là 0.",
        security: loggedIn,
        responses: {
          ...ok("Dung lượng", ref("StorageSummary")),
          ...errors(401),
        },
      },
    },
    "/api/admin/storage/limit": {
      put: {
        tags: ["In ảnh"],
        summary: "Lưu giới hạn dung lượng toàn cluster Atlas",
        description: `${adminOnly} Nhập số MB dương hoặc null để bỏ giới hạn. Lưu ở Setting media-storage, độc lập cài đặt studio. Giới hạn dùng cho cảnh báo, không tự chặn upload hoặc xóa ảnh.`,
        security: loggedIn,
        requestBody: body(
          {
            limitMB: {
              type: "number",
              nullable: true,
              minimum: 0,
              exclusiveMinimum: true,
              maximum: Number.MAX_SAFE_INTEGER / 1048576,
            },
          },
          ["limitMB"],
          { limitMB: null },
        ),
        responses: {
          ...ok("Đã lưu giới hạn", ref("StorageSummary")),
          ...errors(400, 401, 403),
        },
      },
    },
    "/api/admin/storage/r2-limit": {
      put: {
        tags: ["In ảnh"],
        summary: "Đặt mức cảnh báo riêng cho kho ảnh R2",
        description: `${adminOnly} GB = 1.000.000.000 byte. null bỏ mức cảnh báo. Không đổi quota MongoDB, gói R2 hoặc chặn upload. Thống kê đọc metadata tệp trong R2_PREFIX, không tải ảnh.`,
        security: loggedIn,
        requestBody: body(
          {
            limitGB: {
              type: "number",
              nullable: true,
              minimum: 0,
              exclusiveMinimum: true,
            },
          },
          ["limitGB"],
          { limitGB: 10 },
        ),
        responses: {
          ...ok("Đã lưu mức cảnh báo R2", ref("StorageSummary")),
          ...errors(400, 401, 403),
        },
      },
    },
    "/api/admin/storage/cleanup-expired": {
      post: {
        tags: ["In ảnh"],
        summary: "Dọn ngay ảnh và lệnh in đã hết hạn",
        description: `${adminOnly} Dùng cùng purgeExpiredMedia với lịch dọn tự động. Không xóa ảnh hoặc lệnh in còn hạn, giữ thông tin vé/doanh thu. freedBytes là mức giảm byte nội dung media thực đo; dung lượng database/nhà cung cấp có thể giảm khác.`,
        security: loggedIn,
        responses: {
          ...ok(
            "Đã dọn",
            object({
              freedBytes: int("Tổng byte media giảm sau khi dọn", {
                minimum: 0,
              }),
              summary: ref("StorageSummary"),
            }),
          ),
          ...errors(401, 403),
        },
      },
    },

    // ── Danh mục & cài đặt ──
    ...resourcePaths,
    "/api/admin/rooms/{id}/device": {
      post: {
        tags: ["Danh mục & cài đặt"],
        summary:
          "Lấy mã máy chụp (device) của phòng — dùng cho liên kết Cài kiosk",
        description:
          "Lễ tân (staff, quyền Cài máy chụp) và quản trị đã đăng nhập có thể mở/cài kiosk cho phòng đang hoạt động. Mã có hạn 1 năm; phòng đã tắt không thể cấp mã mới hoặc dùng mã cũ để nhận vé. " +
          "Loại phòng (photobooth / polaroid) chọn lúc thêm phòng, không đổi ở đây; `paymentTest` bật / tắt chế độ thử đút tiền của phòng photobooth (không gửi = giữ nguyên).",
        security: loggedIn,
        parameters: [pathParam("id", "Mã phòng")],
        requestBody: body({ paymentTest: { type: "boolean" } }, []),
        responses: {
          ...ok(
            "Mã máy chụp",
            object({
              token: { type: "string" },
              name: { type: "string" },
              kind: enumOf(["photobooth", "polaroid"]),
              paymentTest: { type: "boolean" },
            }),
          ),
          ...errors(400, 401, 403, 404, 409),
        },
      },
    },
    "/api/admin/settings/kiosk": {
      put: {
        tags: ["Danh mục & cài đặt"],
        summary: "Lưu màn hình chờ của máy chụp (Tap to start)",
        description: adminOnly,
        security: loggedIn,
        requestBody: body({
          idleTitle: str("Dòng chữ lớn, để trống = “Tap to start”"),
          idleSubtitle: str("Dòng chữ nhỏ bên dưới"),
          idleImage: str("Ảnh nền PNG/JPG/WebP dạng data URL, \"\" để bỏ ảnh"),
        }, []),
        responses: { ...ok("Đã lưu", ref("Settings")), ...errors(400, 401, 403) },
      },
    },
    "/api/admin/shifts": {
      get: {
        tags: ["Quầy & vé"],
        summary: "Ca trực đang mở và 20 ca gần nhất",
        description: "Lễ tân xem chi nhánh được phân công; quản trị chọn ?branch=.",
        security: loggedIn,
        parameters: [query("branch", "Chi nhánh (chỉ quản trị)", { type: "string" })],
        responses: { ...ok("Ca trực"), ...errors(401, 403) },
      },
    },
    "/api/admin/shifts/open": {
      post: {
        tags: ["Quầy & vé"],
        summary: "Mở ca",
        description: "Mỗi chi nhánh chỉ một ca đang mở (409 nếu đã có).",
        security: loggedIn,
        requestBody: body({
          branch: str("Chi nhánh (quản trị bắt buộc chọn; lễ tân bỏ qua)"),
          openingCash: int("Tiền mặt đầu ca (VND)"),
        }, []),
        responses: { ...ok("Đã mở ca", { type: "object" }, 201), ...errors(400, 401, 403, 404, 409) },
      },
    },
    "/api/admin/shifts/{id}/close": {
      post: {
        tags: ["Quầy & vé"],
        summary: "Đóng ca",
        description: "Chốt số vé, tiền mặt và chuyển khoản đã thu trong ca.",
        security: loggedIn,
        parameters: [pathParam("id", "Mã ca trực")],
        requestBody: body({
          closingCash: int("Tiền mặt đếm được cuối ca (VND)"),
          note: str("Ghi chú"),
        }, ["closingCash"]),
        responses: { ...ok("Đã đóng ca"), ...errors(400, 401, 403, 404) },
      },
    },
    "/api/admin/shifts/report": {
      get: {
        tags: ["Quầy & vé"],
        summary: "Đối soát theo tháng: các ca đã đóng và tiền đã thu từng chi nhánh",
        description: "Cần quyền xem doanh thu (quản trị hoặc nhân viên được cấp revenue:view, chỉ chi nhánh của mình).",
        security: loggedIn,
        parameters: [
          query("month", "Tháng (mặc định tháng này)", month),
          query("branch", "Chi nhánh (chỉ quản trị)", { type: "string" }),
        ],
        responses: { ...ok("Bảng đối soát"), ...errors(400, 401, 403) },
      },
    },
    "/api/admin/stats/summary": {
      get: {
        tags: ["Quầy & vé"],
        summary: "Tổng hợp: doanh thu thực nhận, số đơn so với kỳ trước, tiền mặt / chuyển khoản, xếp hạng chủ đề, gói, máy",
        description: "Không có quyền xem doanh thu thì chỉ trả số lượt.",
        security: loggedIn,
        parameters: [
          query("from", "Từ ngày (YYYY-MM-DD, mặc định hôm nay)", { type: "string", format: "date" }),
          query("to", "Đến ngày (YYYY-MM-DD)", { type: "string", format: "date" }),
          query("branch", "Chi nhánh (quản trị; lễ tân luôn là chi nhánh được phân công)", { type: "string" }),
          query("room", "Tên máy / phòng", { type: "string" }),
        ],
        responses: { ...ok("Tổng hợp"), ...errors(400, 401, 403) },
      },
    },
    "/api/admin/stats/chart": {
      get: {
        tags: ["Quầy & vé"],
        summary: "Thống kê doanh thu: doanh thu & số đơn theo ngày (≤ 62 ngày) hoặc theo tháng, kèm kỳ so sánh",
        description: "Cần quyền xem doanh thu.",
        security: loggedIn,
        parameters: [
          query("from", "Từ ngày (YYYY-MM-DD, mặc định hôm nay)", { type: "string", format: "date" }),
          query("to", "Đến ngày (YYYY-MM-DD)", { type: "string", format: "date" }),
          query("branch", "Chi nhánh (quản trị; lễ tân luôn là chi nhánh được phân công)", { type: "string" }),
          query("room", "Tên máy / phòng", { type: "string" }),
        ],
        responses: { ...ok("Chuỗi số liệu"), ...errors(400, 401, 403) },
      },
    },
    "/api/admin/screens": {
      get: {
        tags: ["Danh mục & cài đặt"],
        summary: "Màn hình chờ: cấu hình chung và cấu hình riêng từng máy",
        description: adminOnly + " Lần đầu tự tạo cấu hình chung từ màn hình chờ cũ.",
        security: loggedIn,
        responses: { ...ok("Danh sách", { type: "array", items: { type: "object" } }), ...errors(401, 403) },
      },
      post: {
        tags: ["Danh mục & cài đặt"],
        summary: "Thêm cấu hình màn hình chờ riêng cho một số máy",
        description: adminOnly,
        security: loggedIn,
        requestBody: { required: true, ...json(ref("ScreenInput")) },
        responses: { ...ok("Danh sách sau khi lưu"), ...errors(400, 401, 403) },
      },
    },
    "/api/admin/screens/{id}": {
      parameters: [pathParam("id", "Mã màn hình chờ")],
      put: {
        tags: ["Danh mục & cài đặt"],
        summary: "Sửa màn hình chờ (ảnh giữ lại gửi { _id }, ảnh mới gửi { data })",
        description: adminOnly,
        security: loggedIn,
        requestBody: { required: true, ...json(ref("ScreenInput")) },
        responses: { ...ok("Danh sách sau khi lưu"), ...errors(400, 401, 403, 404, 409) },
      },
      delete: {
        tags: ["Danh mục & cài đặt"],
        summary: "Xóa cấu hình riêng (không xóa được cấu hình chung)",
        description: adminOnly,
        security: loggedIn,
        responses: { ...ok("Danh sách còn lại"), ...errors(400, 401, 403, 404, 409) },
      },
    },
    "/api/admin/themes": {
      get: {
        tags: ["Danh mục & cài đặt"],
        summary: "Chủ đề (bộ khung): loại hình chụp (photobooth / polaroid), số khung, số ô ảnh, trạng thái, thứ tự",
        description: adminOnly,
        security: loggedIn,
        responses: { ...ok("Danh sách", { type: "array", items: { type: "object" } }), ...errors(401, 403) },
      },
      post: {
        tags: ["Danh mục & cài đặt"],
        summary: "Thêm chủ đề (chưa có khung)",
        description: adminOnly,
        security: loggedIn,
        requestBody: body({
          name: str("Tên chủ đề"),
          kind: { type: "string", enum: ["photobooth", "polaroid"], description: "Chủ đề của phòng Photobooth (mặc định) hay phòng Polaroid" },
        }, ["name"]),
        responses: { ...ok("Danh sách", { type: "array", items: { type: "object" } }, 201), ...errors(400, 401, 403, 409) },
      },
      put: {
        tags: ["Danh mục & cài đặt"],
        summary: "Đổi tên chủ đề (đổi luôn tên bộ của các khung) hoặc bật / tắt hiển thị với khách",
        description: adminOnly,
        security: loggedIn,
        requestBody: body({ name: str("Tên hiện tại"), newName: str("Tên mới"), active: bool("Hiện cho khách") }, ["name"]),
        responses: { ...ok("Danh sách"), ...errors(400, 401, 403, 404, 409) },
      },
    },
    "/api/admin/themes/order": {
      put: {
        tags: ["Danh mục & cài đặt"],
        summary: "Sắp xếp thứ tự chủ đề khách thấy",
        description: adminOnly,
        security: loggedIn,
        requestBody: body({ names: { type: "array", items: { type: "string" } } }, ["names"]),
        responses: { ...ok("Danh sách"), ...errors(400, 401, 403, 409) },
      },
    },
    "/api/admin/themes/{name}": {
      delete: {
        tags: ["Danh mục & cài đặt"],
        summary: "Xóa chủ đề (khung trong chủ đề thành khung lẻ, không bị xóa)",
        description: adminOnly,
        security: loggedIn,
        parameters: [pathParam("name", "Tên chủ đề", { type: "string" })],
        responses: { ...ok("Danh sách còn lại"), ...errors(400, 401, 403, 404) },
      },
    },
    "/api/admin/settings/custom-filters": {
      put: {
        tags: ["Danh mục & cài đặt"],
        summary: "Lưu các filter tiệm tự tạo (độ sáng, tương phản, bão hòa, sepia %, xoay màu độ)",
        description: adminOnly,
        security: loggedIn,
        requestBody: body({ customFilters: { type: "array", items: { type: "object" } } }, ["customFilters"]),
        responses: { ...ok("Cài đặt", ref("Settings")), ...errors(400, 401, 403) },
      },
    },
    "/api/admin/settings": {
      get: {
        tags: ["Danh mục & cài đặt"],
        summary: "Cài đặt tiệm",
        description: adminOnly,
        security: loggedIn,
        responses: { ...ok("Cài đặt", ref("Settings")), ...errors(401, 403) },
      },
      put: {
        tags: ["Danh mục & cài đặt"],
        summary: "Lưu cài đặt tiệm",
        description: adminOnly,
        security: loggedIn,
        requestBody: { required: true, ...json(ref("Settings")) },
        responses: {
          ...ok("Đã lưu", ref("Settings")),
          ...errors(400, 401, 403),
        },
      },
    },
  },
};
