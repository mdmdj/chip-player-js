#!/usr/bin/env bash
# DEV-ONLY: serve the generated site for a browser look before uploading it.
#
#   ./dev/record/serve.sh [port]
#
# Thin wrapper around dev/record/serve.mjs. This used to exec
# `python3 -m http.server` directly, which cannot serve the page: it has no Range
# support, so every media request gets a full-file 200 with no Accept-Ranges, the
# video elements' `seekable` range comes back empty, and the page shows a first
# frame that will not play (the same file plays standalone, which is what makes it
# look like an encoding problem). Measured with dev/record/vidcheck.mjs; express's
# static handler -- already a dependency of this repo -- does 206 properly.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
PORT="${1:-8099}"
OUT="$ROOT/site"

[[ -f "$OUT/index.html" ]] || { printf 'no %s/index.html -- run: node dev/record/build-site.mjs\n' "$OUT" >&2; exit 1; }

# Bind 0.0.0.0 rather than loopback because the T3 preview tab's browser cannot
# reach 127.0.0.1 on this host (it can reach the Tailscale/LAN name) -- the same
# constraint dev/record/upload-server.mjs is built around. Open
# http://<this-host>:<port>/ in the preview.
exec node "$DIR/serve.mjs" "$PORT"