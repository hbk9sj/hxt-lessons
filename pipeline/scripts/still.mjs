// still.mjs — one PNG of the composition at a given second, to choose a look without a
// full render. Serves the project over a local HTTP server (file:// aborts media range
// requests), seeks the GSAP timeline and the footage video by hand. Preview only.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
const ROOT = process.cwd();
const t = Number(process.argv[2] || 2), out = process.argv[3] || `out/still-${t}.png`;
const P = process.env.ORIENT === "portrait";
const types = { ".html": "text/html", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".woff2": "font/woff2", ".png": "image/png", ".js": "text/javascript" };
const srv = createServer((req, res) => {
  const f = join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!existsSync(f) || statSync(f).isDirectory()) return res.writeHead(404).end();
  const size = statSync(f).size, type = types[extname(f)] || "application/octet-stream";
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${a}-${b}/${size}`, "Content-Length": b - a + 1, "Accept-Ranges": "bytes" });
    return createReadStream(f, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  createReadStream(f).pipe(res);
}).listen(0);
const port = srv.address().port;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: P ? 1080 : 1920, height: P ? 1920 : 1080 } });
await p.goto(`http://127.0.0.1:${port}/index.html`);
for (let i = 0; i < 120; i++) {
  if (await p.evaluate(() => !!(window.__timelines && window.__timelines["screen-lesson"]))) break;
  await new Promise((r) => setTimeout(r, 500));
}
await p.evaluate(async (t) => {
  window.__timelines["screen-lesson"].seek(t);
  const v = document.getElementById("footage"); v.currentTime = t;
  await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
  await new Promise((r) => setTimeout(r, 400));
}, t);
await p.screenshot({ path: join(ROOT, out) }); await b.close(); srv.close();
console.error(`still: ${out}`);
