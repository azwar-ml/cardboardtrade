// All copy for the landing page lives here so the business team can edit it in one place.
// Lines marked "CONFIRM" are commercial promises — check them with the business before going live.

export const site = {
  name: "Cardboard Package",
  email: "trade@cardboardpackage.com", // CONFIRM: inbox for buy/sell requests
  address: "Lahore, Pakistan", // CONFIRM: full office address
  tagline: "Your export partner for sourcing and selling cardboard packaging.",
};

export const nav = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#products", label: "Products" },
  { href: "#export", label: "Export" },
  { href: "#faq", label: "FAQ" },
];

export const hero = {
  eyebrow: "Lahore, Pakistan · Export packaging trade",
  title: "Buy and sell cardboard effortlessly.",
  body: "Buying and selling cardboard packaging doesn’t have to be a headache. Cardboard Package brings you the best offer from verified Pakistani manufacturers — and handles the entire process for you.",
};

export const promise = [
  { value: "48h", label: "to a firm offer" }, // CONFIRM
  { value: "1", label: "partner from factory to port" },
  { value: "0", label: "fees or commission on top" }, // CONFIRM
];

export const modern = {
  eyebrow: "Why us",
  title: "Packaging trade needs a modern touch",
  body: "Pakistan has hundreds of capable corrugated and paper mills, but finding the right one for an export order still runs on phone calls and guesswork. From our base in Lahore, we combine years on the factory floor with structured matching to make it simple.",
  points: [
    { title: "The best offer, fast and discreet", body: "Tell us what you need once. We go to the vendors, compare price, capacity and lead time, and come back with one clear offer." },
    { title: "Fits the way you already work", body: "Send a spec sheet, a PDF drawing, a photo of a sample or a WhatsApp voice note. No portal, no new software." },
    { title: "Quality, logistics and payment handled", body: "We inspect before loading, book the container and manage documents — so you deal with one partner, not five." },
  ],
};

export const comparison = {
  title: "Our solution? A frictionless experience",
  without: {
    label: "The old way",
    items: [
      "Weeks of calls, emails and sample couriers with mills you’ve never met",
      "Prices that change after you place the order",
      "Inconsistent board quality, GSM and print between batches",
      "You arrange inspection, freight, customs and payment yourself",
    ],
  },
  with: {
    label: "With Cardboard Package",
    items: [
      "One request, in any format",
      "A firm offer within 48 hours", // CONFIRM
      "Verified vendors across Pakistan through a single partner",
      "Pre-shipment inspection, freight and export paperwork included",
    ],
  },
};

export type Side = "buyer" | "seller";

export const sides: Record<Side, {
  tab: string; title: string; body: string; cta: string;
  benefits: { title: string; body: string }[];
  steps: { title: string; body: string }[];
}> = {
  buyer: {
    tab: "I’m buying",
    title: "Find the packaging you need, when you need it",
    body: "Importers, brands, distributors and manufacturers abroad use us to source export-grade cartons and paper packaging without flying to Pakistan.",
    cta: "Buy now",
    benefits: [
      { title: "Offers in 48 hours", body: "A firm price, lead time and spec — not a ballpark." }, // CONFIRM
      { title: "Flexible payment terms", body: "LC, advance or staged payments to suit your order." }, // CONFIRM
      { title: "Verified vendors", body: "Every mill is visited and checked before it quotes for you." },
      { title: "Delivered to your port", body: "FOB Karachi or CFR to your nearest port, fully documented." },
    ],
    steps: [
      { title: "Share your requirement", body: "Box type, size, ply, GSM, print and quantity. Any format works — even a photo." },
      { title: "We match it to vendor capacity", body: "Our sales team checks your spec against vendor stock and production slots across Pakistan." },
      { title: "Accept and relax", body: "Approve the offer. We handle production follow-up, inspection, loading and shipping." },
    ],
  },
  seller: {
    tab: "I’m selling",
    title: "Sell packaging abroad, without the legwork",
    body: "Corrugated box makers, carton plants and paper bag manufacturers in Pakistan use us as their export sales desk.",
    cta: "Sell now",
    benefits: [
      { title: "Export orders, steady volume", body: "Fill production lines with buyers you couldn’t reach alone." },
      { title: "Secure, on-time payment", body: "We are your counterparty, so you never chase a foreign buyer." }, // CONFIRM
      { title: "Logistics handled", body: "We collect from your factory and take care of freight and paperwork." },
      { title: "Stay anonymous", body: "Your company name and prices are only shared with serious, matched buyers." },
    ],
    steps: [
      { title: "Share your inventory and capacity", body: "Send stock lists, machine capacity or a catalogue — Excel, PDF or photos." },
      { title: "We match it with export demand", body: "Our sales team matches your products against live buyer requests worldwide." },
      { title: "Approve the order", body: "Confirm the offer, produce to spec and we arrange inspection, pickup and payment." },
    ],
  },
};

export type ProductItem = { name: string; icon: string; spec: string };
export type ProductFamily = { id: string; name: string; blurb: string; image: string; items: ProductItem[] };

