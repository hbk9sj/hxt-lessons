// thumbnail.mjs — pick the frame that makes the best thumbnail, without a person judging.
//
//   node scripts/thumbnail.mjs                 out/lesson.mp4      → out/thumb.png (1280×720)
//   node scripts/thumbnail.mjs --portrait      out/lesson-9x16.mp4 → out/thumb-9x16.png (1080×1920)
//   node scripts/thumbnail.mjs --video x.mp4 --out y.png [--no-timeline]   any file
//
// Frames are sampled every 0.5 s between 3 s and 20 s (after the title has landed, before
// the lesson is deep in a detail). Each is scored by the variance of its Laplacian on a
// 320-px greyscale copy — the standard sharpness measure — and any sample inside 1.3 s
// after a camera push or pull-back (from capture/timeline.json) is skipped, because a
// frame taken mid-move is motion-blurred by design. The best sample is extracted at
// full size. A check: `--prove` runs the scorer on two synthetic clips (sharp vs
// gaussian-blurred) and exits 1 if it prefers the blurred one.

import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const PORTRAIT = flag("--portrait");
const VIDEO = opt("--video", PORTRAIT ? "out/lesson-9x16.mp4" : "out/lesson.mp4");
const OUT = opt("--out", PORTRAIT ? "out/thumb-9x16.png" : "out/thumb.png");
const SIZE = PORTRAIT ? "1080:1920" : "1280:720";
const FROM = 3,
  TO = 20,
  STEP = 0.5,
  MOVE = 1.3;

const W = 320;
function sharpness(gray, w, h) {
  // variance of the 4-neighbour Laplacian
  let sum = 0,
    sum2 = 0,
    n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}
function grayFrame(video, t) {
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${W}:-2,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
  if (r.status !== 0 || !r.stdout.length) return null;
  const h = r.stdout.length / W;
  return { gray: r.stdout, w: W, h: Math.floor(h) };
}
function score(video, t) {
  const f = grayFrame(video, t);
  return f ? sharpness(f.gray, f.w, f.h) : -1;
}

if (flag("--prove")) {
  const td = mkdtempSync(join(tmpdir(), "thumb-prove-"));
  const sharp = join(td, "sharp.mp4"),
    blurred = join(td, "blurred.mp4");
  // a busy test pattern; the second copy is blurred hard
  spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "1", "-pix_fmt", "yuv420p", sharp]);
  spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", sharp, "-vf", "gblur=sigma=6", "-pix_fmt", "yuv420p", blurred]);
  const a = score(sharp, 0.5),
    b = score(blurred, 0.5);
  rmSync(td, { recursive: true, force: true });
  console.error(`thumbnail --prove: sharp ${a.toFixed(1)} vs blurred ${b.toFixed(1)}`);
  if (!(a > b * 3)) {
    console.error("thumbnail --prove: the scorer does not prefer the sharp clip — FAIL");
    process.exit(1);
  }
  console.error("thumbnail --prove: ok");
  process.exit(0);
}

const video = join(ROOT, VIDEO);
if (!existsSync(video)) {
  console.error(`thumbnail: ${VIDEO} is missing`);
  process.exit(2);
}
const dur = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).stdout.toString());
// windows to avoid: 1.3 s after every camera move
const avoid = [];
const tlPath = join(ROOT, "capture/timeline.json");
if (!flag("--no-timeline") && existsSync(tlPath)) {
  const tl = JSON.parse(readFileSync(tlPath, "utf8"));
  for (const st of tl.steps || []) {
    const at = tl.mode === "stills" ? st.start + 0.15 : st.actionStart;
    if (st.zoom) avoid.push([at - 0.1, at + MOVE]);
    if (st.pullBackTo != null) avoid.push([st.end - 0.1, st.end + MOVE]);
  }
}
const inMove = (t) => avoid.some(([a, b]) => t >= a && t <= b);
let best = null;
const rows = [];
for (let t = FROM; t <= Math.min(TO, dur - 0.5); t += STEP) {
  if (inMove(t)) continue;
  const s = score(video, t);
  rows.push([t, s]);
  if (!best || s > best.s) best = { t, s };
}
if (!best) {
  console.error("thumbnail: no frame outside camera moves between 3 s and 20 s");
  process.exit(1);
}
mkdirSync(join(ROOT, "out"), { recursive: true });
const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", best.t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${SIZE}`, join(ROOT, OUT)]);
if (r.status !== 0) {
  console.error("thumbnail: ffmpeg failed to write the frame");
  process.exit(1);
}
console.error(`thumbnail: ${rows.length} samples, ${avoid.length} move windows skipped; best t=${best.t.toFixed(1)}s (sharpness ${best.s.toFixed(0)}) → ${OUT}`);
