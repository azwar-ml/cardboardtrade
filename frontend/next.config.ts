import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  ...((process.env.STOCK_QA_DIST_DIR || process.env.CATALOG_QA_DIST_DIR) ? { distDir: process.env.STOCK_QA_DIST_DIR || process.env.CATALOG_QA_DIST_DIR } : {}),
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["better-sqlite3", "exceljs", "nodemailer"],
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};
export default nextConfig;
