import { z } from "zod";

// Tên trường hiển thị cho người dùng trong thông báo lỗi.
const LABELS = {
  name: "Tên",
  email: "Email",
  password: "Mật khẩu",
  current: "Mật khẩu hiện tại",
  role: "Vai trò",
  active: "Trạng thái",
  phone: "Số điện thoại",
  code: "Mã vé",
  room: "Phòng chụp",
  package: "Gói chụp",
  paymentMethod: "Hình thức thanh toán",
  price: "Giá",
  duration: "Thời gian chụp",
  prints: "Số tờ in",
  shots: "Số lần chụp",
  sheets: "Số tờ in thêm",
  extraPrintPrice: "Giá in thêm mỗi tờ",
  description: "Mô tả",
  branch: "Chi nhánh / địa chỉ",
  image: "Ảnh",
  images: "Ảnh",
  slots: "Ô đặt ảnh",
  themeName: "Tên bộ chủ đề",
  order: "Thứ tự trong bộ",
  printSize: "Kích thước khung",
  address: "Địa chỉ",
  bank: "Tên ngân hàng",
  bankAccount: "Số tài khoản",
  bankOwner: "Chủ tài khoản",
  bankQrImage: "Ảnh QR chuyển khoản",
  ids: "Danh sách ảnh",
  frameName: "Tên khung",
  status: "Trạng thái",
  printed: "Trạng thái in",
  date: "Ngày",
  video: "Video",
  month: "Tháng",
};
// Trường kỹ thuật: không nêu tên, chỉ báo yêu cầu không hợp lệ.
const INTERNAL = new Set([
  "captureToken",
  "clientKey",
  "requestKey",
  "device",
  "sessionId",
  "expectedTotal",
]);

const isNumber = (origin) => ["number", "int", "bigint"].includes(origin);

z.config({
  ...z.locales.vi(),
  customError: (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return issue.input === undefined ||
          issue.input === null ||
          issue.input === ""
          ? "không được để trống"
          : "sai kiểu dữ liệu";
      case "too_small":
        if (issue.origin === "string")
          return Number(issue.minimum) <= 1
            ? "không được để trống"
            : `tối thiểu ${issue.minimum} ký tự`;
        if (isNumber(issue.origin))
          return issue.inclusive
            ? `phải từ ${issue.minimum} trở lên`
            : `phải lớn hơn ${issue.minimum}`;
        if (issue.origin === "array") return `cần ít nhất ${issue.minimum} mục`;
        return undefined;
      case "too_big":
        if (issue.origin === "string") return `tối đa ${issue.maximum} ký tự`;
        if (isNumber(issue.origin)) return `tối đa ${issue.maximum}`;
        if (issue.origin === "array") return `tối đa ${issue.maximum} mục`;
        return undefined;
      case "invalid_format":
        return issue.format === "email"
          ? "không đúng định dạng email"
          : "không đúng định dạng";
      case "invalid_value":
      case "invalid_union":
        return "giá trị không hợp lệ";
      default:
        return undefined;
    }
  },
});

// Thông báo tự viết trong schema (viết hoa đầu câu) giữ nguyên; thông báo chung
// (viết thường) được gắn tên trường: "Mật khẩu: tối thiểu 10 ký tự".
export function formatZodError(error) {
  const parts = [];
  for (const issue of error.issues) {
    const key = issue.path.find((p) => typeof p === "string") ?? "";
    let text = issue.message;
    if (INTERNAL.has(key))
      text =
        "Yêu cầu không hợp lệ hoặc đã hết hạn. Vui lòng tải lại trang và thử lại.";
    else if (
      text[0] &&
      text[0] === text[0].toLowerCase() &&
      text[0] !== text[0].toUpperCase()
    )
      text = `${LABELS[key] || "Dữ liệu"}: ${text}`;
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.slice(0, 3).join(" · ");
}

// Lỗi từ script PowerShell của máy in DNP → câu tiếng Việt dễ hiểu.
const DEVICE_MESSAGES = [
  [
    /printer is not installed/i,
    "Chưa cài máy in DNP có tên đã cấu hình trên máy tính quầy.",
  ],
  [
    /paper size/i,
    "Máy in chưa có khổ giấy 10 × 15 cm. Hãy cấu hình driver máy in DNP.",
  ],
];
export function deviceMessage(raw, fallback) {
  const text = String(raw || "").trim();
  if (text) console.error("[device]", text);
  return (
    DEVICE_MESSAGES.find(([pattern]) => pattern.test(text))?.[1] || fallback
  );
}
