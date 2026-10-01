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
echo "== midi loops =="
node "$DIR/test-midi-loops.js" 2>/dev/null
echo
echo "== xmp loops =="
node "$DIR/test-xmp-loops.js" 2>/dev/null
