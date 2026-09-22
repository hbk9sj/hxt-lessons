// capture.mjs — drive the lesson in a real browser and record it.
//
//   node scripts/capture.mjs          full run: needs assets/voice/lines.json, writes
//                                     capture/frames/*.jpg, capture/frames.txt,
//                                     capture/timeline.json
//   node scripts/capture.mjs --dry    no recording, no narration timing: runs every
//                                     action with short waits, prints each target's box,
//                                     saves capture/dry.png. Proves the selectors.
//
// Tour mode (lesson.mode === "tour"): the "no software installed, no vendor video" route.
// Each step names a public page and a thing on it — `{ page, show, click?, hide? }` — and
// the driver finds `show` by its visible text (heading, link, button, then any text),
// scrolls it into the upper third with an eased human scroll, and rests the pointer on
// it. The zoom box is the element's own bounding box, so nothing is hand-measured. No
// clicks unless the step says `click: true` and the target is a link on the same site.
// A step whose `show` is not on the page is recorded wide with the pointer parked and
// logged as a miss; two misses in one lesson exit 2, because a lesson that points at
// nothing twice is not a lesson.
//
// The picture and the narration share one timebase: T0 is the moment the screencast
// starts; the narration is placed at T0 + AUDIO_LEAD in the composition, and every
// step waits on the wall clock for its line's measured start. Frames are stamped by
// Chromium (epoch seconds) and log events by Date.now(), so a dropped frame becomes a
// held frame, never a time slip.

import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd(); // the lesson project; scripts are shared between lessons
const DRY = process.argv.includes("--dry");
const AUDIO_LEAD = 0.6; // seconds of quiet before the first word
const TAIL = 1.2; // seconds held after the last step

const lesson = JSON.parse(readFileSync(join(ROOT, "lesson.json"), "utf8"));
const IS_TOUR = lesson.mode === "tour";
const linesPath = join(ROOT, "assets/voice/lines.json");
if (!DRY && !existsSync(linesPath)) {
  console.error("capture: assets/voice/lines.json is missing — run `npm run narrate` first");
  process.exit(2);
}
const lines = DRY ? null : JSON.parse(readFileSync(linesPath, "utf8"));

