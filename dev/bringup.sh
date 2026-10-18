#!/usr/bin/env bash
#
# DEV-ONLY: one command to make a new target's dev tree runnable.
#
#   dev/bringup.sh <name> [<feature-branch>]
#
# Idempotent and re-runnable, from either place:
#   * the main checkout (which then creates the overlay), or
#   * a worktree t3 created from dev/kit -- you are already on
#     dev/overlay-<name>, so it uses this worktree and only creates the feature
#     branch + worktree.
#
# It does the whole documented sequence, so a fresh agent spends its turns on the
# feature rather than on setup:
#   1. feature branch (FEATURE_BASE, default master) + its worktree;
#   2. overlay branch dev/overlay-<name> + its worktree, carrying dev/kit;
#   3. a port pair claimed from the shared registry (dev/registry.sh);
#   4. the manifest row, committed on the overlay;
#   5. engine siblings linked (dev/engines.sh) and node_modules hardlinked from
#      the main checkout -- ~1.5s instead of two npm installs;
#   6. dev/apply.sh, then the main checkout's real chip-core copied in (so audio
#      works without a build). NO_REAL_CORE=1 keeps the silent stub.
#
# Progress from apply.sh goes to a log beside the worktree, not to stdout, so an
# agent's context stays small. Nothing is pushed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

FEATURE_BASE="${FEATURE_BASE:-master}"
die() { echo "bringup: $*" >&2; exit 1; }

name="${1:-}"
[ -n "$name" ] || die "usage: dev/bringup.sh <name> [<feature-branch>]"
feature="${2:-feature/$name}"
overlay="dev/overlay-$name"

git -C "$ROOT" show-ref --verify --quiet refs/heads/dev/kit \
  || die "dev/kit does not exist; build it first with ./dev/kit.sh capture"

main_wt="$(git -C "$ROOT" worktree list --porcelain | awk '$1 == "worktree" { print $2; exit }')"
[ -n "$main_wt" ] || die "could not find the main worktree"

ensure_branch() { # branch base
  git -C "$ROOT" show-ref --verify --quiet "refs/heads/$1" && return 0
  git -C "$ROOT" rev-parse --verify -q "$2" >/dev/null || die "base $2 not found"
  git -C "$ROOT" branch "$1" "$2"
  echo "bringup: created $1 from $2"
}
ensure_worktree() { # branch -> path on stdout
  local have
  have="$(overlay_wt "$1")"
  if [ -n "$have" ]; then echo "$have"; return 0; fi
  local wt="$(dirname "$ROOT")/chip-player-js-$(printf '%s' "$1" | tr '/' '-')"
  git -C "$ROOT" worktree add -q "$wt" "$1"
  echo "bringup: worktree $wt -> $1" >&2
  echo "$wt"
}

