#!/usr/bin/env bash
# DEV-ONLY: mux one recorded clip (dev/record/README.md).
#
#   mux.sh <video.mp4> <audio.webm> <out.mp4> [flashVideoTimeSec] [audioStartToFlashMs]
#
# The video comes from the host's tab recorder, the audio from the page's
# MediaStreamAudioDestinationNode mirror (window.__cpRec). Both are trimmed to a
# common mark: __cpRec.run() paints one full-viewport white frame *after* the
# song has loaded and *before* it arms any step, and records Date.now() for it.
# find-flash.sh reports that frame's time in the video; `audioStartToFlashMs` (from
# the page's finish() result) is how far into the audio the flash landed.
#
#   trim video by  flashVideoTimeSec
#   trim audio by  flashVideoTimeSec*1000 - audioStartToFlashMs   (ms -> s)
#
# The trim is done with trim/atrim filters rather than `-ss`:
#   - `-ss` before `-i` is keyframe-snapped, and this recorder writes only 3
#     keyframes per take (the first at 0.000), so a stream copy would either keep
#     the whole load or swallow 0.7 s of content -- there is no copy path;
#   - `-ss` after `-i` applies per *output*, not per stream, so the two `-ss`
#     flags in the first version of this script trimmed the audio twice and left
#     the video 3.55 s against 5.65 s of audio.
# Filtering decodes both streams, so the cuts land on the exact frame and the
# exact sample.
#
# Quality: the video re-encode is crf 14 / preset slow. crf 20 / veryfast was
# visibly soft on the bitmap font (SSIM 0.931 on a static text crop vs 0.934 at
# crf 14, and crf 12 measures the same as 14 -- so 14 is the knee, not a guess).
# Note that SSIM over the whole frame is useless here: the spectrum visualiser
# changes every frame, so a one-frame misalignment dominates the score.
#
# `-fps_mode passthrough` is mandatory, not a nicety. The recorder's streams
# declare `r_frame_rate=1/1` (the idle keepalive) while actually carrying ~15-30
# fps of change-driven frames, and ffmpeg's default CFR output resamples to the
# declared rate and *discards the rest*: a take with 60 real frames muxed to 5.
# That is what made the first `songfolder` clip look like a slideshow while the
# capture was fine all along. Passthrough keeps the real timestamps, so the
# published clip is VFR with the motion it was recorded with.
#
# Audio: the page's MediaRecorder produces opus at ~131 kbps, so 128k AAC is
# matched to the source rather than padding it (the first version asked for
# 160k, which was an upscale). That *is* a second lossy generation; pass
# RECORD_AUDIO=copy to keep the opus stream untouched instead, at the cost of
# Safari < 16 support for Opus-in-MP4.
set -euo pipefail

