#!/usr/bin/env bash
#
# DEV-ONLY: the canonical home of the overlay-only *whole-file* content (`dev/kit`).
# Edit it here, then sync it onto any overlay with `pull` -- do not maintain a
# separate copy on each overlay.
#
# Why a kit: an overlay carries two kinds of thing -- files that are ours and
# only ours (dev/**, the engine build, the vendored-tree deletion, the two
# engine-config files), and DEV regions inside files the feature branch owns.
# The first kind is identical for every target, so `pull` writes it from this
# branch into a target overlay, which commits it. Nothing here rewrites history,
# so it composes with the existing rebase/promote cycle unchanged.
#
# `dev/kit` is CANONICAL: change a tool or doc by editing it here, committing on
# this branch, and pulling it to the targets. `capture`/`import` exists only to
# bootstrap or deliberately rebuild the kit from an overlay; it is not the normal
# route and requires `KIT_SOURCE` (no implicit "canonical overlay").
#
# The kit deliberately excludes the feature-coupled parts, which cannot be a
# shared whole-file copy because they edit feature-owned files:
#   * server/index.js           -- the "seam": the dev delta substitutes a module
#                                  at a require site, and the file also carries
#                                  feature work that is hand-carried.
#   * DEV-BEGIN/DEV-END regions -- they sit inside feature files; overlays keep
#                                  them as ordinary commits.
# Everything else in dev/promote-paths.txt (minus that exclusion) is carried --
# except two paths handled specially:
#
#   * KIT_SEED (AGENTS.md) -- the shared playbook. It lives on dev/kit as a
#     TEMPLATE: `pull` delivers it only to a target that has none, and an import
#     never takes an overlay's copy up. So an overlay keeps its own notes, and a
#     fresh worktree gets the clean template.
#   * KIT_NEVER -- paths the kit must not carry: per-feature notes
#     (dev/features), and feature tests (from dev/tests.manifest).
#
# Usage:
#   ./dev/kit.sh import <source> [<path>...]  # bootstrap only; rebuilds dev/kit from an overlay
#   ./dev/kit.sh capture [<path>...]          # same, with KIT_SOURCE=<ref> (compat alias)
#   ./dev/kit.sh pull <target>                # write dev/kit onto the target's overlay
#   ./dev/kit.sh list                         # what the kit carries, seeds, never carries
#
# `pull` writes onto a target's overlay worktree and commits only what it changed.
# KIT_BASE is the branch a fresh dev/kit is based on (default master). Nothing is
# pushed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

KIT_BRANCH="${KIT_BRANCH:-dev/kit}"
KIT_BASE="${KIT_BASE:-master}"
# Paths the kit must NEVER carry: per-feature notes, which must not become kit
# baggage carried into every other feature's worktree. (The build script's
# source-coupled parts are handled in the script itself: its export list drops a
# symbol the tree's engine sources do not define, so one script serves any base.)
KIT_NEVER="${KIT_NEVER:-dev/features dev/MIDI_LOOP_TEST_GAPS.md dev/UPSTREAM_PR_PLAN.md dev/pr-body.md dev/pr-body.suggested.md dev/prod-midi-collections.md}"
# The seam file: its dev delta is not a whole-file copy, so it is not in the kit
# either (dev/apply.sh patches it in place instead).
KIT_EXCLUDE="${KIT_EXCLUDE:-server/index.js}"
# Paths the kit OWNS as a template: they live on dev/kit and are delivered to a
# target only when the target does not already have one, and are never captured
# back up. AGENTS.md is the shared playbook -- without this, capturing an overlay
# that has grown feature-specific notes would make those notes the template for
# every future feature, and pulling would overwrite an overlay's own copy.
KIT_SEED="${KIT_SEED:-AGENTS.md}"

die() { echo "kit: $*" >&2; exit 1; }
kit_exists() { git -C "$ROOT" show-ref --verify --quiet "refs/heads/$KIT_BRANCH"; }

# An import source must be named explicitly. There is no default canonical
# overlay: dev/kit is canonical, and silently importing from whichever overlay
# happened to be first is how one feature's kit-path edits became the template.
kit_import_source() {
  [ -n "${KIT_SOURCE:-}" ] || die "dev/kit is canonical; edit it directly. To import from an overlay: $0 import <ref> [<path>...]"
  printf '%s\n' "$KIT_SOURCE"
}

# Feature test harnesses are source-coupled: they belong to the branch whose code
# they test, so the kit never carries them. The list comes from the registry
# (dev/tests.manifest), so adding a feature's tests means editing one file.
kit_feature_tests() { # ref
  git show "$1:dev/tests.manifest" 2>/dev/null \
    | awk '$1 == "test" && $2 == "feature" { print $4 }'
}

