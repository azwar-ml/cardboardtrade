"""Build the vendor directory + virtual inventory workbook from data/trade.db.

Run from the project root:  python3 scripts/build_deliverables.py
Pricing columns are live Excel formulas driven by the Assumptions sheet.
"""
import json, os, sqlite3, datetime
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "deliverables")
os.makedirs(OUT_DIR, exist_ok=True)
TODAY = datetime.date.today().isoformat()
db = sqlite3.connect(os.path.join(ROOT, "data", "trade.db"))
db.row_factory = sqlite3.Row

LINES = ["TV Box", "Refrigerator", "Air Conditioners", "Laptop", "Iron Box", "Pizza", "Fruit & Vegetable Crates", "Liquid / Milk Box",
         "Ration Box", "Shipping Box", "Universal Carton", "Paper Bag", "Shopping Bag", "Beverages"]
INK, BONE, ACC = "0E1013", "F2EFE9", "E35B2C"
F = "Arial"
head_font = Font(name=F, bold=True, color="FFFFFF", size=10)
head_fill = PatternFill("solid", fgColor=INK)
body = Font(name=F, size=10)
blue = Font(name=F, size=10, color="0000FF")
green = Font(name=F, size=10, color="008000")
bold = Font(name=F, size=10, bold=True)
thin = Border(bottom=Side(style="thin", color="DCD7CD"))
wrap = Alignment(wrap_text=True, vertical="top")
input_fill = PatternFill("solid", fgColor="FFFF00")


def header(ws, row, cols, widths=None):
    for i, c in enumerate(cols, 1):
        cell = ws.cell(row=row, column=i, value=c)
        cell.font, cell.fill = head_font, head_fill
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        if widths:
            ws.column_dimensions[get_column_letter(i)].width = widths[i - 1]
    ws.row_dimensions[row].height = 30
    ws.freeze_panes = ws.cell(row=row + 1, column=2)


def title(ws, text, sub):
    ws["A1"] = text; ws["A1"].font = Font(name=F, size=14, bold=True)
    ws["A2"] = sub; ws["A2"].font = Font(name=F, size=9, color="62666D")


wb = Workbook()

# ---------------------------------------------------------------- Read me
rm = wb.active; rm.title = "Read me"
rm.sheet_view.showGridLines = False
rm.column_dimensions["A"].width = 3; rm.column_dimensions["B"].width = 26; rm.column_dimensions["C"].width = 110
rm["B2"] = "Cardboard Package · Vendors & virtual inventory"; rm["B2"].font = Font(name=F, size=16, bold=True)
rm["B3"] = f"Generated {TODAY} from the trading console database (data/trade.db)."; rm["B3"].font = Font(name=F, size=9, color="62666D")
rows = [
    ("Vendors", "31 real Pakistani packaging companies from desk research (user's files + two verification passes, checked 2026-11-11). Every row cites its sources. Contact details are as published — verify before quoting. 'Research note' records what was corrected vs. earlier files."),
    ("Coverage", "Vendor × product-line matrix. 1 = the vendor's site or a credible source shows that product. Totals are formulas."),
    ("Assumptions", "Blue cells on yellow are inputs: FX, margin, port charges, minimum margin, the quote port, ocean freight per 40ft HC and inland freight per CBM. Change them and every price in Virtual Inventory recalculates. All rates are defaults to confirm with a forwarder."),
    ("Virtual Inventory", "Every online lot in the console (internal view, includes the vendor). Vendor price, size and bundle data are inputs; EXW, FOB Karachi, CFR quote port and offer prices are formulas. DEMO: these lots are generated from each vendor's published product range with model prices — replace them by uploading the vendor's real list in the console."),
    ("Demo Buyers", "30 FICTIONAL buyer companies with fictional contacts on the reserved example.com domain, used to test matching and sendouts. Replace with real buyers."),
    ("Gaps & next steps", "Where vendor coverage is thin and what to do next."),
    ("Choice", "1st = prime, produced to spec, certificates available. 2nd = commercial seconds / stock lots (print shift, colour variance, overruns, small tolerance), sold as is without certificates."),
    ("Colour code", "Blue text = typed input · Black = formula · Green = taken from another sheet · Yellow fill = key assumption to review."),
]
for i, (k, v) in enumerate(rows):
    rm.cell(row=5 + i, column=2, value=k).font = bold
    c = rm.cell(row=5 + i, column=3, value=v); c.font = body; c.alignment = wrap
    rm.row_dimensions[5 + i].height = 44

