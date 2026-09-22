#!/usr/bin/env bash
# verify.sh — the gate before anything is called done. Exits 1 on any failed bound
# and 2 when it cannot check (missing tool or file). Never exits 0 on "could not check".
set -uo pipefail
cd "$(dirname "$0")/.."
MP4="${1:-out/lesson.mp4}"
EXPECT="${EXPECT_SIZE:-1920,1080}"
# Duration bounds: a one-minute lesson by default; a longer film sets EXPECT_DUR="min,max".
BOUNDS="${EXPECT_DUR:-50,68}"
for t in ffprobe ffmpeg python3; do command -v "$t" >/dev/null || { echo "verify: $t missing" >&2; exit 2; }; done
[ -f "$MP4" ] || { echo "verify: $MP4 missing" >&2; exit 2; }
[ -f capture/timeline.json ] || { echo "verify: capture/timeline.json missing" >&2; exit 2; }
[ -f assets/voice/narration.mp3 ] || { echo "verify: assets/voice/narration.mp3 missing" >&2; exit 2; }

fail=0
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MP4")
wh=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$MP4")
vol=$(ffmpeg -i "$MP4" -af volumedetect -vn -f null - 2>&1 | sed -n 's/.*mean_volume: \([-0-9.]*\) dB.*/\1/p')
tl_end=$(python3 -c "import json;print(json.load(open('capture/timeline.json'))['duration'])")
lead=$(python3 -c "import json;print(json.load(open('capture/timeline.json'))['audioLead'])")
# Narration is one clip per line, each placed where its step started; the last clip must
# end inside the video and close to its end.
last_voice_end=$(python3 -c "
import json
tl=json.load(open('capture/timeline.json')); ln={l['id']:l for l in json.load(open('assets/voice/lines.json'))}
print(max(s['clipStart']+ln[s['id']]['clipDuration'] for s in tl['steps']))")
echo "verify: duration=${dur}s size=${wh} mean_volume=${vol}dB timeline_end=${tl_end}s last_voice_end=${last_voice_end}s (lead ${lead}s)"

python3 - "$dur" "$wh" "$vol" "$tl_end" "$last_voice_end" "$lead" "$EXPECT" "$BOUNDS" <<'PY' || fail=1
import sys
dur,wh,vol,tl,lve,lead,expect,bounds=sys.argv[1:]
lo,hi=[float(x) for x in bounds.split(",")]
dur=float(dur); vol=float(vol or -999); tl=float(tl); lve=float(lve); lead=float(lead)
bad=[]
if not (lo<=dur<=hi): bad.append(f"duration {dur:.1f}s outside {lo:g}–{hi:g}")
if wh.strip()!=expect: bad.append(f"size {wh.strip()} != {expect}")
if vol<-30: bad.append(f"mean_volume {vol} dB below -30 (silent or near it)")
if lve>tl or tl-lve>3.0: bad.append(f"last narration clip ends at {lve:.1f}s, video ends at {tl:.1f}s (must be inside and within 3 s)")
if abs(dur-tl)>0.5: bad.append(f"rendered {dur:.1f}s vs timeline {tl:.1f}s")
if bad:
    print("verify: FAIL\n  - "+"\n  - ".join(bad)); sys.exit(1)
print("verify: bounds ok")
PY

# 12 frames across the runtime, looked at by a human before "done".
mkdir -p out/frames
rm -f out/frames/*.png
ffmpeg -y -loglevel error -i "$MP4" -vf "fps=12/${dur},scale=640:-1,tile=4x3" -frames:v 1 out/contact.png
for i in 0 1 2 3; do
  t=$(python3 -c "print(round($dur*(0.15+0.23*$i),2))")
  ffmpeg -y -loglevel error -ss "$t" -i "$MP4" -frames:v 1 "out/frames/at-${t}s.png"
done
echo "verify: out/contact.png and out/frames/*.png written"
exit $fail
