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

# A sentinel only counts when it is the first WORD on the line, behind nothing
# but whitespace and comment punctuation. Matching the bare substring meant a
# line that merely mentioned "DEV-BEGIN" in prose turned on skipping and
# silently swallowed every line after it. The balance check caught the usual
# case (an odd number of mentions), but a stray mention that happened to
# balance stripped the wrong span and committed truncated code.
#
# "first word" rather than an enumeration of comment styles, because the styles
# are not enumerable in practice: Settings.js wraps a region in a JSX comment
# (`{/* DEV-BEGIN ... */}`), which no list of // # -- * would have matched.
# Anything non-alphanumeric before the sentinel is comment punctuation; a
# letter means prose, and prose is not a marker.
SENTINEL_RE='^[^A-Za-z0-9_]*(DEV-BEGIN|DEV-END)([[:space:]]|$)'

# Strip DEV-BEGIN..DEV-END regions (inclusive) from stdin.
strip_regions() {
  awk -v b="$BEGIN" -v e="$END" -v re="$SENTINEL_RE" '
    $0 ~ re {
      if (match($0, b)) { skip=1; next }
      if (match($0, e)) { skip=0; next }
    }
    skip==0 { print }
  '
}

# After stripping, the result must still parse. A region that unbalances a
# brace or a paren produces a file that is wrong but still commits; the only
# cheap guard is to ask the language. Anything we cannot check is reported
# rather than assumed fine.
check_syntax() {
  local file="$1" stripped="$2"
  case "$file" in
    *.js|*.cjs|*.mjs)
      node --check "$stripped" >/dev/null 2>&1 || {
        echo "promote: $file does not parse after stripping DEV regions" >&2
        node --check "$stripped" 2>&1 | head -5 >&2
        return 1
      }
      ;;
    *)
      : # no cheap syntax check for this language; brace balance is all we get
      local before after
      before="$(git show "HEAD:$file" | tr -cd '{' | wc -c)"
      after="$(tr -cd '{' < "$stripped" | wc -c)"
      if [ "$before" != "$after" ]; then
        echo "promote: $file loses {braces} when DEV regions are stripped" >&2
        return 1
      fi
      ;;
  esac
}

plan=()
unbalanced=()
unsound=()
TMPFILE="$(mktemp --suffix=.js)"
trap 'rm -f "$TMPFILE"' EXIT
for f in "${CANDIDATES[@]}"; do
  [ -e "$f" ] || continue
  # Balanced sentinel check, using the same anchoring as the strip itself --
  # counting raw substring hits here flagged prose as an unbalanced region.
  nb="$(git show "HEAD:$f" | awk -v re="$SENTINEL_RE" -v s="$BEGIN" \
        '$0 ~ re && $0 ~ s { c++ } END { print c+0 }')"
  ne="$(git show "HEAD:$f" | awk -v re="$SENTINEL_RE" -v s="$END" \
        '$0 ~ re && $0 ~ s { c++ } END { print c+0 }')"
  if [ "$nb" != "$ne" ]; then
    unbalanced+=("$f")
    continue
  fi
  # Promote if stripping regions leaves a difference from the feature branch.
  if git show "HEAD:$f" | strip_regions | diff -q - <(git show "$FEATURE:$f" 2>/dev/null) >/dev/null 2>&1; then
    continue  # nothing but dev regions differ
  fi
  git show "HEAD:$f" | strip_regions > "$TMPFILE"
  if ! check_syntax "$f" "$TMPFILE"; then
    unsound+=("$f")
    continue
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
if [ ${#unsound[@]} -gt 0 ]; then
  echo
  echo "ERROR (stripping DEV regions does not produce a valid file):"
  printf '  %s\n' "${unsound[@]}"
  die "a dev region is unbalancing the file; promoting it would commit broken code"
fi