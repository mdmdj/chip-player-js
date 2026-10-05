#!/usr/bin/env bash
# DEV-ONLY: serve the generated site for a browser look before uploading it.
#
#   ./dev/record/serve.sh [port]
#
# Binds 0.0.0.0 rather than loopback because the T3 preview tab's browser cannot
# reach 127.0.0.1 on this host (it can reach the Tailscale/LAN name) -- the same
# constraint dev/record/upload-server.mjs is built around. Open
# http://<this-host>:8099/ in the preview.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
PORT="${1:-8099}"
OUT="$ROOT/site"

[[ -f "$OUT/index.html" ]] || { printf 'no %s/index.html -- run: node dev/record/build-site.mjs\n' "$OUT" >&2; exit 1; }

host=$(hostname 2>/dev/null || echo localhost)
printf 'serving %s on http://%s:%s/  (ctrl-c to stop)\n' "$OUT" "$host" "$PORT"
exec python3 -m http.server "$PORT" --directory "$OUT" --bind 0.0.0.0