# 1-2. Branches and worktrees.
cur="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
# A worktree created from dev/kit is named for its target, `dev/overlay-<name>`. If
# the branch is an overlay for a *different* name, this command would quietly
# create a second pair elsewhere instead of setting up the tree you are in.
if [ "$cur" != "$overlay" ] && [ "${cur#dev/overlay-}" != "$cur" ]; then
  die "this worktree is on $cur, the overlay for '${cur#dev/overlay-}'.
       Run: ./dev/overlay.sh ${cur#dev/overlay-} bringup"
fi
ensure_branch "$feature" "$FEATURE_BASE"
fe_wt="$(ensure_worktree "$feature")"

if [ "$cur" = "$overlay" ]; then
  ov_wt="$ROOT"
  echo "bringup: $overlay is this worktree"
else
  ensure_branch "$overlay" "$feature"
  ov_wt="$(ensure_worktree "$overlay")"
fi

# The overlay-only content (minus the seam file; dev/apply.sh supplies that).
( cd "$ov_wt" && bash "$DIR/kit.sh" pull "$overlay" )

# 3-4. Register the target and claim a port pair: one shared row, so any worktree
# (and any agent) can discover this target and its ports.
row="$(bash "$DIR/registry.sh" claim "$name" "$feature" "$overlay")"
wds="$(printf '%s\n' "$row" | awk '{print $4}')"
api="$(printf '%s\n' "$row" | awk '{print $5}')"
echo "bringup: registered $name -> $feature / $overlay on WDS $wds / API $api"

# 5. Engines and modules.
bash "$DIR/engines.sh" link "$ov_wt"

# node_modules: hardlink-clone from the main checkout (~1.5s) instead of two npm
# installs. Cross-device (e.g. a worktree on tmpfs) cannot hardlink, so fall back
# to a symlink -- and never leave a partial copy behind: `cp -al` creates the
# destination directories before it fails on the first cross-device file, and a
# half-copied node_modules resolves some modules and not others.
link_modules() { # relpath
  local src="$main_wt/$1" dst="$ov_wt/$1"
  [ -e "$dst" ] && { echo "bringup: $1 already present"; return 0; }
  if [ -d "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    if cp -al "$src" "$dst" 2>/dev/null; then
      echo "bringup: $1 <- hardlinked from the main checkout"
      return 0
    fi
    rm -rf "$dst"
    if ln -s "$src" "$dst" 2>/dev/null; then
      echo "bringup: $1 <- symlinked to the main checkout (cross-device: no hardlinks)"
      return 0
    fi
  fi
  echo "bringup: $1 not linked; run 'npm install' in $ov_wt (or in $ov_wt/server)" >&2
}
link_modules node_modules
link_modules server/node_modules

# 6. Shims, DBs, catalog (log kept out of the worktree so git stays clean).
log="$(dirname "$ov_wt")/.bringup-$name.log"
if [ ! -f "$ov_wt/server/.env.local" ] || [ "${FORCE_APPLY:-0}" = 1 ]; then
  if ! ( cd "$ov_wt" && ./dev/apply.sh ) >"$log" 2>&1; then
    echo "bringup: dev/apply.sh failed; last lines of $log:" >&2
    tail -15 "$log" >&2
    exit 1
  fi
  echo "bringup: dev/apply.sh done (log: $log)"
fi

if [ "${NO_SAMPLE:-0}" != 1 ]; then
  # The cheap canonical sample: ~16 files across engines (dev/sample.manifest), so
  # the tree has something to play and the harness fixtures are present. Cheapest
  # mechanism per file (symlink, then hardlink, then copy); never the big
  # collections. NO_SAMPLE=1 skips it; SAMPLE_FROM=<worktree> steals that one's.
  bash "$DIR/sample.sh" seed "$ov_wt"
fi

if [ "${NO_REAL_CORE:-0}" != 1 ]; then
  # A core is a build of the ENGINE SOURCES, so which one matters. Default: a core
  # built from CORE_REF (master) -- a fresh feature then behaves like upstream. A
  # feature extending unmerged engine work asks for that branch's core instead:
  #   CORE_REF=dev/overlay ./dev/bringup.sh <name>
  if bash "$DIR/core.sh" use "${CORE_REF:-master}" "$ov_wt" >/dev/null 2>&1; then
    echo "bringup: chip-core from ${CORE_REF:-master}"
  elif bash "$DIR/core.sh" from "$main_wt" "$ov_wt" >/dev/null 2>&1; then
    echo "bringup: nothing has a core from ${CORE_REF:-master}; copied the main checkout's" >&2
    echo "         (built from ITS branch's sources -- see dev/core.sh list for what each core is)" >&2
  else
    echo "bringup: no core available; this tree will run on the silent stub" >&2
  fi
fi

echo
echo "bringup: $name is ready."
echo "  run:    ./dev/overlay.sh $name dev      # WDS $wds / API $api"
echo "  verify: curl -s -o /dev/null -w '%{http_code}\\n' localhost:$api/"
echo "  preview: mms-1:$api"