export const productFamilies: ProductFamily[] = [
  {
    id: "electronics",
    name: "Electronic Appliances",
    blurb: "Heavy-duty 5 and 7-ply cartons with inserts, built to survive container stacking and last-mile drops.",
    image: "/img/products/Carton.png",
    items: [
      { name: "TV Box", icon: "tv", spec: "5–7 ply · up to 85″" },
      { name: "Refrigerator", icon: "fridge", spec: "7 ply · full-height" },
      { name: "Air Conditioners", icon: "ac", spec: "Indoor & outdoor units" },
      { name: "Laptop", icon: "laptop", spec: "E-flute · printed" },
      { name: "Iron Box", icon: "iron", spec: "3 ply · retail print" },
    ],
  },
  {
    id: "food",
    name: "Food & Beverages",
    blurb: "Food-safe board, ventilated crates and moisture-resistant liquid packaging for growers and food brands.",
    image: "/img/products/product_p_4_1.jpg",
    items: [
      { name: "Pizza", icon: "pizza", spec: "E & B flute · 6–16″" },
      { name: "Fruit & Vegetable Crates", icon: "crate", spec: "Ventilated · wax option" },
      { name: "Liquid / Milk Box", icon: "milk", spec: "Coated · bulk & retail" },
    ],
  },
  {
    id: "cartons",
    name: "Cartons",
    blurb: "The workhorses of export — regular slotted cartons in every size, plain or printed, from 3 to 7 ply.",
    image: "/img/products/Ration_Box.png",
    items: [
      { name: "Ration Box", icon: "ration", spec: "3–5 ply · bulk" },
      { name: "Shipping Box", icon: "shipping", spec: "3–10 kg rated" },
      { name: "Universal Carton", icon: "carton", spec: "RSC · any size" },
    ],
  },
  {
    id: "paper",
    name: "Paper Products",
    blurb: "Kraft and white paper bags for retail, food service and beverages — plastic-free and fully printable.",
    image: "/img/products/product_k_6_1.png",
    items: [
      { name: "Paper Bag", icon: "paperbag", spec: "Kraft · flat or SOS" },
      { name: "Shopping Bag", icon: "shoppingbag", spec: "Twisted rope handle" },
      { name: "Beverages", icon: "cup", spec: "Cup carriers & sleeves" },
    ],
  },
];

export const smart = {
  eyebrow: "Smart matching",
  title: "Matching that knows packaging",
  body: "Behind our sales team is a matching engine that reads specs the way a box maker does.",
  points: [
    { title: "Reads any request", body: "Pulls box type, dimensions, ply, flute, GSM and print from spreadsheets, drawings, emails or photos." },
    { title: "Knows real capacity", body: "Tracks each vendor’s machines, board stock and open production slots, so offers are ones they can actually deliver." },
    { title: "Prices with the market", body: "Factors in kraft paper prices, freight rates and exchange rates, so your offer holds." },
  ],
};

export const exportLanes = {
  eyebrow: "Export",
  title: "From Pakistani mills to your warehouse",
  body: "Run from Lahore, shipped through Karachi and Port Qasim. FOB, or CFR to your nearest port, in full container or consolidated loads.", // CONFIRM
  regions: [
    { name: "Gulf & Middle East", ports: "Jebel Ali · Dammam · Doha" },
    { name: "Europe & UK", ports: "Rotterdam · Hamburg · Felixstowe" },
    { name: "North America", ports: "New York · Houston · Toronto" },
    { name: "Africa", ports: "Mombasa · Durban · Djibouti" },
    { name: "Asia Pacific", ports: "Colombo · Port Klang · Sydney" },
  ],
};

export const faqs = [
  { q: "Why was Cardboard Package created?", a: "Buyers abroad struggle to find reliable packaging mills in Pakistan, and good mills struggle to reach export buyers. We sit in the middle, match the two and take care of everything in between." },
  { q: "Are there any additional fees?", a: "No. The price in your offer includes our service, inspection and the logistics stated in it. There is no commission on top." }, // CONFIRM
  { q: "Do I need to register?", a: "No account, no portal. Send a request through the form below or email us, and your account manager takes it from there." },
  { q: "How fast can a deal be done?", a: "Standard cartons and bags often get an offer within hours. Custom, printed or very large orders usually take up to 48 hours." }, // CONFIRM
  { q: "Is this a marketplace?", a: "No. We don’t publish listings or broadcast your request. Our sales team matches each request privately with the vendors who fit it best." },
  { q: "Are you an agent?", a: "No. We are your direct counterparty. Buyers buy from us and vendors sell to us, so each side has one contract and one point of contact." },
  { q: "How do you guarantee quality?", a: "Every vendor is visited and verified before they quote. Each order is checked against the agreed spec — board grade, GSM, burst strength, print and dimensions — before it is loaded." },
  { q: "What can you supply?", a: "Corrugated cartons from 3 to 7 ply, appliance and electronics boxes, food and beverage packaging, fruit and vegetable crates, and kraft paper bags. Plain or printed, in standard or custom sizes." },
];

export const subjects = ["Buying request", "Selling request", "General inquiry"] as const;

export const countries = [
  "Pakistan", "United Arab Emirates", "Saudi Arabia", "Qatar", "Oman", "Kuwait", "Bahrain", "United Kingdom", "Germany",
  "Netherlands", "France", "Italy", "Spain", "Poland", "Belgium", "Sweden", "United States", "Canada", "Australia",
  "Malaysia", "Sri Lanka", "Bangladesh", "Kenya", "South Africa", "Nigeria", "Egypt", "Turkey", "Other",
];
