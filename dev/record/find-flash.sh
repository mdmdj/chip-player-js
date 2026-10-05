#!/usr/bin/env bash
# DEV-ONLY: find the sync-flash frame in a recorded clip (dev/record/README.md).
#
#   find-flash.sh <video.mp4>
#
# __cpRec.run() paints one full-viewport **green** frame and records Date.now() for
# it. Prints the timestamp of the LAST frame of that run -- the value mux.sh wants
# -- or fails loudly, because a silently-missing mark means a silently desynced
# clip.
#
# The detector is hue-based, not luma-based, and that is the whole point. A clip
# has three kinds of full-frame content that a luma threshold cannot tell apart:
#
#   * the blank page the capture starts on (Playwright starts recording at context
#     creation, before navigation) -- white-ish, and *earlier* than the mark;
#   * the mark itself;
#   * the occasional blank frame Playwright's screencast emits mid-clip.
#
# A white mark made the detector lock onto the page load, trimming ~3.5 s early and
# desyncing the clip while every assertion still passed. Green is unique by
# construction: the app is blue (high U) and yellow (high V) on near-black, so a
# frame that is bright with *both* U and V low cannot be app content, and a blank
# page is neutral (U = V = 128).
#
# frame-accurate: the mark is one or two frames, so it is reported as a run.
set -euo pipefail

video="${1:?usage: find-flash.sh <video.mp4>}"

command -v ffprobe >/dev/null 2>&1 || { printf 'ffprobe not found\n' >&2; exit 1; }

stats=$(ffprobe -v error -f lavfi -i "movie=${video},signalstats" \
  -show_entries frame=pts_time:frame_tags=lavfi.signalstats.YAVG:frame_tags=lavfi.signalstats.UAVG:frame_tags=lavfi.signalstats.VAVG \
  -of csv=p=0 2>/dev/null || true)

if [[ -z "$stats" ]]; then
  printf 'could not read frame stats from %s\n' "$video" >&2
  exit 1
fi

read -r hit runms frames <<< "$(printf '%s\n' "$stats" | awk -F, '
  # Bright, with both chroma channels low: green, and nothing else in this app.
  $2 + 0 > 140 && $3 + 0 < 90 && $4 + 0 < 90 {
    run++
    if (run == 1) first = $1
    last = $1
    next
  }
  run >= 2 { printf "%.4f %.1f %d\n", last, (last - first) * 1000, last != "" ? NR - 1 : NR; exit }
  { run = 0 }
  END { if (run >= 1) printf "%.4f %.1f %d\n", last, (last - first) * 1000, NR }
')"

if [[ -z "$hit" || "$hit" == "0.0000" && -z "$runms" ]]; then
  printf 'no green sync frame found in %s (%s frames scanned) -- was __cpRec.flash() in the take?\n' \
    "$video" "$(printf '%s\n' "$stats" | wc -l)" >&2
  exit 1
fi

printf '%s\n' "$hit"
printf 'sync mark: last frame at %ss, run %s ms (%s frames)\n' "$hit" "$runms" "$frames" >&2