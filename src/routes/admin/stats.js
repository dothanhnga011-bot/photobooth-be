import { Router } from "express";
import { z } from "zod";
import {
  daysBetween,
  getMonthRevenue,
  getRevenueSeries,
  getStudioStats,
  getSummary,
} from "../../services/stats.js";
import { allow, can, staffBranch } from "../../middleware/auth.js";
import { date, fail, today } from "../validation.js";

export const statsRouter = Router();

statsRouter.get("/", async (req, res) => {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(
      new Date(Date.now() - (6 - i) * 86400000),
    ),
  );
  const stats = { ...(await getStudioStats(today(), days, staffBranch(req))) };
  // Lễ tân chưa được cấp quyền xem doanh thu: chỉ số lượt khách / lệnh in.
  if (!can(req, "revenue:view")) {
    delete stats.revenue;
    delete stats.todayRevenue;
    delete stats.byDate;
  }
  res.json(stats);
});
// Xem lại doanh thu từng ngày của tháng bất kỳ (mặc định tháng hiện tại).
statsRouter.get("/revenue", allow("revenue:view"), async (req, res) => {
  const month = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Tháng không hợp lệ.")
    .parse(req.query.month ?? today().slice(0, 7));
  res.json(await getMonthRevenue(month, staffBranch(req)));
});

// Khoảng ngày (mặc định hôm nay), chi nhánh và máy cần xem. Lễ tân luôn ở chi nhánh của mình.
function range(req) {
  const from = date.parse(req.query.from ?? today());
  const to = date.parse(req.query.to ?? from);
  if (from > to) fail(400, "Ngày bắt đầu phải trước ngày kết thúc.");
  if (daysBetween(from, to) > 731) fail(400, "Chỉ xem được tối đa 2 năm mỗi lần.");
  const text = z.string().trim().max(200).optional();
  return {
    from,
    to,
    branch: staffBranch(req) || text.parse(req.query.branch) || null,
    room: text.parse(req.query.room) || null,
  };
}

// Tổng hợp: doanh thu thực nhận, số đơn so với kỳ trước, tiền mặt / chuyển khoản và xếp hạng
// chủ đề, gói chụp, máy. Không có quyền xem doanh thu thì chỉ còn số lượt.
statsRouter.get("/summary", async (req, res) => {
  const summary = { ...(await getSummary(range(req))) };
  if (!can(req, "revenue:view")) {
    for (const key of ["revenue", "previousRevenue", "revenueGrowth", "cash", "transfer"])
      delete summary[key];
    for (const key of ["themes", "packages", "rooms"])
      summary[key] = summary[key].map(({ name, count }) => ({ name, count }));
  }
  res.json(summary);
});

// Thống kê doanh thu: chuỗi doanh thu & số đơn theo ngày / tháng kèm kỳ so sánh.
statsRouter.get("/chart", allow("revenue:view"), async (req, res) => {
  res.json(await getRevenueSeries(range(req)));
});
