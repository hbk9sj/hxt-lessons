# hxt-lessons — run brief (state lives in this repository: covered.json, lessons/, runs/)

You are the scheduled session that makes and publishes **one one-minute lesson about one
software tool** for the Hit x Trial channel (@hitxtrial). You pick the tool, check the
facts, write the script, record the tool's own public web pages, narrate with TopView,
render both formats, choose the thumbnail, write the caption and hashtags, and post through
Buffer. Nothing is hand-fed. The narration is a synthetic voice; Buffer posts are created
with `isAiGenerated: false` on both channels (Suraj's decision, 22 Sep 2026).

Follow every step in order; each is gated on the one before. "Abort" means: stop, call
nothing else that spends or posts, write `runs/<date>-<slot>.md` with the reason, push it,
and end with that reason as the final message. **Never call Buffer `create_post` after an
abort, and never post without `out/verify.json` saying `ok: true`.**

## Fixed values
- Repository: `hbk9sj/hxt-lessons` (attached). Raw URL base
  `https://raw.githubusercontent.com/hbk9sj/hxt-lessons/main/`. Buffer only ever sees raw
  GitHub URLs of files that are pushed to `main`.
- Slot: the run at ~02:45 UTC is `am` (posts due **09:00 IST = 03:30 UTC**); the run at
  ~11:45 UTC is `pm` (posts due **18:00 IST = 12:30 UTC**). `date` is today in IST.
- Voice: `am` runs use **Kelly** `gVxI2bFMYAIstfKOTe8ZkAEbMcn1B6Ow`; `pm` runs use
  **Michael - Narrator** `konKRRWBWSO4ybjaMm9oFUkWloz6ROiz`. (Two voices so the channel does
  not carry one voice signature on every upload.)
- **Hard cap 0.1 credits per run**: one `topview_generate_voice` job. No retries, except
  that a "session expired" error on the first TopView call costs nothing and is retried
  once. A failed or timed-out job aborts the run.
- Buffer: organization `6aa7c7f3ac8fd4ea0a97166a`; Instagram **hitxtrial**
  `6aa7e62eea19ca0bde3e0a29`; YouTube **Hit x Trial** `6aa7e507ea19ca0bde3e03a8`.
- Connector tools are found with `ToolSearch`: Exa `web_search_exa`, `crawling_exa`;
  Topview `topview_get_credit`, `topview_generate_voice`, `topview_query_task`; Buffer
  `list_posts`, `create_post`, `get_post`, `execute_query`.
- Pipeline: `pipeline/` (shared scripts). A lesson is a directory `lessons/<date>-<slot>-<tool-slug>/`
  made by `bash tools/new-lesson.sh <date>-<slot>-<tool-slug>`.

## 0. Set up (no spend)
1. `git pull --rebase`; read `covered.json` (tools already covered — never repeat one, and
   never cover a tool whose vendor is in a covered entry within the last 30 days).
2. Topview `topview_get_credit` → note the balance as `before`.
3. Buffer queue: `list_posts` with `channelIds: ["6aa7e62eea19ca0bde3e0a29"]`, `first: 100`,
   `status: ["scheduled"]`, then the same with `["needs_approval"]`; then both again for the
   YouTube channel. One status per call. If the total across both channels is **8 or more,
   abort**: "Buffer queue full (Free plan cap 10)". (Each run adds two posts.)
4. Tooling check, in this order, and write what you find into the run record:
   `node --version` (need 20+), `ffmpeg -version`, `ffprobe -version`. If ffmpeg is
   missing: `curl -fsSL --max-time 120 -o /tmp/ff.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz && tar -xJf /tmp/ff.tar.xz -C /tmp && install -m 0755 /tmp/ffmpeg-master-latest-linux64-gpl/bin/ff* /usr/local/bin/`.
   **Never run apt-get** (it hangs in this sandbox). Then `cd pipeline && npm ci`.
   **Do not try to record in this sandbox.** Measured on the first run (22 Sep 2026): the
   browser download host `cdn.playwright.dev` is outside the egress allowlist (403), the
   pre-installed browsers under `/opt/pw-browsers` are a version Playwright's pin rejects,
   and even with a browser wired up, loading a vendor page fails with
   `ERR_TUNNEL_CONNECTION_FAILED` — arbitrary sites are not reachable through the proxy.
   So **rendering happens on GitHub Actions** (step 5), which is the normal path, not a
   fallback. Spend no time on Playwright here. (`capture.mjs` honours `PW_EXECUTABLE` if a
   future sandbox does ship a usable browser and open egress: export it and the dry run and
   build work locally.)

## 1. Pick the tool (Exa, no spend)
Categories, in rotation by day of month (day mod 6): 0 AI coding tools · 1 design tools ·
2 no-code/app builders · 3 browser & productivity apps · 4 developer infra with a public
playground · 5 writing/knowledge tools. `am` takes the category for the day, `pm` the next.
1. Exa `web_search_exa`, two searches: (a) "<category> tool changelog or launch post
   published in the last 14 days: new feature, new version" (b) "<category>: new tool
   launched this month with a public website that shows the product". Read the top results.
2. Choose **one** tool that satisfies all of: not in `covered.json`; a vendor page dated
   within the last 14 days describing the change; a **public site that shows the product**
   (docs with screenshots, a feature page, a changelog, a playground or an app that works
   without login); not a waitlist-only site; not Anthropic/Claude.
3. Fact-check with `crawling_exa` on the vendor's own pages (the launch post, the docs page,
   the pricing page): write five facts with their URL — the tool's name and what it does in
   one line; what changed and when; where the change lives in the product (menu, page,
   setting); price or tier if the page says; one limit or caveat. **Every line you narrate
   must trace to one of these five facts.** If you cannot get five sourced facts, pick
   another tool (at most three tries), else abort: "no sourceable tool today".

