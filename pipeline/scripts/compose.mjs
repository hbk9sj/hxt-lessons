// compose.mjs — capture/timeline.json + assets/voice/lines.json → index.html
//
// The footage is a muted <video> inside a padded window (#cam). The camera is a GSAP
// scale/translate on #cam (the yt-camera-move helpers from the HyperFrames registry),
// the cursor is the registry's simulated-cursor driven from the capture log, and each
// narration line is its own <audio> placed where its step started. Nothing here plays
// or seeks media; HyperFrames owns playback.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd(); // the lesson project; scripts are shared between lessons
const lesson = JSON.parse(readFileSync(join(ROOT, "lesson.json"), "utf8"));
const tl = JSON.parse(readFileSync(join(ROOT, "capture/timeline.json"), "utf8"));

// --- geometry ------------------------------------------------------------------------
// ORIENT=landscape (default, 1920×1080) or portrait (1080×1920). Screen-Studio-style stage:
// padding, a browser chrome bar, rounded window, soft shadow, gradient behind. #cam is the
// whole window (chrome + footage) and is what the camera transforms.
const PORTRAIT = process.env.ORIENT === "portrait";
const W = PORTRAIT ? 1080 : 1920,
  H = PORTRAIT ? 1920 : 1080;
const CHROME_H = PORTRAIT ? 40 : 46;
const FOOT_W = PORTRAIT ? 1000 : 1600;
const FOOT_H = Math.round((FOOT_W * tl.viewport.height) / tl.viewport.width);
const CAM_W = FOOT_W,
  CAM_H = FOOT_H + CHROME_H;
const CAM_X = (W - CAM_W) / 2,
  CAM_Y = PORTRAIT ? 560 : (H - CAM_H) / 2;
const K = FOOT_W / tl.viewport.width; // viewport px → footage px (inside the window)
const r2 = (n) => Math.round(n * 100) / 100;

// Camera translate that brings window point (cx, cy) to the frame centre at scale s,
// clamped so the window's edge never shows inside the frame.
function camFor(cx, cy, s) {
  let tx = -(cx - CAM_W / 2) * s;
  let ty = -(cy - CAM_H / 2) * s;
  const lx = (CAM_W / 2) * s - W / 2,
    ly = (CAM_H / 2) * s - H / 2;
  if (s <= 1.04) return { s: 1, tx: 0, ty: 0 };
  tx = lx > 0 ? Math.max(-lx, Math.min(lx, tx)) : 0;
  ty = ly > 0 ? Math.max(-ly, Math.min(ly, ty)) : 0;
  return { s, tx: r2(tx), ty: r2(ty) };
}
const centreOf = (box, bias = {}) => ({
  cx: (box.x + box.width / 2 + (bias.x || 0)) * K,
  cy: (box.y + box.height / 2 + (bias.y || 0)) * K + CHROME_H,
});

