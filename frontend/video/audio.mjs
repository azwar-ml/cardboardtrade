// Synthesises the film soundtrack → video/audio.wav (original, royalty-free).
// 120 BPM pop-house in A minor (Am–F–C–G) + sound design locked to the cuts in video/film.html.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000, DUR = 53, N = SR * DUR;
const BEAT = 0.5, S16 = BEAT / 4, BAR = BEAT * 4;
const DROP = 7.0;                                   // bar 0 of the groove
const mus = [new Float32Array(N), new Float32Array(N)];
const sfx = [new Float32Array(N), new Float32Array(N)];
const verb = [new Float32Array(N), new Float32Array(N)];
const kickEnv = new Float32Array(N);
const midi = (m) => 440 * 2 ** ((m - 69) / 12);
let seed = 12345; const noise = () => ((seed = (seed * 16807) % 2147483647) / 1073741823.5) - 1;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const S = (t) => Math.round(t * SR);

// ---------- DSP building blocks ----------
class Biquad {
  constructor(type, f, q = 0.707) { this.type = type; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, q); }
  set(f, q = this.q) {
    this.q = q; const w = 2 * Math.PI * clamp(f, 20, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    let b0, b1, b2; const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    if (this.type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (this.type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
}
// band-limited saw (polyBLEP)
function saw(ph, dt) { let v = 2 * ph - 1; if (ph < dt) { const t = ph / dt; v -= t + t - t * t - 1; } else if (ph > 1 - dt) { const t = (ph - 1) / dt; v -= t * t + t + t + 1; } return v; }
function add(bus, i, l, r = l, send = 0) { if (i < 0 || i >= N) return; bus[0][i] += l; bus[1][i] += r; if (send) { verb[0][i] += l * send; verb[1][i] += r * send; } }
const pan = (p) => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];

// ---------- arrangement helpers ----------
const sections = (t) => {
  if (t < DROP) return "intro";
  if (t < 30) return "A";
  if (t < 32) return "break";
  if (t < 37) return "B";
  if (t < 39) return "build";
  if (t < 46) return "C";
  return "outro";
};
const gaps = [[6.86, 7.0], [38.9, 39.0]];
const inGap = (t) => gaps.some(([a, b]) => t >= a && t < b);
const chords = [[57, 60, 64, 67], [53, 57, 60, 64], [55, 60, 64, 67], [55, 59, 62, 69]];   // Am7, Fmaj7, C/G, G6/9
const roots = [45, 41, 48, 43];
const barIdx = (t) => Math.floor((t - DROP) / BAR);
const chordAt = (t) => ((barIdx(t) % 4) + 4) % 4;
const drumsOn = (t) => ["A", "B", "C"].includes(sections(t)) || (sections(t) === "build" && t < 38);

// ---------- instruments ----------
function kick(t, g = 1) {
  const s0 = S(t), n = S(0.42); let ph = 0;
  for (let k = 0; k < n; k++) {
    const x = k / SR, f = 45 + 120 * Math.exp(-x * 38);
    ph += f / SR;
    const v = (Math.sin(2 * Math.PI * ph) * Math.exp(-x * 7) + (k < 90 ? noise() * 0.25 * (1 - k / 90) : 0)) * g;
    add(mus, s0 + k, v * 0.9);
    if (s0 + k < N) kickEnv[s0 + k] = Math.max(kickEnv[s0 + k], Math.exp(-x * 9));
  }
}
function clap(t, g = 1) {
  const bp = new Biquad("bp", 1500, 1.2), s0 = S(t), n = S(0.25);
  for (let k = 0; k < n; k++) {
    const x = k / SR, env = (x < 0.03 ? (Math.floor(x / 0.009) % 2 ? 0.5 : 1) : 1) * Math.exp(-x * 18);
    const v = bp.run(noise()) * env * g * 1.6;
    add(mus, s0 + k, v * 0.9, v, 0.25);
  }
}
function hat(t, open = false, g = 1, p = 0.2) {
  const hp = new Biquad("hp", 7500, 0.9), s0 = S(t), n = S(open ? 0.22 : 0.045), [L, R] = pan(p);
  for (let k = 0; k < n; k++) { const x = k / SR, v = hp.run(noise()) * Math.exp(-x * (open ? 14 : 70)) * g * 0.5; add(mus, s0 + k, v * L, v * R, 0.05); }
}
function snare(t, g = 1) {
  const bp = new Biquad("bp", 2200, 0.8), s0 = S(t), n = S(0.18);
  for (let k = 0; k < n; k++) { const x = k / SR, v = (bp.run(noise()) * 1.2 + Math.sin(2 * Math.PI * 190 * x) * 0.5) * Math.exp(-x * 22) * g; add(mus, s0 + k, v * 0.6, v * 0.6, 0.2); }
}
function bassNote(t, m, len, g = 1) {
  const lp = new Biquad("lp", 900, 1.0), s0 = S(t), n = S(len); const f = midi(m), dt = f / SR; let ph = 0, ph2 = 0;
  for (let k = 0; k < n; k++) {
    const x = k / SR, env = Math.min(1, x / 0.004) * Math.min(1, (n - k) / 600);
    lp.set(300 + 1400 * Math.exp(-x * 14), 1.1);
    ph = (ph + dt) % 1; ph2 = (ph2 + dt / 2) % 1;
    const v = (lp.run(saw(ph, dt)) * 0.55 + Math.sin(2 * Math.PI * ph2) * 0.6) * env * g;
    add(mus, s0 + k, v * 0.5);
  }
}
function supersaw(t, notes, len, cutoff, g = 1, send = 0.3) {
  const voices = [-0.12, -0.05, 0, 0.05, 0.12];
  const lpL = new Biquad("lp", cutoff, 0.9), lpR = new Biquad("lp", cutoff, 0.9);
  const s0 = S(t), n = S(len), oscs = [];
  notes.forEach((m) => voices.forEach((d, vi) => oscs.push({ dt: midi(m + d) / SR, ph: (vi * 0.21) % 1, p: vi % 2 ? -0.5 : 0.5 })));
  for (let k = 0; k < n; k++) {
    const x = k / SR, env = Math.min(1, x / 0.004) * Math.exp(-x * 9) * Math.min(1, (n - k) / 400);
    let l = 0, r = 0;
    for (const o of oscs) { o.ph = (o.ph + o.dt) % 1; const v = saw(o.ph, o.dt); l += v * (0.5 + o.p * 0.5); r += v * (0.5 - o.p * 0.5); }
    lpL.set(cutoff * (0.4 + 0.6 * Math.exp(-x * 10))); lpR.set(cutoff * (0.4 + 0.6 * Math.exp(-x * 10)));
    const sc = 0.06 * g / oscs.length * 4;
    add(mus, s0 + k, lpL.run(l) * env * sc, lpR.run(r) * env * sc, send);
  }
}
function padChord(t, notes, len, cutFn, g = 1) {
  const lpL = new Biquad("lp", 800, 0.7), lpR = new Biquad("lp", 800, 0.7);
  const s0 = S(t), n = S(len), oscs = [];
  notes.forEach((m) => [-0.08, 0.08].forEach((d, vi) => oscs.push({ dt: midi(m + d - 12) / SR, ph: vi * 0.37, side: vi })));
  for (let k = 0; k < n; k++) {
    const x = k / SR, env = Math.min(1, x / 0.35) * Math.min(1, (n - k) / (SR * 0.3));
    let l = 0, r = 0;
    for (const o of oscs) { o.ph = (o.ph + o.dt) % 1; const v = saw(o.ph, o.dt); if (o.side) r += v; else l += v; }
    if (k % 64 === 0) { const c = cutFn(t + x); lpL.set(c); lpR.set(c); }
    add(mus, s0 + k, lpL.run(l) * env * 0.035 * g, lpR.run(r) * env * 0.035 * g, 0.4);
  }
}
function pluck(t, m, len, g = 1, p = 0, send = 0.35) {
  const lp = new Biquad("lp", 4000, 1.4), s0 = S(t), n = S(len + 0.25), f = midi(m), dt = f / SR; let ph = 0, ph2 = 0.25;
  const [L, R] = pan(p);
  for (let k = 0; k < n; k++) {
    const x = k / SR, env = Math.min(1, x / 0.003) * Math.exp(-x * (3 / Math.max(0.12, len))) * Math.min(1, (n - k) / 300);
    if (k % 32 === 0) lp.set(900 + 5200 * Math.exp(-x * 11), 1.4);
    ph = (ph + dt) % 1; ph2 = (ph2 + dt * 1.003) % 1;
    const sq = ph < 0.5 ? 1 : -1;
    const v = lp.run(saw(ph2, dt) * 0.6 + sq * 0.35) * env * 0.16 * g;
    add(mus, s0 + k, v * L, v * R, send);
  }
}

// ---------- music ----------
// pads: one per bar, filter opens through the intro and breathes in the break
for (let b = -4; DROP + b * BAR < DUR; b++) {
  const t = DROP + b * BAR; if (t + BAR < 0) continue;
  const len = Math.min(BAR + 0.3, DUR - Math.max(0, t));
  const sec = sections(Math.max(0, t));
  const cut = (tt) => tt < DROP ? 250 + 2800 * clamp(tt / 6.8, 0, 1) ** 2 : sections(tt) === "break" ? 900 : sections(tt) === "outro" ? 2600 : 1800;
  const start = Math.max(0, t);
  padChord(start, chords[((b % 4) + 4) % 4], len - (start - t), cut, sec === "outro" ? 1.4 : sec === "intro" ? 2.4 : sec === "break" ? 1.8 : 1);
}
// final chord ring-out
padChord(46.0, [57, 60, 64, 71], 7.0, () => 2400, 1.6);
supersaw(46.0, [57, 64, 69, 72], 1.6, 3200, 1.6, 0.6);

for (let i = 0; i * S16 < DUR; i++) {
  const t = i * S16 + ((DROP % S16));
  if (t >= DUR || inGap(t)) continue;
  const sec = sections(t);
  const step = Math.round((t - DROP) / S16);
  const s16 = ((step % 16) + 16) % 16;
  const c = chordAt(t);

  // intro: ticking hats and an arpeggio that builds
  if (sec === "intro") {
    if (t >= 1.0) hat(t, false, 0.25 + 0.5 * (t / 7), s16 % 2 ? 0.3 : -0.3);
    if (t >= 0.5 && s16 % 2 === 0) pluck(t, chords[c][(s16 / 2) % 4] + 12, 0.18, 0.7 + 0.6 * t / 7, (s16 % 4 ? 0.4 : -0.4));
    if (t < 6.86 && [0, 3, 6, 8, 11, 14].includes(s16)) bassNote(t, roots[c] - 12, S16 * 1.6, 0.35 + 0.5 * t / 7);
    if (t >= 5.0 && t < 6.86 && (t >= 6.0 || s16 % 2 === 0)) snare(t, 0.15 + 0.5 * ((t - 5) / 1.86) ** 2);
    continue;
  }
  if (sec === "outro") { if (t < 50 && s16 % 4 === 0) pluck(t, chords[0][(step / 4) % 4] + 12, 0.4, 0.5 * (1 - (t - 46) / 4), 0, 0.6); continue; }

  const drums = drumsOn(t);
  if (drums) {
    if (s16 % 4 === 0) kick(t, 1);
    if (s16 === 4 || s16 === 12) clap(t, 0.9);
    if (s16 % 4 === 2) hat(t, true, 0.55, 0.15);
    else hat(t, false, s16 % 2 ? 0.35 : 0.2, -0.25);
  }
  if (sec === "break" && t >= 31.0) snare(t, 0.2 + 0.7 * ((t - 31) / 1) ** 2);
  if (sec === "build" && t >= 38.0 && t < 38.9) { snare(t, 0.3 + 0.8 * (t - 38) / 0.9); }

  // bass: syncopated root / octave pattern
  if (sec !== "break" && [0, 3, 6, 8, 11, 14].includes(s16)) bassNote(t, roots[c] - 12 + ([6, 14].includes(s16) ? 12 : 0), S16 * 1.8, 1);
  // offbeat chord stabs
  if ([2, 6, 10, 14].includes(s16)) supersaw(t, chords[c], 0.2, sec === "break" ? 1200 : 3400, sec === "break" ? 0.6 : 1);
}

// lead hook: two-bar phrases, comes in at 15 s and doubles an octave up in the last section
const hookA = [[0, 76, 2], [2, 74, 1], [3, 72, 1], [4, 74, 2], [6, 69, 2], [8, 72, 3], [11, 74, 1], [12, 76, 2], [14, 79, 2], [16, 76, 2], [18, 74, 2], [20, 72, 2], [22, 74, 2], [24, 69, 4], [28, 67, 2], [30, 69, 2]];
const hookB = [[0, 76, 2], [2, 79, 2], [4, 76, 1], [5, 74, 1], [6, 72, 2], [8, 74, 3], [11, 72, 1], [12, 74, 2], [14, 76, 2], [16, 74, 2], [18, 72, 2], [20, 71, 2], [22, 72, 2], [24, 74, 6], [30, 72, 2]];
for (let ph = 0; DROP + ph * 2 * BAR < DUR; ph++) {
  const t0 = DROP + ph * 2 * BAR;
  if (t0 < 15.0 || t0 >= 46) continue;
  const hook = ph % 2 ? hookB : hookA;
  for (const [st, m, len] of hook) {
    const t = t0 + st * S16;
    const sec = sections(t);
    if (sec === "break" || sec === "outro" || inGap(t) || (sec === "build" && t >= 38)) continue;
    pluck(t, m, len * S16, 1, -0.1, 0.35);
    pluck(t + 0.375, m, len * S16, 0.3, 0.6, 0.2);              // dotted-eighth echo
    if (sec === "C") pluck(t, m + 12, len * S16, 0.45, 0.2, 0.4);
  }
}

// ---------- sound design ----------
function whoosh(t0, dur, f0, f1, g = 1, p0 = -0.6, p1 = 0.6, q = 1.4) {
  const bp = new Biquad("bp", f0, q), s0 = S(t0), n = S(dur);
  for (let k = 0; k < n; k++) {
    const x = k / n, f = f0 * (f1 / f0) ** x;
    if (k % 32 === 0) bp.set(f, q);
    const env = Math.sin(Math.PI * Math.min(1, x)) ** 1.6;
    const [L, R] = pan(p0 + (p1 - p0) * x);
    const v = bp.run(noise()) * env * g * 1.4;
    add(sfx, s0 + k, v * L, v * R, 0.25);
  }
}
const whip = (t, g = 1, dir = 1) => whoosh(t - 0.06, 0.32, 600, 5200, g, -dir * 0.8, dir * 0.8, 1.1);
function pop(t, f = 900, g = 1, p = 0) {
  const s0 = S(t), n = S(0.12), [L, R] = pan(p); let ph = 0;
  for (let k = 0; k < n; k++) { const x = k / SR, fr = f * (1 + 1.2 * Math.exp(-x * 60)); ph += fr / SR; const v = Math.sin(2 * Math.PI * ph) * Math.exp(-x * 34) * g * 0.45; add(sfx, s0 + k, v * L, v * R, 0.2); }
}
function tick(t, g = 1, p = 0, f = 2600) {
  const s0 = S(t), n = S(0.03), bp = new Biquad("bp", f, 3), [L, R] = pan(p);
  for (let k = 0; k < n; k++) { const x = k / SR, v = (bp.run(noise()) * 1.2 + Math.sin(2 * Math.PI * f * 0.5 * x) * 0.4) * Math.exp(-x * 220) * g * 0.5; add(sfx, s0 + k, v * L, v * R, 0.1); }
}
function impact(t, g = 1) {
  const s0 = S(t), n = S(2.2), lp = new Biquad("lp", 6000, 0.7); let ph = 0;
  for (let k = 0; k < n; k++) {
    const x = k / SR, f = 32 + 90 * Math.exp(-x * 9); ph += f / SR;
    if (k % 32 === 0) lp.set(200 + 6000 * Math.exp(-x * 6));
    const v = (Math.sin(2 * Math.PI * ph) * Math.exp(-x * 1.8) * 1.1 + lp.run(noise()) * Math.exp(-x * 5) * 0.5) * g;
    add(sfx, s0 + k, v * 0.6, v * 0.6, 0.5);
  }
}
function thunk(t, g = 1, f = 110) {
  const s0 = S(t), n = S(0.35), bp = new Biquad("bp", 700, 1); let ph = 0;
  for (let k = 0; k < n; k++) { const x = k / SR, fr = f * (1 + Math.exp(-x * 40)); ph += fr / SR; const v = (Math.sin(2 * Math.PI * ph) * Math.exp(-x * 14) + bp.run(noise()) * Math.exp(-x * 40) * 0.6) * g * 0.8; add(sfx, s0 + k, v, v, 0.25); }
}
function ding(t, g = 1, m = 88) {
  const s0 = S(t), n = S(1.6), f = midi(m);
  for (let k = 0; k < n; k++) { const x = k / SR, mod = Math.sin(2 * Math.PI * f * 3.5 * x) * 2.2 * Math.exp(-x * 4); const v = Math.sin(2 * Math.PI * f * x + mod) * Math.exp(-x * 3.2) * g * 0.22; add(sfx, s0 + k, v * 0.8, v, 0.5); }
}
function riser(t0, t1, g = 1, f0 = 300, f1 = 6000) {
  const bp = new Biquad("bp", f0, 2), s0 = S(t0), n = S(t1 - t0); let ph = 0;
  for (let k = 0; k < n; k++) {
    const x = k / n; if (k % 32 === 0) bp.set(f0 * (f1 / f0) ** x, 2);
    ph += (110 * 2 ** (x * 3)) / SR;
    const v = (bp.run(noise()) * 1.2 + saw(ph % 1, 0.01) * 0.12 * x) * x ** 2 * g;
    add(sfx, s0 + k, v * 0.6, v * 0.6, 0.3);
  }
}
function suck(t0, t1, g = 1) { // reverse whoosh that ends sharply
  const bp = new Biquad("bp", 300, 1.2), s0 = S(t0), n = S(t1 - t0);
  for (let k = 0; k < n; k++) { const x = k / n; if (k % 32 === 0) bp.set(300 + 5000 * x * x, 1.2); const v = bp.run(noise()) * x ** 3 * g * 1.6; add(sfx, s0 + k, v * (1 - x * 0.4), v * (0.6 + x * 0.4), 0.2); }
}
function scatter(t, g = 1) { whoosh(t, 0.35, 2500, 9000, g * 0.6, -0.4, 0.4, 2); seed += 7; for (let i = 0; i < 6; i++) tick(t + 0.02 + i * 0.04, 0.35 * g, (i % 2 ? 0.6 : -0.6), 3000 + i * 500); }
function truck(t0, t1, inbound = true) {
  const lp = new Biquad("lp", 400, 0.8), s0 = S(t0), n = S(t1 - t0); let ph = 0;
  for (let k = 0; k < n; k++) {
    const x = k / n, f = inbound ? 70 - 20 * x : 50 + 40 * x; ph += f / SR;
    const env = inbound ? Math.sin(Math.PI * Math.min(1, x * 1.2)) : x ** 1.5;
    const v = (lp.run(saw(ph % 1, f / SR)) * 0.5 + lp.run(noise()) * 0.3) * env * 0.9;
    const p = inbound ? -0.9 + 1.0 * x : 0.1 + 0.8 * x; const [L, R] = pan(p);
    add(sfx, s0 + k, v * L, v * R, 0.15);
  }
  whoosh(inbound ? t1 - 0.35 : t0 + 0.1, 0.45, 300, 2400, 1.1, inbound ? -0.8 : 0, inbound ? 0.2 : 0.9, 0.9);
}

// cues (seconds) — mirror the timeline in film.html
const words = [0.05, 0.3, 0.55, 1.0, 1.5, 10.5, 10.75, 11.0, 11.25, 12.0, 12.25, 12.75, 13.0, 13.25, 14.25, 14.4, 14.55, 14.75, 15.5, 15.75, 18.0, 18.25, 18.5, 18.75, 22.25, 24.0, 24.25, 24.5, 24.75, 25.0, 26.25, 26.5, 26.75, 27.0, 30.0, 30.5, 30.75, 31.0, 32.5, 32.75, 33.0, 34.25, 34.5, 36.0, 36.25, 36.5, 41.0, 41.125, 41.25, 41.5, 41.75, 42.0, 43.25, 43.4, 43.55, 43.75];
words.forEach((t, i) => tick(t, 0.55, (i % 2 ? 0.25 : -0.25), 2200 + (i % 3) * 300));
[2.62, 23.62, 27.62, 31.6, 33.62, 35.62].forEach((t) => scatter(t));
scatter(11.68, 0.6);
whip(3.0, 1.1, -1); whip(13.75, 1.1, -1); whip(14.0, 1.1, -1); whip(37.0, 1.2, -1);
[3.5, 4.0, 4.5, 5.0, 5.5].forEach((t, i) => pop(t, 700 + i * 60, 0.9, i % 2 ? 0.5 : -0.5));
[15.0, 15.5, 16.0, 16.5, 17.0].forEach((t, i) => { pop(t, 600 + i * 120, 1.1, -0.3); whoosh(t - 0.05, 0.2, 400, 2500, 0.5, -0.2, -0.2); });
[19.5, 20.0, 20.5, 21.0, 21.25, 21.5].forEach((t, i) => { pop(t, 880 * 2 ** ([0, 2, 4, 5, 7, 9][i] / 12), 0.9, (i % 2 ? 0.4 : -0.4)); tick(t, 0.4); });
[10.0, 14.0].forEach((t) => pop(t, 520, 1.2));
[22.0, 22.125, 22.25, 22.375, 22.5, 22.625].forEach((t, i) => tick(t, 0.6, i % 2 ? 0.7 : -0.7, 3400));
pop(43.75, 700, 1); pop(44.0, 820, 1);
suck(6.0, 6.85, 1.2); suck(7.55, 7.95, 0.7); suck(17.45, 17.88, 0.9); ding(17.9, 0.7, 93);
riser(3.0, 6.85, 1.0); riser(30.5, 32.0, 0.8); riser(37.6, 38.95, 1.1, 400, 9000); riser(45.25, 46.0, 1.0, 500, 8000);
impact(7.0, 1.3); impact(39.0, 1.2); impact(46.0, 1.3);
thunk(8.35, 1, 120); thunk(46.5, 0.9, 120); thunk(32.25, 1.4, 70); thunk(28.5, 1.0, 140); ding(28.55, 1, 88);
whoosh(8.0, 0.4, 500, 3000, 0.7); whoosh(9.0, 0.35, 1500, 6000, 0.4); whoosh(9.72, 0.3, 4000, 1500, 0.4); whoosh(11.72, 0.35, 300, 4000, 1.0, 0, 0, 0.8);
whoosh(19.0, 0.4, 300, 2500, 0.9, 0, 0); whoosh(21.7, 0.35, 400, 5000, 1.0, 0, 0); whoosh(25.25, 0.3, 2000, 7000, 0.5, -0.6, 0.6);
whoosh(25.7, 0.6, 250, 2200, 1.0, 0, 0, 0.9); whoosh(27.6, 0.4, 3000, 600, 0.9, 0, 0); whoosh(28.0, 0.3, 800, 3000, 0.6);
whoosh(32.0, 0.3, 4000, 400, 0.9, 0, 0); whoosh(33.7, 0.35, 400, 4000, 0.7, 0, 0);
truck(34.0, 34.6, true); truck(35.5, 36.05, false);
whoosh(43.0, 0.35, 400, 3000, 0.8, 0, 0); whoosh(46.0, 0.4, 4000, 500, 0.9, 0, 0);
tick(45.0, 1.2, 0, 4200); pop(45.02, 400, 0.8);
for (let i = 0; i < 13; i++) pop(40.5 + i * 0.125 + 0.42, 1200 * 2 ** ([0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29][i] / 12) / 2, 0.45, (i % 2 ? 0.6 : -0.6));
ding(47.0, 0.5, 81); ding(47.75, 0.4, 88);
// TV carton: flaps pop, the set slides out against the board, the screen powers on
thunk(28.78, 0.55, 220); tick(28.8, 0.6, -0.3, 1800); tick(28.84, 0.5, 0.3, 1600);
{ const lp = new Biquad("lp", 1400, 0.8), s0 = S(28.9), n = S(0.55);
  for (let k = 0; k < n; k++) { const x = k / n, env = Math.sin(Math.PI * Math.min(1, x * 1.1)) * (0.6 + 0.4 * Math.sin(x * 90)); if (k % 32 === 0) lp.set(900 + 1800 * x, 0.8); const v = lp.run(noise()) * env * 0.9; add(sfx, s0 + k, v * 0.9, v, 0.15); } }
whoosh(29.0, 0.45, 300, 2600, 0.7, 0, 0);
ding(29.45, 0.55, 76); ding(29.47, 0.4, 83);

// ---------- mix ----------
// reverb (Schroeder): 4 combs + 2 allpasses per channel on the send bus
function reverb(inp, sizes) {
  const out = new Float32Array(N);
  const combs = sizes.map((d) => ({ b: new Float32Array(d), i: 0, f: 0.8, lp: 0 }));
  const aps = [556, 441].map((d) => ({ b: new Float32Array(d), i: 0 }));
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (const c of combs) { const y = c.b[c.i]; c.lp = y * 0.7 + c.lp * 0.3; c.b[c.i] = inp[n] + c.lp * c.f; c.i = (c.i + 1) % c.b.length; s += y; }
    s *= 0.25;
    for (const a of aps) { const y = a.b[a.i]; a.b[a.i] = s + y * 0.5; a.i = (a.i + 1) % a.b.length; s = y - s * 0.5; }
    out[n] = s;
  }
  return out;
}
const rvL = reverb(verb[0], [1557, 1617, 1491, 1422].map((x) => Math.round(x * SR / 44100)));
const rvR = reverb(verb[1], [1580, 1640, 1514, 1445].map((x) => Math.round(x * SR / 44100)));

const out = [new Float32Array(N), new Float32Array(N)];
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const duck = 1 - 0.55 * kickEnv[i];                                   // sidechain on music (kick itself is part of mus, slight self-duck is fine)
  const gap = inGap(t) ? 0 : 1;
  const fade = Math.min(1, t / 0.05) * Math.min(1, (DUR - t) / 1.0);
  for (let c = 0; c < 2; c++) {
    const m = mus[c][i] * duck * gap * 0.9;
    const x = sfx[c][i] * 0.85;
    const r = (c ? rvR : rvL)[i] * 0.5;
    let v = (m + x + r) * fade;
    v = Math.tanh(v * 1.25);                                            // soft limiter
    out[c][i] = v; peak = Math.max(peak, Math.abs(v));
  }
}
const norm = 0.93 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(clamp(out[0][i] * norm, -1, 1) * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(clamp(out[1][i] * norm, -1, 1) * 32767), 46 + i * 4); }
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "audio.wav");
await writeFile(file, buf);
console.log("wrote", file);