if (( $# < 3 || $# > 5 )); then
  printf 'Usage: %s <video.mp4> <audio.webm> <out.mp4> [flashVideoSec] [audioStartToFlashMs]\n' "$0" >&2
  exit 1
fi

video="$1"; audio="$2"; out="$3"
flash_sec="${4:-}"
audio_to_flash_ms="${5:-}"

command -v ffmpeg >/dev/null 2>&1 || { printf 'ffmpeg not found\n' >&2; exit 1; }
for f in "$video" "$audio"; do
  [[ -f "$f" ]] || { printf 'missing input: %s\n' "$f" >&2; exit 1; }
done
mkdir -p "$(dirname "$out")"

if [[ -z "$flash_sec" || -z "$audio_to_flash_ms" ]]; then
  printf 'no flash calibration given -- muxing untrimmed. Run find-flash.sh and pass\n' >&2
  printf '  flashSec and audioStartToFlashMs from finish(); an uncalibrated mux is a\n' >&2
  printf '  silently desynced clip, which is worse than no clip.\n' >&2
  exit 2
fi

# Trim math. Two independent clocks:
#   video: the tab recorder's t=0 is at page time V0; the flash lands at video
#          time v, so V0 = F - v*1000 (F = flashAt, from the page).
#   audio: the page's MediaRecorder t=0 is at page time A (audio.startedAt) and
#          the flash is at A + audioStartToFlashMs.
# We publish video starting at the flash, i.e. video time 0 == page time F. For
# the audio to line up its t=0 must also be page time F, so we drop (F - A) of
# audio -- which is exactly audioStartToFlashMs.
#
# The first version computed `audio_skip = v*1000 - audioStartToFlashMs`, which
# folds the video clock into the audio offset. It is accidentally right when the
# audio starts at the flash (skip 0, the common case) and wrong otherwise: with a
# 21 s dead-air pre-roll it asked atrim to skip 21 s of a 2.5 s track, i.e. it
# would have published a silent clip.
audio_skip=$(awk -v m="$audio_to_flash_ms" 'BEGIN { s = m / 1000; printf "%.3f", (s > 0 ? s : 0) }')

# find-flash.sh reports the PTS of the flash's *last* frame and `trim=start=`
# keeps frames at or after it, so that white frame survived into the output.
# Start a frame and a half later (~25 fps captures) to be safely past it.
video_start=$(awk -v f="$flash_sec" 'BEGIN { printf "%.3f", f + 0.06 }')
audio_total=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$audio")
if awk -v s="$audio_skip" -v t="$audio_total" 'BEGIN { exit !(s >= t) }'; then
  printf 'audio_skip %.3fs >= audio duration %.3fs -- the flash is not inside the audio.\n' "$audio_skip" "$audio_total" >&2
  printf 'The take never started recording, or audioStartToFlashMs is wrong.\n' >&2
  exit 3
fi

# The tab recorder keeps running between finish() and preview_recording_stop, so
# the video has a tail the audio does not (measured: 0.7 s). Cap the video at the
# audio's trimmed length rather than publishing a frozen last frame.
video_keep=$(awk -v t="$audio_total" -v s="$audio_skip" 'BEGIN { d = t - s; printf "%.3f", (d > 0.2 ? d : 0.2) }')

# RECORD_AUDIO=aac (default) re-encodes to AAC; RECORD_AUDIO=copy keeps the
# page's opus stream bit-for-bit.
audio_mode="${RECORD_AUDIO:-aac}"
if [[ "$audio_mode" == "copy" ]]; then
  audio_args=(-c:a copy)
else
  audio_args=(-c:a aac -b:a 128k)
fi

printf 'flash run ends at video %ss -> trim video from %ss (%.3fs long, audio is %ss), audio %.3fs\n' \
  "$flash_sec" "$video_start" "$video_keep" "$audio_total" "$audio_skip"
printf 'video crf 14 / preset slow; audio %s\n' "${audio_args[*]}"

ffmpeg -nostdin -y -i "$video" -i "$audio" \
  -filter_complex "[0:v]trim=start=${video_start}:duration=${video_keep},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=0.4[v];[1:a]atrim=start=${audio_skip},asetpts=PTS-STARTPTS[a]" \
  -map '[v]' -map '[a]' \
  -fps_mode passthrough \
  -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p \
  "${audio_args[@]}" \
  -movflags +faststart \
  "$out" 2>&1 | tail -2

v_len=$(ffprobe -v error -show_entries stream=codec_type,duration -of csv=p=0 "$out" | tr '\n' ' ')
printf 'wrote %s (%s)\nstreams: %s\n' "$out" "$(du -h "$out" | cut -f1)" "$v_len"

# Trim check: the *first* published frame must not be the mark. Do not re-run
# find-flash over the whole file -- Playwright's screencast emits the occasional
# full-white blank frame mid-clip, so "is there a bright frame anywhere" would fire
# on the artefact instead of on a bad trim.
first_yavg=$(ffprobe -v error -f lavfi -i "movie=${out},signalstats" \
  -show_entries frame=pts_time:frame_tags=lavfi.signalstats.YAVG -of csv=p=0 2>/dev/null | head -1 | cut -d, -f2 || true)
if [[ -n "$first_yavg" ]] && awk -v y="$first_yavg" 'BEGIN { exit !(y > 200) }'; then
  printf 'WARNING: first frame of %s is a flash frame (YAVG %s) -- the trim point is wrong\n' "$out" "$first_yavg" >&2
else
  printf 'trim check: first published frame YAVG %s (not the mark)\n' "${first_yavg:-unknown}"
fi