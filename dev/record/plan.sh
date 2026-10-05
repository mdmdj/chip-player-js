#!/usr/bin/env bash
# DEV-ONLY: prepare one clip -- emit the exact tool-call plan for a scenario id.
#
#   ./dev/record/plan.sh <clip-id>
#
# The tab recorder is a host tool, so the recording loop cannot live in a shell
# script: the agent makes the preview_recording_start/_stop calls. This prints
# everything else from dev/record/scenarios.mjs, so the agent never hand-writes a
# step or an assertion -- hand-writing them is how a clip ends up proving
# something other than what the registry says.
#
# Order per clip:
#   1. preview_resize    fixed viewport, so framing is identical between takes
#   2. preview_navigate  <base><browse>          (BASE defaults to mms-1:8080)
#   3. preview_wait_for  .BrowseList-row
#   4. preview_evaluate  __cpRec.pinDefaults(<settings>)
#   5. preview_recording_start
#   6. preview_evaluate  __cpRec.run(...)  -- immediately after the recorder starts
#   7. (sleep: take span + 4 s, no evaluate in that window)
#   8. preview_recording_stop
#   9. preview_evaluate  __cpRec.result()   -- safe now: recorder is stopped
#  10. flash=$(dev/record/find-flash.sh <video>)
#      dev/record/mux.sh <video> dev/record/.work/<id>.webm site/clips/<id>.mp4 \
#          "$flash" <audioStartToFlashMs from step 7>
#
# The song is loaded *inside* the recorded window (step 6) and the load is
# trimmed away by the flash: loading it before the recorder starts races the tool
# round trip, and a song that ends during the round trip lets the sequencer
# advance, so the take records the next file in the directory.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
id="${1:?usage: plan.sh <clip-id>}"
BASE="${RECORD_BASE:-http://mms-1:8080}"
NODE="$HOME/.nvm/versions/node/v24.21.0/bin/node"

mkdir -p "$DIR/.work"

"$NODE" -e '
const { byId } = require(process.argv[1] + "/dev/record/scenarios.mjs");
const s = byId[process.argv[2]];
if (!s) { console.error("no scenario: " + process.argv[2]); process.exit(1); }
console.log(JSON.stringify({
  id: s.id, title: s.title, ready: s.ready, browse: s.browse,
  settings: s.settings || {}, preload: s.preload || null,
  until: s.until || null, steps: s.steps, assert: s.assert,
}, null, 1));
' "$ROOT" "$id" > "$DIR/.work/plan.json"

j() { "$NODE" -e 'const p = require(process.argv[1]); const f = new Function("p", "return " + process.argv[2]); console.log(f(p));' "$DIR/.work/plan.json" "$1"; }

printf '# clip %s -- %s\n' "$id" "$(j 'p.title')"
printf '# ready: %s (ready:true means recorded with a passing verdict)\n\n' "$(j 'p.ready')"
cat <<EOF
1. preview_resize    { mode: "freeform", width: 900, height: 900 }
2. preview_navigate  ${BASE}$(j 'p.browse')?r=N
3. preview_wait_for  { selector: ".BrowseList-row" }
4. preview_evaluate  window.__cpRec.abort(); window.__cpRec.pinDefaults($(j 'JSON.stringify(p.settings)'))
5. preview_recording_start
6. preview_evaluate  window.__cpRec.abort(); window.__cpRec.run(<payload>); 'armed'   -- RETRY up to 3x;
      verify with a read of window.__cpRec._run: the reply can be lost while the call lands.
7. (sleep span + 4 s in the shell. NO evaluate here: they fail while recording.)
8. preview_recording_stop                            -> video path
9. preview_evaluate  window.__cpRec.result()          -> verdict + proof path
10. mux:
   flash=\$(dev/record/find-flash.sh <video>)
   dev/record/mux.sh <video> dev/record/.work/${id}.webm site/clips/${id}.mp4 "\$flash" <audioStartToFlashMs>
EOF

printf '\n# 4. pin (before recording)\nwindow.__cpRec.abort(); window.__cpRec.pinDefaults(%s);\n\n# 6. kick (after preview_recording_start; retry until _run is true)\nwindow.__cpRec.abort(); window.__cpRec.run(%s);\n\n# 9. after preview_recording_stop\nwindow.__cpRec.result()\n' "$(j 'JSON.stringify(p.settings)')" \
  "$(j 'JSON.stringify({ name: p.id, preload: p.preload, steps: p.steps, until: p.until, intervalMs: 100, assert: p.assert })')"
