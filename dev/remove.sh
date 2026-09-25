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

# Restore tracked files that were replaced
if [ -f server/middleware/auth.js.dev-backup ]; then
  mv server/middleware/auth.js.dev-backup server/middleware/auth.js
  echo "[dev]   restored server/middleware/auth.js"
fi

if [ -f server/index.js.dev-backup ]; then
  mv server/index.js.dev-backup server/index.js
  echo "[dev]   restored server/index.js"
fi

if [ -f src/components/UserProvider.js.dev-backup ]; then
  mv src/components/UserProvider.js.dev-backup src/components/UserProvider.js
  echo "[dev]   restored src/components/UserProvider.js"
fi

echo "[dev] Done. (Left in place: catalog/, server/*.db. Delete manually if desired.)"
