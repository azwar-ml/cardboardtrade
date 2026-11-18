import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { db, DATA_DIR } from "@/lib/trade/db";
import { linkSellerSubmission } from "@/lib/trade/discovery";

export const runtime = "nodejs";

// Enquiries are committed as individual SQLite rows to avoid concurrent JSON read/write loss.
const DATA = DATA_DIR;
const MAX_FILE = 10 * 1024 * 1024;
const OK_EXT = /\.(xlsx?|csv|pdf|png|jpe?g|webp)$/i;

function validFile(name: string, bytes: Buffer) {
  const lower = name.toLowerCase();
  if (/\.pdf$/.test(lower)) return bytes.subarray(0, 5).toString() === "%PDF-";
  if (/\.png$/.test(lower)) return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (/\.jpe?g$/.test(lower)) return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (/\.webp$/.test(lower)) return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (/\.xlsx$/.test(lower)) return bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04]));
  if (/\.xls$/.test(lower)) return bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  if (/\.csv$/.test(lower)) return !bytes.includes(0);
  return false;
}

const s = (v: FormDataEntryValue | null, max = 2000) => (typeof v === "string" ? v.slice(0, max).trim() : "");

export async function POST(req: Request) {
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (s(fd.get("website"))) return NextResponse.json({ ok: true, id: "CP-000000" }); // honeypot

  const email = s(fd.get("email"), 200);
  const required = ["firstName", "lastName", "company", "country", "message"].map((k) => s(fd.get(k)));
  if (required.some((v) => !v) || !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "Please fill in all required fields with a valid email." }, { status: 400 });
  }

  const id = `CP-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${randomBytes(5).toString("hex").toUpperCase()}`;
  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > 8 || files.some((f) => f.size > MAX_FILE || !OK_EXT.test(f.name))) {
    return NextResponse.json({ error: "Attachments must be Excel, CSV, PDF or images under 10 MB each." }, { status: 400 });
  }

  const saved: string[] = [];
  if (files.length) {
    const dir = path.join(DATA, "files", "enquiries", id);
    await mkdir(dir, { recursive: true });
    for (const f of files) {
      const name = path.basename(f.name).replace(/[^\w.\- ]+/g, "_");
      const bytes = Buffer.from(await f.arrayBuffer());
      if (!validFile(name, bytes)) return NextResponse.json({ error: `The file ${name} does not match its file type.` }, { status: 400 });
      const uniqueName = `${randomBytes(4).toString("hex")}-${name}`;
      await writeFile(path.join(dir, uniqueName), bytes, { flag: "wx" });
      saved.push(`enquiries/${id}/${uniqueName}`);
    }
  }

  const record = {
    id,
    receivedAt: new Date().toISOString(),
    subject: s(fd.get("subject"), 60),
    firstName: required[0], lastName: required[1], email, phone: "",
    company: required[2], country: required[3], city: s(fd.get("city"), 100),
    product: s(fd.get("product"), 120), quantity: s(fd.get("quantity"), 120),
    message: required[4], callback: false, attachments: saved,
  };

  const d = db();
  d.transaction(() => {
  d.prepare(`INSERT INTO enquiries(id,received_at,subject,first_name,last_name,email,phone,company,country,product,quantity,message,callback,attachments)
    VALUES (@id,@received_at,@subject,@first_name,@last_name,@email,@phone,@company,@country,@product,@quantity,@message,@callback,@attachments)`).run({
    id, received_at: record.receivedAt, subject: record.subject || null, first_name: record.firstName, last_name: record.lastName,
    email, phone: record.phone || null, company: record.company, country: record.country,
    product: record.product || null, quantity: record.quantity || null, message: record.message,
    callback: record.callback ? 1 : 0, attachments: JSON.stringify(saved),
  });
  linkSellerSubmission(d, record);
  })();

  return NextResponse.json({ ok: true, id });
}
