import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { User } from "../models/index.js";
import { userCache } from "../services/read-cache.js";
import { fail } from "../routes/validation.js";

export function setSession(res, user) {
  const signed = jwt.sign(
    { sub: String(user._id), version: user.sessionVersion || 0 },
    config.secret,
    { expiresIn: config.expires },
  );
  const { exp } = jwt.decode(signed);
  res.cookie("session", signed, {
    httpOnly: true,
    sameSite: config.production ? "none" : "lax",
    secure: config.production,
    maxAge: Math.max(0, exp * 1000 - Date.now()),
  });
}
export async function auth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.session || "", config.secret);
    // One database round trip saved on every admin request (the database is far away).
    req.user = await userCache.get(String(p.sub), () =>
      User.findById(p.sub).select("+sessionVersion").lean());
    if (
      !req.user?.active ||
      (p.version || 0) !== (req.user.sessionVersion || 0)
    )
      throw Error();
    next();
  } catch {
    res.status(401).json({ message: "Vui lòng đăng nhập." });
  }
}
export const isAdmin = (req) => req.user?.role === "admin";
// Quyền chủ cửa hàng cấp cho từng nhân viên (Tài khoản → Phân quyền). Tài khoản chưa lưu quyền
// dùng bộ mặc định: đúng những việc lễ tân làm được trước khi có phân quyền.
export const STAFF_PERMISSIONS = [
  "revenue:view",
  "orders:export",
  "orders:cancel",
  "print:operate",
  "rooms:setup",
];
export const DEFAULT_STAFF_PERMISSIONS = [
  "orders:export",
  "print:operate",
  "rooms:setup",
];
// Quyền đã bỏ cùng tính năng (Ca trực & Đối soát): tài khoản cũ còn lưu thì bỏ qua, không báo lỗi khi lưu lại.
export const RETIRED_PERMISSIONS = ["shift:operate"];
export const permissionsOf = (user) =>
  user?.role === "admin"
    ? STAFF_PERMISSIONS
    : (user?.permissions ?? DEFAULT_STAFF_PERMISSIONS).filter((p) => STAFF_PERMISSIONS.includes(p));
export const can = (req, permission) => permissionsOf(req.user).includes(permission);
export const allow = (permission) => (req, res, next) =>
  can(req, permission)
    ? next()
    : res
        .status(403)
        .json({ message: "Tài khoản chưa được cấp quyền thực hiện thao tác này." });
export function staffBranch(req) {
  if (isAdmin(req)) return null;
  const branch = req.user?.branch?.trim();
  if (!branch) fail(403, "Tài khoản chưa được gán chi nhánh. Nhờ chủ cửa hàng cập nhật tài khoản.");
  return branch;
}
export function requireBranch(req, branch) {
  const assigned = staffBranch(req);
  if (assigned && assigned !== branch?.trim())
    fail(403, "Bạn chỉ được thao tác với chi nhánh được phân công.");
}
// Staff must see the amount of an order to collect or confirm payment. Revenue
// aggregates remain admin-only in /stats; discounts stay private.
export const hideMoney = (req, b) =>
  isAdmin(req) ? b : { ...b, discount: undefined };
export const admin = (req, res, next) =>
  req.user.role === "admin"
    ? next()
    : res
        .status(403)
        .json({ message: "Chỉ quản trị viên được thực hiện thao tác này." });
