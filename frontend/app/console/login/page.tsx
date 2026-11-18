import { redirect } from "next/navigation";
import { Mark } from "@/components/Logo";
import { currentUser, login } from "@/lib/trade/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · Cardboard Package Trading" };

async function signIn(fd: FormData) {
  "use server";
  const ok = await login(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""));
  redirect(ok ? "/console" : "/console/login?error=1");
}

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/console");
  const { error } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center bg-bone px-4">
      <form action={signIn} className="w-full max-w-sm rounded-[8px] border border-line bg-paper p-8">
        <div className="flex items-center gap-2.5"><Mark className="size-8" /><div><p className="label-mono text-stone">Cardboard Package</p><p className="font-display text-lg font-semibold">Trading</p></div></div>
        <h1 className="mt-8 text-2xl">Sign in</h1>
        <label className="field-label mt-6" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="username" className="field" />
        <label className="field-label mt-4" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className="field" />
        {error && <p role="alert" className="mt-3 text-sm text-accent-deep">Email or password is wrong.</p>}
        <button className="btn btn-ink mt-6 w-full">Sign in</button>
      </form>
    </main>
  );
}
