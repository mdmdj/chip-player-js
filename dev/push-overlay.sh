#!/usr/bin/env bash
#
# DEV-ONLY: publish dev/overlay to origin.
#
#   ./dev/push-overlay.sh
#
# dev/rebase.sh rewrites dev/overlay's history every promote (it replays all of
# the branch's commits onto the feature branch), so the remote tip is never an
# ancestor and a plain `git push` is always rejected as non-fast-forward. The
# branch therefore needs --force-with-lease, which overwrites only if the remote
# still matches what this checkout last fetched.
#
# NEVER `git pull` dev/overlay after a rebase: it would reconcile the stale
# remote history back into the rebased one -- the wrong direction, and it can
# reintroduce every pre-rebase commit. If a push is rejected, `git fetch` and
# look; do not pull.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH=dev/overlay
die() { echo "push-overlay: $*" >&2; exit 1; }

[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "expected to be on $BRANCH"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "uncommitted changes on $BRANCH; commit first"
fi
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  die "a rebase is in progress; finish it first"
fi

# No fetch: --force-with-lease is safest against the remote-tracking ref from the
# last fetch, so a push someone else made in the meantime is refused, not clobbered.
git push --force-with-lease origin "$BRANCH"
echo "push-overlay: $BRANCH -> origin ($(git rev-parse --short HEAD))"
