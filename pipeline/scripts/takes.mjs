// takes.mjs — per-sentence Orpheus takes, scored, best one kept, joined with pauses we set.
//
//   GROQ_API_KEY=… node scripts/takes.mjs <voice> [takes=3] [--fallback <dir> <prefix>]
//
// --fallback: when the day's Groq budget runs out mid-lesson (3,600 tokens/day), a step
// with no usable take falls back to an existing whole-line recording
// (<dir>/<prefix>-<id>.wav) and gets its sentence pauses inserted after the fact: the cut
// is made at the quietest 20 ms within ±0.15 s of the Whisper sentence boundary, and
// silence is padded so the gap matches SENTENCE_GAP. Reported as "fallback" in the JSON.
//
// Why: Orpheus has no pause or speed control (Groq's speech endpoint takes only model,
// input, voice, response_format), and every request is a different random take. So the
// controls we do have are (1) the text of each request, (2) how many takes we ask for and
// which one we keep, and (3) the silence we put between requests. This script uses all
// three: each step's `say` is split at sentence ends (tiny fragments merged into a
// neighbour so the model never sees a two-word request), N takes are requested per chunk,
// each take is transcribed and scored — wrong word count is a rejection; then a penalty
// for a pause of 0.3 s+ that is not at a comma, and for a speech rate away from a
// narrator's ~2.65 words/s — and the best take per chunk is joined with a set gap into
// assets/voice/orpheus-takes/<voice>-<id>.wav, which `narrate.mjs --lines` reads unchanged.
// An optional `direction` on a step ("[warm]") is prepended to each of its requests.
// Groq's Orpheus is deterministic: the same input returns byte-identical audio (checked
// 22 Sep 2026, three requests, one MD5), so a "take" must differ in text. Take k uses a
// different bracketed direction — the step's own (or none), then [calm], then [warm] —
// which changes the delivery while the words stay the same.
//
// Rate limits on Groq's free tier are 10 requests/min and 100/day, so requests are
// spaced 6.5 s apart. The key is read from the environment only.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const voice = process.argv[2];
const TAKES = Number(process.argv[3] || 3);
if (!voice) {
  console.error("takes: usage  GROQ_API_KEY=… node scripts/takes.mjs <voice> [takes]");
  process.exit(2);
}
if (!process.env.GROQ_API_KEY) {
  console.error("takes: GROQ_API_KEY is not set in the environment");
  process.exit(2);
}
const fi = process.argv.indexOf("--fallback");
const FALLBACK = fi > 0 ? { dir: process.argv[fi + 1], prefix: process.argv[fi + 2] } : null;
if (fi > 0 && (!FALLBACK.dir || !FALLBACK.prefix)) {
  console.error("takes: --fallback needs <dir> <prefix>");
  process.exit(2);
}
const lesson = JSON.parse(readFileSync(join(ROOT, "lesson.json"), "utf8"));
const OUT = join(ROOT, "assets/voice/orpheus-takes");
const RAW = join(OUT, "raw");
mkdirSync(RAW, { recursive: true });

