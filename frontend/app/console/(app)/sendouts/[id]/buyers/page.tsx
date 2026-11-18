import { notFound, redirect } from "next/navigation";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { generateMessages, getSendout, sendoutMatches } from "@/lib/trade/sendout";
import { PageHead } from "@/components/console/ui";
import Steps from "@/components/console/Steps";
import BuyerPicker, { type Row } from "@/components/console/BuyerPicker";

export const metadata = { title: "Matched buyers" };

async function save(fd: FormData) {
  "use server";
  await requireUser();
  const id = Number(fd.get("id"));
  const s = getSendout(id);
  if (!s || s.status === "sent") redirect(`/console/sendouts/${id}/send`);
  const included = new Set(fd.getAll("include").map(Number));
  const all = sendoutMatches(s!).filter((m) => !m.excluded).map((m) => m.buyer.id);
  db().prepare("UPDATE sendouts SET excluded_buyer_ids = ? WHERE id = ?").run(JSON.stringify(all.filter((b) => !included.has(b))), id);
  generateMessages(id);
  redirect(`/console/sendouts/${id}/compose`);
}

export default async function MatchedBuyers({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const id = Number((await params).id);
  const s = getSendout(id);
  if (!s) notFound();
  if (s.status === "sent") redirect(`/console/sendouts/${id}/send`);
  const ex = new Set(json<number[]>(s.excluded_buyer_ids, []));
  const ups = db().prepare(`SELECT v.name, v.city, count(i.id) lots, sum(i.qty) pcs FROM uploads u JOIN vendors v ON v.id=u.vendor_id JOIN items i ON i.upload_id=u.id AND i.status='online' WHERE u.id IN (SELECT value FROM json_each(?)) GROUP BY u.id`).all(s.upload_ids) as { name: string; city: string; lots: number; pcs: number }[];
  const rows: Row[] = sendoutMatches(s).map((m) => ({
    buyerId: m.buyer.id, company: m.buyer.name, country: m.buyer.country, score: m.score, choice: m.buyer.choice_pref, signals: m.signals, port: m.port, transit: m.transit,
    lots: m.items.length, pcs: m.pcs, lines: [...new Set(m.items.map((i) => i.line))], am: m.am, contact: m.contact ? { name: m.contact.name, email: m.contact.email, bounce: m.contact.bounce } : null,
    excluded: m.excluded, lastSent: m.lastSent, included: !m.excluded && !ex.has(m.buyer.id),
  }));
  return (
    <>
      <PageHead title="Buyer Sendouts" sub={<>{ups.map((u) => `${u.name} (${u.city}) · ${u.lots} lots · ${u.pcs.toLocaleString("en-US")} pcs`).join("  ·  ")}. Transit times are Karachi to the buyer&apos;s port.</>} />
      <Steps active={1} id={id} />
      <BuyerPicker rows={rows} action={save} sendoutId={id} />
    </>
  );
}
