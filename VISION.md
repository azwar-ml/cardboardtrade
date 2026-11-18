# Cardboard Package — Project Vision

> **Buy and sell cardboard effortlessly.**
> Buying and selling cardboard packaging doesn't have to be a headache. Cardboard Package brings you the best offer — and handles the entire process for you.

## What we are building

Cardboard Package is an export trading business for cardboard and paper packaging, run from **Lahore, Pakistan**. It follows the business model of [Vanilla Steel](https://vanillasteel.com/), applied to our line of products instead of steel.

We do not run a factory and we are not a marketplace. We sit between Pakistani packaging manufacturers and buyers outside Pakistan:

- **Vendors (suppliers)** reach out to us and give us their inventory.
- We hold that inventory as a **virtual inventory** in our system.
- Our **sales team** matches it with buyers abroad, sends them offers, and handles the deal.

## How it works

### Supply: vendors and the virtual inventory

- Vendors provide their inventory to us in a **specified format**: our Excel template. They can also send it as Excel, PDF, images (JPG), or text, and we convert it.
- We can also upload a vendor's file ourselves, for example from a catalogue or price list we find online.
- Every item in the virtual inventory carries what a buyer needs to decide: **product, dimensions, specification, quantity, vendor price, and shipping price**.
- **We add the shipping price from our side**, so buyers receive a price delivered to their port.
- **We grade the inventory: 1st choice, 2nd choice**, and so on.
- **Pictures are not needed for now.** If a buyer asks, we can send them, and that request is handled from the backend.

### Demand: buyers and sendouts

The sales team runs **buyer sendouts**, which are kept very simple:

1. Choose the vendor listings to offer.
2. See **which buyers they match**.
3. **Compose and review** the email for each buyer.
4. **Send**. The email goes out to that buyer automatically.

### Who uses the platform

- **Admin view**: full control of the platform, its settings, pricing and users.
- **Sales team**: uses the functionality we provide to manage inventory and send offers through the platform.

## Product lines

These are the products we currently have vendors for, for export outside Pakistan:

| Family | Products |
|---|---|
| Electronic Appliances | TV Box, Refrigerator, Air Conditioners, Laptop, Iron Box |
| Food & Beverages | Pizza, Fruit & Vegetable Crates, Liquid / Milk Box |
| Cartons | Ration Box, Shipping Box, Universal Carton |
| Paper Products | Paper Bag, Shopping Bag, Beverages (cup carriers and sleeves) |

## What we promise customers

These promises are adapted from Vanilla Steel's model. They are marked `CONFIRM` in `lib/content.ts` and still need business sign-off:

- **One request, in any format.** Buyers and vendors can send us spreadsheets, PDFs, photos or messages.
- **An offer within 48 hours.**
- **One partner from factory to port**: inspection, freight and paperwork handled.
- **No fees or commission on top.** We are the direct counterparty: buyers buy from us and vendors sell to us.
- **Discretion**: vendor names and prices are never shown to buyers.

## Where this stands today

- **Website**: a public landing page with a promotional film. It presents the model to buyers and vendors, and its form collects buy and sell requests.
- **Trading console**: the back office (`/console`), covering the supply → matching → sendout flow above.
- **Research**: 31 real Pakistani packaging vendors, each with sources.
- **Demo data**: all buyers are fictional, and the demo inventory uses modelled prices. Both are to be replaced with real data as vendors are onboarded.
- **Gaps**: vendor coverage is thinnest for electronic appliance cartons, liquid/milk boxes and cup carriers. See the "Gaps & next steps" sheet in the deliverables workbook.
