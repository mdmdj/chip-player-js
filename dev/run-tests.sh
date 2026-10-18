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
echo "== v2m loops (tier 3) =="
node "$DIR/test-v2m-loops.js" 2>/dev/null
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
echo "== sid load / deferred seek =="
node "$DIR/test-sid-load.js" 2>/dev/null
echo
echo "== blind loop (slider/loop label state) =="
node "$DIR/test-blind-loop.js" 2>/dev/null
echo
echo "== sub-tunes (server) =="
node "$DIR/test-subtunes-server.js"
echo
echo "== song search =="
node "$DIR/test-search.js"
echo
echo "== song refs (client) =="
node "$DIR/test-songrefs.js" 2>/dev/null
echo
echo "== local file sub-tune cache (client) =="
node "$DIR/test-local-subtunes.js" 2>/dev/null
echo
echo "== devtools stall watch =="
node "$DIR/test-devtools.js" 2>/dev/null
echo
echo "== promote strip syntax (C compile, JS parse) =="
bash "$DIR/test-promote-syntax.sh"
echo
echo "== server dev seams (apply/revert on both bases) =="
node "$DIR/test-server-seams.js"
echo
echo "== overlay tooling (multi-target, kit) =="
bash "$DIR/test-overlay-tooling.sh"
echo
echo "== dev server ports (per-target) =="
node "$DIR/test-dev-ports.js"
echo
echo "== no overlay-only references in what can promote =="
node "$DIR/check-promotable-refs.js"
echo
echo "== clip scenario registry =="
node "$DIR/record/scenarios.check.mjs"
echo
echo "== seo (directory metadata) =="
node "$DIR/fetch-seo-fixtures.mjs" --check \
  || { echo "run-tests: test-seo cannot run until its catalog fixtures are fetched and indexed." >&2; exit 1; }
node "$DIR/../scripts/test-seo.js"
echo
echo "== play-page seo (sub-tune canonical/title) =="
node "$DIR/test-play-seo.js"
