#!/usr/bin/env bash
# DEV-ONLY: run the dev test harnesses. Not part of the PR.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== parsers =="
node "$DIR/test-parsers.js"
echo
echo "== build-music round-trip =="
node "$DIR/test-build.js"
echo
echo "== sequencer navigation =="
node "$DIR/test-sequencer.js" 2>/dev/null
echo
echo "== vgm loops =="
node "$DIR/test-vgm-loops.js" 2>/dev/null
echo
echo "== gme loops =="
node "$DIR/test-gme-loops.js" 2>/dev/null
echo
echo "== mdx loops =="
node "$DIR/test-mdx-loops.js" 2>/dev/null
echo
echo "== midi loops =="
node "$DIR/test-midi-loops.js" 2>/dev/null
echo
echo "== xmp loops =="
node "$DIR/test-xmp-loops.js" 2>/dev/null
echo
echo "== end detector (sid/n64) =="
node "$DIR/test-end-detector.js" 2>/dev/null
echo
echo "== sub-tunes (server) =="
node "$DIR/test-subtunes-server.js"
echo
echo "== song refs (client) =="
node "$DIR/test-songrefs.js" 2>/dev/null
echo
echo "== devtools stall watch =="
node "$DIR/test-devtools.js" 2>/dev/null
