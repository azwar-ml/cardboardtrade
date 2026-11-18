import { requireUser } from "@/lib/trade/auth";
import Sidebar from "@/components/console/Sidebar";

export const dynamic = "force-dynamic";
export const metadata = { title: { default: "Trading · Cardboard Package", template: "%s · Trading" } };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex min-h-dvh flex-col bg-bone text-ink lg:flex-row">
      <Sidebar user={user} />
      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-7 lg:px-10">{children}</main>
    </div>
  );
}