# ---------------------------------------------------------------- Vendors
vs = wb.create_sheet("Vendors")
title(vs, "Vendor directory", "Pakistani packaging manufacturers and converters. Sources per row; research confidence: high / medium / low.")
cols = ["Code", "Vendor", "Legal name", "City", "Address", "Website", "Email", "Phone", "Type", "Product lines", "Research confidence", "What sources confirm", "Export evidence", "Certifications (claimed)", "Research note / correction", "Lots online (demo)", "Sources"]
header(vs, 4, cols, [9, 30, 30, 18, 40, 30, 28, 24, 13, 34, 11, 60, 50, 34, 50, 10, 60])
vendors = db.execute("""SELECT v.*, (SELECT count(*) FROM items i WHERE i.vendor_id=v.id AND i.status='online') lots FROM vendors v ORDER BY v.name""").fetchall()
for r, v in enumerate(vendors, 5):
    vals = [v["code"], v["name"], v["legal_name"], v["city"], v["address"], v["website"], v["email"], v["phone"], v["business_type"], ", ".join(json.loads(v["product_lines"])),
            v["confidence"], v["evidence"], v["export_evidence"], v["certifications"], (v["notes"] or "").replace("Research note: ", ""), v["lots"], "\n".join(json.loads(v["sources"]))]
    for c, val in enumerate(vals, 1):
        cell = vs.cell(row=r, column=c, value=val); cell.font = body; cell.alignment = wrap; cell.border = thin
    if v["website"]:
        vs.cell(row=r, column=6).hyperlink = v["website"]
vs.auto_filter.ref = f"A4:{get_column_letter(len(cols))}{4 + len(vendors)}"

# ---------------------------------------------------------------- Coverage
cv = wb.create_sheet("Coverage")
title(cv, "Product-line coverage", "1 = product shown by the vendor's site or a credible source. Totals and gaps are formulas.")
header(cv, 4, ["Vendor", "City"] + LINES + ["Lines"], [32, 18] + [11] * len(LINES) + [8])
first = 5
for r, v in enumerate(vendors, first):
    pl = set(json.loads(v["product_lines"]))
    cv.cell(row=r, column=1, value=v["name"]).font = body
    cv.cell(row=r, column=2, value=v["city"]).font = body
    for j, line in enumerate(LINES, 3):
        c = cv.cell(row=r, column=j, value=1 if line in pl else None); c.font = body; c.alignment = Alignment(horizontal="center")
        if line in pl: c.fill = PatternFill("solid", fgColor="E6F2EA")
    L = get_column_letter(2 + len(LINES))
    cv.cell(row=r, column=3 + len(LINES), value=f"=SUM(C{r}:{L}{r})").font = body
last = first + len(vendors) - 1
tr = last + 1
cv.cell(row=tr, column=1, value="Vendors per line").font = bold
for j in range(3, 3 + len(LINES)):
    col = get_column_letter(j)
    cv.cell(row=tr, column=j, value=f"=SUM({col}{first}:{col}{last})").font = bold
cv.cell(row=tr + 1, column=1, value="Thin coverage (≤ 2 vendors)").font = bold
for j in range(3, 3 + len(LINES)):
    col = get_column_letter(j)
    cv.cell(row=tr + 1, column=j, value=f'=IF({col}{tr}<=2,"THIN","")').font = Font(name=F, size=10, bold=True, color=ACC)

# ---------------------------------------------------------------- Assumptions
asm = wb.create_sheet("Assumptions")
title(asm, "Pricing & freight assumptions", "Inputs in blue on yellow. Defaults to confirm with your freight forwarder and finance.")
s = {r["key"]: float(r["value"]) for r in db.execute("SELECT key, value FROM settings WHERE key != 'seeded'")}
asm.column_dimensions["A"].width = 38; asm.column_dimensions["B"].width = 16; asm.column_dimensions["C"].width = 60
params = [("PKR per USD", s["fx_pkr_per_usd"], "FX rate used to convert vendor PKR prices. Console default; update weekly."),
          ("Margin", s["margin_pct"] / 100, "Cardboard Package margin on landed cost (stored as a fraction)."),
          ("Karachi port & docs, USD per CBM", s["fob_usd_per_cbm"], "THC, loading, documentation. Forwarder estimate to confirm."),
          ("Minimum margin, USD per piece", s["min_margin_usd_per_pc"], "Floor so cheap items still earn something."),
          ("Usable CBM per 40ft HC", 68, "Industry rule of thumb for knocked-down cartons on pallets."),
          ("Quote port (CFR column)", "AEJEA", "Pick a port code from the table below; the CFR column prices to it.")]
