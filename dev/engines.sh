#!/usr/bin/env bash
#
# DEV-ONLY: link the engine siblings a worktree needs for the chip-core build.
#
# `scripts/build-subprojects.sh` and `scripts/build-chip-core.js` resolve their
# engines as SIBLINGS of the checkout: ../libvgm, ../libxmp, ../FluidLite,
# ../game-music-emu, ../libgsf, ../libsidplayfp. A worktree t3 creates lives at
# ~/.t3/worktrees/<repo>/<name>, so it has none of them -- which is why a kit
# worktree could not build a core, and why `dev/apply.sh` silently found no
# `../game-music-emu/test.nsf` to seed its catalog with.
#
# Move nothing: link them. The MAIN worktree's parent is where the real clones
# live, so symlink each engine into THIS worktree's parent. Every t3 worktree of
# a repo shares one parent directory, so a single farm serves them all, and the
# built archives inside the clones (`<engine>/build/...`) are reused too.
#
# Usage:
#   dev/engines.sh link [<worktree-root>]    # default: this worktree
#   dev/engines.sh check [<worktree-root>]   # which engines/archives are present
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_ROOT="$(cd "$DIR/.." && pwd)"

ENGINES="${ENGINES:-game-music-emu libxmp libvgm FluidLite libgsf libsidplayfp}"
# The archive each engine contributes to the chip-core link (for `check`).
archive_of() {
  case "$1" in
    game-music-emu) echo 'build/gme/libgme.a' ;;
    libxmp)         echo 'build/libxmp-lite.a' ;;
    libvgm)         echo 'build/bin/libvgm-player.a' ;;
    FluidLite)      echo 'build/libfluidlite.a' ;;
    libgsf)         echo 'build/libviogsf.a' ;;
    libsidplayfp)   echo 'src/.libs/libsidplayfp.a' ;;
  esac
}

die() { echo "engines: $*" >&2; exit 1; }
root="${2:-$SELF_ROOT}"
[ -d "$root" ] || die "no such worktree: $root"
dst_parent="$(dirname "$root")"

# The main worktree's parent holds the real clones.
main_wt="$(git -C "$root" worktree list --porcelain | awk '$1 == "worktree" { print $2; exit }')"
[ -n "$main_wt" ] || die "could not find the main worktree"
src_parent="$(dirname "$main_wt")"

cmd_link() {
  [ "$src_parent" = "$dst_parent" ] && { echo "engines: $dst_parent is already the engine home"; return 0; }
  local e src dst linked=0 present=0
  for e in $ENGINES; do
    src="$src_parent/$e"; dst="$dst_parent/$e"
    if [ -e "$dst" ]; then present=$((present + 1)); continue; fi
    if [ -d "$src" ]; then ln -s "$src" "$dst"; linked=$((linked + 1)); echo "engines: linked $e -> $src"
    else echo "engines: $e not found at $src (skipped)" >&2; fi
  done
  echo "engines: $linked linked, $present already there (parent $dst_parent)"
}

cmd_check() {
  local e a
  for e in $ENGINES; do
    a="$(archive_of "$e")"
    if [ ! -e "$dst_parent/$e" ]; then
      printf '%-16s %s\n' "$e" 'missing (run dev/engines.sh link)'
    elif [ -f "$dst_parent/$e/$a" ]; then
      printf '%-16s %s\n' "$e" 'present, archive built'
    else
      printf '%-16s %s\n' "$e" "present, archive NOT built (run scripts/build-subprojects.sh)"
    fi
  done
}

case "${1:-}" in
  link)  cmd_link ;;
  check) cmd_check ;;
  "")    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)     die "unknown command '$1' (link|check)" ;;
esac
