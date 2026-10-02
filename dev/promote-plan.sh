#!/usr/bin/env bash
# DEV-ONLY: shared planning logic for the promote pair. Sourced, not run.
#
# Sets FEATURE, FEATURE_WT and the `plan` array (files to lift), prints the
# plan, and dies on anything that would make the plan untrustworthy. Callers:
# dev/promote.sh (plan only) and dev/promote-apply.sh (the only writer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FEATURE="${PROMOTE_TARGET:-feature/subtunes-as-first-class}"
PATHS_FILE="dev/promote-paths.txt"

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

# 2. Candidate files: differ from feature, minus the overlay-only areas.
mapfile -t OVERLAY < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$PATHS_FILE")
pathspec_exclusions=()
for p in "${OVERLAY[@]}"; do pathspec_exclusions+=(":(exclude)$p"); done
mapfile -t CANDIDATES < <(git diff --name-only "$FEATURE"...HEAD -- . "${pathspec_exclusions[@]}" 2>/dev/null | sort -u)

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