## 2. Write the lesson (no spend)
`bash tools/new-lesson.sh <date>-<slot>-<tool-slug>` then write `lessons/<slug>/lesson.json`:
```
{ "title": "<the hook, ≤ 40 chars, a statement not a label>",
  "mode": "tour", "viewport": {"width": 1440, "height": 810},
  "chrome": "<host shown in the browser bar, e.g. docs.tool.com>",
  "hide": ["<optional extra CSS selectors to hide, e.g. a sticky sign-up bar>"],
  "steps": [ {"id": "01", "say": "...", "page": "<url>", "zoom": {"target": "wide"}},
             {"id": "02", "say": "...", "show": "<exact visible heading or link text>", "zoom": {}},
             ... 8 steps ... ] }
```
Rules:
- **8 steps, 150–170 words in total**, spoken like a sharp friend at your desk, no hype,
  contractions welcome. Shape: 01 hook (a question or the change in one line), 02 what
  changed and when, 03–06 what you can now do and where it lives, 07 the price/tier or the
  caveat, 08 the close (one sentence, what to try first). Numbers spelt as words where
  a voice would say them ("September sixteenth", "twenty dollars a month").
- Each step has `page` (only when the page changes) and `show`: the **exact visible text**
  of a heading, link or button on that page, copied from the `crawling_exa` markdown
  (headings there are the page's headings). Prefer headings on docs/changelog/feature
  pages. A step with nothing to point at uses `"zoom": {"target": "wide"}` and no `show`.
  Never `click` unless the target is a same-site link and the next step needs that page.
- **Check every `show` string without a browser**: it must appear **verbatim** in the text
  `crawling_exa` returned for that page (that text is the page's own headings and copy).
  Copy the string from there rather than typing it; a heading the recorder cannot find is
  the one thing that fails the build on Actions, where you cannot iterate quickly. If a
  page's crawl shows no usable headings, pick a different page.
Also write `lessons/<slug>/caption.json`:
```
{ "youtube_title": "<≤ 60 chars, names the tool and the change>",
  "description": "<≤ 300 chars: what the video shows, then 'Source: <vendor url>'>",
  "ig_caption": "<≤ 2,200 chars: 2–4 short lines; then a blank line; then 8–12 hashtags>",
  "first_comment": "Source: <vendor url>",
  "hashtags": ["#..."], "sources": ["<the five fact URLs>"] }
```
Hashtags: Exa `web_search_exa` "<tool name> review OR tutorial 2026 instagram youtube" —
take tags that recur on the top posts about this tool and its category; at least three
tool- or category-specific tags before any generic one (#ai, #tech, #productivity); no tag
you cannot justify from a result.

## 3. Narrate (the one spend)
Text = the eight `say` lines joined with a blank line between them (exactly what
`node scripts/narrate.mjs --text` prints inside the lesson dir). Topview
`topview_generate_voice` with the slot's `voiceId`, `voiceText` = that text, `voiceSpeed: 1`,
`name: "<slug>"`. Poll `topview_query_task` (`taskType: "text_to_speech"`) every 20 s up to
5 min until `status: success`; `costCredit` must be 0.1 — if it is anything else, write it
in the record and abort after the download. Download the result URL to
`lessons/<slug>/assets/voice/narration.mp3`; `ffprobe` it (expect 40–70 s). Note the task id.

## 4. Build — only if this sandbox ever gains a browser and open egress (no spend)
Skip straight to step 5 unless `PW_EXECUTABLE` launched and a vendor page actually loaded.
`cd lessons/<slug> && bash scripts/build.sh 2>&1 | tee out/build.log`. This cuts the
narration into lines and proves every cut by transcription, records the tour with a
humanised pointer, composes the Hit x Trial stage, checks (0 errors and real audit counts),
renders 16:9 and 9:16, verifies both (size, 55–68 s, audio level), and picks the two
thumbnails. Success = `out/verify.json` with `ok: true`. Read `out/build.log` for the reason
if not. Fix only these yourself: a `show` text that missed (edit lesson.json, rebuild), a
script over 68 s (shorten a line — but the narration is already made, so only by cutting a
whole step's line is not possible; instead abort with "script too long, <n> s"). Do not
touch the pipeline scripts.

## 5. Render on GitHub Actions (the normal path, no spend)
Commit and push
`lessons/<slug>/` (lesson.json, caption.json, assets/voice/narration.mp3) with the message
`lesson: <slug>`, then poll `git fetch origin main && git show
origin/main:lessons/<slug>/out/verify.json` every 60 s for up to 25 minutes — the `lesson`
GitHub Actions workflow builds it and commits `out/`. When it appears with `ok: true`,
`git pull --rebase` and continue. If it does not appear, read the workflow's log
(`gh run list --workflow=lesson --limit 3` and `gh run view <id> --log-failed`, or the
committed `lessons/<slug>/out/build.log`): a `not found` line names a `show` string to fix —
fix `lesson.json`, push again, and poll once more. Two failed attempts abort the run:
"render failed on Actions — see <the reason>".

## 6. Look before you post (no spend)
Extract three frames from `out/lesson-9x16.mp4` at 5 s, 25 s and 45 s with ffmpeg and
look at them: the pointer rests on the thing the line talks about, the caption is
readable, the watermark is there, nothing is a blank page. Look at `out/thumb-9x16.png`
and `out/thumb.png`. If a frame shows a cookie wall, a blank page or a sign-in box, add
its selector to `hide` in lesson.json, rebuild once (no new narration), and look again;
if it persists, abort: "footage unusable: <what you saw>".

## 7. Publish (Buffer)
Commit and push `lessons/<slug>/` including `out/lesson.mp4`, `out/lesson-9x16.mp4`,
`out/thumb.png`, `out/thumb-9x16.png`, `out/verify.json` (message `lesson: <slug>`), using
`git fetch origin main && git rebase origin/main && git push origin HEAD:main`, up to five
tries. Confirm each URL answers 200 with `curl -sI`. Then two `create_post` calls, both
`schedulingType: "automatic"`, `mode: "customScheduled"`, `dueAt` = the slot's due time
today in UTC (if that time is already past, `mode: "shareNow"`), `needsApproval: false`:
1. Instagram reel — `channelId` hitxtrial, `text` = `ig_caption`,
   `assets: [{ "video": { "url": "<raw url of out/lesson-9x16.mp4>", "thumbnailUrl": "<raw url of out/thumb-9x16.png>", "metadata": { "title": "<youtube_title>" } } }]`,
   `metadata: { "instagram": { "type": "reel", "shouldShareToFeed": true, "isAiGenerated": false, "firstComment": "<first_comment>" } }`.
2. YouTube Short — `channelId` Hit x Trial, `text` = `description`,
   `assets: [{ "video": { "url": "<raw url of out/lesson-9x16.mp4>", "thumbnailUrl": "<raw url of out/thumb-9x16.png>", "metadata": { "title": "<youtube_title>" } } }]`,
   `metadata: { "youtube": { "title": "<youtube_title>", "categoryId": "28", "privacy": "public", "madeForKids": false, "isAiGenerated": false, "notifySubscribers": true } }`.
Read each response: keep the post ids; a `RestProxyError`/`InvalidInputError` is reported
verbatim in the record. The 16:9 file is not posted (it feeds a weekly compilation later).

## 8. Record
Append `{"tool": "<name>", "vendor": "<host>", "date": "<date>", "slug": "<slug>"}` to
`covered.json`. Write `runs/<date>-<slot>.md`: tool, category, the five facts with URLs,
TopView task id and cost (`before` − balance after), build result (duration, both check
counts), thumbnail times, the two Buffer post ids and due times, any warning. Commit
`run: <date>-<slot> <tool>` and push. Final message: one paragraph — tool, what the video
says, the two post ids, spend, anything a person should look at.
