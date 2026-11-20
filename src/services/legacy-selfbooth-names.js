// 20/11 chủ tiệm: bỏ hẳn tên cũ của phòng thứ hai, mọi chỗ chỉ còn "selfbooth". Dữ liệu đã lưu với tên cũ được đổi
// khi máy chủ khởi động: loại phòng (Room.kind), loại chủ đề (cài đặt tiệm, themes[].kind), nguồn đơn
// (Booking.source) và khoá chữ máy chụp (cài đặt tiệm, kioskTexts "<tên cũ>.codeTitle"…). Chạy lại nhiều lần không sao.
import { Booking, Room, Setting } from "../models/index.js";

// Tên cũ đã lưu trong cơ sở dữ liệu — chỉ dùng ở đây để tìm và đổi.
const OLD = "polaroid";
const NEW = "selfbooth";

export async function migrateSelfboothNames() {
  const [rooms, bookings] = await Promise.all([
    Room.collection.updateMany({ kind: OLD }, { $set: { kind: NEW } }),
    Booking.collection.updateMany({ source: OLD }, { $set: { source: NEW } }),
  ]);
  const themes = await Setting.collection.updateOne(
    { key: "studio", "value.themes.kind": OLD },
    { $set: { "value.themes.$[theme].kind": NEW } },
    { arrayFilters: [{ "theme.kind": OLD }] },
  );
  const studio = await Setting.collection.findOne({ key: "studio" }, { projection: { "value.kioskTexts": 1 } });
  const texts = studio?.value?.kioskTexts || {};
  const old = Object.keys(texts).filter((name) => name.startsWith(`${OLD}.`));
  if (old.length) {
    const renamed = Object.fromEntries(Object.entries(texts).map(([name, text]) =>
      [name.startsWith(`${OLD}.`) ? `${NEW}.${name.slice(OLD.length + 1)}` : name, text]));
    await Setting.collection.updateOne({ key: "studio" }, { $set: { "value.kioskTexts": renamed } });
  }
  return { rooms: rooms.modifiedCount, bookings: bookings.modifiedCount, themes: themes.modifiedCount, kioskTexts: old.length };
}
