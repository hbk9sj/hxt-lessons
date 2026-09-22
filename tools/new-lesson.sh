#!/usr/bin/env bash
# tools/new-lesson.sh <slug>  — creates lessons/<slug>/ wired to the shared pipeline.
# The lesson dir is a full HyperFrames project: scripts, node_modules and brand assets
# are links into pipeline/, so `bash scripts/build.sh` runs there unchanged.
set -euo pipefail
cd "$(dirname "$0")/.."
slug="$1"; d="lessons/$slug"
mkdir -p "$d/assets/voice" "$d/out"
[ -d pipeline/node_modules ] || (cd pipeline && npm ci --silent)
ln -sfn ../../pipeline/scripts "$d/scripts"
ln -sfn ../../pipeline/node_modules "$d/node_modules"
ln -sfn ../../../pipeline/assets/fonts "$d/assets/fonts"
ln -sfn ../../../pipeline/assets/sfx "$d/assets/sfx"
cp pipeline/package.json pipeline/hyperframes.json "$d/"
echo "$d ready — write $d/lesson.json and $d/assets/voice/narration.mp3, then: cd $d && bash scripts/build.sh"
