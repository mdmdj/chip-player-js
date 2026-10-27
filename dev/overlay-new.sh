#!/usr/bin/env bash
#
# DEV-ONLY: create an overlay for a feature branch -- the feature branch plus
# dev/kit.
#
#   ./dev/overlay-new.sh <name> [<feature-branch>]
#
# Creates what is missing and is idempotent for what exists:
#   * feature/<name>        from FEATURE_BASE (default master), when the branch
#                           is not given and does not exist;
#   * dev/overlay-<name>    from the feature branch, then `git merge dev/kit`;
#   * worktrees ../chip-player-js-feature-<name> and ../chip-player-js-overlay-<name>.
#
# Refreshing an overlay later is `dev/overlay.sh <name> refresh`: it syncs the
# overlay-only content from dev/kit, then rebases onto the feature branch. The
# sync is a commit, not a history rewrite, so the rebase verification is intact.
#
# Nothing is pushed. Use a distinct <name>: the existing subtunes worktree is
# ../chip-player-js-feature (no suffix), so do not run this for `subtunes`.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

KIT_BRANCH="${KIT_BRANCH:-dev/kit}"
FEATURE_BASE="${FEATURE_BASE:-master}"

die() { echo "overlay-new: $*" >&2; exit 1; }

name="${1:-}"
[ -n "$name" ] || die "usage: dev/overlay-new.sh <name> [<feature-branch>]"
feature="${2:-feature/$name}"
overlay="dev/overlay-$name"
parent="$(dirname "$ROOT")"
fe_wt="$parent/chip-player-js-feature-$name"
ov_wt="$parent/chip-player-js-overlay-$name"

git -C "$ROOT" show-ref --verify --quiet "refs/heads/$overlay" \
  && die "$overlay already exists; add its manifest line and run dev/overlay.sh $name"

# 1. Feature branch.
if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$feature"; then
  echo "new: feature branch $feature exists"
else
  git -C "$ROOT" rev-parse --verify -q "$FEATURE_BASE" >/dev/null \
    || die "base $FEATURE_BASE not found"
  git -C "$ROOT" branch "$feature" "$FEATURE_BASE"
  echo "new: created $feature from $FEATURE_BASE"
fi

# 2. Overlay branch = feature branch + kit.
git -C "$ROOT" branch "$overlay" "$feature"
echo "new: created $overlay from $feature"

# 3. Worktrees (both branches open at once, matching the subtunes layout).
[ -d "$fe_wt" ] || { git -C "$ROOT" worktree add -q "$fe_wt" "$feature"; echo "new: $fe_wt -> $feature"; }
git -C "$ROOT" worktree add -q "$ov_wt" "$overlay"
echo "new: $ov_wt -> $overlay"

# 4. Sync the overlay-only content from the kit: the whole-file material and the
#    vendored-tree deletion, committed on the overlay. No rebase, no force-push.
if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$KIT_BRANCH"; then
  bash "$DIR/kit.sh" pull "$overlay"
else
  echo "new: $KIT_BRANCH does not exist yet; check out the canonical dev/kit branch,"
  echo "     then run dev/overlay.sh $name refresh"
fi

cat <<EOF

Add this target to dev/overlay.conf (name feature overlay wds api) -- give it
its own port pair so it can run beside the others:

  $name   $feature   $overlay   3300 8180

Then:

  dev/overlay.sh $name status
  dev/overlay.sh $name dev        # on ports 3300/8180
EOF