# Everything the kit must not carry: the explicit list above plus the registry's
# feature tests.
kit_never_paths() { # ref
  local n
  for n in $KIT_NEVER; do printf '%s\n' "$n"; done
  kit_feature_tests "$1"
}

# Overlay-only pathspecs, read from a ref, minus the exclusions (KIT_EXCLUDE and
# KIT_NEVER are never carried), optionally filtered to/away from the seeds.
kit_paths() { # ref [--seed|--no-seed]
  local ref="$1" mode="${2:-all}" p raw
  raw="$(git show "$ref:dev/promote-paths.txt" 2>/dev/null \
    | sed -e 's/#.*//' -e '/^[[:space:]]*$/d' -e 's/[[:space:]]*$//')"
  local -a kept=()
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case " $KIT_EXCLUDE $KIT_NEVER " in *" $p "*) continue ;; esac
    kept+=("$p")
  done <<< "$raw"
  [ ${#kept[@]} -gt 0 ] || return 0
  printf '%s\n' "${kept[@]}" | case "$mode" in
    --no-seed) grep -vxF -- "$KIT_SEED" || true ;;
    --seed)    grep -xF  -- "$KIT_SEED" || true ;;
    *)         cat ;;
  esac
}

# The bare path for a pathspec (`libvgm/**` -> libvgm).
kit_bare() { local p="$1"; p="${p%/\*\*}"; echo "${p%/}"; }

# Copy each named path from $1 into the worktree $2 (checkout if present, remove
# if not -- which is how the vendored-tree deletion travels). Prints the bare
# paths; populate stages (checkout updates the index, rm stages the removal), so
# callers never `git add -A` over unrelated work.
populate_from() { # src dest path...
  local src="$1" dest="$2"; shift 2
  local p bare
  for p in "$@"; do
    [ -n "$p" ] || continue
    bare="$(kit_bare "$p")"
    if git -C "$dest" cat-file -e "$src:$bare" 2>/dev/null; then
      git -C "$dest" checkout "$src" -- "$bare"
      printf '%s\n' "$bare"
    elif git -C "$dest" cat-file -e "HEAD:$bare" 2>/dev/null; then
      git -C "$dest" rm -r -q --ignore-unmatch -- "$bare"
      printf '%s\n' "$bare"
    fi
  done
}

