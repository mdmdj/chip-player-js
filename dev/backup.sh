#!/usr/bin/env bash
#
# DEV-ONLY: before a promotion, keep what git does not.
#
#   dev/backup.sh <target>
#
# A promote is two destructive things at once: it commits the stripped files on the
# feature branch, then REBASES the overlay (a history rewrite the push needs
# --force-with-lease) and re-applies the dev patches. The commit covers TRACKED
# files only, so the built core, the shims, .env.local and the DBs live nowhere
# else -- a bad promote can lose them, and `dev/.pre-rebase` only covers the
# tracked tree.
#
# This does the two cheap things that make it recoverable and changes nothing
# else: tags both branches, and tars the ignored dev artifacts into dev/.backups/
# (gitignored). The applied patches need no copy -- `dev/apply.sh` regenerates
# them from the tracked files.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

die() { echo "backup: $*" >&2; exit 1; }

target="${1:-}"
[ -n "$target" ] || die "usage: dev/backup.sh <target>"
overlay_resolve "$target"
overlay_require_worktrees

# The dev artifacts `apply.sh` stages, the databases, and the built core. Anything
# absent is simply skipped (a stub core, a fresh tree with no DB yet).
ARTIFACTS=(
  src/chip-core.js
  src/chip-core.wasm
  src/chip-core.wasm.buildinfo.json
  src/chip-player-devtools.js
  src/chip-player-record.js
  src/config/firebaseConfig.js
  server/.env.local
  server/middleware/auth.dev.js
  server/users.db
  server/csdb.db
  server/catalog.db
)
present=()
for f in "${ARTIFACTS[@]}"; do
  [ -e "$OV_OVERLAY_WT/$f" ] && present+=("$f")
done

stamp="$(date +%Y%m%d-%H%M%S)"
tag="pre-promote-$target-$stamp"
git -C "$ROOT" tag "$tag" "$OV_OVERLAY" || die "could not tag $OV_OVERLAY"
git -C "$ROOT" tag "$tag-feature" "$OV_FEATURE" || die "could not tag $OV_FEATURE"

mkdir -p "$DIR/.backups"
tarball="$DIR/.backups/$target-$stamp.tar.gz"
if [ ${#present[@]} -gt 0 ]; then
  tar -czf "$tarball" -C "$OV_OVERLAY_WT" "${present[@]}"
else
  echo "backup: no dev artifacts present to archive (nothing to tar)" >&2
  tarball="(none)"
fi

echo "backup: tags"
echo "  $tag            -> $OV_OVERLAY ($(git -C "$ROOT" rev-parse --short "$OV_OVERLAY"))"
echo "  $tag-feature    -> $OV_FEATURE ($(git -C "$ROOT" rev-parse --short "$OV_FEATURE"))"
echo "backup: artifacts"
echo "  $tarball"
echo
echo "to undo a promote:"
echo "  git -C $OV_OVERLAY_WT reset --hard $tag       # the overlay, before the rewrite"
echo "  git -C $OV_FEATURE_WT reset --hard $tag-feature # only if the promote commit is bad"
echo "  # artifacts: tar -xzf $tarball -C $OV_OVERLAY_WT"
echo "  ./dev/apply.sh                                 # regenerates the applied patches"