asm["A4"], asm["B4"], asm["C4"] = "Parameter", "Value", "Note"
for c in ("A4", "B4", "C4"): asm[c].font, asm[c].fill = head_font, head_fill
for i, (k, v, n) in enumerate(params, 5):
    asm.cell(row=i, column=1, value=k).font = body
    c = asm.cell(row=i, column=2, value=v); c.font = blue; c.fill = input_fill
    asm.cell(row=i, column=3, value=n).font = Font(name=F, size=9, color="62666D")
asm["B6"].number_format = "0.0%"
FX, MARGIN, FOBC, MINM, CBM40, QPORT = "Assumptions!$B$5", "Assumptions!$B$6", "Assumptions!$B$7", "Assumptions!$B$8", "Assumptions!$B$9", "Assumptions!$B$10"

lanes = db.execute("SELECT * FROM freight_lanes WHERE active=1 ORDER BY region, port").fetchall()
LR0 = 13
for j, h in enumerate(["Port code", "Port", "Country", "Region", "USD per 40HC", "USD per CBM", "Transit days"], 1):
    c = asm.cell(row=LR0, column=j, value=h); c.font, c.fill = head_font, head_fill
for i, l in enumerate(lanes, LR0 + 1):
    for j, v in enumerate([l["code"], l["port"], l["country"], l["region"], l["rate_40hc_usd"], None, l["transit_days"]], 1):
        c = asm.cell(row=i, column=j, value=v); c.font = blue if j in (5, 7) else body
        if j == 5: c.fill = input_fill
    asm.cell(row=i, column=6, value=f"=E{i}/{CBM40}").font = body
    asm.cell(row=i, column=6).number_format = "0.00"
LR1 = LR0 + len(lanes)
for col, w in zip("DEFG", [20, 14, 12, 12]): asm.column_dimensions[col].width = w
dv = DataValidation(type="list", formula1=f"=$A${LR0 + 1}:$A${LR1}", allow_blank=False); asm.add_data_validation(dv); dv.add("B10")
asm["B10"].comment = Comment("Choose any port code from column A of the freight table.", "Cardboard Package")

origins = db.execute("SELECT * FROM origins ORDER BY city").fetchall()
OR0 = LR1 + 3
asm.cell(row=OR0 - 1, column=1, value="Inland freight to Karachi port").font = bold
for j, h in enumerate(["Pick-up city", "USD per CBM"], 1):
    c = asm.cell(row=OR0, column=j, value=h); c.font, c.fill = head_font, head_fill
for i, o in enumerate(origins, OR0 + 1):
    asm.cell(row=i, column=1, value=o["city"]).font = body
    c = asm.cell(row=i, column=2, value=o["inland_usd_per_cbm"]); c.font = blue; c.fill = input_fill
OR1 = OR0 + len(origins)

# ---------------------------------------------------------------- Virtual Inventory
iv = wb.create_sheet("Virtual Inventory")
title(iv, "Virtual inventory (internal — includes vendor names)", "Inputs in blue; prices are formulas from Assumptions. DEMO lots: model prices generated from each vendor's published range.")
cols = ["Ref", "Vendor", "Vendor SKU", "Family", "Product", "Description", "Style", "Choice", "Defect notes", "Ply", "Flute", "L mm", "W mm", "H mm", "Print", "Coating", "Food safe",
        "Qty pcs", "MOQ pcs", "Location", "Lead days", "Vendor price", "Currency", "CBM per 1000", "kg per 1000",
        "EXW USD/pc", "FOB Karachi USD/pc", "CFR quote port USD/pc", "Offer FOB USD/pc", "Offer CFR USD/pc", "Pcs per 40HC", "Lot value FOB USD", "Price source"]
