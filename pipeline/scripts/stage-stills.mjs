// stage-stills.mjs — the "no software installed" route. Builds the same capture/timeline.json
// and assets/footage.mp4 that capture.mjs makes, but from official material: per step either
// a still (`still`) held for its line, or a clip (`clip: {src, in, out, crop?}`) played at
// 1× and frozen on its last frame until the line ends; dissolves between steps. The cursor
// is a presenter's pointer — it glides to `pointAt` and rests; it never clicks, because the
// material cannot respond, and a click that changes nothing is a tell.
//
//   node scripts/stage-stills.mjs     needs lesson.json (mode "stills") + assets/voice/lines.json
//
// Coordinates: `zoom.box` and `pointAt` are written in lesson.boxSpace (1920×1080 by default,
// as read off a scaled frame); stills are lesson.stillSize; the timeline is in viewport px so
// compose.mjs needs no changes.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const lesson = JSON.parse(readFileSync(join(ROOT, "lesson.json"), "utf8"));
if (lesson.mode !== "stills" && lesson.mode !== "clips") {
  console.error('stage-stills: lesson.json must have "mode": "stills" or "clips"');
  process.exit(2);
}
const linesPath = join(ROOT, "assets/voice/lines.json");
if (!existsSync(linesPath)) {
  console.error("stage-stills: assets/voice/lines.json is missing — run `npm run narrate` first");
  process.exit(2);
}
const lines = JSON.parse(readFileSync(linesPath, "utf8"));
const VP = lesson.viewport;
const BS = lesson.boxSpace || { width: 1920, height: 1080 };
const kx = VP.width / BS.width,
  ky = VP.height / BS.height;
const AUDIO_LEAD = 0.6,
  TAIL = 1.2,
  XFADE = 0.35,
  MIN_HOLD = 3.2;