// --- deterministic "randomness" so a re-run gives the same feel ---------------------
let seed = 20260922;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const between = (a, b) => a + (b - a) * rnd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- output -----------------------------------------------------------------------
const CAP = join(ROOT, "capture");
const FRAMES = join(CAP, "frames");
if (!DRY) {
  rmSync(CAP, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
}

const log = { cursor: [], clicks: [], typing: [], steps: [] };
const frames = []; // { file, ts } ts = epoch seconds from Chromium
let T0 = 0; // epoch ms when the recording clock started
const now = () => (Date.now() - T0) / 1000;

// A sandbox may ship a Chromium that Playwright's own version pin does not match (the
// cloud runner has 1194 while playwright 1.58 wants 1208, and the download CDN is blocked
// there). PW_EXECUTABLE points the launcher at whatever browser is actually installed.
const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const context = await browser.newContext({
  viewport: lesson.viewport,
  deviceScaleFactor: 2,
  colorScheme: lesson.colorScheme || (IS_TOUR ? "light" : "dark"),
  acceptDownloads: true,
  locale: "en-US",
});
const page = await context.newPage();
page.on("download", (d) => d.cancel().catch(() => {})); // Export is shown, not kept

// --- tour helpers -----------------------------------------------------------------------
// Banners that sit on top of every public site: cookie consent, sticky sign-up bars,
// chat bubbles. Hidden by common selectors plus the lesson's own `hide` list.
const TOUR_HIDE = [
  "[id*='cookie' i]", "[class*='cookie' i]", "[id*='consent' i]", "[class*='consent' i]",
  "[aria-label*='cookie' i]", "#onetrust-consent-sdk", ".cc-window", "[class*='gdpr' i]",
  "[id*='intercom' i]", "[class*='intercom' i]", "[id*='crisp' i]", "[id*='hubspot-messages' i]",
  "iframe[title*='chat' i]", "[class*='announcement-bar' i]", "[class*='banner' i][class*='top' i]",
];
async function tourClean(extra = []) {
  const sels = [...TOUR_HIDE, ...(lesson.hide || []), ...extra];
  await page.addStyleTag({
    content: `${sels.join(", ")} { display: none !important; }
    ::-webkit-scrollbar { display: none !important; } html { scrollbar-width: none !important; }
    html { scroll-behavior: auto !important; }`,
  }).catch(() => {});
}
let currentUrl = null;
async function tourGoto(url) {
  if (currentUrl === url) return;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await tourClean();
  await sleep(between(500, 800));
  currentUrl = url;
}
// Find a thing by what a viewer would read on it. Exact heading first, then link, then
// button, then any text; each also tried case-insensitively as a substring.
async function tourFind(text) {
  const tries = [
    () => page.getByRole("heading", { name: text, exact: true }),
    () => page.getByRole("link", { name: text, exact: true }),
    () => page.getByRole("button", { name: text, exact: true }),
    () => page.getByText(text, { exact: true }),
    () => page.getByRole("heading", { name: text }),
    () => page.getByRole("link", { name: text }),
    () => page.getByText(text),
  ];
  for (const t of tries) {
    const loc = t().first();
    if ((await loc.count()) === 0) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    return loc;
  }
  return null;
}
// Eased scroll so the element sits about a third of the way down the viewport.
async function tourScrollTo(loc) {
  const b = await loc.boundingBox();
  if (!b) return null;
  const targetY = b.y - lesson.viewport.height * 0.33;
  if (Math.abs(targetY) > 8) {
    const n = Math.max(8, Math.min(28, Math.round(Math.abs(targetY) / 60)));
    let done = 0;
    for (let i = 1; i <= n; i++) {
      const p = 1 - Math.pow(1 - i / n, 3);
      const want = Math.round(targetY * p);
      const dy = want - done;
      done = want;
      await page.mouse.wheel(0, dy);
      await sleep(between(22, 38));
    }
    await sleep(between(250, 450));
  }
  return loc.boundingBox();
}
async function tourSameSite(loc) {
  const href = await loc.getAttribute("href").catch(() => null);
  if (!href) return false;
  try {
    const u = new URL(href, page.url());
    return u.host === new URL(page.url()).host && !/sign|login|register|download|\.(zip|dmg|exe|pkg)$/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

if (!IS_TOUR) await page.goto(lesson.url, { waitUntil: "networkidle", timeout: 90000 });
else await tourGoto(lesson.steps[0].page || lesson.url);
// Clean canvas: no sponsor card, no sign-in, no scrollbars (the Carbon lesson).
if (!IS_TOUR) await page.addStyleTag({
  content: `
    [class*="carbon-ad"], #carbonads, .carbon-ad, [id^="carbonads"], a[href*="carbonads"] { display: none !important; }
    .profile-button { visibility: hidden !important; }
    img[alt='Vercel logo'] { visibility: hidden !important; }
    footer { visibility: hidden !important; }
    ::-webkit-scrollbar { display: none !important; }
    html { scrollbar-width: none !important; }
  `,
});
if (!IS_TOUR) await page.evaluate(() => {
  // The sponsor card has no stable id; hide any block whose text is the ad copy.
  for (const el of document.querySelectorAll("div, aside, section")) {
    const t = (el.innerText || "").trim();
    if (t.startsWith("Google Cloud") || /ads via/i.test(t) || /^created by @carbon_app/i.test(t)) {
      if (el.children.length < 8) el.style.display = "none";
    }
  }
});
await page.mouse.move(lesson.viewport.width * 0.62, lesson.viewport.height * 0.9);
let cur = { x: lesson.viewport.width * 0.62, y: lesson.viewport.height * 0.9 };
await sleep(600);

// --- frame capture -------------------------------------------------------------------
// The CDP screencast ignores deviceScaleFactor (frames came back 1600×900), so frames are
// taken with Page.captureScreenshot with a scale-2 clip (3200×1800, ~50 ms each) on a
// 12 fps loop. Only typing and menus move in the footage; the cursor is drawn at render.
const FPS = 12;
let cdp = null;
let capturing = false;
async function captureLoop() {
  while (capturing) {
    const tick = Date.now();
    try {
      // The clip is in document coordinates, not viewport ones: after the page scrolls,
      // {0,0} is above the visible area and every frame comes back black (found on the
      // first tour lesson, 22 Sep 2026). Offset by the current scroll position.
      const [sx, sy] = await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => [0, 0]);
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 92,
        fromSurface: true,
        // scale: 2 in the clip is what makes Chromium hand back device pixels (3200×1800);
        // without it every route returns CSS pixels regardless of deviceScaleFactor.
        clip: { x: sx, y: sy, width: lesson.viewport.width, height: lesson.viewport.height, scale: 2 },
      });
      const file = join(FRAMES, String(frames.length).padStart(5, "0") + ".jpg");
      writeFileSync(file, Buffer.from(data, "base64"));
      frames.push({ file, ts: tick / 1000 });
    } catch {}
    const wait = 1000 / FPS - (Date.now() - tick);
    if (wait > 0) await sleep(wait);
  }
}
if (!DRY) {
  cdp = await context.newCDPSession(page);
  capturing = true;
}
T0 = Date.now();
const loop = DRY ? null : captureLoop();

