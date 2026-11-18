import { NextResponse } from "next/server";
import { currentUser } from "@/lib/trade/auth";
import { templateWorkbook } from "@/lib/trade/template";

export const runtime = "nodejs";

// Blank supplier inventory template (Cardboard Package format) to send to vendors.
export async function GET() {
  if (!(await currentUser())) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const wb = await templateWorkbook();
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return new NextResponse(buf, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": 'attachment; filename="Cardboard_Package_Supplier_Inventory_Template.xlsx"' } });
}
