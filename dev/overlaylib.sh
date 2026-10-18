#!/usr/bin/env bash
# DEV-ONLY: resolve which overlay target a tool run is for. Sourced, never run.
#
# The promote/rebase/push scripts act on two branches: the reviewable feature
# branch and the overlay stacked on it. dev/overlay.conf names each pair once;
# this resolves the pair -- and the ports its dev server uses -- from one input,
# so a script reads $OV_FEATURE / $OV_OVERLAY instead of assuming
# feature/subtunes-as-first-class on dev/overlay. Matching branches to refs
# explicitly, rather than reading HEAD, is what lets one checkout drive any
# target.
#
# Precedence (overlay_resolve):
#   1. an explicit argument      dev/promote.sh dev/overlay-gba
#   2. PROMOTE_OVERLAY           the overlay branch
#   3. PROMOTE_TARGET            the feature branch (the long-standing knob)
#   4. the current branch, when it is a manifest row
#   5. the first manifest row    the default, so `./dev/promote.sh` = sub-tunes
#   6. feature/subtunes-as-first-class + the current branch (no manifest at all)
#
# The arm key and the rebase scratch file need no per-target suffix: they live
# in the overlay branch's own worktree, and two overlays are two worktrees.
set -euo pipefail

OVERLAY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY_ROOT="$(cd "$OVERLAY_LIB_DIR/.." && pwd)"
OVERLAY_CONF="${OVERLAY_CONF:-$OVERLAY_LIB_DIR/overlay.conf}"

# Manifest rows, comment-stripped, as: name feature overlay wds api
overlay_rows() {
  [ -f "$OVERLAY_CONF" ] || return 0
  awk '{
    line = $0
    sub(/#.*/, "", line)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
    if (line == "") next
    n = split(line, f, /[[:space:]]+/)
    if (n < 3) next
    printf "%s %s %s %s %s\n", f[1], f[2], f[3],
      (f[4] == "" ? 3000 : f[4]), (f[5] == "" ? 8080 : f[5])
  }' "$OVERLAY_CONF"
}

# First manifest row matching a value against name, feature or overlay.
overlay_match() { # value rows
  local v="$1" rows="$2" r n f o
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    read -r n f o _ _ <<< "$r"
    if [ "$n" = "$v" ] || [ "$f" = "$v" ] || [ "$o" = "$v" ]; then
      printf '%s\n' "$r"; return 0
    fi
  done <<< "$rows"
  return 1
}

# Worktree path where a branch is checked out, or empty. Same discovery the
# feature branch has always used (both worktrees are usually open at once).
overlay_wt() { # branch
  git -C "$OVERLAY_ROOT" worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$1" '
    $1 == "worktree" { wt = $2 }
    $1 == "branch" && $2 == b { print wt }'
}

# Resolve $OV_NAME/$OV_FEATURE/$OV_OVERLAY/$OV_WDS/$OV_API. Optional arg is a
# name, a feature branch or an overlay branch.
overlay_resolve() {
  local want="${1:-}" rows cur sel="" row owner_row=""
  rows="$(overlay_rows)"
  cur="$(git -C "$OVERLAY_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ "$cur" = "HEAD" ] && cur=""

  if [ -n "$want" ]; then
    sel="$want"
  elif [ -n "${PROMOTE_OVERLAY:-}" ]; then
    sel="$PROMOTE_OVERLAY"
  elif [ -n "${PROMOTE_TARGET:-}" ]; then
    sel="$PROMOTE_TARGET"
  elif [ -n "$cur" ] && overlay_match "$cur" "$rows" >/dev/null; then
    sel="$cur"
  elif [ -n "$rows" ]; then
    sel="$(head -1 <<< "$rows" | awk '{print $1}')"
  fi

  OV_NAME=""; OV_FEATURE=""; OV_OVERLAY=""; OV_WDS=3000; OV_API=8080
  if [ -n "$sel" ] && row="$(overlay_match "$sel" "$rows")"; then
    read -r OV_NAME OV_FEATURE OV_OVERLAY OV_WDS OV_API <<< "$row"
    return 0
  fi

  # No manifest match: the historical single-target shape -- the target is the
  # feature branch, the overlay is the branch you are on.
  if [ -n "$want" ]; then OV_FEATURE="$want"
  else OV_FEATURE="${PROMOTE_TARGET:-feature/subtunes-as-first-class}"; fi
  OV_OVERLAY="${PROMOTE_OVERLAY:-${cur:-dev/overlay}}"
  OV_NAME="$(basename "$OV_FEATURE")"

  # Refuse an ambiguous retarget: naming a feature branch while standing on some
  # *other* target's overlay would push this overlay's work onto that feature.
  # Say so instead of guessing which overlay was meant.
  if [ -z "${PROMOTE_OVERLAY:-}" ] && [ -n "$cur" ] \
     && owner_row="$(overlay_match "$cur" "$rows")"; then
    local owner_feature
    read -r _ owner_feature _ _ _ <<< "$owner_row"
    if [ "$owner_feature" != "$OV_FEATURE" ]; then
      echo "overlay: $cur is the overlay for $owner_feature, not $OV_FEATURE." >&2
      echo "         name a target from dev/overlay.conf (dev/overlay.sh), or" >&2
      echo "         set PROMOTE_OVERLAY to the overlay branch you mean." >&2
      return 1
    fi
  fi
  return 0
}

# The worktrees the promote pair needs, resolved and required to exist. Both
# branches are normally open at once; if one is not, the caller stops rather than
# guessing a path.
overlay_require_worktrees() {
  OV_OVERLAY_WT="$(overlay_wt "$OV_OVERLAY")"
  if [ -z "$OV_OVERLAY_WT" ]; then
    echo "overlay: $OV_OVERLAY is not checked out in any worktree." >&2
    return 1
  fi
  OV_FEATURE_WT="$(overlay_wt "$OV_FEATURE")"
  if [ -z "$OV_FEATURE_WT" ]; then
    echo "overlay: $OV_FEATURE is not checked out in any worktree." >&2
    return 1
  fi
  return 0
}