// --- humanised input ---------------------------------------------------------------
const easeOut = (p) => 1 - Math.pow(1 - p, 3);

async function moveTo(x, y) {
  const dx = x - cur.x,
    dy = y - cur.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  const dur = Math.min(700, Math.max(380, 380 + dist * 0.45));
  const bow = between(8, 20) * (rnd() < 0.5 ? -1 : 1); // gentle curve, not a straight line
  const nx = -dy / dist,
    ny = dx / dist; // perpendicular
  const steps = Math.round(dur / 16);
  const start = { ...cur };
  for (let i = 1; i <= steps; i++) {
    const p = easeOut(i / steps);
    const arc = Math.sin(p * Math.PI) * bow;
    cur = { x: start.x + dx * p + nx * arc, y: start.y + dy * p + ny * arc };
    await page.mouse.move(cur.x, cur.y);
    log.cursor.push({ t: now(), x: cur.x, y: cur.y });
    await sleep(16);
  }
}

async function box(selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 8000 }).catch(() => {
    throw new Error(`capture: selector not visible: ${selector}`);
  });
  const b = await loc.boundingBox();
  if (!b) throw new Error(`capture: no bounding box for: ${selector}`);
  return b;
}

async function click(selector) {
  const b = await box(selector);
  const x = b.x + b.width * between(0.35, 0.65);
  const y = b.y + b.height * between(0.4, 0.6);
  await moveTo(x, y);
  await sleep(between(450, 700)); // settle on the target before pressing
  const t = now();
  await page.mouse.down();
  await sleep(between(70, 110));
  await page.mouse.up();
  log.clicks.push({ t, x, y, selector });
  log.cursor.push({ t: now(), x: cur.x, y: cur.y });
  await sleep(between(300, 420));
  return b;
}

async function hover(selector) {
  const b = await box(selector);
  await moveTo(b.x + b.width * between(0.35, 0.65), b.y + b.height * 0.5);
  await sleep(between(250, 400));
}

async function type(text) {
  const t0 = now();
  for (const ch of text) {
    await page.keyboard.type(ch);
    let d = between(40, 105);
    if (/[.,;:!?)]/.test(ch)) d += between(180, 320);
    if (ch === "\n") d += between(220, 380);
    if (ch === " " && rnd() < 0.12) d += between(120, 260); // the occasional think
    await sleep(d);
  }
  log.typing.push({ t0, t1: now(), chars: text.length });
}