// --- camera cues -----------------------------------------------------------------------
// One push per step at its first click (or at action start), pull-back after its last
// click. "home" is the code card from step 02, used when a step pulls back to a number.
const cues = []; // { t, s, tx, ty, dur }
let home = null;
let current = { s: 1, tx: 0, ty: 0 };
let lastPushEnd = 0;
const clicksIn = (st) => tl.clicks.filter((c) => c.t >= st.actionStart - 0.01 && c.t <= st.end);
for (let i = 0; i < tl.steps.length; i++) {
  const st = tl.steps[i];
  const spec = lesson.steps[i].zoom || {};
  const clicks = clicksIn(st);
  const stills = tl.mode === "stills";
  if (st.zoom && !st.zoom.wide && st.zoom.box) {
    const { cx, cy } = centreOf(st.zoom.box, spec.bias);
    if (lesson.steps[i].id === "02") home = { cx, cy };
    // Move in as the cursor approaches, so the camera settles as the click lands. On a
    // stills lesson the push rides the dissolve into the new still instead.
    const at = stills ? st.start + 0.15 : clicks.length ? Math.max(st.actionStart + 0.1, clicks[0].t - 0.55) : st.actionStart;
    let scale = st.zoom.scale;
    if (PORTRAIT) {
      // the authored scale is for a wide frame; in portrait fill ~85 % of the width
      const bw = st.zoom.box.width * K,
        bh = st.zoom.box.height * K;
      scale = Math.max(1.25, Math.min(3.2, (0.85 * W) / bw, (0.6 * H) / bh));
      scale = Math.round(scale * 100) / 100;
    }
    const cam = camFor(cx, cy, scale);
    cues.push({ t: r2(at), ...cam, dur: 1.1 });
    current = cam;
    lastPushEnd = at + 1.1;
  } else if (stills && st.zoom && st.zoom.wide && current.s > 1) {
    const cam = camFor(0, 0, 1);
    cues.push({ t: r2(st.start + 0.15), ...cam, dur: 0.9 });
    current = cam;
  }
  if (st.pullBackTo != null) {
    const at = Math.max(lastPushEnd + 0.5, (clicks.length ? clicks[clicks.length - 1].t : st.actionEnd) + 0.7);
    const cam =
      st.pullBackTo === "wide" || !home ? camFor(0, 0, 1) : camFor(home.cx, home.cy, Number(st.pullBackTo));
    cues.push({ t: r2(at), ...cam, dur: 0.9 });
    current = cam;
  }
}
// Automatic re-centre: while zoomed, if the cursor sits outside the inner 70 % of the
// visible region for more than 350 ms, one gentle pan to it. The only unauthored move.
const visibleRect = (cam) => {
  const vw = W / cam.s,
    vh = H / cam.s;
  const cx = CAM_W / 2 - cam.tx / cam.s,
    cy = CAM_H / 2 - cam.ty / cam.s;
  return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
};
{
  const sorted = [...cues].sort((a, b) => a.t - b.t);
  const extra = [];
  for (let i = 0; i < sorted.length; i++) {
    const cam = sorted[i];
    if (cam.s <= 1.04) continue;
    const from = cam.t + cam.dur,
      to = i + 1 < sorted.length ? sorted[i + 1].t : tl.duration;
    const v = visibleRect(cam);
    let outSince = null;
    for (const p of tl.cursor) {
      if (p.t < from || p.t > to) continue;
      const x = p.x * K,
        y = p.y * K + CHROME_H;
      const inside =
        x > v.x + v.w * 0.15 && x < v.x + v.w * 0.85 && y > v.y + v.h * 0.15 && y < v.y + v.h * 0.85;
      if (inside) outSince = null;
      else if (outSince == null) outSince = p.t;
      else if (p.t - outSince > 0.35) {
        extra.push({ t: r2(outSince + 0.35), ...camFor(x, y, cam.s), dur: 0.8 });
        break;
      }
    }
  }
  cues.push(...extra);
}
cues.sort((a, b) => a.t - b.t);

// --- cursor ------------------------------------------------------------------------------
// 30 Hz samples from the log; between logged points the cursor holds.
const cursorSets = [];
{
  let last = null;
  for (const p of tl.cursor) {
    if (last && p.t - last < 1 / 30) continue;
    cursorSets.push(`tl.set(C,{"--hf-cursor-x":"${r2(p.x * K)}px","--hf-cursor-y":"${r2(p.y * K)}px"},${r2(p.t)});`);
    last = p.t;
  }
}
const first = tl.cursor[0] || { x: tl.viewport.width * 0.62, y: tl.viewport.height * 0.9 };
const pulses = tl.clicks
  .map((c) => `tl.fromTo(P,{opacity:0.75,scale:0.25},{opacity:0,scale:2.2,duration:0.42,ease:"power2.out"},${r2(c.t)});`)
  .join("\n      ");

// --- audio ---------------------------------------------------------------------------------
const voices = tl.steps
  .map((st) => `<audio id="v${st.id}" src="${st.clip}" data-start="${r2(st.clipStart)}" data-volume="1"></audio>`)
  .join("\n      ");
const clickSfx = tl.clicks
  .map((c, i) => `<audio id="sfx-click-${i}" src="assets/sfx/click-soft.mp3" data-start="${r2(c.t)}" data-volume="0.3"></audio>`)
  .join("\n      ");
const keySfx = [];
for (const b of tl.typing) {
  for (let t = b.t0 + 0.05, n = 0; t < b.t1; t += 0.33 + (n % 3) * 0.05, n++) {
    keySfx.push(`<audio id="sfx-key-${keySfx.length}" src="assets/sfx/key-press.mp3" data-start="${r2(t)}" data-volume="0.16"></audio>`);
  }
}

// --- portrait captions: the spoken line, shown while its clip plays -----------------------
const lines = JSON.parse(readFileSync(join(ROOT, "assets/voice/lines.json"), "utf8"));
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const captions = PORTRAIT
  ? tl.steps
      .map((st, i) => {
        const ws = lines[i] && lines[i].wordsTimed && lines[i].wordsTimed.length ? lines[i].wordsTimed : null;
        const inner = ws
          ? ws.map((w, k) => `<i id="w-${st.id}-${k}">${esc(w.text)}</i>`).join(" ")
          : esc(lesson.steps[i].say);
        return `<div class="cap" id="cap-${st.id}"><span>${inner}</span></div>`;
      })
      .join("\n      ")
  : "";
