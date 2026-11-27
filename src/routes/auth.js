import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../config.js";
import { User } from "../models/index.js";
import { auth, permissionsOf, sessionUser, setSession } from "../middleware/auth.js";
import { sensitive } from "../middleware/rate-limits.js";
import { fail } from "./validation.js";

export const authRouter = Router();
// Mã băm (cost 12 như mật khẩu thật) của một mật khẩu ngẫu nhiên không ai biết: tính sẵn để máy chủ
// không phải băm lúc khởi động.
const DUMMY_HASH = "$2b$12$xci29YOhx20ynTi9S/D9r.BEhNMA6tJrkgzVSYoGM7La5nGaEqXAa";

authRouter.post("/login", sensitive(), async (req, res) => {
  const d = z
    .object({ email: z.email(), password: z.string().min(1).max(128) })
    .parse(req.body);
  const user = await User.findOne({
    email: d.email.toLowerCase(),
    active: true,
  }).select("+password +sessionVersion");
  // Email không có tài khoản vẫn so với mã băm giả: trả lời cùng thời gian như sai mật khẩu.
  const matches = await bcrypt.compare(d.password, user?.password || DUMMY_HASH);
  if (!user || !matches) fail(401, "Email hoặc mật khẩu không đúng.");
  setSession(res, user);
  res.json({ name: user.name, email: user.email, role: user.role, branch: user.branch || "", permissions: permissionsOf(user) });
});
// Chỉ thông tin tài khoản — không gửi mức lương về trình duyệt.
const publicUser = (user) => {
  const { _id, name, email, role, active, branch } = user;
  return { _id, name, email, role, active, branch: branch || "", permissions: permissionsOf(user) };
};
authRouter.get("/me", auth, (req, res) => {
  res.json(publicUser(req.user));
});
// Trang quản trị vừa mở: đã đăng nhập thì trả tài khoản, chưa thì null — câu trả lời 200, không phải lỗi 401
// (trình duyệt ghi mọi câu trả lời 401 thành lỗi trong console; PageSpeed trừ điểm "Phương pháp hay nhất").
authRouter.get("/session", async (req, res) => {
  const user = await sessionUser(req);
  res.set("Cache-Control", "no-store");
  res.json(user ? publicUser(user) : null);
});
authRouter.post("/logout", (req, res) => {
  res.clearCookie("session", {
    httpOnly: true,
    sameSite: config.production ? "none" : "lax",
    secure: config.production,
  });
  res.json({ ok: true });
});
authRouter.post("/password", auth, async (req, res) => {
  const d = z
    .object({ current: z.string(), password: z.string().min(10).max(128) })
    .parse(req.body);
  const u = await User.findById(req.user._id).select(
    "+password +sessionVersion",
  );
  if (!(await bcrypt.compare(d.current, u.password)))
    fail(400, "Mật khẩu hiện tại không đúng.");
  const updated = await User.findOneAndUpdate(
    { _id: u._id, password: u.password },
    {
      $set: { password: await bcrypt.hash(d.password, 12) },
      $inc: { sessionVersion: 1 },
    },
    { new: true },
  ).select("+sessionVersion");
  if (!updated)
    fail(
      409,
      "Mật khẩu đã được thay đổi ở phiên khác. Vui lòng đăng nhập lại.",
    );
  setSession(res, updated);
  res.json({ ok: true });
});