widths = [17, 26, 18, 18, 20, 32, 12, 7, 26, 6, 7, 8, 8, 8, 10, 12, 8, 11, 10, 12, 8, 11, 8, 11, 10, 11, 12, 12, 12, 12, 11, 13, 11]
header(iv, 4, cols, widths)
items = db.execute("""SELECT i.*, v.name vendor FROM items i JOIN vendors v ON v.id=i.vendor_id WHERE i.status='online' ORDER BY i.family, i.line, v.name, i.length_mm""").fetchall()
lane_rng = f"Assumptions!$A${LR0 + 1}:$A${LR1}"
rate_rng = f"Assumptions!$F${LR0 + 1}:$F${LR1}"
orig_rng, inland_rng = f"Assumptions!$A${OR0 + 1}:$A${OR1}", f"Assumptions!$B${OR0 + 1}:$B${OR1}"
for r, it in enumerate(items, 5):
    vals = [it["ref"], it["vendor"], it["vendor_sku"], it["family"], it["line"], it["description"], it["style"], it["choice"], it["defects"], it["ply"], it["flute"],
            it["length_mm"], it["width_mm"], it["height_mm"], it["print"], it["coating"], "Y" if it["food_safe"] else "N", it["qty"], it["moq"], it["location"], it["lead_days"],
            it["price"], it["currency"], round(it["cbm_per_1000"], 4), round(it["kg_per_1000"], 2)]
    for c, val in enumerate(vals, 1):
        cell = iv.cell(row=r, column=c, value=val)
        cell.font = blue if c in (18, 19, 22, 24, 25) else body
    # Z EXW, AA FOB, AB CFR, AC offer FOB, AD offer CFR, AE pcs/40, AF lot value
    iv.cell(row=r, column=26, value=f'=IF(W{r}="USD",V{r},V{r}/{FX})')
    iv.cell(row=r, column=27, value=f"=Z{r}+X{r}/1000*(IFERROR(INDEX({inland_rng},MATCH(T{r},{orig_rng},0)),15)+{FOBC})")
    iv.cell(row=r, column=28, value=f"=AA{r}+X{r}/1000*INDEX({rate_rng},MATCH({QPORT},{lane_rng},0))")
    iv.cell(row=r, column=29, value=f"=MAX(AA{r}*(1+{MARGIN}),AA{r}+{MINM})")
    iv.cell(row=r, column=30, value=f"=MAX(AB{r}*(1+{MARGIN}),AB{r}+{MINM})")
    iv.cell(row=r, column=31, value=f"=IF(X{r}>0,INT({CBM40}/X{r}*1000),0)")
    iv.cell(row=r, column=32, value=f"=R{r}*AC{r}")
    iv.cell(row=r, column=33, value="demo (model price)" if it["price_source"] == "demo-model" else it["price_source"]).font = body
    for c in range(26, 33): iv.cell(row=r, column=c).font = body
    for c in (26, 27, 28, 29, 30): iv.cell(row=r, column=c).number_format = "0.000"
    iv.cell(row=r, column=31).number_format = "#,##0"; iv.cell(row=r, column=32).number_format = "$#,##0"; iv.cell(row=r, column=18).number_format = "#,##0"
lastr = 4 + len(items)
iv.auto_filter.ref = f"A4:{get_column_letter(len(cols))}{lastr}"
tot = lastr + 2
iv.cell(row=tot, column=17, value="Totals").font = bold
iv.cell(row=tot, column=18, value=f"=SUM(R5:R{lastr})").font = bold; iv.cell(row=tot, column=18).number_format = "#,##0"
iv.cell(row=tot, column=32, value=f"=SUM(AF5:AF{lastr})").font = bold; iv.cell(row=tot, column=32).number_format = "$#,##0"
iv.cell(row=tot, column=24, value=f"=SUMPRODUCT(R5:R{lastr},X5:X{lastr})/1000").font = bold
iv.cell(row=tot, column=24).number_format = "#,##0"
iv.cell(row=tot + 1, column=24, value="← total shipping CBM").font = Font(name=F, size=9, color="62666D")
iv.cell(row=3, column=28, value="CFR port →").font = Font(name=F, size=9, color="62666D")
iv.cell(row=3, column=29, value=f"={QPORT}").font = green

