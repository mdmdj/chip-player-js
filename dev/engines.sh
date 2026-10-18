#!/usr/bin/env bash
#
# DEV-ONLY: the engine inventory, and the helper that makes the libraries a
# worktree needs actually present. One place answers "which engines does the build
# use, and where does each come from".
#
# There are exactly two sources, and nothing else is used:
#
#   SIBLINGS   clones beside the checkout. `scripts/build-subprojects.sh` builds
#              them and `scripts/build-chip-core.js` links their archives through
#              `../<name>`. A worktree created by t3 lives under
#              ~/.t3/worktrees/<repo>/<name>, so it has no siblings -- `link`
#              symlinks them into this worktree's PARENT, which every t3 worktree
#              of the repo shares, so one farm serves them all.
#
#   IN_REPO    sources that travel with the repository. Their *sources* are in git
#              (and, on the overlay, in `dev/kit`), but their built archives are
#              gitignored, so a fresh worktree has sources and no archives.
#              `link` symlinks the ARCHIVE (or the engine's build directory) from
#              the main checkout, so the core can be linked without rebuilding.
#              `mdxmini` and `farbrausch-v2m` have no archive: build-chip-core
#              compiles their sources directly, so there is nothing to link.
#
# Anything else in the tree is a decoy: the vendored trees this overlay deleted
# (`libvgm/`, `libxmp/`, `fluidlite/`, `game-music-emu/`) are NOT the build's
# source, and an in-tree copy of a sibling's name is not used either -- `check`
# warns about one, because a stale `FluidLite/build/libfluidlite.a` sitting in the
# tree is exactly the sort of thing that gets mistaken for the real library.
#
# Usage:
#   dev/engines.sh check [<worktree-root>]   # per engine: source, present, archive
#   dev/engines.sh link  [<worktree-root>]   # make the libraries present, as above
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_ROOT="$(cd "$DIR/.." && pwd)"

SIBLINGS="${SIBLINGS:-game-music-emu libxmp libvgm FluidLite libgsf libsidplayfp}"
IN_REPO="${IN_REPO:-libADLMIDI psflib lazyusf2 mdxmini farbrausch-v2m}"

# The archive a sibling contributes to the link, relative to its clone.
sibling_archive() {
  case "$1" in
    game-music-emu) echo 'build/gme/libgme.a' ;;
    libxmp)         echo 'build/libxmp-lite.a' ;;
    libvgm)         echo 'build/bin/libvgm-player.a' ;;
    FluidLite)      echo 'build/libfluidlite.a' ;;
    libgsf)         echo 'build/libviogsf.a' ;;
    libsidplayfp)   echo 'src/.libs/libsidplayfp.a' ;;
  esac
}

# The archive an in-repo engine builds, relative to the repo root. Empty means the
# engine is compiled from source by build-chip-core.js (nothing to link).
in_repo_archive() {
  case "$1" in
    libADLMIDI) echo 'build/libADLMIDI.a' ;;
    psflib)     echo 'libpsflib.a' ;;
    lazyusf2)   echo 'build/liblazyusf2.a' ;;
    *)          echo '' ;;
  esac
}

die() { echo "engines: $*" >&2; exit 1; }
root="${2:-$SELF_ROOT}"
[ -d "$root" ] || die "no such worktree: $root"
dst_parent="$(dirname "$root")"

# The main worktree's parent holds the real sibling clones.
main_wt="$(git -C "$root" worktree list --porcelain | awk '$1 == "worktree" { print $2; exit }')"
[ -n "$main_wt" ] || die "could not find the main worktree"
src_parent="$(dirname "$main_wt")"

cmd_link() {
  local linked=0 skipped=0 e
  # Siblings: one farm in the shared parent directory.
  if [ "$src_parent" = "$dst_parent" ]; then
    echo "engines: $dst_parent is already the engine home"
  else
    for e in $SIBLINGS; do
      if [ -e "$dst_parent/$e" ]; then skipped=$((skipped + 1)); continue; fi
      if [ -d "$src_parent/$e" ]; then
        ln -s "$src_parent/$e" "$dst_parent/$e"
        echo "engines: linked sibling $e -> $src_parent/$e"
        linked=$((linked + 1))
      else
        echo "engines: sibling $e not found at $src_parent/$e (skipped)" >&2
      fi
    done
  fi
  # In-repo engines: per worktree, because their path is inside each worktree.
  local a src dst
  for e in $IN_REPO; do
    a="$(in_repo_archive "$e")"
    [ -n "$a" ] || continue
    src="$main_wt/$e/$a"; dst="$root/$e/$a"
    if [ -e "$dst" ]; then skipped=$((skipped + 1)); continue; fi
    if [ -f "$src" ]; then
      mkdir -p "$(dirname "$dst")"
      ln -s "$src" "$dst"
      echo "engines: linked in-repo archive $e/$a -> the main checkout"
      linked=$((linked + 1))
    else
      echo "engines: in-repo $e/$a is not built in the main checkout; run scripts/build-subprojects.sh" >&2
    fi
  done
  echo "engines: $linked linked, $skipped already present"
}

cmd_check() {
  local e a where state
  for e in $SIBLINGS; do
    a="$(sibling_archive "$e")"
    where="$src_parent/$e"
    if [ ! -d "$where" ]; then state='MISSING (clone it, then dev/engines.sh link)'
    elif [ -f "$where/$a" ]; then state="archive built ($a)"
    else state="clone present, archive NOT built (scripts/build-subprojects.sh)"; fi
    printf '%-16s %-9s %-28s %s\n' "$e" 'sibling' "$where" "$state"
    # A same-named dir inside the tree is NOT the build's source.
    [ -e "$root/$e" ] && printf '%-16s %-9s %-28s %s\n' "" '!! DECOY' "$root/$e" 'an in-tree copy exists but is NOT used'
  done
  for e in $IN_REPO; do
    a="$(in_repo_archive "$e")"
    if [ -z "$a" ]; then state='sources only (compiled by build-chip-core)'
    elif [ -e "$root/$e/$a" ]; then state="archive present ($a)"
    else state="archive NOT built (scripts/build-subprojects.sh, or dev/engines.sh link)"; fi
    printf '%-16s %-9s %-28s %s\n' "$e" 'in-repo' "$root/$e" "$state"
  done
}

case "${1:-}" in
  link)  cmd_link ;;
  check) cmd_check ;;
  "")    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)     die "unknown command '$1' (link|check)" ;;
esac
