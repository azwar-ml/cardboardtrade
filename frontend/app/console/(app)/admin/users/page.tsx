import { revalidatePath } from "next/cache";
import { db } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { hashPassword } from "@/lib/trade/password";
import { PageHead, Panel, Pill, Td, Th, fmtDate } from "@/components/console/ui";

export const metadata = { title: "Users" };

async function addUser(fd: FormData) {
  "use server";
  await requireUser("admin");
  const g = (k: string) => String(fd.get(k) ?? "").trim();
  if (!g("name") || !g("email") || g("password").length < 8) return;
  db().prepare("INSERT OR IGNORE INTO users(name,email,initials,role,password_hash) VALUES (?,?,?,?,?)").run(g("name"), g("email").toLowerCase(), (g("initials") || g("name").split(" ").map((w) => w[0]).join("")).slice(0, 3).toUpperCase(), g("role") === "admin" ? "admin" : "sales", hashPassword(g("password")));
  revalidatePath("/console/admin/users");
}
async function updateUser(fd: FormData) {
  "use server";
  const me = await requireUser("admin");
  const id = Number(fd.get("id"));
  const role = String(fd.get("role")) === "admin" ? "admin" : "sales";
  const active = fd.get("active") === "on" ? 1 : 0;
  if (id === me.id && (role !== "admin" || !active)) return;   // never lock yourself out
  db().prepare("UPDATE users SET role = ?, active = ? WHERE id = ?").run(role, active, id);
  const pw = String(fd.get("password") ?? "");
  if (pw.length >= 8) db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(pw), id);
  if (!active) db().prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  revalidatePath("/console/admin/users");
}

export default async function Users() {
  const me = await requireUser("admin");
  const users = db().prepare("SELECT id, name, email, initials, role, active, created_at FROM users ORDER BY role, name").all() as { id: number; name: string; email: string; initials: string; role: string; active: number; created_at: string }[];
  return (
    <>
      <PageHead title="Users" sub="Admins manage pricing, freight, users and can block vendors or buyers. Sales run uploads, inventory, buyers and sendouts." />
      <Panel className="mb-6 overflow-x-auto">
        <table className="w-full"><thead><tr><Th>Name</Th><Th>Email</Th><Th>Initials</Th><Th>Role</Th><Th>Active</Th><Th>New password</Th><Th>Since</Th><Th></Th></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id}>
              <Td className="font-medium">{u.name}{u.id === me.id && <span className="ml-2"><Pill tone="muted">you</Pill></span>}</Td><Td>{u.email}</Td><Td>{u.initials}</Td>
              <Td colSpan={4} className="!p-0">
                <form action={updateUser} className="flex items-center gap-3 px-3 py-2">
                  <input type="hidden" name="id" value={u.id} />
                  <select name="role" defaultValue={u.role} className="field !min-h-[34px] !w-28 !py-1 text-sm"><option value="sales">sales</option><option value="admin">admin</option></select>
                  <input type="checkbox" name="active" defaultChecked={!!u.active} className="size-4 accent-accent" aria-label="Active" />
                  <input name="password" type="password" placeholder="leave blank" minLength={8} className="field !min-h-[34px] !w-40 !py-1 text-sm" />
                  <span className="text-sm text-stone">{fmtDate(u.created_at)}</span>
                  <button className="text-sm underline">Save</button>
                </form>
              </Td>
            </tr>))}</tbody></table>
      </Panel>
      <Panel className="p-5">
        <p className="font-medium">Add a user</p>
        <form action={addUser} className="mt-3 grid gap-3 md:grid-cols-6">
          <input name="name" required placeholder="Full name" className="field md:col-span-2" /><input name="email" type="email" required placeholder="Email" className="field md:col-span-2" />
          <input name="initials" placeholder="Initials" className="field" />
          <select name="role" className="field"><option value="sales">sales</option><option value="admin">admin</option></select>
          <input name="password" type="password" required minLength={8} placeholder="Password (8+ chars)" className="field md:col-span-2" />
          <button className="btn btn-ink md:col-span-1">Add user</button>
        </form>
      </Panel>
    </>
  );
}
