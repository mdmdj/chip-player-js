#!/usr/bin/env bash
#
# DEV-ONLY: bring an overlay up to date -- safely, and all of them at once.
#
#   dev/refresh.sh <target|all> [--dry-run]
#
# A refresh is two halves: sync the kit (`dev/kit` -> the overlay), then rebase the
# overlay onto its feature branch. The rebase half verifies itself (dev/rebase.sh);
# the KIT half was the unverified one, so this wraps it with the two things that
# make going back and forth between features safe:
#
#   * PRE-FLIGHT -- what the kit would change here, printed before anything moves,
#     so an unexpected edit to a kit path is visible rather than a surprise;
#   * POST-CHECK -- after both halves, assert that nothing OUTSIDE the paths the kit
#     owns moved. A refresh that touches feature code is a bug, and this says so,
#     names the files, and leaves the pre-refresh tip to restore from.
#
# The dev patches (`server/index.js`, `UserProvider.js`) do not need reverting by
# hand: the rebase half reverts and re-applies them itself, and neither file is a
# path the kit owns.
#
# `all` refreshes every target that is checked out, SKIPPING (not failing) the ones
# that are absent or refuse, and prints one verdict per target -- that is the
# "bring them all up to date" case. `--dry-run` (or DRY_RUN=1) prints the pre-flight
# and the rebase's status and touches nothing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

DRY="${DRY_RUN:-0}"
want=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) [ -z "$want" ] && want="$a" ;;
  esac
done

die() { echo "refresh: $*" >&2; exit 1; }

# The paths the kit OWNS are the only ones a refresh may move. Read them from the
# kit so this cannot drift from what a pull actually carries.
KIT_REF="$(git -C "$ROOT" show-ref --verify --quiet refs/heads/dev/kit && echo dev/kit || true)"
[ -n "$KIT_REF" ] || die "no dev/kit branch; nothing to refresh from"
mapfile -t OWNED < <(bash "$DIR/kit.sh" owned "$KIT_REF")
[ ${#OWNED[@]} -gt 0 ] || die "the kit owns no paths?"
mapfile -t OWNED_EXCL < <(printf ':(exclude)%s\n' "${OWNED[@]}")
# What a pull will actually touch: the carried paths, and only the changes the kit
# brings (a file the kit does not have is not removed from the target, and a SEED is
# delivered only to a target that has none -- so neither belongs in a pre-flight).
mapfile -t CARRIED < <(bash "$DIR/kit.sh" carried "$KIT_REF")

# What the kit would change in this worktree (committed states only: the applied
# dev patches are uncommitted and are not kit content).
preflight() { # wt
  local wt="$1" files
  # From the kit to HEAD: M/D/R/T are the changes the kit SUPPLIES (a file the kit
  # has and HEAD lacks is a deletion in this direction, i.e. the pull would add it).
  # An 'A' here is a file HEAD has that the kit does not -- the pull will not remove
  # it, so it is not a change a refresh brings.
  files="$(git -C "$wt" diff --name-only --diff-filter=MDRT "$KIT_REF" HEAD -- "${CARRIED[@]}" 2>/dev/null || true)"
  if [ -z "$files" ]; then echo "kit is current here"; return 0; fi
  printf 'kit would change %s file(s):\n' "$(printf '%s\n' "$files" | grep -c .)"
  printf '%s\n' "$files" | head -12 | sed 's/^/  /'
}

refresh_one() { # target -> 0 ok, 1 refused/failed, 2 verification failed, 3 not applicable
  overlay_resolve "$1" 2>/dev/null || { echo "cannot resolve target '$1'"; return 3; }
  if ! overlay_require_worktrees 2>/dev/null; then
    echo "$OV_OVERLAY is not checked out in a worktree"; return 3
  fi
  local wt="$OV_OVERLAY_WT" pre post moved
  pre="$(git -C "$wt" rev-parse HEAD)"

  preflight "$wt" | sed 's/^/  /'
  if [ "$DRY" = 1 ]; then
    if git -C "$wt" merge-base --is-ancestor "$OV_FEATURE" HEAD 2>/dev/null; then
      echo "  rebase: already on top of $OV_FEATURE"
    else
      echo "  rebase: would replay onto $OV_FEATURE"
    fi
    return 0
  fi

  if ! bash "$DIR/kit.sh" pull "$OV_OVERLAY" 2>&1 | sed 's/^/  /'; then
    return 1
  fi
  if ! bash "$DIR/rebase.sh" "$OV_OVERLAY" >/dev/null 2>&1; then
    echo "  rebase refused or failed -- run ./dev/overlay.sh $1 rebase to see why"
    return 1
  fi

  # The invariant of the kit half: only paths the kit owns may move.
  post="$(git -C "$wt" rev-parse HEAD)"
  moved="$(git -C "$wt" diff --name-only "$pre" "$post" -- . "${OWNED_EXCL[@]}" 2>/dev/null || true)"
  if [ -n "$moved" ]; then
    echo "  REFRESH MOVED PATHS THE KIT DOES NOT OWN -- that is a bug:"
    printf '%s\n' "$moved" | sed 's/^/    /'
    echo "  the pre-refresh tip is $pre"
    return 2
  fi
  echo "  ok"
  return 0
}

if [ "$want" = all ] || [ -z "$want" ]; then
  mapfile -t targets < <(overlay_rows | awk 'NF >= 3 { print $1 }' | sort -u)
  [ ${#targets[@]} -gt 0 ] || die "no targets registered"
else
  targets=("$want")
fi

ok=0; skipped=0; failed=0
for t in "${targets[@]}"; do
  echo "== $t =="
  rc=0; refresh_one "$t" || rc=$?
  case "$rc" in
    0) ok=$((ok + 1)) ;;
    3) skipped=$((skipped + 1)); echo "  skipped" ;;
    *) failed=$((failed + 1)); echo "  FAILED (rc=$rc)" ;;
  esac
done

echo
echo "refresh: $ok refreshed, $skipped skipped, $failed failed$([ "$DRY" = 1 ] && echo ' [dry-run]')"
[ "$failed" -eq 0 ]