cmd_capture() { # [<path>...] -- naming paths imports just those (from KIT_SOURCE)
  local src wt; src="$(kit_import_source)"
  git -C "$ROOT" rev-parse --verify -q "$src" >/dev/null || die "import source $src not found"
  kit_exists || git -C "$ROOT" branch "$KIT_BRANCH" "$KIT_BASE"
  wt="$(mktemp -d)"; rmdir "$wt"
  git -C "$ROOT" worktree add -q "$wt" "$KIT_BRANCH"
  # EXIT, not RETURN: `set -e` makes any failure below exit the script outright, and
  # a RETURN trap would not fire -- leaving the temp worktree registered and
  # `$KIT_BRANCH` "already used by worktree", which blocks every later kit command.
  # shellcheck disable=SC2064
  trap "git -C '$ROOT' worktree remove --force '$wt' >/dev/null 2>&1 || true" EXIT

  # Explicit paths are an override: publish exactly those, seeds included. A path
  # that is actually a branch name is a mistake worth stopping for -- silently
  # treating it as a path is how `capture <overlay> <file>` published the wrong
  # source.
  local -a paths=()
  if [ "$#" -gt 0 ]; then
    local p
    for p in "$@"; do
      git -C "$ROOT" rev-parse --verify -q "$p" >/dev/null 2>&1 \
        && die "'$p' is a branch, not a path. Set KIT_SOURCE=$p and use '$0 import $p <path>'"
      paths+=("$p")
    done
  else
    while IFS= read -r p; do [ -n "$p" ] && paths+=("$p"); done < <(kit_paths "$src" --no-seed)
  fi
  [ ${#paths[@]} -gt 0 ] || die "no paths to capture"

  populate_from "$src" "$wt" "${paths[@]}" >/dev/null
  # Files the kit must never carry: drop them whatever the source had, so they
  # cannot ride along -- and so a path that used to be carried gets pruned. `-f`
  # because populate_from staged them (git rm refuses a staged file otherwise).
  local nev
  while IFS= read -r nev; do
    [ -n "$nev" ] || continue
    [ -e "$wt/$nev" ] && git -C "$wt" rm -r -q -f --ignore-unmatch -- "$nev"
  done < <(kit_never_paths "$src")
  git -C "$wt" add -A -- .
  if git -C "$wt" diff --cached --quiet; then
    echo "kit: $KIT_BRANCH already current with $src"
  else
    git -C "$wt" commit -q -m "kit: overlay-only content from $src"
    echo "kit: $KIT_BRANCH updated from $src ($(git -C "$wt" rev-parse --short HEAD))"
  fi
}

cmd_pull() { # write dev/kit onto the target's overlay worktree
  local ov="$1" wt row
  # Accept a manifest target name in place of the overlay branch.
  if row="$(overlay_match "$ov" "$(overlay_rows)")"; then
    read -r _ _ ov _ _ <<< "$row"
  fi
  wt="$(overlay_wt "$ov")"
  [ -n "$wt" ] || die "$ov is not checked out in any worktree"
  kit_exists || die "$KIT_BRANCH does not exist; check out the canonical dev/kit branch first"

  local -a paths=()
  while IFS= read -r p; do [ -n "$p" ] && paths+=("$(kit_bare "$p")"); done < <(kit_paths "$KIT_BRANCH")
  [ ${#paths[@]} -gt 0 ] || die "no paths to pull"

  # A seed path is delivered only when the target has none: the kit's AGENTS.md
  # is the template a NEW worktree gets, not a rewrite of a worktree's own notes.
  local -a deliver=() p
  for p in "${paths[@]}"; do
    if printf '%s\n' "$KIT_SEED" | grep -qxF -- "$p" && git -C "$wt" cat-file -e "HEAD:$p" 2>/dev/null; then
      continue
    fi
    deliver+=("$p")
  done
  paths=("${deliver[@]}")
  [ ${#paths[@]} -gt 0 ] || { echo "kit: $ov already current with $KIT_BRANCH"; return 0; }

  # Refuse to clobber pending work in the paths the kit owns -- but a worktree's own
  # feature notes (dev/features/**) and the tests it carries are EXPECTED to sit
  # there untracked, and they live under `dev/**`, so counting them as pending work
  # in a kit path would mean a refresh could never run.
  local -a excl=()
  local n
  while IFS= read -r n; do [ -n "$n" ] && excl+=(":(exclude)$n"); done < <(kit_never_paths "$KIT_BRANCH")
  if [ -n "$(git -C "$wt" status --porcelain -- "${paths[@]}" "${excl[@]}")" ]; then
    die "$ov has uncommitted changes in kit paths; commit or stash first"
  fi

  local -a touched=()
  mapfile -t touched < <(populate_from "$KIT_BRANCH" "$wt" "${paths[@]}")
  # Commit only what populate_from touched: the full path list includes the vendored
  # trees, which exist in neither the kit nor HEAD in a master-based overlay after its
  # first sync, and `git commit -- <pathspec>` is fatal when a pathspec matches
  # nothing -- so a second sync used to abort after staging everything.
  if [ ${#touched[@]} -gt 0 ] && [ -n "$(git -C "$wt" status --porcelain -- "${touched[@]}" "${excl[@]}")" ]; then
    git -C "$wt" commit -q -m "kit: sync overlay-only content from $KIT_BRANCH" -- "${touched[@]}" "${excl[@]}"
    echo "kit: $ov updated from $KIT_BRANCH ($(git -C "$wt" rev-parse --short HEAD))"
  else
    echo "kit: $ov already current with $KIT_BRANCH"
  fi
}

cmd_list() {
  kit_exists || die "$KIT_BRANCH does not exist; check out the canonical dev/kit branch first"
  echo "kit:    $KIT_BRANCH $(git -C "$ROOT" rev-parse --short "$KIT_BRANCH")"
  echo "source: $KIT_BRANCH (canonical)"
  echo "carries (dev/promote-paths.txt minus $KIT_EXCLUDE and the seeds):"
  kit_paths "$KIT_BRANCH" --no-seed | sed 's/^/  /'
  echo "seeded (delivered only to a target that has none, never imported up):"
  kit_paths "$KIT_BRANCH" --seed | sed 's/^/  /'
  echo "never carried (not template material):"
  local nev; while IFS= read -r nev; do [ -n "$nev" ] && echo "  $nev"; done < <(kit_never_paths "$KIT_BRANCH")
}

case "${1:-}" in
  import)
    shift
    [ -n "${1:-}" ] || die "usage: dev/kit.sh import <source> [<path>...]"
    KIT_SOURCE="$1"; shift
    cmd_capture "$@"
    ;;
  capture) shift; cmd_capture "$@" ;;
  pull)    [ -n "${2:-}" ] || die "usage: dev/kit.sh pull <target>"; cmd_pull "$2" ;;
  list)    cmd_list ;;
  never)   kit_never_paths "$KIT_BRANCH" ;;
  owned)   kit_paths "$KIT_BRANCH" ;;
  carried) kit_paths "$KIT_BRANCH" --no-seed ;;
  "")      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)       die "unknown command '$1' (import|capture|pull|list)" ;;
esac
