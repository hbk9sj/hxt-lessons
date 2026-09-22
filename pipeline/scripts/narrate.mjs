// narrate.mjs — narration text out, line timings in.
//
//   node scripts/narrate.mjs --text     print the exact text to send to TopView TTS
//                                       (one job for the whole lesson, 0.1 credits)
//   node scripts/narrate.mjs --lines <dir> <prefix>
//                                       one audio file per line already exists
//                                       (<dir>/<prefix>-<id>.wav, e.g. from Groq's Orpheus,
//                                       200 chars per request): measure each, transcribe
//                                       for word timings, write lines.json. No cutting.
//   node scripts/narrate.mjs            after assets/voice/narration.mp3 exists:
//                                       transcribe it with HyperFrames' Whisper and cut
//                                       the word list into per-line {start,end} →
//                                       assets/voice/lines.json
//
// The TopView call is made through the MCP by the Claude session (no CLI key lives on
// this machine); this script never spends credits.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd(); // the lesson project; scripts are shared between lessons
const lesson = JSON.parse(readFileSync(join(ROOT, "lesson.json"), "utf8"));
const VOICE = join(ROOT, "assets/voice");
const MP3 = join(VOICE, "narration.mp3");
const WAV = join(VOICE, "narration.wav");

// Paragraph breaks give the voice a real breath between lines.
const text = lesson.steps.map((s) => s.say.trim()).join("\n\n");

if (process.argv.includes("--text")) {
  process.stdout.write(text + "\n");
  process.exit(0);
}

const li = process.argv.indexOf("--lines");
if (li > 0) {
  const dir = process.argv[li + 1],
    prefix = process.argv[li + 2];
  if (!dir || !prefix) {
    console.error("narrate: --lines needs <dir> <prefix>");
    process.exit(2);
  }
  const norm2 = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const td = mkdtempSync(join(tmpdir(), "hf-trans-"));
  const out = [];
  let bad = 0;
  for (const st of lesson.steps) {
    const src = join(ROOT, dir, `${prefix}-${st.id}.wav`);
    if (!existsSync(src)) {
      console.error(`narrate: missing ${src}`);
      process.exit(2);
    }
    // trim leading/trailing silence to a small margin, normalise loudness, write the clip
    const clip = join(VOICE, `${st.id}.mp3`);
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.18,areverse,loudnorm=I=-18:TP=-1.5:LRA=9", "-ar", "44100", "-c:a", "libmp3lame", "-q:a", "2", clip]);
    if (r.status !== 0) {
      console.error(`narrate: ffmpeg failed on ${src}`);
      process.exit(1);
    }
    const clipDuration = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip]).stdout.toString());
    const wav = join(td, `${st.id}.wav`);
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", clip, "-ac", "1", "-ar", "16000", wav]);
    const d = join(td, st.id);
    spawnSync("npx", ["--yes", "hyperframes@0.8.31", "transcribe", wav, "--model", "small.en", "--dir", d], { cwd: ROOT, stdio: "ignore" });
    const tj = join(d, "transcript.json");
    const raw = existsSync(tj) ? JSON.parse(readFileSync(tj, "utf8")) : [];
    const ws = raw.map((w) => norm2(w.text)).filter(Boolean);
    const lw = st.say.split(/\s+/).map(norm2).filter(Boolean);
    const okCount = Math.abs(ws.length - lw.length) <= 2;
    if (!okCount) {
      bad++;
      console.error(`narrate: line ${st.id} heard ${ws.length} words, expected ${lw.length}: "${ws.join(" ")}"`);
    }
    const first = raw.length ? Number(raw[0].start) : 0.05;
    const last = raw.length ? Number(raw[raw.length - 1].end) : clipDuration;
    out.push({
      id: st.id,
      clip: `assets/voice/${st.id}.mp3`,
      clipDuration,
      speechOffset: Math.max(0, first),
      duration: Math.max(0.5, last - first),
      words: ws.length,
      expected: lw.length,
      wordsTimed: raw.filter((w) => norm2(w.text)).map((w) => ({ text: w.text.trim(), start: Number(w.start), end: Number(w.end) })),
    });
    console.error(`  ${st.id}  ${clipDuration.toFixed(2)}s  speech ${first.toFixed(2)}+${(last - first).toFixed(2)}s  (${ws.length}/${lw.length} words)`);
  }
  rmSync(td, { recursive: true, force: true });
  if (bad) {
    console.error(`narrate: ${bad} line(s) do not match their text — nothing written`);
    process.exit(1);
  }
  writeFileSync(join(VOICE, "lines.json"), JSON.stringify(out, null, 1));
  console.error(`narrate: ${out.length} lines from ${dir}/${prefix}-*.wav`);
  process.exit(0);
}

