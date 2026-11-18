# Cardboard Package · Trade
run command

backend\.venv\Scripts\python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000

cd frontend
npm run dev

Landing page for Cardboard Package's export trading model, run from Lahore. Buyers abroad send a packaging requirement, vendors in Pakistan share their inventory and capacity, and the sales team matches the two. The page is modelled on how vanillasteel.com presents steel trading, adapted for cardboard and paper packaging.

- **[VISION.md](VISION.md)** — what we are building and why.
- **[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)** — architecture, domain model, flows and roadmap for developers.
- **[REVIEW_BRIEF.md](REVIEW_BRIEF.md)** — what we would like a reviewer to check.

## Run it

Needs **Node.js 20 or newer** (`node -v`). Nothing else is required to run the website and console.

```bash
npm install
npm run dev
```

- Website: http://localhost:3000
- Trading console: http://localhost:3000/console — sign in as `admin@cardboardpackage.com` / `admin123` (admin) or `hamza@cardboardpackage.com` / `sales123` (sales).
- The first sign-in builds the demo database by itself (vendors, demo buyers, demo stock); it takes a few seconds.
- Emails are never sent: they are written to `data/outbox/` as `.eml` files unless SMTP is configured.

## Where things live

| What | Where |
|---|---|
| All page copy, products, FAQs, countries | `lib/content.ts` (lines marked `CONFIRM` are commercial promises to check) |
| Page sections | `components/*` and `app/page.tsx` |
| Buy / sell request inbox | `POST /api/request` → `data/requests.json`, attachments in `data/uploads/<id>/` |
| World map dots, port and Lahore coordinates | `lib/worldDots.json` |
| Hero background reel (Mixkit clips, graded and looped) | `public/video/hero-reel.mp4` |

## Trading console (back office)

`http://localhost:3000/console` — the internal tool for the sales team and admins, modelled on Vanilla Steel's trading console.

| Login | Role | Default password (local only — change before going live) |
|---|---|---|
| admin@cardboardpackage.com | admin | `admin123` (or `CONSOLE_ADMIN_PASSWORD`) |
| hamza@cardboardpackage.com, sana@cardboardpackage.com | sales | `sales123` (or `CONSOLE_SALES_PASSWORD`) |

**The flow**
1. **Vendors** send stock in any format. A sales user puts it into the **supplier template** (Console → Supplier template; one row = one lot) and uploads both files in **List Upload**: the raw file as sent (kept with its SHA-256) and the transformed file.
2. The **contract check** runs by itself (required columns, allowed values, mm sizes, 2nd-choice defect notes, duplicate SKUs). Rows that pass are **published** to the **virtual inventory**.
3. Every lot is priced per piece: vendor price (PKR) → EXW USD → FOB Karachi (inland freight from the city + port charges, by shipping CBM) → CFR the buyer's port (ocean freight share per 40ft HC) → offer with margin. Admins set FX, margin and freight in **Pricing & Freight**.
4. **Buyer Sendouts** (4 steps): pick vendor listings → matched buyers with a score and reasons (bought before, past RFQ, preference, choice, freight lane; 7-day cap, blocked buyers and bounced contacts are held back) → compose & review per-buyer emails (language, greeting, price basis, Excel material list priced to their port, never showing vendor names) → send.
5. **Sendout Tracking** shows every email, its .eml and attachment, and lets you log replies / bids.

**Email delivery.** Without SMTP settings, emails are written as real `.eml` files to `data/outbox/` (safe for the demo buyers, who are fictional and on example.com). To send for real set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE=1` (for 465) and `MAIL_FROM`.

**Data.** SQLite at `data/trade.db`, stored files in `data/files/`. On first login the database is seeded with 31 researched vendors (`lib/trade/seed/vendors-*.json`, with sources), 30 demo buyers (`lib/trade/seed/buyers.ts`) and demo stock lists generated per vendor (`lib/trade/seed/inventory.ts`, model prices) that go through the real upload pipeline. Delete `data/trade.db*` and `data/files` to start over.

**Deliverables** in `deliverables/` — rebuild the workbook with `python3 scripts/build_deliverables.py`:
- `Cardboard_Package_Vendors_and_Virtual_Inventory_<date>.xlsx` — vendor directory with sources, coverage matrix, assumptions, formula-priced virtual inventory, demo buyers, gaps.
- `Cardboard_Package_Supplier_Inventory_Template.xlsx` — send this to vendors.
- `Example_filled_list_Afeef_Packages_DEMO.xlsx` — what a filled list looks like.

## Brand

| Token | Hex | Use |
|---|---|---|
| Ink | `#0E1013` | Text, dark sections, primary buttons on light |
| Bone | `#F2EFE9` | Page background |
| Paper | `#FBFAF7` | Cards and alternate sections |
| Accent (carton orange) | `#E35B2C` | One action per view, the logo lid, key highlights |
| Kraft | `#B4844F` | Material details only |
| Stone / Fog | `#62666D` / `#9A9DA3` | Secondary text on light / dark |

Type: Inter Tight (headings), Inter (body), IBM Plex Mono (labels and specs).
Logo: a "C" whose lid lifts open — `components/Logo.tsx`, `public/logo-mark.svg`, `public/logo-mark-light.svg`, `app/icon.svg`.

## The film

`public/video/cardboard-package-film.mp4` (0:53, 1080p30, AAC) is generated from code at 120 BPM: every cut lands on the beat and every sound effect is placed on an on-screen event.

```bash
npm run video:audio  # synthesises video/audio.wav: music + sound design (original, royalty-free)
npm run video        # renders video/film.html → public/video/cardboard-package-film.mp4 + poster.jpg (~10 min, motion blur)
npm run video -- --fast                  # no motion blur, ~3 min
npm run video -- --stills 1.2,9.8,35.3   # quick stills in video/stills/
```

Timings in `video/film.html` and the sound cues in `video/audio.mjs` mirror each other; change both together.
Rendering needs Google Chrome and ffmpeg installed.

The first draft of the film (and the code that made it) is kept in `video/drafts/v1/`.
