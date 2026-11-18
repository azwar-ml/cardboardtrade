import { currentUser } from "@/lib/trade/auth";
import { cookies } from "next/headers";
import { DATA_DIR } from "@/lib/trade/db";
import pathModule from "node:path";
import { createHash } from "node:crypto";

export const runtime = "nodejs";

async function proxy(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const user = await currentUser();
  if (!user)
    return Response.json({ detail: "Sign in required" }, { status: 401 });
  if (user.role !== "admin")
    return Response.json({ detail: "Admin access required" }, { status: 403 });
  if (req.method !== "GET" && req.headers.get("origin")) {
    try {
      const origin = new URL(req.headers.get("origin")!);
      if (
        origin.host !== req.headers.get("host") ||
        !["http:", "https:"].includes(origin.protocol)
      ) {
        return Response.json({ detail: "Untrusted origin" }, { status: 403 });
      }
    } catch {
      return Response.json({ detail: "Invalid origin" }, { status: 403 });
    }
  }
  const { path } = await context.params;
  if (!path.every((part) => /^[a-z0-9-]+$/.test(part)))
    return Response.json({ detail: "Invalid path" }, { status: 400 });
  const root = process.env.AGENTS_API_URL ?? "http://127.0.0.1:8000";
  const target = `${root.replace(/\/$/, "")}/api/v1/qualification/${path.join("/")}${new URL(req.url).search}`;
  try {
    const response = await fetch(target, {
      method: req.method,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Content-Type": "application/json",
        Cookie: `cp_session=${(await cookies()).get("cp_session")?.value ?? ""}`,
      },
      ...(req.method === "GET" ? {} : { body: await req.text() }),
    });
    const expected = createHash("sha256")
      .update(
        pathModule
          .join(DATA_DIR, "trade.db")
          .replaceAll("\\", "/")
          .toLowerCase(),
      )
      .digest("hex");
    const identity = response.headers.get("X-Trade-Database");
    if (identity && identity !== expected) {
      return Response.json(
        {
          detail:
            "Qualification is connected to a different database. Restart both services with start-local.ps1 so they share the existing records.",
          code: "QUALIFICATION_DATABASE_MISMATCH",
        },
        { status: 503 },
      );
    }
    if (
      response.status === 404 &&
      path.length === 1 &&
      ["summary", "suppliers", "jobs"].includes(path[0])
    ) {
      return Response.json(
        {
          detail: `The backend at ${new URL(root).origin} does not provide Supplier Qualification (HTTP 404). Stop the old demo backend and start backend/.venv/Scripts/python.exe backend/run.py on port 8000.`,
          code: "QUALIFICATION_ROUTES_MISSING",
        },
        { status: 503 },
      );
    }
    if (response.status === 401) {
      return Response.json(
        {
          detail:
            "The backend could not validate your Admin session. Set the same absolute TRADE_DATA_DIR for Next.js and FastAPI, then sign in again.",
          code: "QUALIFICATION_SESSION_MISMATCH",
        },
        { status: 503 },
      );
    }
    if (response.ok && !identity) {
      return Response.json(
        {
          detail:
            "The service on port 8000 is outdated. Restart both services with start-local.ps1, then Retry.",
          code: "QUALIFICATION_INSTANCE_UNVERIFIED",
        },
        { status: 503 },
      );
    }
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      {
        detail:
          "Supplier Qualification is offline. Start both services with .\\start-local.ps1, then select Retry.",
        code: "QUALIFICATION_OFFLINE",
      },
      { status: 503 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