const capScript = PORTRAIT
  ? tl.steps
      .map((st, i) => {
        const ws = lines[i] && lines[i].wordsTimed ? lines[i].wordsTimed : [];
        const show = `tl.fromTo("#cap-${st.id}",{opacity:0,y:14},{opacity:1,y:0,duration:0.35,ease:"power2.out"},${r2(st.clipStart)});tl.to("#cap-${st.id}",{opacity:0,duration:0.25,ease:"power2.in"},${r2(Math.max(st.clipStart + 0.5, st.end - 0.25))});`;
        const words = ws.map((w, k) => `tl.set("#w-${st.id}-${k}",{color:"#F8635F"},${r2(st.clipStart + w.start)});`).join("");
        return show + words;
      })
      .join("\n      ")
  : "";

// --- camera script -------------------------------------------------------------------------
// Motion blur: during a camera move the footage is blurred along the direction of travel,
// peaking mid-move (velocity is bell-shaped under power2.inOut). Amount ≈ px moved per
// frame / 2, capped at 7 px — Screen Studio's range. Set on an SVG feGaussianBlur from
// the tween's onUpdate, which HyperFrames evaluates on every seek, so it is deterministic.
let prev = { s: 1, tx: 0, ty: 0 };
const camScript = cues
  .map((c) => {
    const dx = c.tx - prev.tx,
      dy = c.ty - prev.ty,
      ds = Math.abs(c.s - prev.s) * 420; // a scale change moves the edges about this far
    prev = c;
    const dist = Math.hypot(dx, dy) + ds;
    const peak = Math.min(7, dist / c.dur / 30 / 2);
    const ax = (Math.abs(dx) + ds * 0.5) / (Math.abs(dx) + Math.abs(dy) + ds + 1e-6);
    const ay = (Math.abs(dy) + ds * 0.5) / (Math.abs(dx) + Math.abs(dy) + ds + 1e-6);
    return `tl.to("#cam",{scale:${c.s},x:${c.tx},y:${c.ty},duration:${c.dur},ease:"power2.inOut",onUpdate:function(){var p=this.progress();var b=${peak.toFixed(2)}*Math.sin(Math.PI*p);MB.setAttribute("stdDeviation",(b*${ax.toFixed(2)}).toFixed(2)+" "+(b*${ay.toFixed(2)}).toFixed(2));}},${c.t});`;
  })
  .join("\n      ");
const whooshes = cues
  .filter((c) => c.s > 1.04)
  .map((c, i) => `<audio id="sfx-whoosh-${i}" src="assets/sfx/whoosh-short.mp3" data-start="${r2(c.t)}" data-volume="0.1"></audio>`)
  .join("\n      ");

