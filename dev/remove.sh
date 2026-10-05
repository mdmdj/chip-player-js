#!/usr/bin/env bash
#
# DEV-ONLY: revert everything `dev/apply.sh` did. Safe to run repeatedly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[dev] Removing development shims..."

# Generated / gitignored artifacts
rm -f src/chip-core.js
echo "[dev]   removed src/chip-core.js"

rm -f src/config/firebaseConfig.js
if [ -f src/config/firebaseConfig.js.dev-backup ]; then
  mv src/config/firebaseConfig.js.dev-backup src/config/firebaseConfig.js
  echo "[dev]   restored original src/config/firebaseConfig.js"
fi

rm -f server/.env.local
echo "[dev]   removed server/.env.local"

# SQLite WAL sidecar files
rm -f server/*.db-shm server/*.db-wal
echo "[dev]   removed sqlite WAL sidecar files"

# Untracked shim modules staged by apply.sh (no tracked files to restore)
rm -f server/middleware/auth.dev.js
echo "[dev]   removed server/middleware/auth.dev.js"

# Undo in-place patches (reversible, so feature edits are preserved)
node dev/patch-server.js --revert

# Staged devtools shim (copied by apply.sh; untracked, no patch to revert)
rm -f src/chip-player-devtools.js
echo "[dev]   removed src/chip-player-devtools.js"

# Staged clip-recording shim (same deal; see dev/record/README.md)
rm -f src/chip-player-record.js
echo "[dev]   removed src/chip-player-record.js"

echo "[dev] Done. (Left in place: catalog/, server/*.db. Delete manually if desired.)"
