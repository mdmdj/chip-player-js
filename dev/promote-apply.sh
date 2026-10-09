#!/usr/bin/env bash
#
# DEV-ONLY: the promote WRITER. This is the only thing in the repo that puts a
# commit on the reviewable PR branch, so it requires an armed key file:
#
#   touch dev/.promote-armed
#   ./dev/promote-apply.sh
#
# The key is consumed on a successful promote, so it cannot be left armed. It is
# deliberately *not* a flag: a flag on the same script you reach for when you
# want to look at the plan would not be a boundary at all. Creating a file is
# something a person does on purpose, and something an agent does not do on its
# own initiative.
#
# Promotion writes commits to feature/subtunes-as-first-class. Ask before
# running it; see dev/promote.sh for the plan and the rules.
#
# Once the commit lands, this runs the whole mechanical tail -- dev/rebase.sh
# (rebase + verify), then pushes the feature branch, then dev/push-overlay.sh --
# so the cycle is one command after arming. PROMOTE_SKIP_PUSH=1 holds the
# publishes back.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
ARMED="$ROOT/dev/.promote-armed"

die() { echo "promote-apply: $*" >&2; exit 1; }

if [ ! -e "$ARMED" ]; then
  die "not armed. Promotion writes commits to the reviewable PR branch, so it
       has to be asked for:

         touch dev/.promote-armed
         ./dev/promote-apply.sh

       To look at the plan first: ./dev/promote.sh"
fi

# shellcheck source=dev/promote-plan.sh
source "$DIR/promote-plan.sh"

if [ ${#plan[@]} -eq 0 ]; then
  rm -f "$ARMED"
  exit 0
fi

# 3. Write stripped content onto the feature branch and commit there.
if [ -n "$(git -C "$FEATURE_WT" status --porcelain)" ]; then
  die "feature worktree at $FEATURE_WT is dirty; commit or stash there first."
fi
for f in "${plan[@]}"; do
  mkdir -p "$FEATURE_WT/$(dirname "$f")"
  git show "HEAD:$f" | strip_regions > "$FEATURE_WT/$f"
done
if git -C "$FEATURE_WT" diff --quiet; then
  rm -f "$ARMED"
  echo "promote-apply: no changes staged; nothing to commit."
  exit 0
fi
git -C "$FEATURE_WT" add -A
git -C "$FEATURE_WT" commit -q -m "Promote feature work from dev/overlay"
echo "promote-apply: committed on $FEATURE: $(git -C "$FEATURE_WT" rev-parse --short HEAD)"
rm -f "$ARMED"

# Mechanical tail: put dev/overlay back on top (rebase.sh verifies the tree), then
# publish. A failing rebase stops here before the push (set -e above).
echo
"$DIR/rebase.sh"

if [ "${PROMOTE_SKIP_PUSH:-0}" = "1" ]; then
  echo
  echo "promote-apply: PROMOTE_SKIP_PUSH=1, not published. When ready:"
  echo "             git -C $FEATURE_WT push origin $FEATURE"
  echo "             ./dev/push-overlay.sh"
  exit 0
fi
echo
echo "promote-apply: publishing $FEATURE to origin..."
git -C "$FEATURE_WT" push origin "$FEATURE"
echo
"$DIR/push-overlay.sh"