#!/usr/bin/env bash
#
# DEV-ONLY: promote feature work from dev/overlay to feature/subtunes-as-first-class.
#
# The feature branch is the reviewable PR and must contain ONLY feature work.
# dev/overlay stacks dev tooling and audio/engine work on top. When you finish a
# chunk of feature work on the overlay branch, run this to lift it to the parent
# in one deterministic step.
#
# How it decides what is feature:
#   * Whole dev files live under paths that never overlap feature code, so they
#     simply never appear in the overlay-vs-feature diff (see CONVENTIONS).
#   * Dev code inside a shared file is wrapped in additive sentinel regions:
#         // DEV-BEGIN ... // DEV-END
#     Promotion STRIPS those regions; because each region only adds the dev
#     behavior, removing it restores prod behavior exactly. There is no
#     allowlist to maintain.
#
# Usage:
#   ./dev/promote.sh            # dry run: show what would be promoted
#   ./dev/promote.sh --apply    # do it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FEATURE="${PROMOTE_TARGET:-feature/subtunes-as-first-class}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Sentinel pair marking dev-only additive regions. Stripped on promotion.
BEGIN='DEV-BEGIN'
END='DEV-END'

die() { echo "promote: $*" >&2; exit 1; }

# 1. Clean worktree? (so the plan matches exactly what you reviewed)
if [ -n "$(git status --porcelain)" ]; then
  die "dev/overlay worktree is dirty. Commit or stash, then re-run so the plan matches what you reviewed."
fi

git rev-parse --verify -q "$FEATURE" >/dev/null || die "branch $FEATURE not found"

# The feature branch is usually checked out in a sibling worktree (both open at
# once). Operate there rather than failing on a busy branch.
FEATURE_WT="$(git worktree list --porcelain | awk -v b="refs/heads/$FEATURE" '
  $1=="worktree" { wt=$2 } $1=="branch" && $2==b { print wt }')"
[ -n "$FEATURE_WT" ] || die "$FEATURE is not checked out in any worktree."

# 2. Candidate files: differ from feature.
mapfile -t CANDIDATES < <(git diff --name-only "$FEATURE"...HEAD -- . 2>/dev/null | sort -u)

# Strip DEV-BEGIN..DEV-END regions (inclusive) from stdin.
strip_regions() {
  awk -v b="$BEGIN" -v e="$END" '
    $0 ~ b { skip=1 }
    skip==0 { print }
    $0 ~ e { skip=0 }
  '
}

plan=()
unbalanced=()
for f in "${CANDIDATES[@]}"; do
  [ -e "$f" ] || continue
  # Balanced sentinel check.
  nb="$(git show "HEAD:$f" | grep -c "$BEGIN" || true)"
  ne="$(git show "HEAD:$f" | grep -c "$END" || true)"
  if [ "$nb" != "$ne" ]; then
    unbalanced+=("$f")
    continue
  fi
  # Promote if stripping regions leaves a difference from the feature branch.
  if git show "HEAD:$f" | strip_regions | diff -q - <(git show "$FEATURE:$f" 2>/dev/null) >/dev/null 2>&1; then
    continue  # nothing but dev regions differ
  fi
  plan+=("$f")
done

echo "promote: target $FEATURE"
echo
if [ ${#plan[@]} -eq 0 ]; then
  echo "Nothing to promote (feature branch is up to date)."
else
  echo "Will promote ${#plan[@]} file(s) (DEV-BEGIN..DEV-END regions stripped):"
  printf '  %s\n' "${plan[@]}"
fi
if [ ${#unbalanced[@]} -gt 0 ]; then
  echo
  echo "ERROR (unbalanced $BEGIN/$END sentinels):"
  printf '  %s\n' "${unbalanced[@]}"
  die "fix the sentinel regions before promoting"
fi

[ ${#plan[@]} -eq 0 ] && exit 0
if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry run. Re-run with --apply to promote."
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
  echo "promote: no changes staged; nothing to commit."
else
  git -C "$FEATURE_WT" add -A
  git -C "$FEATURE_WT" commit -q -m "Promote feature work from dev/overlay"
  echo "promote: committed on $FEATURE: $(git -C "$FEATURE_WT" rev-parse --short HEAD)"
fi
echo "promote: dev/overlay unchanged. Push $FEATURE when ready, then rebase dev/overlay onto it."