if (!existsSync(MP3)) {
  console.error(`narrate: ${MP3} is missing. Run with --text, send that text to TopView, save the mp3 there.`);
  process.exit(2);
}

// Whisper wants wav; keep the mp3 as the delivered asset.
let r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", MP3, "-ac", "1", "-ar", "16000", WAV]);
if (r.status !== 0) {
  console.error("narrate: ffmpeg failed to make the wav");
  process.exit(1);
}
const td = mkdtempSync(join(tmpdir(), "hf-trans-"));
r = spawnSync("npx", ["--yes", "hyperframes@0.8.31", "transcribe", "assets/voice/narration.wav", "--model", "small.en", "--dir", td], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
});
const tj = join(td, "transcript.json");
if (r.status !== 0 || !existsSync(tj)) {
  console.error("narrate: hyperframes transcribe produced no transcript.json");
  process.exit(1);
}
const words = JSON.parse(readFileSync(tj, "utf8"));
rmSync(td, { recursive: true, force: true });

// Cut the word stream into lines: walk forward, matching each line's word count with a
// tolerance, anchored on the line's first word where Whisper agrees.
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
const lineWords = lesson.steps.map((s) => s.say.split(/\s+/).map(norm).filter(Boolean));
const out = [];
let i = 0;
for (let li = 0; li < lineWords.length; li++) {
  const lw = lineWords[li];
  // Try to anchor on the first word within a small window.
  let start = i;
  for (let k = i; k < Math.min(words.length, i + 4); k++) {
    if (norm(words[k].text) === lw[0]) {
      start = k;
      break;
    }
  }
  let end = Math.min(words.length - 1, start + lw.length - 1);
  // Nudge the end onto the line's last word if it is nearby.
  for (let k = Math.max(start, end - 3); k <= Math.min(words.length - 1, end + 3); k++) {
    if (norm(words[k].text) === lw[lw.length - 1]) {
      end = k;
      break;
    }
  }
  out.push({ id: lesson.steps[li].id, start: words[start].start, end: words[end].end, words: end - start + 1, expected: lw.length });
  i = end + 1;
}
// Whisper's boundaries drift up to a second from the real pauses (measured 22 Sep 2026:
// it put line 1's end at 7.74 s; the real pause was 6.71–7.27 s), so cutting at its word
// times chops words. Cut at the midpoints of the real silences instead: for each Whisper
// boundary, take the nearest silence of at least 0.4 s. Whisper only counts the lines.
const total = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", MP3]).stdout.toString());
const sd = spawnSync("ffmpeg", ["-i", MP3, "-af", "silencedetect=n=-40dB:d=0.15", "-f", "null", "-"]).stderr.toString();
const gaps = [];
{
  const re = /silence_start: ([0-9.]+)[\s\S]*?silence_end: ([0-9.]+)/g;
  let m;
  while ((m = re.exec(sd))) gaps.push({ s: Number(m[1]), e: Number(m[2]) });
}
// Breaths between paragraphs can be as short as 0.25 s; a short gap near the guess is
// preferred over a long one far from it, and every cut is proven below by transcription.
const big = gaps.filter((g) => g.e - g.s >= 0.22);
const cuts = [0];
const used = new Set();
for (let k = 1; k < out.length; k++) {
  const guess = (out[k - 1].end + out[k].start) / 2;
  let best = null;
  for (const g of big) {
    if (used.has(g)) continue;
    const mid = (g.s + g.e) / 2;
    const score = Math.abs(mid - guess) + Math.max(0, 0.5 - (g.e - g.s)) * 1.5;
    if (!best || score < best.score) best = { ...g, score };
  }
  if (!best || Math.abs((best.s + best.e) / 2 - guess) > 1.8) {
    console.error(`narrate: no silence near the boundary before line ${out[k].id} (guess ${guess.toFixed(2)}s) — refusing to cut mid-word`);
    process.exit(1);
  }
  used.add(best);
  cuts.push(best);
}
for (let k = 0; k < out.length; k++) {
  const l = out[k];
  const from = k === 0 ? 0 : (cuts[k].s + cuts[k].e) / 2;
  const to = k + 1 < out.length ? (cuts[k + 1].s + cuts[k + 1].e) / 2 : total;
  const speechStart = k === 0 ? (gaps.length && gaps[0].s < 0.05 ? gaps[0].e : 0.05) : cuts[k].e;
  const speechEnd = k + 1 < out.length ? cuts[k + 1].s : total;
  const clip = join(VOICE, `${l.id}.mp3`);
  const fade = `afade=t=in:st=0:d=0.03,afade=t=out:st=${(to - from - 0.03).toFixed(3)}:d=0.03`;
  const c = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", from.toFixed(3), "-to", to.toFixed(3), "-i", MP3, "-af", fade, "-c:a", "libmp3lame", "-q:a", "2", clip]);
  if (c.status !== 0) {
    console.error(`narrate: failed to cut ${clip}`);
    process.exit(1);
  }
  l.clip = `assets/voice/${l.id}.mp3`;
  l.cutFrom = from;
  l.cutTo = to;
  l.clipDuration = to - from;
  l.speechOffset = speechStart - from; // first word inside the clip
  l.duration = speechEnd - speechStart; // spoken length
}
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const skel = (w) => w.replace(/[aeiouy']/g, "").replace(/(.)\1+/g, "$1");
// a heard word that is a strict prefix or suffix of the wanted one is the chop itself
const chopped = (heard, want) => heard !== want && heard.length >= 1 && (want.startsWith(heard) || want.endsWith(heard));
const near = (heard, want) => heard === want || (!chopped(heard, want) && skel(want).length >= 3 && lev(skel(heard), skel(want)) <= 1);
// Prove the cuts: transcribe every clip and require its first and last words to match the
// line's. A clip that starts or ends mid-word fails here, before anything is rendered.
{
  const td2 = mkdtempSync(join(tmpdir(), "hf-trans-"));
  let bad = 0;
  for (let k = 0; k < out.length; k++) {
    const l = out[k];
    const wav = join(td2, `${l.id}.wav`);
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(ROOT, l.clip), "-ac", "1", "-ar", "16000", wav]);
    const d = join(td2, l.id);
    spawnSync("npx", ["--yes", "hyperframes@0.8.31", "transcribe", wav, "--model", "small.en", "--dir", d], { cwd: ROOT, stdio: "ignore" });
    const tj2 = join(d, "transcript.json");
    const raw = existsSync(tj2) ? JSON.parse(readFileSync(tj2, "utf8")) : [];
    const ws = raw.map((w) => norm(w.text)).filter(Boolean);
    // word timings relative to the clip, for word-by-word captions
    l.wordsTimed = raw.filter((w) => norm(w.text)).map((w) => ({ text: w.text.trim(), start: Number(w.start), end: Number(w.end) }));
    const lw = lineWords[k];
    // Whisper mishears a word on a short clip ("clod" for "claude", "flides" for
    // "slides") while hearing it right in the full file. Vowels are what it gets wrong;
    // a chopped word loses consonants. So compare consonant skeletons ("cld" = "cld",
    // "flds" ~ "slds") and allow one edit there; "d" for a chopped "claude" still fails.
    const okFirst = ws.length && near(ws[0], lw[0]);
    const okLast = ws.length && near(ws[ws.length - 1], lw[lw.length - 1]);
    const okCount = Math.abs(ws.length - lw.length) <= 2;
    l.proof = { heard: ws.length, expected: lw.length, first: okFirst, last: okLast };
    if (!(okFirst && okLast && okCount)) {
      bad++;
      console.error(`narrate: clip ${l.id} does not match its line — heard "${ws.slice(0, 3).join(" ")} … ${ws.slice(-3).join(" ")}" (${ws.length} words) for "${lw.slice(0, 3).join(" ")} … ${lw.slice(-3).join(" ")}" (${lw.length})`);
    }
  }
  rmSync(td2, { recursive: true, force: true });
  if (bad) {
    console.error(`narrate: ${bad} clip(s) cut wrongly — nothing written`);
    process.exit(1);
  }
}
const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", MP3]).stdout.toString().trim();
writeFileSync(join(VOICE, "lines.json"), JSON.stringify(out, null, 1));
console.error(`narrate: ${words.length} words, ${out.length} lines, audio ${dur}s`);
for (const l of out) console.error(`  ${l.id}  whisper ${l.start.toFixed(2)}–${l.end.toFixed(2)} → cut ${l.cutFrom.toFixed(2)}–${l.cutTo.toFixed(2)}, speech ${l.speechOffset.toFixed(2)}+${l.duration.toFixed(2)}s  (${l.words}/${l.expected} words)`);
