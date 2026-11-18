import { redirect } from "next/navigation";
import { db } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { matchBuyers } from "@/lib/trade/match";
import { pricingSettings, quote } from "@/lib/trade/pricing";
import { createDraft } from "@/lib/trade/sendout";
import { PageHead } from "@/components/console/ui";
import Steps from "@/components/console/Steps";
import ListingPicker, { type Listing } from "@/components/console/ListingPicker";

export const metadata = { title: "Buyer Sendouts" };

async function start(fd: FormData) {
  "use server";
  const user = await requireUser();
  const ids = fd.getAll("upload").map(Number).filter(Boolean);
  if (!ids.length) return;
  const id = createDraft(ids, user.id);
  redirect(`/console/sendouts/${id}/buyers`);
}

export default async function Listings() {
  await requireUser();
  const d = db();
  const ups = d.prepare(`SELECT u.id, u.published_at, u.created_at, v.name vendor, v.city, v.id vendor_id, us.initials am FROM uploads u JOIN vendors v ON v.id = u.vendor_id
    LEFT JOIN users us ON us.id = v.am_user_id WHERE u.status = 'published' AND EXISTS (SELECT 1 FROM items i WHERE i.upload_id = u.id AND i.status='online') ORDER BY u.published_at DESC, u.id DESC`).all() as { id: number; published_at: string; created_at: string; vendor: string; city: string; vendor_id: number; am: string | null }[];
  const s = pricingSettings();
  const lastSent = d.prepare(`SELECT max(s.sent_at) at, us.initials FROM sendouts s LEFT JOIN users us ON us.id = s.created_by WHERE s.status='sent' AND EXISTS (SELECT 1 FROM json_each(s.upload_ids) j WHERE j.value = ?)`);
  const listings: Listing[] = ups.map((u) => {
    const items = d.prepare("SELECT line, choice, qty, price_pkr, cbm_per_1000, location FROM items WHERE upload_id = ? AND status='online'").all(u.id) as { line: string; choice: string; qty: number; price_pkr: number; cbm_per_1000: number; location: string }[];
    const prices = items.map((i) => quote(i, null, s).offerFob);
    const m = matchBuyers([u.id]);
    const ls = lastSent.get(u.id) as { at: string | null; initials: string | null };
    return {
      id: u.id, date: u.published_at ?? u.created_at, vendor: u.vendor, city: u.city, am: u.am,
      lines: [...new Set(items.map((i) => i.line))], choices: [...new Set(items.map((i) => i.choice))].sort(),
      lots: items.length, pcs: items.reduce((a, i) => a + i.qty, 0), cbm: items.reduce((a, i) => a + (i.qty * i.cbm_per_1000) / 1000, 0),
      priceMin: Math.min(...prices), priceMax: Math.max(...prices), matches: m.filter((x) => !x.excluded).length, held: m.filter((x) => x.excluded).length,
      lastSent: ls?.at ?? null, lastSentBy: ls?.initials ?? null,
    };
  });
  return (
    <>
      <PageHead title="Buyer Sendouts" sub="Pick one or more vendor listings. Vendor names stay internal: buyers only ever see Cardboard Package." />
      <Steps active={0} />
      <ListingPicker listings={listings} action={start} />
    </>
  );
}
