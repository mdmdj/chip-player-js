#!/usr/bin/env bash
#
# DEV-ONLY: put dev/overlay back on top of the feature branch after a promote.
#
#   ./dev/rebase.sh
#
# The rebase is one command, but it is the only step of the promote cycle that
# can change the tree without saying so. Two mechanisms do it quietly: `-X
# theirs` resolves an overlapping hunk toward the replayed commit, and work the
# feature branch already carries is dropped or emptied. On 2026-10-07 a rebase
# that printed "Successfully rebased" and exited 0 dropped the commit carrying
# the shuffle rewrite and put server/database.js back to a superseded design.
# Nothing in git's output said so; only diffing the tree against the pre-rebase
# tip caught it, and reconstructing which commit went missing took an hour.
#
# So this script does the two things a person should not have to remember:
#   * it refuses to continue a rebase that stopped. An interrupted rebase leaves
#     the partially applied commit staged and `--continue` trusts it, which is
#     how the above went wrong;
#   * after a successful rebase it checks the tree is byte-identical to the tip
#     it started from, and names every commit the rebase emptied or dropped.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FEATURE="${PROMOTE_TARGET:-feature/subtunes-as-first-class}"
# Scratch state for the failure path, so the pre-rebase tip is recoverable.
STATE="dev/.pre-rebase"

die() { echo "rebase: $*" >&2; exit 1; }

cleanup() { rm -f "$STATE" "$STATE.mb"; }
trap cleanup EXIT

# Tracked changes only: untracked files (the dev shims, catalog/) are invisible
# to the tree comparison below, and a rebase that would clobber one stops on
# its own.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "dev/overlay worktree is dirty. Commit or stash first: the check below
       compares this exact tree against the rebased one."
fi
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  die "a rebase is already in progress. Do not resume it -- run
       \`git rebase --abort\`, then re-run this script."
fi
[ "$(git rev-parse --abbrev-ref HEAD)" = "dev/overlay" ] \
  || die "expected to be on dev/overlay; on $(git rev-parse --abbrev-ref HEAD)"
git rev-parse --verify -q "$FEATURE" >/dev/null || die "branch $FEATURE not found"

TIP="$(git rev-parse HEAD)"
MB="$(git merge-base "$TIP" "$FEATURE")"
echo "$TIP" > "$STATE"
echo "$MB" > "$STATE.mb"

echo "rebase: dev/overlay ($(git rev-parse --short "$TIP")) onto $FEATURE ($(git rev-parse --short "$FEATURE"))"
if ! git rebase -X theirs "$FEATURE"; then
  die "the rebase stopped; its output above is the whole story. Abort it
       (\`git rebase --abort\`) rather than resuming: the partially applied
       commit is staged, and --continue trusts it. The tree is untouched and
       the pre-rebase tip is in $STATE."
fi

# 1. Did any commit lose content? Range-diff pairs the two ranges by similarity:
#    '=' unchanged, '!' changed, '<' dropped. Ranges are spelled out rather than
#    using A...B, whose differing merge bases add a bogus boundary row.
changed="$(git range-diff --no-color "$MB..$TIP" "$FEATURE..HEAD" 2>/dev/null \
  | grep -E '^[[:space:]]*[0-9]+:[[:space:]]+[0-9a-f]+[[:space:]]+[!<]' || true)"
if [ -n "$changed" ]; then
  echo
  echo "rebase: these commits are not what they were. Old and new sha:"
  sed -E 's/^[[:space:]]*[0-9]+:[[:space:]]+//' <<< "$changed" | sed -E 's/^/  /'
  echo "  '=' unchanged, '!' diff changed, '<' gone. A promoted commit is"
  echo "  expected here: $FEATURE carries the work now, so only its dev-only"
  echo "  remainder is left. A commit that is gone AND whose content is not"
  echo "  on $FEATURE is a lost change -- restore it from $TIP."
fi

# 2. The invariant: rebasing onto a branch that already holds this branch's
#    content must not move a single byte of the tree.
if git diff --quiet "$TIP" HEAD; then
  echo
  echo "rebase: tree unchanged, $FEATURE is up to date. Push dev/overlay when ready."
  exit 0
fi

mapfile -t moved < <(git diff --name-only "$TIP" HEAD)
if git diff --quiet "$FEATURE" HEAD -- "${moved[@]}"; then
  # The base supplied content the tip did not have -- i.e. this tip predates the
  # work just promoted. Nothing was lost, so say so rather than crying wolf.
  echo
  echo "rebase: the tree moved only where $FEATURE is ahead of the tip you"
  echo "rebased from. Nothing was lost, but check that is what you meant:"
  printf '  %s\n' "${moved[@]}"
  exit 0
fi

echo
echo "rebase: FAIL -- the tree is not what it was before, and the rebase"
echo "reported success, so this is the only place it shows. Something was lost"
echo "that $FEATURE does not have: a DEV region, a hand-carried hunk, or a"
echo "promoted file that came back stripped. Restore the affected files from"
echo "$TIP, commit, and re-run:"
echo
git diff --stat "$TIP" HEAD
exit 1
