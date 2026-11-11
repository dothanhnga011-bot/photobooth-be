import { PrintJob, Room } from "../models/index.js";
import { statsCache } from "./read-cache.js";
import { financialAggregate } from "./revenue-ledger.js";

export async function getStudioStats(currentDate, days, branch = null) {
  const cacheKey = `studio:${currentDate}:${days.join(",")}:${branch || ""}`;
  return statsCache.get(cacheKey, async () => {
    const [result, rooms, printQueue] = await Promise.all([
      financialAggregate([
        { $match: branch ? { branch } : {} },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  bookings: { $sum: 1 },
                  revenue: { $sum: { $cond: ["$paid", "$total", 0] } },
                  pending: {
                    $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                  },
                },
              },
            ],
            daily: [
              {
                $match: {
                  paid: true,
                  date: { $gte: days[0], $lte: currentDate },
                },
              },
              { $group: { _id: "$date", revenue: { $sum: "$total" } } },
            ],
            occupancy: [
              { $match: { date: currentDate, status: { $ne: "cancelled" } } },
              { $group: { _id: "$room", booked: { $sum: 1 } } },
            ],
          },
        },
      ]),
      Room.find({ active: true, ...(branch && { branch }) }).select("name branch").lean(),
      PrintJob.countDocuments({ status: "pending", ...(branch && { branch }) }),
    ]);
    const data = result[0];
    const totals = data.totals[0] || { bookings: 0, revenue: 0, pending: 0 };
    const revenues = new Map(data.daily.map((row) => [row._id, row.revenue]));
    const occupancy = new Map(
      data.occupancy.map((row) => [String(row._id), row.booked]),
    );
    return {
      bookings: totals.bookings,
      revenue: totals.revenue,
      pending: totals.pending,
      printQueue,
      // Doanh thu trong ngày: tiền đã nhận của các vé cấp hôm nay (kể cả tờ in bán thêm).
      todayRevenue: revenues.get(currentDate) || 0,
      today: data.occupancy.reduce((sum, row) => sum + row.booked, 0),
      byDate: days.map((date) => ({ date, revenue: revenues.get(date) || 0 })),
      occupancy: rooms.map((room) => {
        const booked = occupancy.get(String(room._id)) || 0;
        return {
          name: room.name,
          branch: room.branch,
          booked,
        };
      }),
    };
  });
}

// Doanh thu từng ngày của một tháng (YYYY-MM): đủ mọi ngày từ 1 đến cuối tháng, ngày không
// có khách trả về 0. Tính theo ngày cấp mã (giờ Việt Nam), chỉ vé đã nhận tiền.
export async function getMonthRevenue(month, branch = null) {
  const cacheKey = `month:${month}:${branch || ""}`;
  return statsCache.get(cacheKey, async () => {
    const [year, m] = month.split("-").map(Number);
    const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const day = (d) => `${month}-${String(d).padStart(2, "0")}`;
    const rows = await financialAggregate([
      { $match: { paid: true, date: { $gte: day(1), $lte: day(count) }, ...(branch && { branch }) } },
      {
        $group: {
          _id: "$date",
          revenue: { $sum: "$total" },
          tickets: { $sum: 1 },
        },
      },
    ]);
    const byDate = new Map(rows.map((row) => [row._id, row]));
    const days = Array.from({ length: count }, (_, i) => {
      const date = day(i + 1);
      const row = byDate.get(date);
      return { date, revenue: row?.revenue || 0, tickets: row?.tickets || 0 };
    });
    return {
      month,
      revenue: days.reduce((sum, d) => sum + d.revenue, 0),
      tickets: days.reduce((sum, d) => sum + d.tickets, 0),
      days,
    };
  });
}

