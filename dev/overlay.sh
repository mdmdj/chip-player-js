#!/usr/bin/env bash
#
# DEV-ONLY: one front end for the overlay targets named in dev/overlay.conf.
#
#   dev/overlay.sh [<target>] list        the targets and where they are checked out
#   dev/overlay.sh [<target>] status      resolved target, worktrees, ports, arm state
#   dev/overlay.sh [<target>] plan        dev/promote.sh (plan only; no write path)
#   dev/overlay.sh [<target>] promote     dev/promote-apply.sh (requires the arm key)
#   dev/overlay.sh [<target>] refresh     kit sync + dev/rebase.sh
#   dev/overlay.sh [<target>] rebase      dev/rebase.sh (the legacy rebase model)
#   dev/overlay.sh [<target>] push        dev/push-overlay.sh (force-with-lease)
#   dev/overlay.sh [<target>] dev         npm run dev in the overlay worktree, on its ports
#   dev/overlay.sh [<target>] arm         print the arm-key path to touch (does not touch it)
#   dev/overlay.sh new <name> [<feature>] dev/overlay-new.sh
#
# <target> is a name, feature branch or overlay branch from dev/overlay.conf; with
# none, the current branch's target (or the manifest default). Promotion is still
# gated by the arm key: this front end never arms for you, and running `promote`
# unarmed refuses exactly as dev/promote-apply.sh does.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

is_cmd() {
  case "$1" in
    list|status|plan|promote|refresh|rebase|push|dev|arm|new) return 0 ;;
    *) return 1 ;;
  esac
}

if is_cmd "${1:-}"; then cmd="$1"; target="${2:-}"; else target="${1:-}"; cmd="${2:-status}"; fi

die() { echo "overlay: $*" >&2; exit 1; }

case "$cmd" in
  list)
    printf '%-10s %-38s %-22s %s\n' NAME FEATURE OVERLAY PORTS
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      read -r n f o w a <<< "$r"
      printf '%-10s %-38s %-22s %s/%s\n' "$n" "$f" "$o" "$w" "$a"
    done <<< "$(overlay_rows)"
    ;;

  status)
    overlay_resolve "$target"
    overlay_require_worktrees
    arm="$OV_OVERLAY_WT/dev/.promote-armed"
    printf 'target    %s\n' "$OV_NAME"
    printf 'feature   %s  (%s)\n' "$OV_FEATURE" "$OV_FEATURE_WT"
    printf 'overlay   %s  (%s)\n' "$OV_OVERLAY" "$OV_OVERLAY_WT"
    printf 'ports     wds=%s api=%s\n' "$OV_WDS" "$OV_API"
    printf 'arm key   %s%s\n' "${arm#"$ROOT"/}" "$([ -e "$arm" ] && echo '  (ARMED)' || echo '')"
    printf 'kit       %s\n' "$(git show-ref --verify --quiet refs/heads/dev/kit && echo present || echo '(absent)')"
    ;;

  plan)    exec "$DIR/promote.sh" "$target" ;;
  promote) exec "$DIR/promote-apply.sh" "$target" ;;
  rebase)  exec "$DIR/rebase.sh" "$target" ;;
  push)    exec "$DIR/push-overlay.sh" "$target" ;;
  new)     exec "$DIR/overlay-new.sh" "$target" ;;
  arm)
    overlay_resolve "$target"
    overlay_require_worktrees
    echo "${OV_OVERLAY_WT#"$ROOT"/}/dev/.promote-armed"
    ;;

  refresh)
    overlay_resolve "$target"
    overlay_require_worktrees
    # Sync the overlay-only content from the kit (a commit, not a rewrite), then
    # put the overlay back on top of the feature branch.
    git show-ref --verify --quiet refs/heads/dev/kit && "$DIR/kit.sh" pull "$OV_OVERLAY"
    exec "$DIR/rebase.sh" "$target"
    ;;

  dev)
    overlay_resolve "$target"
    overlay_require_worktrees
    [ -d "$OV_OVERLAY_WT/node_modules" ] || \
      echo "overlay: no node_modules in $OV_OVERLAY_WT; install there first" >&2
    cd "$OV_OVERLAY_WT"
    echo "overlay: npm run dev on WDS_PORT=$OV_WDS API_PORT=$OV_API ($OV_NAME)"
    WDS_PORT="$OV_WDS" API_PORT="$OV_API" exec npm run dev
    ;;

  *) die "unknown command '$cmd'" ;;
esac
