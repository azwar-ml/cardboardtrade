import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { currentUser } from "@/lib/trade/auth";
import { DATA_DIR, FILES_DIR, OUTBOX_DIR } from "@/lib/trade/db";

export const runtime = "nodejs";

// Authenticated download of stored files (uploads, attachments) and outbox .eml files.
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!(await currentUser())) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const parts = (await params).path;
  const outbox = parts[0] === "outbox", legacyEnquiry = parts[0] === "uploads";
  const root = outbox ? OUTBOX_DIR : legacyEnquiry ? path.join(DATA_DIR, "uploads") : FILES_DIR;
  const rel = outbox || legacyEnquiry ? parts.slice(1) : parts;
  const abs = path.resolve(root, ...rel);
  const relative = path.relative(root, abs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(abs)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let walk = root;
  for (const part of relative.split(path.sep)) {
    walk = path.join(walk, part);
    if (fs.lstatSync(walk).isSymbolicLink()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const name = path.basename(abs).replace(/^[0-9a-f]{12}-/, "");
  const type = /\.xlsx$/i.test(name) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : /\.eml$/i.test(name) ? "message/rfc822" : /\.pdf$/i.test(name) ? "application/pdf" : /\.(png|jpe?g|webp)$/i.test(name) ? `image/${name.split(".").pop()!.replace("jpg", "jpeg")}` : /\.txt$/i.test(name) ? "text/plain; charset=utf-8" : "application/octet-stream";
  return new NextResponse(fs.readFileSync(abs), { headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"` } });
}
