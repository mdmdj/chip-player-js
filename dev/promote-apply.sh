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
  echo "promote-apply: no changes staged; nothing to commit."
else
  git -C "$FEATURE_WT" add -A
  git -C "$FEATURE_WT" commit -q -m "Promote feature work from dev/overlay"
  echo "promote-apply: committed on $FEATURE: $(git -C "$FEATURE_WT" rev-parse --short HEAD)"
fi
rm -f "$ARMED"
echo "promote-apply: dev/overlay unchanged. Now put it back on top:"
echo "             ./dev/rebase.sh    # rebase + verify the tree did not move"