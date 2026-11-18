# Developer Guide

This guide is for developers who will keep building this platform. Read [VISION.md](VISION.md) first to see what the business is trying to do. This document explains how the code does it today, where everything lives, and what is still missing.

---

## 1. The system at a glance

One Next.js app holds two products:

| Part | URL | Who uses it | What it does |
|---|---|---|---|
| **Website** | `/` | Buyers and vendors (public) | Marketing landing page, promotional film, buy/sell request form |
| **Trading console** | `/console` | Our sales team and admins (login required) | Vendor lists → virtual inventory → buyer matching → email sendouts |

```
Vendor sends stock (any format)
        │
        ▼
List Upload ── raw file kept as sent (SHA-256)
        │      + transformed file in our template
        ▼
Contract check (automatic) ──► Publish
        │
        ▼
Virtual inventory  ── priced per piece: EXW → FOB Karachi → CFR buyer port (+ margin)
        │
        ▼
Buyer Sendout:  1 Listings → 2 Matched buyers → 3 Compose & review → 4 Send
        │
        ▼
Email per buyer + Excel price list (vendor names hidden) → SMTP or local outbox
        │
        ▼
Sendout Tracking (log replies / bids)
```

## 2. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Next.js 15** (App Router, Turbopack in dev), **React 19**, TypeScript | Server Components plus Server Actions; there is no separate API server |
| Styling | **Tailwind CSS v4**; tokens in `app/globals.css` | Brand colours: ink `#0E1013`, bone `#F2EFE9`, accent `#E35B2C`, kraft `#B4844F` |
| Database | **SQLite** via `better-sqlite3` (synchronous), file `data/trade.db` | Schema is created on first connection; no migration tool yet |
| Spreadsheets | `exceljs` | Builds the supplier template, parses uploads, generates buyer price lists and exports |
| Email | `nodemailer` | SMTP when configured; otherwise writes `.eml` files to `data/outbox/` |
| Auth | Custom: scrypt password hashes plus a session-token cookie (`cp_session`) | `lib/trade/auth.ts` |
| Animation (website) | `motion` | |
| Video tooling | Playwright (headless Chrome) plus ffmpeg | Renders the promotional film from `video/film.html` |

`better-sqlite3`, `exceljs` and `nodemailer` are listed in `serverExternalPackages` in `next.config.ts`. They run on the server only, and every module under `lib/trade/` imports `server-only`.

## 3. Getting started

```bash
npm install
npm run dev -- -p 3001        # website: http://localhost:3001  · console: http://localhost:3001/console
```

On the first console login the database **seeds itself** (`lib/trade/seed.ts`). Seeding takes a few seconds and creates:
- 3 users: `admin@cardboardpackage.com` / `admin123` (admin), plus `hamza@…` and `sana@…` / `sales123` (sales). Override the passwords with `CONSOLE_ADMIN_PASSWORD` and `CONSOLE_SALES_PASSWORD`.
- Pricing settings, 18 freight lanes and 14 origin cities.
- 31 researched vendors, from `lib/trade/seed/vendors-known.json` and `vendors-gap.json`.
- 30 **fictional** demo buyers with contacts and history, from `lib/trade/seed/buyers.ts`.
- Demo stock lists for each vendor that sells finished goods, from `lib/trade/seed/inventory.ts`. These run through the **real** upload pipeline, so they also act as an integration test.

**Reset everything:** stop the server, delete `data/trade.db*` and `data/files/` (and `data/outbox/` if you want), then start the server again and log in.

### Environment variables