async function run(action) {
  switch (action.do) {
    case "click":
      return click(action.selector);
    case "hover":
      return hover(action.selector);
    case "type":
      return type(action.text);
    case "selectAll":
      await page.keyboard.press("Meta+A");
      await sleep(between(200, 350));
      await page.keyboard.press("Backspace");
      return sleep(between(300, 450));
    case "press":
      await page.keyboard.press(action.key);
      return sleep(between(250, 400));
    case "wait":
      return sleep(action.ms);
    default:
      throw new Error(`capture: unknown action ${action.do}`);
  }
}

const waitUntil = async (t) => {
  const ms = t * 1000 - (Date.now() - T0);
  if (ms > 0) await sleep(ms);
};

// --- the lesson --------------------------------------------------------------------
const misses = [];
for (let i = 0; i < lesson.steps.length; i++) {
  const step = lesson.steps[i];
  // Each line's clip starts when its step starts (after a breath), so the voice never
  // runs ahead of an action that takes longer than the sentence.
  const line = DRY ? { duration: 2, clipDuration: 2.2, speechOffset: 0.08, clip: null } : lines[i];
  const clipStart = i === 0 ? AUDIO_LEAD : now() + between(0.6, 0.9); // a narrator breathes between ideas
  const lineStart = clipStart + line.speechOffset;
  const lineEnd = lineStart + line.duration;
  const actAt = step.actAt === "after" ? lineEnd + 0.25 : lineStart + 0.45 * line.duration;
  if (!DRY) await waitUntil(actAt);

  const rec = { id: step.id, clip: line.clip, clipStart, lineStart, lineEnd, actionStart: now(), zoom: null, pullBackTo: null };
  let zoomBox = null;
  if (IS_TOUR) {
    // A tour step: go to the page, find the thing, scroll it up, point at it.
    if (step.page) await tourGoto(step.page);
    if (step.hide) await tourClean(step.hide);
    let found = step.show ? await tourFind(step.show) : null;
    let b = found ? await tourScrollTo(found) : null;
    if (step.show && !b) {
      misses.push(step.id);
      console.error(`capture: step ${step.id} — "${step.show}" not found on ${page.url()} (recorded wide)`);
      await moveTo(lesson.viewport.width * between(0.86, 0.92), lesson.viewport.height * between(0.84, 0.9));
    } else if (b) {
      await moveTo(b.x + b.width * between(0.3, 0.6), b.y + b.height * between(0.45, 0.6));
      log.cursor.push({ t: now(), x: cur.x, y: cur.y });
      if (step.click && (await tourSameSite(found))) {
        await sleep(between(450, 700));
        const t = now();
        await page.mouse.down();
        await sleep(between(70, 110));
        await page.mouse.up();
        log.clicks.push({ t, x: cur.x, y: cur.y, selector: step.show });
        await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
        await tourClean();
        currentUrl = page.url();
      }
      await sleep(between(300, 500));
      // zoom box = the element with 12 % padding, clamped to the viewport
      if (step.zoom && step.zoom.target !== "wide") {
        const pad = 0.12;
        const x = Math.max(0, b.x - b.width * pad),
          y = Math.max(0, b.y - b.height * pad);
        zoomBox = { x, y, width: Math.min(lesson.viewport.width - x, b.width * (1 + 2 * pad)), height: Math.min(lesson.viewport.height - y, b.height * (1 + 2 * pad)) };
      }
    } else if (i > 0) {
      await moveTo(lesson.viewport.width * between(0.86, 0.92), lesson.viewport.height * between(0.84, 0.9));
    }
    rec.actionEnd = now();
    if (step.zoom) {
      const auto = zoomBox ? Math.max(1.2, Math.min(1.7, (lesson.viewport.width * 0.6) / zoomBox.width, (lesson.viewport.height * 0.6) / zoomBox.height)) : 1;
      rec.zoom = step.zoom.target === "wide" || !zoomBox ? { wide: true } : { scale: step.zoom.scale || Number(auto.toFixed(2)), box: zoomBox };
      rec.pullBackTo = step.zoom.pullBackTo ?? null;
    }
    const end = DRY ? now() + 0.3 : Math.max(lineEnd + 0.3, rec.actionEnd + 0.4);
    await waitUntil(end);
    rec.end = now();
    log.steps.push(rec);
    console.error(`step ${step.id}: line ${lineStart.toFixed(2)}–${lineEnd.toFixed(2)}  action ${rec.actionStart.toFixed(2)}–${rec.actionEnd.toFixed(2)}  end ${rec.end.toFixed(2)}${zoomBox ? `  zoom→ ${Math.round(zoomBox.x)},${Math.round(zoomBox.y)} ${Math.round(zoomBox.width)}×${Math.round(zoomBox.height)} ×${rec.zoom.scale}` : "  wide"}`);
    continue;
  }
  if (step.zoom && step.zoom.target && step.zoom.target !== "wide" && step.zoom.at === "open") {
    zoomBox = await box(step.zoom.target).catch(() => null);
  }
  for (let k = 0; k < step.actions.length; k++) {
    await run(step.actions[k]);
    // "afterAction": n — measure the zoom target once action n has run (a popover that
    // only exists after its button is clicked, for example).
    if (step.zoom && step.zoom.afterAction === k && step.zoom.target !== "wide") {
      zoomBox = await box(step.zoom.target).catch(() => null);
    }
  }
  rec.actionEnd = now();
  if (step.zoom) {
    rec.zoom = step.zoom.target === "wide" ? { wide: true } : { scale: step.zoom.scale, box: zoomBox };
    rec.pullBackTo = step.zoom.pullBackTo ?? null;
  }
  const end = DRY ? now() + 0.3 : Math.max(lineEnd + 0.3, rec.actionEnd + 0.4);
  await waitUntil(end);
  rec.end = now();
  log.steps.push(rec);
  console.error(`step ${step.id}: line ${lineStart.toFixed(2)}–${lineEnd.toFixed(2)}  action ${rec.actionStart.toFixed(2)}–${rec.actionEnd.toFixed(2)}  end ${rec.end.toFixed(2)}${zoomBox ? `  zoom→ ${Math.round(zoomBox.x)},${Math.round(zoomBox.y)} ${Math.round(zoomBox.width)}×${Math.round(zoomBox.height)}` : ""}`);
}
await sleep(TAIL * 1000);
const total = now();
if (misses.length >= 2) {
  console.error(`capture: ${misses.length} steps pointed at nothing (${misses.join(", ")}) — refusing to write a timeline`);
  if (DRY) await page.screenshot({ path: join(CAP, "dry.png") });
  await browser.close();
  process.exit(2);
}