// Stage palettes. Chrome and accents stay charcoal/coral (Hit x Trial look A); only the
// ground behind the window changes.
const THEMES = {
  graphite: {
    body: "#17181c",
    stage: "radial-gradient(70% 70% at 10% 8%, rgba(248, 99, 95, 0.22) 0%, rgba(248, 99, 95, 0) 60%), radial-gradient(60% 60% at 92% 94%, rgba(227, 197, 108, 0.16) 0%, rgba(227, 197, 108, 0) 60%), linear-gradient(160deg, #24262c 0%, #17181c 60%, #121317 100%)",
    lowerBg: "#FFFFFF", lowerFg: "#2D2D2D",
  },
  slate: {
    body: "#1b2430",
    stage: "radial-gradient(70% 70% at 12% 10%, rgba(120, 170, 255, 0.35) 0%, rgba(120, 170, 255, 0) 60%), radial-gradient(60% 60% at 90% 92%, rgba(248, 99, 95, 0.22) 0%, rgba(248, 99, 95, 0) 60%), linear-gradient(160deg, #2b3a4e 0%, #1b2430 55%, #141b24 100%)",
    lowerBg: "#FFFFFF", lowerFg: "#2D2D2D",
  },
  paper: {
    body: "#F6EFE4",
    stage: "radial-gradient(70% 70% at 8% 6%, rgba(248, 99, 95, 0.32) 0%, rgba(248, 99, 95, 0) 60%), radial-gradient(60% 60% at 94% 96%, rgba(227, 197, 108, 0.45) 0%, rgba(227, 197, 108, 0) 60%), linear-gradient(160deg, #FBF6EE 0%, #F3EADB 55%, #EFE3D0 100%)",
    lowerBg: "#FFFFFF", lowerFg: "#2D2D2D",
  },
  coral: {
    body: "#f0554f",
    stage: "radial-gradient(80% 80% at 15% 10%, rgba(255, 210, 140, 0.55) 0%, rgba(255, 210, 140, 0) 60%), radial-gradient(60% 60% at 90% 90%, rgba(120, 40, 60, 0.45) 0%, rgba(120, 40, 60, 0) 60%), linear-gradient(160deg, #ff7a6e 0%, #f0554f 50%, #d6423f 100%)",
    lowerBg: "#FFFFFF", lowerFg: "#2D2D2D",
  },
};
const themeName = process.env.STAGE_THEME || "slate";
const theme = THEMES[themeName];
if (!theme) {
  console.error(`compose: unknown STAGE_THEME "${themeName}" (have ${Object.keys(THEMES).join(", ")})`);
  process.exit(2);
}
// Address-bar text: lesson.chrome, else the host of lesson.url.
const chromeLabel = lesson.chrome || (lesson.url ? new URL(lesson.url).host : "");
const D = r2(tl.duration);
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${lesson.title}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face {
        font-family: "Quicksand";
        src: url("assets/fonts/Quicksand_SemiBold.woff2") format("woff2");
        font-weight: 600;
      }
      /* Stage palette: STAGE_THEME env picks one; see THEMES above. */
      body { margin: 0; background: ${theme.body}; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${theme.stage}; }
      #cam {
        position: absolute; left: ${CAM_X}px; top: ${CAM_Y}px; width: ${CAM_W}px; height: ${CAM_H}px;
        border-radius: 18px; overflow: hidden; background: #16181d;
        box-shadow: 0 34px 70px rgba(45, 45, 45, 0.28), 0 6px 18px rgba(45, 45, 45, 0.18), 0 0 0 1px rgba(45, 45, 45, 0.12);
        transform-origin: 50% 50%;
      }
      #chrome { position: absolute; left: 0; top: 0; width: ${CAM_W}px; height: ${CHROME_H}px; background: #2D2D2D; display: flex; align-items: center; }
      #chrome .dots { display: flex; gap: 8px; margin-left: 18px; }
      #chrome .dots i { width: 12px; height: 12px; border-radius: 50%; display: block; }
      #chrome .url { margin: 0 auto; transform: translateX(-27px); background: #1f1f1f; color: #CFCFCF; border-radius: 8px; padding: 6px 18px; font: 600 15px/1 "Quicksand", system-ui, sans-serif; letter-spacing: 0.02em; }
      #footage-wrap { position: absolute; left: 0; top: ${CHROME_H}px; width: ${FOOT_W}px; height: ${FOOT_H}px; overflow: hidden; }
      #footage { position: absolute; left: 0; top: 0; width: ${FOOT_W}px; height: ${FOOT_H}px; display: block; }
      #footage-wrap { filter: url(#mb); }
      #lower-third {
        position: absolute; left: 160px; bottom: 12px; padding: 9px 20px 9px 16px; border-radius: 10px;
        background: #FFFFFF; color: #2D2D2D; font: 600 26px/1.15 "Quicksand", system-ui, sans-serif;
        letter-spacing: 0.01em; opacity: 0; box-shadow: 0 10px 28px rgba(45,45,45,0.18); border-left: 7px solid #F8635F;
      }
      #watermark {
        position: absolute; right: 160px; bottom: 14px; padding: 9px 18px; border-radius: 999px;
        background: rgba(45, 45, 45, 0.92); color: #FFFFFF; font: 600 22px/1 "Quicksand", system-ui, sans-serif;
        letter-spacing: 0.02em; box-shadow: 0 8px 20px rgba(45,45,45,0.18);
      }
      #watermark b { color: #FF8A86; font-weight: 600; }
      .cap { position: absolute; left: 60px; right: 60px; top: 1585px; opacity: 0; text-align: center;
        font: 600 42px/1.35 "Quicksand", system-ui, sans-serif; color: #2D2D2D; }
      .cap span { background: #FFFFFF; padding: 6px 18px; border-radius: 12px; box-decoration-break: clone; -webkit-box-decoration-break: clone; box-shadow: 0 10px 28px rgba(0,0,0,0.25); }
      .cap i { font-style: normal; }
      ${PORTRAIT ? `
      #lower-third { left: 60px; right: 60px; top: 300px; bottom: auto; text-align: center; font-size: 44px; padding: 18px 24px; }
      #watermark { right: auto; left: 50%; transform: translateX(-50%); bottom: 44px; font-size: 26px; }
      ` : ""}
      /* simulated-cursor (HyperFrames registry) */
      .hf-simulated-cursor {
        position: absolute; left: 0; top: 0;
        width: calc(44px * var(--hf-cursor-scale, 1)); height: calc(44px * var(--hf-cursor-scale, 1));
        transform: translate3d(var(--hf-cursor-x, 0px), var(--hf-cursor-y, 0px), 0);
        pointer-events: none; z-index: 999; filter: drop-shadow(0 8px 18px rgba(0, 0, 0, 0.24));
      }
      .hf-simulated-cursor svg { width: 100%; height: 100%; }
      .hf-simulated-cursor svg path { fill: var(--hf-cursor-fill, #ffffff); stroke: var(--hf-cursor-edge, rgba(0, 0, 0, 0.45)); }
      .hf-simulated-cursor-pulse {
        display: var(--hf-cursor-ring-display, block); position: absolute;
        left: calc((20px - var(--hf-cursor-ring-size, 22px) / 2) * var(--hf-cursor-scale, 1));
        top: calc((20px - var(--hf-cursor-ring-size, 22px) / 2) * var(--hf-cursor-scale, 1));
        width: calc(var(--hf-cursor-ring-size, 22px) * var(--hf-cursor-scale, 1));
        height: calc(var(--hf-cursor-ring-size, 22px) * var(--hf-cursor-scale, 1));
        border: calc(var(--hf-cursor-ring-width, 2px) * var(--hf-cursor-scale, 1)) solid var(--hf-cursor-ring, rgba(255, 255, 255, 0.85));
        border-radius: 999px; opacity: 0; transform: scale(0.2);
      }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="screen-lesson" data-start="0" data-width="${W}" data-height="${H}" data-duration="${D}">
      <div id="cam">
        <div id="chrome"><div class="dots"><i style="background:#F8635F"></i><i style="background:#E3C56C"></i><i style="background:#B9CB8C"></i></div><div class="url" data-layout-allow-overflow>${chromeLabel}</div></div>
        <div id="footage-wrap">
        <video id="footage" src="assets/footage.mp4" data-start="0" data-duration="${D}" muted playsinline></video>
        <div class="hf-simulated-cursor" id="cursor" aria-hidden="true" style="--hf-cursor-scale: 0.82; --hf-cursor-ring-size: 18px; --hf-cursor-ring-width: 1.5px; --hf-cursor-x: ${r2(first.x * K)}px; --hf-cursor-y: ${r2(first.y * K)}px;">
          <div class="hf-simulated-cursor-pulse" id="cursor-pulse"></div>
          <svg viewBox="0 0 24 24" width="44" height="44">
            <path d="M3 2.8 20.6 14 12.8 15.5 9 22 3 2.8Z" fill="white" stroke="rgba(0,0,0,0.45)" stroke-width="1.4" />
          </svg>
        </div>
        </div>
      </div>
      <div id="lower-third">${lesson.title}</div>
      ${captions}
      <div id="watermark"><b>▶</b> Hit x Trial · @hitxtrial</div>
      ${voices}
      ${clickSfx}
      ${keySfx.join("\n      ")}
      ${whooshes}
      <svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="mb" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur id="mb-blur" stdDeviation="0 0" /></filter></svg>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      const C = "#cursor", P = "#cursor-pulse", MB = document.getElementById("mb-blur");
      gsap.set("#cam", { transformPerspective: 1200, transformOrigin: "50% 50%" });
      // title
      tl.to("#lower-third", { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, 0.5);
      tl.to("#lower-third", { opacity: 0, duration: 0.45, ease: "power2.in" }, ${PORTRAIT ? 4.6 : 3.6});
      ${capScript}
      // camera (yt-camera-move pattern: scale + translate, power2.inOut)
      ${camScript}
      // cursor
      ${cursorSets.join("\n      ")}
      ${pulses}
      tl.set("#root", { visibility: "visible" }, ${D});
      window.__timelines = window.__timelines || {};
      window.__timelines["screen-lesson"] = tl;
    </script>
  </body>
</html>
`;
writeFileSync(join(ROOT, "index.html"), html);
console.error(`compose: ${cues.length} camera moves, ${cursorSets.length} cursor samples, ${tl.clicks.length} clicks, ${keySfx.length} key sounds, ${D}s`);
for (const c of cues) console.error(`  cam @${c.t.toFixed(2)}s → ×${c.s} (${c.tx}, ${c.ty})`);
