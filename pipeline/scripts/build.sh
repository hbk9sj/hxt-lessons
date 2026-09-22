#!/usr/bin/env bash
# build.sh — one lesson end to end, from a lesson directory that already holds
# lesson.json and assets/voice/narration.mp3. Writes out/lesson.mp4, out/lesson-9x16.mp4,
# out/thumb.png, out/thumb-9x16.png and out/verify.json {ok, duration, ...}.
# Exits non-zero at the first gate that fails; verify.json is only written on success.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f lesson.json ] || { echo "build: lesson.json missing" >&2; exit 2; }
[ -f assets/voice/narration.mp3 ] || { echo "build: assets/voice/narration.mp3 missing (make the TopView TTS call first)" >&2; exit 2; }
rm -f out/verify.json
mode=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("lesson.json")).mode||"capture")')

echo "== narrate (cut + prove)"; node scripts/narrate.mjs
if [ "$mode" = "stills" ] || [ "$mode" = "clips" ]; then
  echo "== stage"; node scripts/stage-stills.mjs
else
  echo "== capture ($mode)"; node scripts/capture.mjs
  echo "== footage"; bash scripts/footage.sh
fi
echo "== compose 16:9"; node scripts/compose.mjs
echo "== check"; npx --yes hyperframes@0.8.31 check 2>&1 | tee out/check.log | grep -E "error|text checks|Check " || true
grep -q "Check passed" out/check.log || { echo "build: check did not pass" >&2; exit 1; }
grep -Eq "[1-9][0-9]*/[1-9][0-9]* text checks" out/check.log || { echo "build: audits did not run (0/0)" >&2; exit 1; }
echo "== render 16:9"; npx --yes hyperframes@0.8.31 render --output out/lesson.mp4 2>&1 | tail -2
echo "== verify 16:9"; bash scripts/verify.sh
echo "== thumbnail 16:9"; node scripts/thumbnail.mjs

echo "== compose 9:16"; ORIENT=portrait node scripts/compose.mjs
echo "== check 9:16"; npx --yes hyperframes@0.8.31 check 2>&1 | tee out/check-9x16.log | grep -E "error|text checks|Check " || true
grep -q "Check passed" out/check-9x16.log || { echo "build: portrait check did not pass" >&2; exit 1; }
echo "== render 9:16"; npx --yes hyperframes@0.8.31 render --output out/lesson-9x16.mp4 2>&1 | tail -2
echo "== verify 9:16"; EXPECT_SIZE=1080,1920 bash scripts/verify.sh out/lesson-9x16.mp4
echo "== thumbnail 9:16"; node scripts/thumbnail.mjs --portrait
node scripts/compose.mjs >/dev/null 2>&1 # leave index.html in landscape

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 out/lesson-9x16.mp4)
node -e "require('fs').writeFileSync('out/verify.json', JSON.stringify({ok:true, mode:'$mode', duration:Number('$dur'), files:['out/lesson.mp4','out/lesson-9x16.mp4','out/thumb.png','out/thumb-9x16.png'], builtAt:new Date().toISOString()}, null, 1))"
echo "build: ok — $(cat out/verify.json | tr -d '\n ')"
