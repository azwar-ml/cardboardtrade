import { currentUser } from "@/lib/trade/auth";
import { cookies } from "next/headers";
import { DATA_DIR } from "@/lib/trade/db";
import pathModule from "node:path";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
async function proxy(req: Request, context: { params: Promise<{ path: string[] }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ detail: "Sign in required" }, { status: 401 });
  if (user.role !== "admin") return Response.json({ detail: "Admin access required" }, { status: 403 });
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && origin) {
    try {
      const source = new URL(origin);
      if (source.host !== req.headers.get("host") || !["http:", "https:"].includes(source.protocol)) return Response.json({ detail: "Untrusted origin" }, { status: 403 });
    } catch { return Response.json({ detail: "Invalid origin" }, { status: 403 }); }
  }
  const { path } = await context.params;
  if (!path.every(p => /^[a-z0-9-]+$/.test(p))) return Response.json({ detail: "Invalid path" }, { status: 400 });
  const root = process.env.AGENTS_API_URL ?? "http://127.0.0.1:8000";
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 22 * 1024 * 1024) return Response.json({ detail: "File too large" }, { status: 413 });
    const body = req.method === "GET" ? undefined : await req.arrayBuffer();
    if (body && body.byteLength > 22 * 1024 * 1024) return Response.json({ detail: "File too large" }, { status: 413 });
    const response = await fetch(`${root}/api/v1/stock/${path.join("/")}${new URL(req.url).search}`, {
      method: req.method, cache: "no-store", signal: AbortSignal.timeout(20000), body,
      headers: { "Content-Type": req.headers.get("content-type") ?? "application/json", Cookie: `cp_session=${(await cookies()).get("cp_session")?.value ?? ""}` },
    });
    const expected = createHash("sha256").update(pathModule.join(DATA_DIR, "trade.db").replaceAll("\\", "/").toLowerCase()).digest("hex");
    if (response.headers.get("X-Trade-Database") !== expected) return Response.json({ detail: "Stock monitor backend is outdated or uses a different database. Start both services with the same TRADE_DATA_DIR." }, { status: 503 });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", ...(response.headers.get("content-disposition") ? { "Content-Disposition": response.headers.get("content-disposition")! } : {}),
    } });
  } catch { return Response.json({ detail: "Stock monitor backend is unavailable. Start FastAPI and retry." }, { status: 503 }); }
}
export const GET = proxy;
export const POST = proxy;