// ─── Tổng hợp & thống kê doanh thu theo khoảng ngày (Tổng quan) ───────────
// Ngày dạng YYYY-MM-DD (ngày cấp mã, giờ Việt Nam) cộng n ngày.
export const addDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
// Kỳ trước: cùng số ngày, ngay trước kỳ đang xem.
export const previousRange = (from, to) => {
  const n = daysBetween(from, to);
  return { from: addDays(from, -n), to: addDays(from, -1) };
};
// Cùng ngày (hoặc cùng tháng) năm khác; 29/2 rơi vào năm thường thành 28/2.
const shiftYear = (day, years) => {
  const shifted = `${Number(day.slice(0, 4)) + years}${day.slice(4)}`;
  if (shifted.length === 7) return shifted;
  const [y, m] = shifted.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Number(shifted.slice(8)) > last ? `${shifted.slice(0, 8)}${last}` : shifted;
};
const scope = ({ branch, room }) => ({
  ...(branch && { branch }),
  ...(room && { roomName: room }),
});
const method = (field) => ({ $cond: [{ $eq: [field, "transfer"] }, "transfer", "cash"] });
const ranking = (field) => [
  { $group: { _id: field, count: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$total", 0] } } } },
  { $sort: { count: -1, revenue: -1 } },
  { $limit: 10 },
];
export const growth = (current, previous) =>
  previous ? Math.round(((current - previous) / previous) * 1000) / 10 : current ? 100 : 0;

// Doanh thu thực nhận, số đơn, tiền mặt / chuyển khoản và các bảng xếp hạng của vé đã thu tiền.
export async function getSummary({ from, to, branch = null, room = null }) {
  const cacheKey = `summary:${from}:${to}:${branch || ""}:${room || ""}`;
  return statsCache.get(cacheKey, async () => {
    const prev = previousRange(from, to);
    const [[current], [previous]] = await Promise.all([
      financialAggregate([
        { $match: { paid: true, date: { $gte: from, $lte: to }, ...scope({ branch, room }) } },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  orders: { $sum: 1 },
                  revenue: { $sum: { $ifNull: ["$total", 0] } },
                  sheets: { $sum: { $ifNull: ["$printSheets", 0] } },
                  extraSheets: { $sum: { $ifNull: ["$extraPrints", 0] } },
                },
              },
            ],
            // Tiền vé theo hình thức thu lúc bán; tờ in bán thêm theo hình thức của từng lần bán.
            base: [
              {
                $group: {
                  _id: method("$paymentMethod"),
                  amount: {
                    $sum: {
                      $subtract: [
                        { $ifNull: ["$total", 0] },
                        { $sum: { $ifNull: ["$extraSales.amount", []] } },
                      ],
                    },
                  },
                },
              },
            ],
            extras: [
              { $unwind: "$extraSales" },
              { $group: { _id: method("$extraSales.paymentMethod"), amount: { $sum: "$extraSales.amount" } } },
            ],
            themes: [{ $match: { frameName: { $nin: [null, ""] } } }, ...ranking("$frameName")],
            packages: ranking("$packageName"),
            rooms: ranking("$roomName"),
          },
        },
      ]),
      financialAggregate([
        { $match: { paid: true, date: { $gte: prev.from, $lte: prev.to }, ...scope({ branch, room }) } },
        { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$total", 0] } } } },
      ]),
    ]);
    const totals = current.totals[0] || { orders: 0, revenue: 0, sheets: 0, extraSheets: 0 };
    const amount = (m) =>
      (current.base.find((r) => r._id === m)?.amount || 0) +
      (current.extras.find((r) => r._id === m)?.amount || 0);
    const rows = (list, empty) =>
      list.map((r) => ({ name: r._id || empty, count: r.count, revenue: r.revenue }));
    return {
      from,
      to,
      previousFrom: prev.from,
      previousTo: prev.to,
      revenue: totals.revenue,
      previousRevenue: previous?.revenue || 0,
      revenueGrowth: growth(totals.revenue, previous?.revenue || 0),
      orders: totals.orders,
      previousOrders: previous?.orders || 0,
      ordersGrowth: growth(totals.orders, previous?.orders || 0),
      cash: amount("cash"),
      transfer: amount("transfer"),
      sheets: totals.sheets,
      extraSheets: totals.extraSheets,
      themes: rows(current.themes, "Khung lẻ"),
      packages: rows(current.packages, "Gói đã xóa"),
      rooms: rows(current.rooms, "Chưa vào phòng"),
    };
  });
}

// Biểu đồ doanh thu & số đơn: theo ngày (≤ 62 ngày, so với kỳ trước cùng độ dài) hoặc theo
// tháng (so với cùng kỳ năm trước) để hai đường luôn khớp từng mốc.
export async function getRevenueSeries({ from, to, branch = null, room = null }) {
  const cacheKey = `series:${from}:${to}:${branch || ""}:${room || ""}`;
  return statsCache.get(cacheKey, async () => {
    const unit = daysBetween(from, to) <= 62 ? "day" : "month";
    const prev =
      unit === "day"
        ? previousRange(from, to)
        : { from: shiftYear(from, -1), to: shiftYear(to, -1) };
    const rows = await financialAggregate([
      {
        $match: {
          paid: true,
          $or: [{ date: { $gte: from, $lte: to } }, { date: { $gte: prev.from, $lte: prev.to } }],
          ...scope({ branch, room }),
        },
      },
      { $group: { _id: "$date", revenue: { $sum: { $ifNull: ["$total", 0] } }, orders: { $sum: 1 } } },
    ]);
    const byDate = new Map(rows.map((r) => [r._id, r]));
    const sumDays = (start, end) => {
      let revenue = 0, orders = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) {
        const row = byDate.get(d);
        revenue += row?.revenue || 0;
        orders += row?.orders || 0;
      }
      return { revenue, orders };
    };
    const points = [];
    if (unit === "day") {
      for (let i = 0; i < daysBetween(from, to); i++) {
        const date = addDays(from, i), before = addDays(prev.from, i);
        points.push({ key: date, previousKey: before, current: sumDays(date, date), previous: sumDays(before, before) });
      }
    } else {
      for (let month = from.slice(0, 7); month <= to.slice(0, 7); ) {
        const start = month === from.slice(0, 7) ? from : `${month}-01`;
        const [y, m] = month.split("-").map(Number);
        const last = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
        const end = last > to ? to : last;
        points.push({
          key: month,
          previousKey: shiftYear(month, -1),
          current: sumDays(start, end),
          previous: sumDays(shiftYear(start, -1), shiftYear(end, -1)),
        });
        month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      }
    }
    return { unit, from, to, previousFrom: prev.from, previousTo: prev.to, points };
  });
}
