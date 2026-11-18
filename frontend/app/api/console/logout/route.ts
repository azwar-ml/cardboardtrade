import { NextResponse } from "next/server";
import { logout } from "@/lib/trade/auth";

export async function POST(req: Request) {
  await logout();
  return NextResponse.redirect(new URL("/console/login", req.url), 303);
}
