"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Boxes, Upload, Factory, Users, Send, LineChart, Settings2, UserCog, LayoutDashboard, LogOut, FileSpreadsheet, Bot, Mail, Menu, X } from "lucide-react";
import { Mark } from "@/components/Logo";
import type { User } from "@/lib/trade/auth";

const groups = (admin: boolean) => [
  { title: null, items: [{ href: "/console", label: "Overview", icon: LayoutDashboard, exact: true }] },
  { title: "Supply", items: [
    { href: "/console/inventory", label: "Inventory", icon: Boxes },
    { href: "/console/uploads", label: "List Upload", icon: Upload },
    { href: "/console/vendors", label: "Vendors", icon: Factory },
    { href: "/api/console/template", label: "Supplier template", icon: FileSpreadsheet, external: true },
  ] },
  { title: "Demand", items: [{ href: "/console/buyers", label: "Buyers", icon: Users }, { href: "/console/enquiries", label: "Enquiries", icon: Mail }] },
  { title: "Deals", items: [
    { href: "/console/sendouts/new", label: "Buyer Sendouts", icon: Send, match: /^\/console\/sendouts\/(new|\d+)/ },
    { href: "/console/sendouts", label: "Sendout Tracking", icon: LineChart, exact: true },
  ] },
  ...(admin ? [{ title: "Admin", items: [
    { href: "/console/admin/pricing", label: "Pricing & Freight", icon: Settings2 },
    { href: "/console/admin/users", label: "Users", icon: UserCog },
    { href: "/console/admin/agents", label: "AI Control Center", icon: Bot },
  ] }] : []),
];

export default function Sidebar({ user }: { user: User }) {
  const path = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sections = groups(user.role === "admin");
  return (
    <aside className="sticky top-0 z-30 flex w-full shrink-0 flex-col border-b border-line bg-paper lg:sticky lg:h-dvh lg:w-60 lg:border-b-0 lg:border-r">
      <div className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 lg:px-5 lg:pt-5">
        <Link href="/console" onClick={() => setMobileOpen(false)} className="flex items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4">
          <Mark className="size-7" />
          <span className="leading-tight"><span className="label-mono block text-[10px] text-stone">Cardboard Package</span><span className="font-display font-semibold">Trading</span></span>
        </Link>
        <div className="flex items-center gap-3 lg:hidden">
          <span className="max-w-36 truncate text-xs text-stone">{user.name} · {user.role}</span>
          <button type="button" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)} className="inline-flex size-10 items-center justify-center rounded-md border border-line text-ink hover:bg-bone focus-visible:outline-2 focus-visible:outline-accent">
            {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      <nav data-testid="console-sidebar-navigation" aria-label="Console" className={`${mobileOpen ? "block" : "hidden"} max-h-[calc(100dvh-4rem)] space-y-5 overflow-y-auto overscroll-contain px-3 pb-3 lg:block lg:min-h-0 lg:flex-1 lg:px-3 lg:pb-3 lg:pt-5`}>
        {sections.map((g, i) => (
          <div key={i}>
            {g.title && <p className="label-mono mb-1.5 px-2 text-[11px] text-stone">{g.title}</p>}
            <ul className="space-y-0.5">
              {g.items.map((it) => {
                const active = "match" in it && it.match ? it.match.test(path) : "exact" in it && it.exact ? path === it.href : path.startsWith(it.href);
                const Icon = it.icon;
                const cls = `group relative flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 ${active ? "bg-[#f7eee9] font-medium text-ink" : "text-ink/80 hover:bg-bone hover:text-ink"}`;
                const onClick = () => setMobileOpen(false);
                return (
                  <li key={it.href}>
                    {"external" in it && it.external ? <a href={it.href} onClick={onClick} className={cls}>{active && <span aria-hidden="true" data-testid="nav-active-indicator" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent" />}<Icon className="size-4 shrink-0" strokeWidth={1.6} />{it.label}</a>
                      : <Link href={it.href} onClick={onClick} aria-current={active ? "page" : undefined} data-nav-active={active ? "true" : undefined} className={cls}>{active && <span aria-hidden="true" data-testid="nav-active-indicator" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-accent" />}<Icon className={`size-4 shrink-0 ${active ? "text-accent" : ""}`} strokeWidth={1.6} />{it.label}</Link>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="hidden shrink-0 border-t border-line px-5 py-4 lg:block">
        <p className="truncate text-sm font-medium">{user.name}</p>
        <p className="label-mono mt-0.5 text-[10px] text-stone">{user.role} · {user.initials}</p>
        <form action="/api/console/logout" method="post"><button className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm text-stone hover:text-ink focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"><LogOut className="size-3.5" />Sign out</button></form>
      </div>
      {mobileOpen && <div className="border-t border-line px-5 py-3 lg:hidden"><p className="label-mono text-[10px] text-stone">{user.initials} · {user.role}</p><form action="/api/console/logout" method="post"><button className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-sm text-sm text-stone hover:text-ink focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"><LogOut className="size-4" />Sign out</button></form></div>}
    </aside>
  );
}
