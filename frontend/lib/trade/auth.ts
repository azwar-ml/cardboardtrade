import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { ensureSeeded } from "./seed";
import { verifyPassword } from "./password";
export { hashPassword } from "./password";

export type User = { id: number; name: string; email: string; initials: string; role: "admin" | "sales" };
const COOKIE = "cp_session";

export async function login(email: string, password: string) {
  await ensureSeeded();
  const d = db(), normalized = email.trim().toLowerCase();
  const limit = d.prepare("SELECT failures,locked_until FROM login_attempts WHERE email=?").get(normalized) as { failures: number; locked_until: string | null } | undefined;
  if (limit?.locked_until && limit.locked_until > new Date().toISOString()) return false;
  const u = d.prepare("SELECT * FROM users WHERE lower(email) = ? AND active = 1").get(normalized) as (User & { password_hash: string }) | undefined;
  if (!u || !verifyPassword(password, u.password_hash)) {
    const failures = limit?.locked_until ? 0 : limit?.failures ?? 0;
    const next = failures + 1;
    const locked = next >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    d.prepare("INSERT INTO login_attempts(email,failures,locked_until) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until").run(normalized, next, locked);
    return false;
  }
  d.prepare("DELETE FROM login_attempts WHERE email=?").run(normalized);
  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
  db().prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)").run(token, u.id, expires);
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", expires: new Date(expires), secure: process.env.NODE_ENV === "production" });
  return true;
}

export async function logout() {
  const c = await cookies();
  const t = c.get(COOKIE)?.value;
  if (t) db().prepare("DELETE FROM sessions WHERE token = ?").run(t);
  c.delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  await ensureSeeded();
  const t = (await cookies()).get(COOKIE)?.value;
  if (!t) return null;
  const u = db().prepare(`SELECT u.id, u.name, u.email, u.initials, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(t, new Date().toISOString()) as User | undefined;
  return u ?? null;
}

/** Use at the top of every console page / action. */
export async function requireUser(role?: "admin") {
  const u = await currentUser();
  if (!u) redirect("/console/login");
  if (role === "admin" && u.role !== "admin") redirect("/console?denied=1");
  return u;
}
