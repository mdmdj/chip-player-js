#!/usr/bin/env bash
#
# DEV-ONLY: choose which chip-core a worktree uses -- by which SOURCES it was built
# from. A core is a build of the engine sources, and those differ per branch, so
# the choice is per worktree and it is deliberate:
#
#   * a feature that extends unmerged engine work (the sub-tune / Repeat One loop
#     API, say) needs a core built from THAT branch, or the player's calls have no
#     exports behind them;
#   * a fresh feature is better served by a core built from master, so it behaves
#     like upstream rather than picking up unmerged engine behaviour.
#
#   dev/core.sh list                      # which worktrees have a core, and from what
#   dev/core.sh use [<ref>] [<worktree>]  # copy in the core built from <ref> (default master)
#   dev/core.sh steal <from> [<worktree>] # same, naming a worktree/target instead of a ref
#   dev/core.sh build [<worktree>]        # build one FROM THAT worktree's sources
#
# `use`/`steal` only copy `src/chip-core.{js,wasm,buildinfo.json}` -- they never
# build. If no worktree has a core from <ref>, it fails and lists what does exist,
# so the caller can fall back knowingly instead of silently getting the wrong core.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

ARTIFACTS='src/chip-core.js src/chip-core.wasm src/chip-core.wasm.buildinfo.json'
DEFAULT_REF="${CORE_REF:-master}"
die() { echo "core: $*" >&2; exit 1; }

worktrees() { git -C "$ROOT" worktree list --porcelain | awk '$1 == "worktree" { print $2 }'; }
branch_of() { git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(detached)'; }
has_core() { [ -f "$1/src/chip-core.wasm" ]; }

# A worktree's ref matches if its branch name is <ref> or its HEAD equals <ref>.
wt_matches() { # wt ref
  local wb wh r
  wb="$(branch_of "$1")"; wh="$(git -C "$1" rev-parse HEAD 2>/dev/null || true)"
  r="$(git -C "$ROOT" rev-parse --verify -q "$2^{commit}" 2>/dev/null || true)"
  [ "$wb" = "$2" ] || { [ -n "$r" ] && [ "$wh" = "$r" ]; }
}

resolve_target() { # [<arg>] -> worktree
  local a="${1:-}" wt
  [ -n "$a" ] || { overlay_resolve "" 2>/dev/null || true; a="${OV_OVERLAY:-}"; }
  [ -n "$a" ] || die "cannot tell which worktree; pass one"
  [ -d "$a" ] && { echo "$a"; return; }
  wt="$(overlay_wt "$a")"
  if [ -z "$wt" ]; then overlay_resolve "$a" 2>/dev/null || true; wt="${OV_OVERLAY_WT:-}"; fi
  [ -n "$wt" ] || die "no worktree for '$a'"
  echo "$wt"
}

cmd_list() {
  printf '%-58s %-34s %s\n' WORKTREE BRANCH CORE
  local wt
  while IFS= read -r wt; do
    printf '%-58s %-34s %s\n' "$wt" "$(branch_of "$wt")" \
      "$(has_core "$wt" && echo 'src/chip-core.wasm' || echo -)"
  done < <(worktrees)
  echo
  echo "a core is a build of the ENGINE SOURCES: pick the one whose sources match the branch."
}

copy_from() { # src-wt dst-wt -> prints what it copied
  local src="$1" dst="$2" f
  for f in $ARTIFACTS; do
    [ -f "$src/$f" ] || continue
    mkdir -p "$dst/$(dirname "$f")"
    cp -f "$src/$f" "$dst/$f"
  done
  echo "core: $dst now uses the core from $src ($(branch_of "$src"))"
}

cmd_use() { # [<ref>] [<worktree>]
  local ref="${1:-$DEFAULT_REF}" dst; dst="$(resolve_target "${2:-}")"
  local wt found=""
  while IFS= read -r wt; do
    [ "$wt" = "$dst" ] && continue
    if has_core "$wt" && wt_matches "$wt" "$ref"; then found="$wt"; break; fi
  done < <(worktrees)
  if [ -z "$found" ]; then
    local have=""
    while IFS= read -r wt; do has_core "$wt" && have="$have $(branch_of "$wt")"; done < <(worktrees)
    die "no worktree has a core built from '$ref'.
       Cores that exist are on:${have:- none}
       Build one with: dev/core.sh build <worktree on $ref>"
  fi
  copy_from "$found" "$dst"
}

cmd_steal() { cmd_use "$1" "$2"; }

cmd_build() {
  local wt; wt="$(resolve_target "${1:-}")"
  echo "core: building in $wt from its own sources ($(branch_of "$wt"))"
  ( cd "$wt" && node scripts/build-chip-core.js )
}

case "${1:-}" in
  list)  cmd_list ;;
  use)   shift; cmd_use "${1:-}" "${2:-}" ;;
  steal) shift; cmd_steal "${1:-}" "${2:-}" ;;
  build) shift; cmd_build "${1:-}" ;;
  "")    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)     die "unknown command '$1' (list|use|steal|build)" ;;
esac
