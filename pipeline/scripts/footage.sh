#!/usr/bin/env bash
# footage.sh — screencast frames (variable rate, timestamped) → constant 30 fps footage.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f capture/frames.txt ] || { echo "footage: capture/frames.txt missing — run npm run capture" >&2; exit 2; }
DUR=$(python3 -c "import json;print(json.load(open('capture/timeline.json'))['duration'])")
ffmpeg -y -loglevel error -f concat -safe 0 -i capture/frames.txt -t "$DUR" \
  -vf "fps=30,format=yuv420p" -c:v libx264 -preset medium -crf 16 -movflags +faststart \
  assets/footage.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -show_entries format=duration -of default=nw=1 assets/footage.mp4
