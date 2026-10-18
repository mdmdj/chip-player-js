#!/usr/bin/env bash
#
# DEV-ONLY: keep the overlay-only *whole-file* content in one place (`dev/kit`)
# and sync it onto any overlay, instead of hand-copying it per target.
#
# Why a kit: an overlay carries two kinds of thing -- files that are ours and
# only ours (dev/**, the engine build, the vendored-tree deletion, the two
# engine-config files), and DEV regions inside files the feature branch owns.
# The first kind is identical for every target, so copying it onto each overlay
# by hand is N copies of the same material. The kit holds it once; `pull` writes
# it into a target overlay, which commits it. Nothing here rewrites history, so
# it composes with the existing rebase/promote cycle unchanged.
#
# The kit deliberately excludes the feature-coupled parts, which cannot be a
# shared whole-file copy because they edit feature-owned files:
#   * server/index.js           -- the "seam": the dev delta substitutes a module
#                                  at a require site, and the file also carries
#                                  feature work that is hand-carried.
#   * DEV-BEGIN/DEV-END regions -- they sit inside feature files; overlays keep
#                                  them as ordinary commits.
# Everything else in dev/promote-paths.txt (minus that exclusion) is carried.
#
# Usage:
#   ./dev/kit.sh capture [<src>]     # build/update dev/kit from an overlay
#   ./dev/kit.sh pull <target>       # write dev/kit onto the target's overlay
#   ./dev/kit.sh list                # what the kit carries
#
# <src> defaults to the manifest's default target's overlay; KIT_BASE is the
# branch capture bases a fresh dev/kit on (default master). Nothing is pushed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

KIT_BRANCH="${KIT_BRANCH:-dev/kit}"
KIT_BASE="${KIT_BASE:-master}"
# The seam file, whose dev delta cannot be a shared whole-file copy.
KIT_EXCLUDE="${KIT_EXCLUDE:-server/index.js}"

die() { echo "kit: $*" >&2; exit 1; }
kit_exists() { git -C "$ROOT" show-ref --verify --quiet "refs/heads/$KIT_BRANCH"; }

# The overlay to capture from.
kit_source() {
  if [ -n "${KIT_SOURCE:-}" ]; then echo "$KIT_SOURCE"; return; fi
  overlay_resolve ""
  echo "$OV_OVERLAY"
}

# Overlay-only pathspecs, read from a ref, minus the exclusion.
kit_paths() { # ref
  git show "$1:dev/promote-paths.txt" 2>/dev/null \
    | sed -e 's/#.*//' -e '/^[[:space:]]*$/d' -e 's/[[:space:]]*$//' \
    | grep -vx -- "$KIT_EXCLUDE" || true
}

# The bare path for a pathspec (`libvgm/**` -> libvgm).
kit_bare() { local p="$1"; p="${p%/\*\*}"; echo "${p%/}"; }

# Copy each path from $1 into the worktree $2 (checkout if present, remove if
# not -- which is how the vendored-tree deletion travels). Prints the bare paths.
populate_from() { # src dest
  local src="$1" dest="$2" p bare
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    bare="$(kit_bare "$p")"
    if git -C "$dest" cat-file -e "$src:$bare" 2>/dev/null; then
      git -C "$dest" checkout "$src" -- "$bare"
    elif git -C "$dest" cat-file -e "HEAD:$bare" 2>/dev/null; then
      git -C "$dest" rm -r -q --ignore-unmatch -- "$bare"
    fi
    printf '%s\n' "$bare"
  done < <(kit_paths "$src")
}

cmd_capture() { # build/refresh dev/kit from a source overlay
  local src wt; src="$(kit_source)"
  git -C "$ROOT" rev-parse --verify -q "$src" >/dev/null || die "source overlay $src not found"
  kit_exists || git -C "$ROOT" branch "$KIT_BRANCH" "$KIT_BASE"
  wt="$(mktemp -d)"; rmdir "$wt"
  git -C "$ROOT" worktree add -q "$wt" "$KIT_BRANCH"
  # shellcheck disable=SC2064
  trap "git -C '$ROOT' worktree remove --force '$wt' >/dev/null 2>&1 || true" RETURN
  populate_from "$src" "$wt" >/dev/null
  git -C "$wt" add -A -- .
  if git -C "$wt" diff --cached --quiet; then
    echo "kit: $KIT_BRANCH already current with $src"
  else
    git -C "$wt" commit -q -m "kit: overlay-only content from $src"
    echo "kit: $KIT_BRANCH updated from $src ($(git -C "$wt" rev-parse --short HEAD))"
  fi
}

cmd_pull() { # write dev/kit onto the target's overlay worktree
  local ov="$1" wt row
  # Accept a manifest target name in place of the overlay branch.
  if row="$(overlay_match "$ov" "$(overlay_rows)")"; then
    read -r _ _ ov _ _ <<< "$row"
  fi
  wt="$(overlay_wt "$ov")"
  [ -n "$wt" ] || die "$ov is not checked out in any worktree"
  kit_exists || die "$KIT_BRANCH does not exist; build it with 'kit.sh capture' first"

  local -a paths=()
  while IFS= read -r p; do [ -n "$p" ] && paths+=("$(kit_bare "$p")"); done < <(kit_paths "$KIT_BRANCH")
  [ ${#paths[@]} -gt 0 ] || die "no paths to pull"

  # Refuse to clobber pending work in the paths the kit owns.
  if [ -n "$(git -C "$wt" status --porcelain -- "${paths[@]}")" ]; then
    die "$ov has uncommitted changes in kit paths; commit or stash first"
  fi

  populate_from "$KIT_BRANCH" "$wt" >/dev/null
  # populate_from already staged (checkout updates the index; rm stages the
  # deletion), so there is nothing to add -- and `git add -A -- <gone path>`
  # would fail on the deleted vendored tree.
  if [ -n "$(git -C "$wt" status --porcelain -- "${paths[@]}")" ]; then
    git -C "$wt" commit -q -m "kit: sync overlay-only content from $KIT_BRANCH" -- "${paths[@]}"
    echo "kit: $ov updated from $KIT_BRANCH ($(git -C "$wt" rev-parse --short HEAD))"
  else
    echo "kit: $ov already current with $KIT_BRANCH"
  fi
}

cmd_list() {
  local src; src="$(kit_source)"
  echo "kit:    $KIT_BRANCH $(kit_exists && git -C "$ROOT" rev-parse --short "$KIT_BRANCH" || echo '(absent)')"
  echo "source: $src"
  echo "carries (dev/promote-paths.txt minus $KIT_EXCLUDE):"
  kit_paths "$(kit_exists && echo "$KIT_BRANCH" || echo "$src")" | sed 's/^/  /'
}

case "${1:-}" in
  capture) cmd_capture ;;
  pull)    [ -n "${2:-}" ] || die "usage: dev/kit.sh pull <target>"; cmd_pull "$2" ;;
  list)    cmd_list ;;
  "")      sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)       die "unknown command '$1' (capture|pull|list)" ;;
esac
