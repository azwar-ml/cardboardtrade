// Product taxonomy, allowed values and reference data shared by uploads, inventory, matching and pricing.

export const FAMILIES = ["Electronic Appliances", "Food & Beverages", "Cartons", "Paper Products"] as const;

export const PRODUCT_LINES = [
  { line: "TV Box", family: "Electronic Appliances" },
  { line: "Refrigerator", family: "Electronic Appliances" },
  { line: "Air Conditioners", family: "Electronic Appliances" },
  { line: "Laptop", family: "Electronic Appliances" },
  { line: "Iron Box", family: "Electronic Appliances" },
  { line: "Pizza", family: "Food & Beverages" },
  { line: "Fruit & Vegetable Crates", family: "Food & Beverages" },
  { line: "Liquid / Milk Box", family: "Food & Beverages" },
  { line: "Ration Box", family: "Cartons" },
  { line: "Shipping Box", family: "Cartons" },
  { line: "Universal Carton", family: "Cartons" },
  { line: "Paper Bag", family: "Paper Products" },
  { line: "Shopping Bag", family: "Paper Products" },
  { line: "Beverages", family: "Paper Products" },
] as const;
export type ProductLine = (typeof PRODUCT_LINES)[number]["line"];
export const LINES = PRODUCT_LINES.map((p) => p.line) as string[];
export const familyOf = (line: string) => PRODUCT_LINES.find((p) => p.line === line)?.family ?? "Cartons";

export const STYLES = ["RSC", "FOL", "Die-cut", "Telescope", "Tray", "Crate", "Mailer", "Pizza box", "Liquid carton", "Bag – SOS", "Bag – flat", "Bag – rope handle", "Bag – flat handle", "Cup carrier", "Cup sleeve", "Other"];
export const CHOICES = ["1st", "2nd"] as const;
export const PLIES = ["Board", "3", "5", "7"];
export const FLUTES = ["—", "E", "B", "C", "EB", "BC", "BCB", "EBC"];
export const PRINTS = ["Plain", "1-colour", "2-colour", "3-colour", "4-colour"];
export const COATINGS = ["None", "Wax", "PE", "Aqueous", "Varnish", "Water-resistant"];
export const DIM_TYPES = ["Internal", "External", "Flat"];
export const CURRENCIES = ["PKR", "USD"];
export const ITEM_STATUSES = ["online", "reserved", "sold", "offline"] as const;

/** 1st / 2nd choice definitions used in templates, emails and the console. */
export const CHOICE_NOTES = {
  "1st": "Prime: produced to the stated spec, no defects, full certification available.",
  "2nd": "Commercial seconds or stock lots: minor print shift, colour variance, overruns or small dimension tolerance. Sold as is; no certificates.",
};

/** Origin cities we pick up from, with inland freight to Karachi port (USD per CBM). CONFIRM with forwarder. */
export const ORIGINS: Record<string, number> = {
  Karachi: 2, Hub: 3, Lahore: 14, Kasur: 14, Sheikhupura: 14, Faisalabad: 13, Sialkot: 15, Gujranwala: 15, Multan: 11, Islamabad: 16, Rawalpindi: 16, Peshawar: 17, Swabi: 17, Hyderabad: 4,
};
export const ORIGIN_CITIES = Object.keys(ORIGINS);
export const DEFAULT_INLAND_USD_PER_CBM = 15;

/** Destination ports with default ocean freight for a 40ft HC from Karachi (USD). CONFIRM with forwarder. */
export const PORTS = [
  { code: "AEJEA", port: "Jebel Ali", country: "United Arab Emirates", region: "Gulf & Middle East", rate40: 900, transit: 5 },
  { code: "SADMM", port: "Dammam", country: "Saudi Arabia", region: "Gulf & Middle East", rate40: 1100, transit: 7 },
  { code: "SAJED", port: "Jeddah", country: "Saudi Arabia", region: "Gulf & Middle East", rate40: 1300, transit: 9 },
  { code: "QADOH", port: "Doha (Hamad)", country: "Qatar", region: "Gulf & Middle East", rate40: 1150, transit: 7 },
  { code: "OMSOH", port: "Sohar", country: "Oman", region: "Gulf & Middle East", rate40: 850, transit: 4 },
  { code: "NLRTM", port: "Rotterdam", country: "Netherlands", region: "Europe & UK", rate40: 2400, transit: 24 },
  { code: "DEHAM", port: "Hamburg", country: "Germany", region: "Europe & UK", rate40: 2500, transit: 26 },
  { code: "GBFXT", port: "Felixstowe", country: "United Kingdom", region: "Europe & UK", rate40: 2450, transit: 25 },
  { code: "PLGDN", port: "Gdańsk", country: "Poland", region: "Europe & UK", rate40: 2650, transit: 28 },
  { code: "USNYC", port: "New York", country: "United States", region: "North America", rate40: 4200, transit: 32 },
  { code: "USHOU", port: "Houston", country: "United States", region: "North America", rate40: 4500, transit: 35 },
  { code: "CATOR", port: "Toronto (via Montreal)", country: "Canada", region: "North America", rate40: 4700, transit: 36 },
  { code: "KEMBA", port: "Mombasa", country: "Kenya", region: "Africa", rate40: 1600, transit: 12 },
  { code: "ZADUR", port: "Durban", country: "South Africa", region: "Africa", rate40: 2100, transit: 18 },
  { code: "DJJIB", port: "Djibouti", country: "Djibouti", region: "Africa", rate40: 1500, transit: 9 },
  { code: "LKCMB", port: "Colombo", country: "Sri Lanka", region: "Asia Pacific", rate40: 800, transit: 5 },
  { code: "MYPKG", port: "Port Klang", country: "Malaysia", region: "Asia Pacific", rate40: 950, transit: 10 },
  { code: "AUSYD", port: "Sydney", country: "Australia", region: "Asia Pacific", rate40: 2900, transit: 22 },
];
export const portByCode = (c: string | null | undefined) => PORTS.find((p) => p.code === c);
export const CBM_PER_40HC = 68;   // usable

/** Sheet thickness (mm) per ply, used to estimate the shipping volume of knocked-down cartons. */
export const PLY_THICKNESS_MM: Record<string, number> = { Board: 0.6, "3": 3.6, "5": 6.6, "7": 10.5 };

/** Indicative factory price model (PKR per m² of board) — used only to generate demo stock. Replace with vendor quotes. */
export const BOARD_PKR_PER_M2: Record<string, number> = { Board: 42, "3": 62, "5": 104, "7": 152 };
