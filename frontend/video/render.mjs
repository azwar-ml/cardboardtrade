// Renders video/film.html to public/video/cardboard-package-film.mp4, frame by frame, with real motion blur.
//   npm run video                       full render (needs Google Chrome + ffmpeg), ~10 min
//   npm run video -- --fast             no motion blur, ~3 min (for checking timing)
//   npm run video -- --stills 1,9.5,20  save stills to video/stills/ for a quick look
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FPS = 30, DURATION = 53;
const OUT = path.join(ROOT, "public/video/cardboard-package-film.mp4");
const POSTER = path.join(ROOT, "public/video/poster.jpg");
const AUDIO = path.join(ROOT, "video/audio.wav");
const POSTER_T = 29.8;

const args = process.argv.slice(2);
const stillsArg = args.includes("--stills") ? args[args.indexOf("--stills") + 1] : null;
const SUB = args.includes("--fast") ? 1 : 4;   // sub-frames per frame
const SHUTTER = 0.5;                            // 180° shutter: sub-frames span half a frame

const types = { ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
// Serve the project folder from a fake origin so the film can fetch its data.
await page.route("http://film.local/**", async (route) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname));
  if (!p.startsWith(ROOT)) return route.abort();
  try { route.fulfill({ body: await readFile(p), contentType: types[path.extname(p)] ?? "application/octet-stream" }); }
  catch { route.fulfill({ status: 404, body: "" }); }
});
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto("http://film.local/video/film.html?render=1");
await page.evaluate(() => window.__ready);

const shot = async (t) => { await page.evaluate((t) => window.seek(t), t); return page.screenshot({ type: "jpeg", quality: 93 }); };

if (stillsArg) {
  const dir = path.join(ROOT, "video/stills");
  await mkdir(dir, { recursive: true });
  for (const t of stillsArg.split(",").map(Number)) await writeFile(path.join(dir, `t${t.toFixed(2)}.jpg`), await shot(t));
  console.log("stills saved to", dir);
  await browser.close();
  process.exit(0);
}

const hasAudio = await access(AUDIO).then(() => true, () => false);
await mkdir(path.dirname(OUT), { recursive: true });
const blur = SUB > 1 ? [`tmix=frames=${SUB}`, `select='eq(mod(n\\,${SUB})\\,${SUB - 1})'`, `setpts=N/${FPS}/TB`] : [];
const ff = spawn("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS * SUB), "-i", "-",
  ...(hasAudio ? ["-i", AUDIO] : []),
  ...(blur.length ? ["-vf", blur.join(",")] : []),
  "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  ...(hasAudio ? ["-c:a", "aac", "-b:a", "256k", "-shortest"] : []),
  OUT,
], { stdio: ["pipe", "inherit", "inherit"] });

const total = FPS * DURATION;
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  for (let k = 0; k < SUB; k++) {
    const t = (i + (SUB > 1 ? (k / SUB - 0.5) * SHUTTER : 0)) / FPS;
    const buf = await shot(Math.max(0, t));
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  if (i % 150 === 0) console.log(`frame ${i}/${total} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await writeFile(POSTER, await shot(POSTER_T));
await browser.close();
console.log("wrote", OUT, hasAudio ? "(with audio)" : "(silent)");
