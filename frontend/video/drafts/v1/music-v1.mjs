// Synthesises an original, royalty-free music bed for the film → video/music.wav
// Upbeat corporate pop at 112 BPM: pads, pluck arpeggio, sub bass, kick/hat, and whooshes on scene cuts.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100, DUR = 53, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
const BPM = 112, beat = 60 / BPM, bar = beat * 4;
const midi = (m) => 440 * 2 ** ((m - 69) / 12);
let seed = 1; const noise = () => ((seed = (seed * 16807) % 2147483647) / 1073741823.5) - 1;

// D major-ish progression: Dmaj9 – Bm7 – Gmaj7 – A6sus
const chords = [[50, 57, 62, 66, 69, 76], [47, 54, 62, 66, 69, 74], [43, 55, 59, 62, 66, 71], [45, 52, 57, 61, 64, 71]];
const roots = [38, 35, 31, 33];
const chordAt = (t) => Math.floor(t / bar) % 4;

// Sections where drums drop out for a "breath": Meet / logo, and "that's not all".
const breaks = [[6.0, 8.0], [35.8, 38.0], [49.6, 53]];
const inBreak = (t) => breaks.some(([a, b]) => t >= a && t < b);
const drumsOn = (t) => t >= 2.6 && !inBreak(t);

function add(i, l, r = l) { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } }

// ---- pad: soft additive saws, slow attack per bar, gentle stereo detune
for (let b = 0; b * bar < DUR; b++) {
  const t0 = b * bar, notes = chords[b % 4];
  const s0 = Math.floor(t0 * SR), len = Math.floor(bar * SR * 1.15);
  for (const m of notes) {
    const f = midi(m);
    for (let k = 0; k < len; k++) {
      const t = k / SR, env = Math.min(1, t / 0.6) * Math.min(1, (len - k) / (SR * 0.5));
      let vl = 0, vr = 0;
      for (let h = 1; h <= 5; h++) { vl += Math.sin(2 * Math.PI * f * h * 1.002 * t) / (h * h); vr += Math.sin(2 * Math.PI * f * h * 0.998 * t + 0.3) / (h * h); }
      add(s0 + k, vl * env * 0.022, vr * env * 0.022);
    }
  }
}

// ---- pluck arpeggio, 8th notes, from 2.6s
const arpOrder = [0, 2, 3, 4, 5, 4, 3, 2];
for (let n = 0; n * beat / 2 < DUR; n++) {
  const t0 = n * beat / 2;
  if (t0 < 2.6 && t0 > 0.01) continue;
  const notes = chords[chordAt(t0)], m = notes[arpOrder[n % 8]] + 12, f = midi(m);
  const s0 = Math.floor(t0 * SR), len = Math.floor(SR * 0.45), pan = 0.5 + 0.3 * Math.sin(n * 0.7);
  const vol = inBreak(t0) ? 0.05 : 0.08;
  for (let k = 0; k < len; k++) {
    const t = k / SR, env = Math.exp(-t * 9) * Math.min(1, t / 0.003);
    const v = (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t)) * env * vol;
    add(s0 + k, v * (1 - pan) * 1.4, v * pan * 1.4);
  }
}

// ---- sub bass, 8ths with a little bounce
for (let n = 0; n * beat / 2 < DUR; n++) {
  const t0 = n * beat / 2;
  if (!drumsOn(t0)) continue;
  const f = midi(roots[chordAt(t0)] + (n % 4 === 3 ? 12 : 0));
  const s0 = Math.floor(t0 * SR), len = Math.floor(SR * beat * 0.48);
  for (let k = 0; k < len; k++) {
    const t = k / SR, env = Math.min(1, t / 0.005) * Math.min(1, (len - k) / 400);
    add(s0 + k, Math.tanh(1.6 * Math.sin(2 * Math.PI * f * t)) * env * 0.13);
  }
}

// ---- kick + sidechain ducking, hats on off-beats, clap on 2 and 4
const duck = new Float32Array(N).fill(1);
for (let n = 0; n * beat < DUR; n++) {
  const t0 = n * beat;
  if (!drumsOn(t0)) continue;
  const s0 = Math.floor(t0 * SR);
  for (let k = 0; k < SR * 0.35; k++) {
    const t = k / SR, f = 48 + 110 * Math.exp(-t * 30);
    add(s0 + k, Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 0.5);
    if (s0 + k < N) duck[s0 + k] = Math.min(duck[s0 + k], 0.45 + 0.55 * Math.min(1, t / 0.22));
  }
  if (n % 2 === 1) for (let k = 0; k < SR * 0.18; k++) { const t = k / SR; add(s0 + k, noise() * Math.exp(-t * 22) * 0.09, noise() * Math.exp(-t * 22) * 0.09); }
  let hp = 0, prev = 0;
  const hs = Math.floor((t0 + beat / 2) * SR);
  for (let k = 0; k < SR * 0.05; k++) { const x = noise(); hp = 0.85 * (hp + x - prev); prev = x; const t = k / SR; add(hs + k, hp * Math.exp(-t * 60) * 0.05, hp * Math.exp(-t * 60) * 0.06); }
}
for (let i = 0; i < N; i++) { L[i] *= duck[i] * 0.6 + 0.4; R[i] *= duck[i] * 0.6 + 0.4; }

// ---- whooshes into each scene cut, plus a riser into the logo and a soft impact on the end card
const cuts = [2.6, 6.0, 13.0, 15.8, 21.0, 26.5, 30.0, 31.8, 34.0, 38.0, 40.5, 43.0, 46.0];
function whoosh(tEnd, len, vol) {
  let lp = 0; const s0 = Math.floor((tEnd - len) * SR), n = Math.floor(len * SR);
  for (let k = 0; k < n; k++) {
    const x = k / n, a = 0.02 + 0.25 * x * x; lp += a * (noise() - lp);
    const env = Math.sin(Math.PI * Math.min(1, x * 1.15)) ** 2 * vol;
    add(s0 + k, lp * env * (1 - x * 0.5), lp * env * (0.5 + x * 0.5));
  }
}
cuts.forEach((t) => whoosh(t + 0.12, 0.55, 0.5));
whoosh(8.05, 1.9, 0.9);
whoosh(49.75, 1.4, 0.8);
for (const t0 of [8.05, 49.75]) {
  const s0 = Math.floor(t0 * SR);
  for (let k = 0; k < SR * 1.5; k++) { const t = k / SR; add(s0 + k, Math.sin(2 * Math.PI * (40 + 60 * Math.exp(-t * 12)) * t) * Math.exp(-t * 3) * 0.45); }
}

// ---- master: fade in/out, soft clip, normalise, write 16-bit WAV
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, g = Math.min(1, t / 0.4) * Math.min(1, (DUR - t) / 1.2);
  L[i] = Math.tanh(L[i] * 1.3 * g); R[i] = Math.tanh(R[i] * 1.3 * g);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * norm * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * norm * 32767), 46 + i * 4); }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "music.wav");
await writeFile(out, buf);
console.log("wrote", out);