# ---------------------------------------------------------------- Demo Buyers
bs = wb.create_sheet("Demo Buyers")
title(bs, "Demo buyers (FICTIONAL)", "Fictional companies and people for testing; every address is on the reserved example.com domain.")
cols = ["Company", "Country", "City", "Destination port", "Industry", "Buys", "Choice", "Min lot pcs", "Incoterm", "Status", "AM", "Contact", "Title", "Email", "Language", "Register", "Bounce", "History (purchases / RFQs)"]
header(bs, 4, cols, [36, 18, 14, 22, 22, 40, 8, 10, 9, 9, 6, 22, 6, 44, 9, 9, 8, 50])
buyers = db.execute("""SELECT b.*, fl.port, u.initials am FROM buyers b LEFT JOIN freight_lanes fl ON fl.code=b.port_code LEFT JOIN users u ON u.id=b.am_user_id ORDER BY b.name""").fetchall()
r = 5
for b in buyers:
    hist = "; ".join(f"{e['kind']} {e['line']} {e['qty']:,} pcs ({e['at']})" for e in db.execute("SELECT * FROM buyer_events WHERE buyer_id=? ORDER BY at DESC", (b["id"],)))
    for c in db.execute("SELECT * FROM contacts WHERE buyer_id=? ORDER BY primary_contact DESC", (b["id"],)):
        vals = [b["name"], b["country"], b["city"], b["port"], b["industry"], ", ".join(json.loads(b["interests"])), b["choice_pref"], b["min_order_pcs"], b["incoterm"],
                b["status"] + (f" — {b['blocked_reason']}" if b["blocked_reason"] else ""), b["am"], c["name"], c["title"], c["email"], c["language"], c["register"], c["bounce"], hist]
        for j, val in enumerate(vals, 1):
            cell = bs.cell(row=r, column=j, value=val); cell.font = body; cell.alignment = wrap; cell.border = thin
        r += 1
bs.auto_filter.ref = f"A4:{get_column_letter(len(cols))}{r - 1}"

# ---------------------------------------------------------------- Gaps
gp = wb.create_sheet("Gaps & next steps")
gp.column_dimensions["A"].width = 28; gp.column_dimensions["B"].width = 120
title(gp, "Gaps & next steps", "From the two research passes on 2026-11-11.")
gaps = [
    ("Appliance cartons (TV, fridge, AC, laptop, iron)", "No vendor names these lines publicly. Roshan Packages Ltd has the strongest link (Haier listed as a client; PSX material mentions home-appliance boxes). UBC Convertec and Falcon say they serve electronics. Next: ask Dawlance, Haier, PEL, Orient and TCL procurement who supplies their cartons; check customs data (Volza/Trademo blocked automated access)."),
    ("Liquid / milk boxes", "Tetra Pak Lahore makes aseptic carton material but sells only to filling customers, not as a traded box. Packaging Solutions (Treet) makes corrugated shipper cases for dairy/beverage. Treat liquid-contact cartons as out of scope unless a converter is found."),
    ("Cup carriers & sleeves", "Only small Lahore sellers (CustomPack.pk, Horizon Foods, Afeef, SASA cups). Weak verification, no export evidence. Ask for samples and capacity."),
    ("Fruit & vegetable crates", "Moderate: UBC Convertec, Khatri, Roshan (both), Bulleh Shah, MSM Packages. No one claims wax coating explicitly (UBC: moisture-resistant coating; Bulleh Shah: moisture-barrier fluting). Confirm wax option before quoting produce exporters."),
    ("Ration boxes", "Only Jahangir Packages shows bulk/heavy cartons explicitly; most 5-ply carton makers can produce them. Ask 3–4 carton makers for an RSC 457×305×305 5-ply quote."),
    ("Data quality", "Packages Ltd is a holding company — use Packages Convertors / Bulleh Shah rows. thalpackaging.com shows injected spam links (use thallimited.com). Printech's site is stale (2018). Horizon may be partly a distributor. Several emails differ from the earlier files; see the Research note column."),
    ("Prices", "No vendor price list was obtained. All demo lots use a board-cost model. Send each vendor the supplier template (console → Supplier template) and upload their real list to replace demo lots."),
]
for i, (k, v) in enumerate(gaps, 4):
    gp.cell(row=i, column=1, value=k).font = bold; gp.cell(row=i, column=1).alignment = wrap
    c = gp.cell(row=i, column=2, value=v); c.font = body; c.alignment = wrap
    gp.row_dimensions[i].height = 48

from openpyxl.workbook.properties import CalcProperties
wb.calculation = CalcProperties(fullCalcOnLoad=True)
out = os.path.join(OUT_DIR, f"Cardboard_Package_Vendors_and_Virtual_Inventory_{TODAY}.xlsx")
wb.save(out)
print(out, len(vendors), "vendors", len(items), "lots", len(buyers), "buyers")