let seed = 20260916;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const between = (a, b) => a + (b - a) * rnd();
// A hand overshoots its target a little and settles: back-out easing with a small
// overshoot (c1 = 0.9 ≈ 4 % past the target), instead of a pure decelerate.
const easeOut = (p) => {
  const c1 = 0.9,
    c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

const CAP = join(ROOT, "capture");
rmSync(CAP, { recursive: true, force: true });
mkdirSync(CAP, { recursive: true });

// --- timing: each line's clip starts when its step starts, exactly as in capture.mjs -------
const steps = [];
let t = 0;
let cur = { x: VP.width * 0.62, y: VP.height * 0.9 };
const cursor = [];
const moveTo = (t0, x, y) => {
  const dx = x - cur.x,
    dy = y - cur.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return t0;
  const dur = Math.min(0.9, Math.max(0.45, 0.45 + dist * 0.0006));
  const bow = between(8, 20) * (rnd() < 0.5 ? -1 : 1);
  const nx = -dy / dist,
    ny = dx / dist;
  const start = { ...cur };
  const n = Math.round(dur * 60);
  for (let i = 1; i <= n; i++) {
    const p = easeOut(i / n);
    const arc = Math.sin(p * Math.PI) * bow;
    cur = { x: start.x + dx * p + nx * arc, y: start.y + dy * p + ny * arc };
    cursor.push({ t: t0 + (dur * i) / n, x: cur.x, y: cur.y });
  }
  return t0 + dur;
};
cursor.push({ t: 0, x: cur.x, y: cur.y });

for (let i = 0; i < lesson.steps.length; i++) {
  const step = lesson.steps[i];
  const line = lines[i];
  // a narrator breathes between ideas: 0.6–0.9 s, longer than any pause inside a sentence
  const clipStart = i === 0 ? AUDIO_LEAD : t + between(0.6, 0.9);
  const lineStart = clipStart + line.speechOffset;
  const lineEnd = lineStart + line.duration;
  const stepStart = i === 0 ? 0 : t;
  // the pointer settles on the subject a third of the way into the line
  const actionStart = lineStart + 0.3 * line.duration;
  let actionEnd = actionStart;
  if (step.pointAt) actionEnd = moveTo(actionStart, step.pointAt[0] * kx, step.pointAt[1] * ky);
  // No target: park the pointer out of the way (lower right) as the step begins, so it
  // never sits on top of what the clip is showing.
  else if (i > 0) moveTo(stepStart + 0.2, VP.width * between(0.86, 0.92), VP.height * between(0.84, 0.9));
  const end = Math.max(lineEnd + 0.45, actionEnd + 0.5, stepStart + MIN_HOLD);
  let zoom = null;
  if (step.zoom && step.zoom.target === "wide") zoom = { wide: true };
  else if (step.zoom && step.zoom.box) {
    const [x, y, w, h] = step.zoom.box;
    zoom = { scale: step.zoom.scale, box: { x: x * kx, y: y * ky, width: w * kx, height: h * ky } };
  }
  steps.push({
    id: step.id,
    still: step.still || null,
    clip: line.clip,
    clipStart,
    lineStart,
    lineEnd,
    start: stepStart,
    actionStart,
    actionEnd,
    end,
    zoom,
    // a still's zoom is released as the next still arrives, so no explicit pull-back
    pullBackTo: null,
  });
  t = end;
}
const total = t + TAIL;

// --- footage: one pre-rendered segment per step, then dissolves ------------------------------
// A still becomes a held frame; a clip plays at 1× from `in` to `out` and its last frame is
// held (tpad clone) to the step length. Every segment is scaled to 2× the viewport.
const FW = VP.width * 2,
  FH = VP.height * 2;
const SEG = join(CAP, "segments");
mkdirSync(SEG, { recursive: true });
const fit = `scale=${FW}:${FH}:force_original_aspect_ratio=decrease,pad=${FW}:${FH}:(ow-iw)/2:(oh-ih)/2:color=#F7F4EF,setsar=1,fps=30,format=yuv420p`;
const segFiles = [];
steps.forEach((s, i) => {
  const need = (i + 1 < steps.length ? steps[i + 1].start : total) - s.start + XFADE + (i + 1 < steps.length ? 0 : 0.5);
  const out = join(SEG, `${s.id}.mp4`);
  const spec = lesson.steps[i];
  let args;
  if (spec.clip) {
    const c = spec.clip;
    const len = c.out - c.in;
    if (len <= 0) {
      console.error(`stage-stills: step ${s.id} clip has out <= in`);
      process.exit(2);
    }
    const crop = c.crop ? `crop=${c.crop.join(":")},` : "";
    // play the clip, then hold its last frame for whatever the line still needs
    args = ["-y", "-loglevel", "error", "-ss", c.in.toFixed(3), "-to", c.out.toFixed(3), "-i", join(ROOT, c.src), "-vf", `${crop}${fit},tpad=stop_mode=clone:stop_duration=${Math.max(0, need - len + 0.1).toFixed(3)}`, "-t", need.toFixed(3), "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "14", out];
    s.clipSrc = { src: c.src, in: c.in, out: c.out, played: Math.min(len, need) };
  } else {
    args = ["-y", "-loglevel", "error", "-loop", "1", "-t", need.toFixed(3), "-i", join(ROOT, s.still), "-vf", fit, "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "14", out];
  }
  const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    console.error(`stage-stills: ffmpeg failed on step ${s.id}`);
    process.exit(1);
  }
  segFiles.push(out);
});
const args = ["-y", "-loglevel", "error"];
for (const f of segFiles) args.push("-i", f);
const filters = [];
let last = "0:v";
for (let i = 1; i < steps.length; i++) {
  const off = steps[i].start - XFADE; // absolute time the dissolve begins
  const outLabel = i === steps.length - 1 ? "v" : `x${i}`;
  filters.push(`[${last}][${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${off.toFixed(3)}[${outLabel}]`);
  last = outLabel;
}
if (steps.length === 1) filters.push(`[0:v]copy[v]`);
args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-t", total.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-movflags", "+faststart", join(ROOT, "assets/footage.mp4"));
const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
if (r.status !== 0) {
  console.error("stage-stills: ffmpeg failed to join the segments");
  process.exit(1);
}

writeFileSync(
  join(CAP, "timeline.json"),
  JSON.stringify({ viewport: VP, audioLead: AUDIO_LEAD, duration: total, mode: "stills", steps, cursor, clicks: [], typing: [] }, null, 1),
);
const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "default=nw=1", join(ROOT, "assets/footage.mp4")]).stdout.toString().trim();
console.error(`stage-stills: ${steps.length} stills, ${total.toFixed(2)}s\n${probe}`);
for (const s of steps) console.error(`  ${s.id}  ${s.start.toFixed(2)}–${s.end.toFixed(2)}  line ${s.lineStart.toFixed(2)}–${s.lineEnd.toFixed(2)}${s.zoom && !s.zoom.wide ? `  ×${s.zoom.scale}` : "  wide"}${s.clipSrc ? `  clip ${s.clipSrc.in}–${s.clipSrc.out}s (${s.clipSrc.played.toFixed(1)}s played)` : "  still"}`);
