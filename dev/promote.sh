#!/usr/bin/env bash
#
# DEV-ONLY: promote feature work from dev/overlay to feature/subtunes-as-first-class.
#
# The feature branch is the reviewable PR and must contain ONLY feature work.
# dev/overlay stacks dev tooling and audio/engine work on top. When you finish a
# chunk of feature work on the overlay branch, run this to lift it to the parent
# in one deterministic step.
#
# What it does:
#   1. Requires a clean dev/overlay worktree (commit or stash first), so the
#      promotion is exactly what you reviewed.
#   2. For each file that differs from the feature branch, skips anything in
#      dev/promote-paths.txt (overlay-only) and anything in the overlay allowlist.
#   3. Refuses to promote a file whose overlay-vs-feature diff still contains a
#      dev marker (DEV-ONLY / dev-user / __cpDev), so shims can't leak into the
#      PR. Move that code into dev/ or an untracked module instead.
#   4. Shows the plan; with --apply, commits the file contents onto the feature
#      branch as a single commit and returns you to dev/overlay.
#
# Usage:
#   ./dev/promote.sh            # dry run: show what would be promoted
#   ./dev/promote.sh --apply    # do it
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FEATURE="${PROMOTE_TARGET:-feature/subtunes-as-first-class}"
PATHS_FILE="dev/promote-paths.txt"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Committed dev markers that must never reach the PR.
MARKERS='DEV-ONLY|dev-user|dev-token|__cpDev'

die() { echo "promote: $*" >&2; exit 1; }

# 1. Clean worktree?
if [ -n "$(git status --porcelain)" ]; then
  die "dev/overlay worktree is dirty. Commit or stash, then re-run so the plan matches what you reviewed."
fi

git rev-parse --verify -q "$FEATURE" >/dev/null || die "branch $FEATURE not found"

# Overlay-only paths (git pathspecs, comments/blank stripped).
mapfile -t OVERLAY < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$PATHS_FILE")
pathspec_exclusions=()
for p in "${OVERLAY[@]}"; do pathspec_exclusions+=(":(exclude)$p"); done

# 2. Candidate files: differ from feature, not overlay-only.
mapfile -t CANDIDATES < <(
  git diff --name-only "$FEATURE"...HEAD -- . "${pathspec_exclusions[@]}" 2>/dev/null | sort -u
)

plan=()
blocked=()
skipped=()
for f in "${CANDIDATES[@]}"; do
  [ -e "$f" ] || { plan+=("$f (deleted)"); continue; }
  diff="$(git diff "$FEATURE"...HEAD -- "$f")"
  changed_lines="$(printf '%s\n' "$diff" | grep -E '^[+-][^+-]' || true)"
  marked="$(printf '%s\n' "$changed_lines" | grep -cE "($MARKERS)" || true)"
  real="$(printf '%s\n' "$changed_lines" | grep -vcE "($MARKERS)" || true)"
  if [ "$marked" -eq 0 ]; then
    plan+=("$f")
  elif [ "$real" -eq 0 ]; then
    # Every changed line is dev-marked: the overlay delta on this file is purely
    # dev (the feature branch already has the real content). Skip, don't leak.
    skipped+=("$f")
  else
    # Dev markers mixed with real changes: needs manual reconciliation.
    blocked+=("$f")
  fi
done

echo "promote: target $FEATURE"
echo "promote: overlay-only paths in $PATHS_FILE are skipped"
echo
if [ ${#plan[@]} -eq 0 ]; then
  echo "Nothing to promote (feature branch is up to date)."
else
  echo "Will promote ${#plan[@]} file(s):"
  printf '  %s\n' "${plan[@]}"
fi
if [ ${#blocked[@]} -gt 0 ]; then
  echo
  echo "BLOCKED (dev markers mixed with real changes; reconcile manually):"
  printf '  %s\n' "${blocked[@]}"
fi
if [ ${#skipped[@]} -gt 0 ]; then
  echo
  echo "Skipped (overlay delta is purely dev; feature branch already correct):"
  printf '  %s\n' "${skipped[@]}"
fi

if [ ${#blocked[@]} -gt 0 ]; then
  die "refusing to promote with dev-only content in feature files"
fi
if [ ${#plan[@]} -eq 0 ]; then
  exit 0
fi
if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry run. Re-run with --apply to promote."
  exit 0
fi

# 3. Copy the candidate files onto the feature branch and commit there.
START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git stash list >/dev/null 2>&1 || true
git checkout "$FEATURE"
for f in "${CANDIDATES[@]}"; do
  if [ -e "$f" ]; then
    git checkout "$START_BRANCH" -- "$f"
  else
    git rm -q --ignore-unmatch "$f" 2>/dev/null || true
  fi
done
if git diff --cached --quiet && git diff --quiet; then
  echo "promote: no changes staged; nothing to commit."
else
  git commit -q -m "Promote feature work from dev/overlay"
  echo "promote: committed on $FEATURE: $(git rev-parse --short HEAD)"
fi
git checkout "$START_BRANCH"
echo "promote: back on $START_BRANCH. Push $FEATURE when ready, then rebase dev/overlay onto it."