if (DRY) {
  await page.screenshot({ path: join(CAP, "dry.png") });
  console.error(`dry run ok — capture/dry.png, ${total.toFixed(1)}s`);
  await browser.close();
  process.exit(0);
}

capturing = false;
await loop;
await browser.close();

// --- frames → concat list ------------------------------------------------------------
// Frames are stamped in epoch seconds; T0 is epoch ms. Clamp the first frame to 0.
const t0s = T0 / 1000;
const list = [];
for (let i = 0; i < frames.length; i++) {
  const t = Math.max(0, frames[i].ts - t0s);
  const next = i + 1 < frames.length ? Math.max(0, frames[i + 1].ts - t0s) : total;
  const d = Math.max(0.001, next - t);
  list.push(`file 'frames/${String(i).padStart(5, "0")}.jpg'\nduration ${d.toFixed(4)}`);
}
// The concat demuxer needs the last file repeated for the final duration to apply;
// footage.sh trims to `duration` so the repeat adds nothing.
list.push(`file 'frames/${String(frames.length - 1).padStart(5, "0")}.jpg'`);
writeFileSync(join(CAP, "frames.txt"), list.join("\n") + "\n");

writeFileSync(
  join(CAP, "timeline.json"),
  JSON.stringify(
    {
      viewport: lesson.viewport,
      audioLead: AUDIO_LEAD,
      duration: total,
      frameCount: frames.length,
      steps: log.steps,
      cursor: log.cursor,
      clicks: log.clicks,
      typing: log.typing,
    },
    null,
    1,
  ),
);
console.error(`capture: ${frames.length} frames, ${total.toFixed(2)}s, ${log.clicks.length} clicks`);
