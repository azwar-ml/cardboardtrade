const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const checks = [
  ["public home", `${base}/`],
  ["admin login route", `${base}/console/login`],
  ["anonymous admin guard", `${base}/console/admin/agents`],
  ["buyers page guard", `${base}/console/buyers`],
  ["pricing page guard", `${base}/console/admin/pricing`],
];
let failed = 0;
for (const [name, url] of checks) {
  const response = await fetch(url, { redirect: "manual" });
  const ok = name === "public home" || name === "admin login route" ? response.status === 200 : [302, 307, 308].includes(response.status);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${response.status}${response.headers.get("location") ? ` -> ${response.headers.get("location")}` : ""}`);
  if (!ok) failed++;
}
if (failed) process.exitCode = 1;