const MIN_CHUNK = 25; // chars; anything shorter is merged into a neighbour
const TARGET_WPS = 2.65;
const GAP_OK = 0.3; // a pause this long is fine only at a comma
const SENTENCE_GAP = [0.5, 0.62]; // seconds of silence we put between sentences
const SPACING_MS = 6500;
const VARIANTS = ["", "[calm]", "[warm]", "[friendly]", "[gently]"]; // take 1 = step's own direction

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function chunksOf(say) {
  const parts = (say.match(/[^.?!]+[.?!]+/g) || [say]).map((s) => s.trim());
  const out = [];
  for (const p of parts) {
    if (out.length && (p.length < MIN_CHUNK || out[out.length - 1].length < MIN_CHUNK)) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out;
}

async function request(text, file) {
  const body = JSON.stringify({ model: "canopylabs/orpheus-v1-english", input: text, voice, response_format: "wav" });
  // curl: Groq's edge rejects Node/urllib user agents with a Cloudflare 1010
  const r = spawnSync("curl", ["-sS", "-A", "Mozilla/5.0", "-X", "POST", "https://api.groq.com/openai/v1/audio/speech", "-H", `Authorization: Bearer ${process.env.GROQ_API_KEY}`, "-H", "Content-Type: application/json", "-d", body, "-o", file, "-w", "%{http_code}"]);
  const code = r.stdout.toString().trim();
  if (code !== "200") {
    const msg = existsSync(file) ? readFileSync(file, "utf8").slice(0, 300) : "";
    rmSync(file, { force: true });
    throw new Error(`HTTP ${code} ${msg}`);
  }
}

function transcribe(wav, dir) {
  const w16 = wav.replace(/\.wav$/, ".16k.wav");
  spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-ar", "16000", w16]);
  spawnSync("npx", ["--yes", "hyperframes@0.8.31", "transcribe", w16, "--model", "small.en", "--dir", dir], { cwd: ROOT, stdio: "ignore" });
  rmSync(w16, { force: true });
  const tj = join(dir, "transcript.json");
  return existsSync(tj) ? JSON.parse(readFileSync(tj, "utf8")).filter((w) => norm(w.text)) : [];
}

function score(words, text) {
  const expected = text.split(/\s+/).map(norm).filter(Boolean);
  if (!words.length) return { reject: "no speech heard" };
  if (Math.abs(words.length - expected.length) > 1) return { reject: `heard ${words.length} words, expected ${expected.length}` };
  const span = Number(words[words.length - 1].end) - Number(words[0].start);
  const wps = words.length / span;
  let badGaps = 0,
    gapPenalty = 0;
  for (let i = 0; i + 1 < words.length; i++) {
    const g = Number(words[i + 1].start) - Number(words[i].end);
    if (g >= GAP_OK && !/[,;:—-]$/.test(words[i].text.trim())) {
      badGaps++;
      gapPenalty += (g - GAP_OK) * 4;
    }
  }
  return { score: Math.abs(wps - TARGET_WPS) + gapPenalty, wps, badGaps, span };
}

// RMS per 20 ms hop of a wav, decoded to 16 kHz mono s16le
function envelope(wav) {
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-i", wav, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const pcm = r.stdout;
  const hop = 320; // 20 ms
  const out = [];
  for (let i = 0; i + hop * 2 <= pcm.length; i += hop * 2) {
    let acc = 0;
    for (let j = 0; j < hop; j++) {
      const v = pcm.readInt16LE(i + j * 2);
      acc += v * v;
    }
    out.push(Math.sqrt(acc / hop));
  }
  return { rms: out, hopSec: hop / 16000 };
}

// Cut a whole-line recording at its sentence ends and pad our gap in. Returns the joined
// file and the gaps used, or null when the boundaries cannot be found in the transcript.
function fallbackLine(st, chunks) {
  const src = join(ROOT, FALLBACK.dir, `${FALLBACK.prefix}-${st.id}.wav`);
  if (!existsSync(src)) return null;
  const words = transcribe(src, join(RAW, `fallback-${st.id}`));
  if (!words.length) return null;
  const env = envelope(src);
  const total = env.rms.length * env.hopSec;
  const cuts = [];
  let wi = 0;
  for (let c = 0; c + 1 < chunks.length; c++) {
    const n = chunks[c].split(/\s+/).map(norm).filter(Boolean);
    const lastWord = n[n.length - 1];
    // the chunk's last word should sit near index wi + n.length - 1; look ±2 around it
    const want = wi + n.length - 1;
    let k = -1;
    for (let d = 0; d <= 2 && k < 0; d++) for (const cand of [want - d, want + d]) if (cand >= 0 && cand + 1 < words.length && norm(words[cand].text) === lastWord) { k = cand; break; }
    if (k < 0) return null;
    const t0 = Number(words[k].end),
      t1 = Number(words[k + 1].start);
    const lo = Math.max(0, Math.floor((t0 - 0.15) / env.hopSec)),
      hi = Math.min(env.rms.length - 1, Math.ceil((t1 + 0.15) / env.hopSec));
    let best = lo;
    for (let i = lo; i <= hi; i++) if (env.rms[i] < env.rms[best]) best = i;
    const at = (best + 0.5) * env.hopSec;
    const existing = Math.max(0, t1 - t0);
    cuts.push({ at, existing });
    wi = k + 1;
  }
  const gaps = [];
  const parts = [];
  let from = 0;
  cuts.forEach((cut, i) => {
    const gap = SENTENCE_GAP[0] + (SENTENCE_GAP[1] - SENTENCE_GAP[0]) * rnd();
    const pad = Math.max(0, gap - cut.existing);
    gaps.push(Number((cut.existing + pad).toFixed(3)));
    parts.push(`[0:a]atrim=${from.toFixed(3)}:${cut.at.toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${pad.toFixed(3)}[a${i}]`);
    from = cut.at;
  });
  parts.push(`[0:a]atrim=${from.toFixed(3)}:${total.toFixed(3)},asetpts=PTS-STARTPTS[a${cuts.length}]`);
  const n = cuts.length + 1;
  const concat = Array.from({ length: n }, (_, i) => `[a${i}]`).join("") + `concat=n=${n}:v=0:a=1[out]`;
  const dst = join(OUT, `${voice}-${st.id}.wav`);
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-filter_complex", parts.join(";") + ";" + concat, "-map", "[out]", "-ar", "24000", dst]);
  if (r.status !== 0) {
    console.error(`takes: ffmpeg failed on fallback ${st.id}: ${r.stderr.toString()}`);
    process.exit(1);
  }
  return { dst, cuts, gaps };
}

let budgetOut = false; // after a daily-limit 429, stop asking; fall back instead
const report = [];
for (const st of lesson.steps) {
  const chunks = chunksOf(st.say);
  const picked = [];
  for (let c = 0; c < chunks.length; c++) {
    const results = [];
    for (let t = 1; t <= TAKES; t++) {
      const own = st.direction || "";
      // the step's direction first; then the other variants, skipping a repeat of it
      const dir = t === 1 ? own : VARIANTS.filter((v) => v !== own)[t - 2] ?? "";
      const text = (dir ? dir + " " : "") + chunks[c];
      if (text.length > 200) {
        console.error(`takes: step ${st.id} chunk ${c + 1} is ${text.length} chars (limit 200): "${text}"`);
        process.exit(2);
      }
      const file = join(RAW, `${voice}-${st.id}-${c + 1}-${t}.wav`);
      if (!existsSync(file)) {
        if (budgetOut) continue;
        try {
          await request(text, file);
        } catch (e) {
          console.error(`takes: ${st.id}/${c + 1} take ${t}: ${e.message}`);
          if (/tokens per day/.test(e.message)) budgetOut = true;
          else await sleep(SPACING_MS);
          continue;
        }
        await sleep(SPACING_MS);
      }
      const words = transcribe(file, join(RAW, `${voice}-${st.id}-${c + 1}-${t}`));
      const s = score(words, chunks[c]);
      results.push({ t, dir, file, ...s });
      console.error(`  ${st.id}/${c + 1} take ${t} ${dir || "[plain]"}: ${s.reject ? "REJECT " + s.reject : `score ${s.score.toFixed(2)}  ${s.wps.toFixed(2)} w/s  ${s.badGaps} stray pause(s)`}`);
    }
    const ok = results.filter((r) => !r.reject).sort((a, b) => a.score - b.score);
    if (!ok.length) {
      if (FALLBACK) {
        picked.length = 0;
        break;
      }
      console.error(`takes: no usable take for step ${st.id} chunk ${c + 1}: "${chunks[c]}"`);
      process.exit(1);
    }
    picked.push({ chunk: chunks[c], take: ok[0].t, dir: ok[0].dir, file: ok[0].file, wps: ok[0].wps, badGaps: ok[0].badGaps });
  }
  if (!picked.length) {
    const fb = fallbackLine(st, chunks);
    if (!fb) {
      console.error(`takes: step ${st.id} has no usable take and no fallback line could be cut`);
      process.exit(1);
    }
    report.push({ id: st.id, direction: st.direction || null, fallback: true, cuts: fb.cuts.map((c, i) => ({ at: Number(c.at.toFixed(3)), gapAfter: fb.gaps[i] })) });
    console.error(`takes: ${st.id} → ${fb.dst}  (fallback line, ${fb.cuts.length} pause(s) inserted at ${fb.cuts.map((c) => c.at.toFixed(2) + "s").join(", ")})`);
    continue;
  }
  // trim each picked take to its speech, then join with our own sentence gaps
  const args = ["-y", "-loglevel", "error"];
  picked.forEach((p) => args.push("-i", p.file));
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1,areverse";
  const parts = [];
  const gaps = [];
  picked.forEach((p, i) => {
    let f = `[${i}:a]${trim}`;
    if (i + 1 < picked.length) {
      const gap = SENTENCE_GAP[0] + (SENTENCE_GAP[1] - SENTENCE_GAP[0]) * rnd();
      gaps.push(gap);
      f += `,apad=pad_dur=${gap.toFixed(3)}`;
    }
    parts.push(`${f}[a${i}]`);
  });
  const concat = picked.map((_, i) => `[a${i}]`).join("") + `concat=n=${picked.length}:v=0:a=1[out]`;
  const dst = join(OUT, `${voice}-${st.id}.wav`);
  const r = spawnSync("ffmpeg", [...args, "-filter_complex", parts.join(";") + ";" + concat, "-map", "[out]", "-ar", "24000", dst]);
  if (r.status !== 0) {
    console.error(`takes: ffmpeg failed joining step ${st.id}: ${r.stderr.toString()}`);
    process.exit(1);
  }
  report.push({ id: st.id, direction: st.direction || null, chunks: picked.map((p, i) => ({ text: p.chunk, take: p.take, direction: p.dir || null, wps: Number(p.wps.toFixed(2)), strayPauses: p.badGaps, gapAfter: gaps[i] ?? null })) });
  console.error(`takes: ${st.id} → ${dst}  (${picked.map((p) => "take " + p.take).join(", ")})`);
}
writeFileSync(join(OUT, `${voice}-takes.json`), JSON.stringify(report, null, 1));
console.error(`takes: done — ${report.length} lines, ${report.reduce((n, r) => n + r.chunks.length, 0)} chunks × ${TAKES} takes`);