| Variable | Purpose |
|---|---|
| `CONSOLE_ADMIN_PASSWORD`, `CONSOLE_SALES_PASSWORD` | Seed passwords (used only when the database is first created) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE=1` | Turn on real email sending. **If none are set, nothing is ever sent.** |
| `MAIL_FROM` | Sender address (default `trade@cardboardpackage.com`) |

> ⚠️ The demo buyers use `@<company>.example.com` addresses, which are reserved and can never be delivered. **Delete the demo buyers before you turn on SMTP.**

## 4. Repository map

```
app/
  page.tsx, layout.tsx, globals.css     Website (landing page) + global styles
  api/request/route.ts                  Website form → data/requests.json (+ attachments in data/uploads/)
  console/login/page.tsx                Login
  console/(app)/layout.tsx              Console shell: auth gate + sidebar
  console/(app)/page.tsx                Overview dashboard
  console/(app)/inventory/              Virtual inventory table (filters, pricing/specs views)
  console/(app)/uploads/                List Upload: list, new (form), [id] (check results + publish)
  console/(app)/vendors/                Vendor directory + profile
  console/(app)/buyers/                 Buyers + profile (contacts, history)
  console/(app)/sendouts/new/           Sendout step 1: listings
  console/(app)/sendouts/[id]/buyers/   Step 2: matched buyers
  console/(app)/sendouts/[id]/compose/  Step 3: compose & review
  console/(app)/sendouts/[id]/send/     Step 4: send + per-message results
  console/(app)/sendouts/page.tsx       Sendout tracking
  console/(app)/admin/pricing|users/    Admin only
  api/console/template/                 Blank supplier template download
  api/console/inventory/export/         Internal inventory export (includes vendor + cost build-up)
  api/console/files/[...path]/          Authenticated download of stored files and outbox .eml
  api/console/logout/
components/                             Website sections
components/console/                     Console UI (Sidebar, ui primitives, client pickers)
lib/content.ts                          ALL website copy (edit text here, not in components)
lib/trade/                              ★ Business logic — start reading here
  catalog.ts     Product lines, allowed values, origin cities, ports, constants
  db.ts          SQLite connection + schema (+ get/setSetting, json helper)
  auth.ts        Login, sessions, requireUser(role?)
  password.ts    scrypt hashing
  template.ts    Supplier template: column spec, workbook builder, parser, contract check
  uploads.ts     Store files, create upload, run check, publish to inventory
  pricing.ts     Volume (CBM) estimation and per-piece quote: EXW → FOB → CFR → offer
  inventory.ts   Inventory query with filters
  match.ts       Buyer matching + scoring + exclusions (7-day cap, blocked, bounced)
  mail.ts        Compose per buyer, build buyer Excel, deliver (SMTP / outbox)
  sendout.ts     Sendout lifecycle: draft → messages → send
  seed.ts        First-run seeding
  seed/          Vendor research JSON, demo buyers, demo stock generator
