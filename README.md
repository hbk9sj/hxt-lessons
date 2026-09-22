# hxt-lessons

One-minute lessons about software tools for the Hit x Trial channel (@hitxtrial), made
twice a day by a scheduled Claude session: it picks a tool that changed this week, checks
the facts on the vendor's pages, writes an eight-line script, records the tool's public web
pages with a humanised pointer, narrates it (TopView), renders 16:9 and 9:16 with the house
stage, picks a thumbnail, writes the caption, and posts the 9:16 to Instagram and YouTube
through Buffer.

- `routine/brief.md` — what the scheduled session does, step by step.
- `pipeline/` — the render pipeline (HyperFrames + ffmpeg + Playwright + Whisper).
- `lessons/<date>-<slot>-<tool>/` — one directory per lesson: script, caption, narration,
  and the rendered files under `out/` (raw GitHub URLs are what Buffer fetches).
- `covered.json` — tools already covered; `runs/` — one record per run.
- `.github/workflows/lesson.yml` — fallback renderer when the session's sandbox cannot.

Footage is our own recording of public web pages; the narration is a synthetic voice.