lib/worldDots.json                      Dot world map + port coordinates (website + film)
scripts/build_deliverables.py           Rebuilds the vendor/inventory Excel deliverable from the DB
deliverables/                           Excel files for the business (template, directory, example)
video/                                  Promotional film source (film.html, audio.mjs, render.mjs); drafts/v1 archived
data/                                   Runtime data (git-ignored): trade.db, files/, outbox/, uploads/
```

## 5. Domain model

| Table | Meaning | Key fields |
|---|---|---|
| `users` | Console users | `role` = `admin` \| `sales`, `initials` (shown as AM), `active` |
| `sessions` | Login sessions (12 h) | `token`, `user_id`, `expires_at` |
| `settings` | Key/value pricing settings | `fx_pkr_per_usd`, `margin_pct`, `fob_usd_per_cbm`, `min_margin_usd_per_pc`, `seeded` |
| `freight_lanes` | Destination ports and ocean freight from Karachi | `code` (UN/LOCODE), `rate_40hc_usd`, `transit_days`, `active` |
| `origins` | Pick-up cities and inland freight to Karachi | `city`, `inland_usd_per_cbm` |
| `vendors` | Suppliers | `code`, contacts, `product_lines` (JSON), `evidence`, `sources` (JSON), `confidence`, `status` = prospect \| onboarding \| active \| blocked, `am_user_id` |
| `uploads` | One vendor list submission | `raw_files` (JSON of stored files with SHA-256), `transformed_file`, `status` = uploaded → checked \| failed → published \| superseded, `issues`, `parsed` |
| `items` | **Virtual inventory**: one row per lot | `ref` (`CPI-YYMMDD-XXXXXX`), `line`, `family`, `choice` (1st/2nd), `defects`, `ply`, `flute`, `length/width/height_mm`, `qty`, `moq`, `price`, `currency`, `price_pkr`, `price_source` (`vendor` / `demo-model`), `cbm_per_1000`, `kg_per_1000`, `location`, `status` = online \| reserved \| sold \| offline |
| `buyers` | Buyer companies | `port_code`, `interests` (JSON of product lines), `choice_pref` = 1st \| 2nd \| mixed, `min_order_pcs`, `incoterm`, `status`, `is_demo` |
| `contacts` | Buyer contacts | `language` (EN/DE/FR/AR), `register` (Formal/Informal), `bounce` = none \| soft \| hard, `primary_contact` |
| `buyer_events` | Purchase and RFQ history | `kind` = purchase \| rfq, `line`, `qty`, `at` — these drive matching signals |
| `sendouts` | A batch offer to buyers | `upload_ids` (JSON listings), `excluded_buyer_ids`, base `subject`/`body`, `options` (JSON), `sender_id`, `status` = draft \| sent |
| `sendout_messages` | One email per buyer | `contact_id`, `score`, `signals`, `item_ids`, `subject`, `body`, `overridden` (hand-edited), `attachment`, `status` = queued \| sent \| outbox \| failed \| replied, `eml_path`, `reply_note` |

**Vocabulary**
- **Listing**: a *published upload*, meaning one vendor's list with online lots. Sendout step 1 picks listings.
- **Lot / item**: identical pieces at one location, available for sale.
- **1st / 2nd choice**: 1st means prime, made to spec and certifiable. 2nd means commercial seconds or stock lots, sold as is (defect notes required). See `CHOICE_NOTES` in `catalog.ts`.

## 6. Core flows in detail

### 6.1 List Upload (`lib/trade/template.ts`, `lib/trade/uploads.ts`)
- **The template is the contract.** `COLUMNS` in `template.ts` defines every column: key, header, required flag, type, allowed values and help text. That one array drives:
  - the Excel template (`templateWorkbook`), including dropdowns and the READ ME sheet;
  - the parser (`readTabular`), which finds the header row by "Supplier SKU", reads `.xlsx` or `.csv`, and ignores rows whose SKU starts with `EXAMPLE`;
  - the contract check (`checkRows`): errors block a row, warnings don't.
- **Flow:**
  1. `createUpload` stores the files (content-addressed under `data/files/YYYY-MM/<sha12>-name`).
  2. It calls `runCheck` immediately, which sets the status to `checked` or `failed`.
  3. A user publishes (`publishUpload`), which turns passing rows into `items` with computed `price_pkr`, `cbm_per_1000` and `kg_per_1000`.
  4. Optionally, publishing first takes the vendor's previous online lots offline.
- **The raw file is never parsed.** It is the record of what the vendor actually sent. Converting a PDF, photo or WhatsApp message into the template is currently manual (see §9).

### 6.2 Pricing (`lib/trade/pricing.ts`)
```
EXW USD/pc   = price_pkr ÷ fx_pkr_per_usd
FOB KHI      = EXW + CBM/pc × (inland_usd_per_cbm[origin city] + fob_usd_per_cbm)
CFR port     = FOB + CBM/pc × (rate_40hc_usd ÷ 68)
Offer        = max(cost × (1 + margin_pct), cost + min_margin_usd_per_pc)
```
- **CBM per piece** is exact when the vendor gives bundle quantity and size. Otherwise `volumeOf` estimates it from the flat blank: `flatArea` × ply thickness (`PLY_THICKNESS_MM`) × a 1.18 packing factor.
- `CBM_PER_40HC = 68` is the usable volume.
- All rates are **defaults to confirm with a forwarder**. Admins edit them in Pricing & Freight.
- `scripts/build_deliverables.py` reproduces this same formula as Excel formulas. **If you change the pricing logic, update both places.**

### 6.3 Matching (`lib/trade/match.ts`)
For the selected listings, `matchBuyers(uploadIds)` loads the online items and evaluates every buyer:
1. **Fit**: a lot matches if its line is in the buyer's interests, purchases or RFQs; its choice matches the buyer's `choice_pref` (`mixed` accepts both); and its quantity is at least the buyer's `min_order_pcs`. Buyers with no fitting lot are left out.
2. **Score** (capped at 100), built from these signals:

   | Signal | Points |
   |---|---|
   | Bought this line before (last 24 months) | 35 |
   | Past RFQ for this line | 25 |
   | Declared preference | 15 |
   | Strict 1st- or 2nd-choice buyer whose lots are all that choice | 10 |
   | A freight lane exists to the buyer's port | 10 |
   | Coverage: share of the listing's lots that fit | up to 15 |
   | Base | 5 |

3. **Held back** (shown greyed with the reason): the buyer is blocked; has no usable contact (only hard-bounced ones); or was sent anything within `CAP_DAYS = 7`.

Tune the weights in this one function. They are deliberately simple and readable.

### 6.4 Sendout (`lib/trade/sendout.ts`, `lib/trade/mail.ts`)
- **Step 1:** `createDraft(uploadIds)` creates a sendout with the default subject, body and options.
- **Step 2:** the user un-ticks buyers; they are stored in `excluded_buyer_ids`. Then `generateMessages` runs.
- **Step 3:** `generateMessages` writes one `sendout_message` per included buyer through `composeFor`:
  - The base body holds variables (`{week} {lines} {count} {pcs} {origins} {priceLine} {company}`).
  - The greeting and sign-off are added in the contact's language and register (`GREET`).
  - An optional "picked for you" line is built from the good signals.
  - Hand-edited messages (`overridden = 1`) survive "Save & update". Only "Regenerate all" overwrites them.
- **Step 4:** `sendAll` processes each queued message:
  - It builds the buyer's Excel list with `buildAttachment`. This file has **no vendor names**. Prices are CFR the buyer's port or FOB, or "Make best offer" when prices are switched off.
  - It then calls `deliver()`: SMTP if configured, otherwise a real `.eml` in `data/outbox/sendout-<id>/`.
  - Finally it marks the sendout `sent`.
- **Test send:** "Send test to me" writes a test email to the signed-in user and records nothing against the buyer.
- **Tracking:** on the send page, "Log reply" sets the message to `replied` and saves a note (for example, a bid).

### 6.5 Auth and roles (`lib/trade/auth.ts`)
- Every console page and Server Action calls `await requireUser()`. Admin-only pages call `requireUser("admin")`. **Add this to anything new you build.**
- **Admin:** Pricing & Freight, Users, and blocking vendors or buyers.
- **Sales:** everything else.
- You cannot demote or deactivate your own account.

### 6.6 The website (`app/page.tsx`, `components/`, `lib/content.ts`)
- All copy, product lists, FAQs and countries live in `lib/content.ts`. Edit text there.
- The buy/sell form posts to `POST /api/request`, which appends to `data/requests.json` and saves attachments under `data/uploads/<id>/`.
- **That form is not yet connected to the console** (see §9).

## 7. Conventions

- **Business logic lives in `lib/trade/`.** Pages stay thin: they read with a function from `lib/trade` and mutate through a Server Action defined in the page file. Every action re-checks auth.
- **Synchronous SQLite.** Use `db().prepare(...)` and wrap multi-row writes in `db().transaction(() => …)()`. JSON columns are read with `json(str, fallback)`.
- **Never expose vendor identity to buyers.** That covers emails, attachments and anything public. The internal inventory export is the only place vendor names and cost build-up appear together. Keep it internal.
- **Demo data must stay clearly marked.** Use `price_source = 'demo-model'` for generated prices, `is_demo = 1` for buyers, and `example.com` for demo emails.
- **UI:** use the primitives in `components/console/ui.tsx` (`PageHead`, `Panel`, `Pill`, `Th`/`Td`, formatters) and the CSS utilities in `globals.css` (`btn`, `btn-ink`, `btn-accent`, `field`, `field-label`, `label-mono`). Keep to rectangular controls, hairline borders, mono labels and one accent colour per view.
- **Checks before you commit:** `npx tsc --noEmit` and `npx eslint .`.

## 8. Testing

There is no automated test suite yet. The flows were verified with ad-hoc Playwright scripts:
1. Upload a file with one good row and one bad row: expect "1 / 2 rows pass".
2. Publish it.
3. Run a sendout across two listings: expect matched buyers, then compose, test send and send, with emails landing in the outbox.
4. Open an admin page as a sales user: expect a redirect to `/console?denied=1`.

**Recommended first task:** turn those scripts into a committed Playwright suite (`tests/e2e`), and add unit tests for `checkRows`, `quote`/`volumeOf` and `matchBuyers`. These are pure and easy to test.

## 9. Known gaps and suggested roadmap

Roughly in priority order:

1. **Production readiness**
   - `next build` passes (2026-11-11), but production mode (`npm start`) has not been exercised end to end. Do that first.
   - Replace the default passwords. Add password reset and rate-limited login.
   - Move to a hosted database (Postgres) if more than one server instance will run. SQLite is fine on a single box.
   - Add a migration tool. The schema is currently `CREATE TABLE IF NOT EXISTS` in `db.ts`, so column changes need a manual `ALTER TABLE`.
   - File storage is the local disk (`data/files`). Move it to object storage for hosting.
2. **Real data**
   - Onboard vendors. Their real lists replace the `demo-model` lots: publishing with "take previous lots offline" does this automatically.
   - Replace the demo buyers with real ones, and do it before turning on SMTP.
3. **Website → console**
   - Turn website buy/sell requests (`data/requests.json`) into console records: buyer RFQs (which feed the "Past RFQ" signal) and vendor leads.
4. **Raw-file conversion**
   - Assist the manual "transform into template" step, for example by extracting tables from PDF and Excel and parsing pasted WhatsApp/email text into rows for review. The design deliberately keeps a human check before publishing.
5. **Deals**
   - Buyer bids are currently a free-text "reply note". Add structured bids per lot, reservations (item `status = reserved`), sold items, and an opportunities/deals view, as in Vanilla Steel.
6. **Photos on request**
   - Lots already record `photos` (Y/N). Add photo upload per lot and a "send photos" action, from the backend only, as the vision states.
7. **Email**
   - Bounce handling (webhooks to set `contacts.bounce`), open/reply tracking, more languages in `GREET`, and reviewed translations of the body (it is base English today).
8. **Vendor coverage**
   - Appliance cartons, liquid/milk boxes and cup carriers are thin. See the "Gaps & next steps" sheet in `deliverables/`.
9. **Matching**
   - Add distance/transit weighting, price competitiveness against the buyer's past prices, and a "research lane" of new prospect buyers, as in Vanilla Steel's console.

## 10. Other assets in this repository

- **Promotional film:** `video/film.html` (a timeline-driven 1920×1080 stage), `video/audio.mjs` (synthesised music and sound effects at 120 BPM) and `video/render.mjs` (frame-by-frame render with motion blur via Playwright and ffmpeg). Cue times in `film.html` and `audio.mjs` mirror each other, so change both together. The v1 draft is archived in `video/drafts/v1/`.
- **Deliverables:** rebuild `deliverables/Cardboard_Package_Vendors_and_Virtual_Inventory_<date>.xlsx` with `python3 scripts/build_deliverables.py`. It needs `openpyxl` and reads `data/trade.db`.
- **Research provenance:** vendor facts come from public sources checked on 2026-11-11 and are listed per vendor in `lib/trade/seed/vendors-*.json` and on each vendor page. Verify a vendor before quoting their details to anyone.
