#!/usr/bin/env bash
#
# DEV-ONLY: keep the overlay-only *whole-file* content in one place (`dev/kit`)
# and sync it onto any overlay, instead of hand-copying it per target.
#
# Why a kit: an overlay carries two kinds of thing -- files that are ours and
# only ours (dev/**, the engine build, the vendored-tree deletion, the two
# engine-config files), and DEV regions inside files the feature branch owns.
# The first kind is identical for every target, so copying it onto each overlay
# by hand is N copies of the same material. The kit holds it once; `pull` writes
# it into a target overlay, which commits it. Nothing here rewrites history, so
# it composes with the existing rebase/promote cycle unchanged.
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
#     TEMPLATE: `pull` delivers it only to a target that has none, and `capture`
#     never takes an overlay's copy up. So an overlay keeps its own notes, and a
#     fresh worktree gets the clean template. Improve the template by editing it
#     on dev/kit, or publish one file explicitly:
#         ./dev/kit.sh capture <src> AGENTS.md
#   * KIT_NEVER -- paths the kit must not carry: per-feature notes
#     (dev/features), and files whose content must match the branch's own sources
#     (scripts/build-chip-core.js, whose export list is coupled to the engine
#     sources). Upstream's script is sibling-path based, so the layout the kit
#     supplies (dev/engines.sh) is all a master-based worktree needs.
#
# Usage:
#   ./dev/kit.sh capture [<path>...]   # build/update dev/kit; paths publish just those
#   ./dev/kit.sh pull <target>         # write dev/kit onto the target's overlay
#   ./dev/kit.sh list                  # what the kit carries, seeds, never carries
#
# capture publishes from KIT_SOURCE, or from the canonical overlay (KIT_CANONICAL,
# default dev/overlay) -- NOT from whatever branch you are on, so standing in a
# feature overlay cannot publish that feature's kit-path edits as the template.
# Naming paths (AGENTS.md) overrides the seed rule and publishes those alone.
# pull writes onto a target's overlay worktree and commits only what it changed.
# KIT_BASE is the branch a fresh dev/kit is based on (default master). Nothing is
# pushed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

KIT_BRANCH="${KIT_BRANCH:-dev/kit}"
KIT_BASE="${KIT_BASE:-master}"
# Paths the kit must NEVER carry, even though they are overlay-only (never
# promoted). Two different reasons, one list:
#   * dev/features     -- per-feature notes; they must not become kit baggage.
#   * scripts/build-chip-core.js -- the build script's SOURCE LIST and export list
#     are coupled to the engine sources. A worktree's sources come from its own
#     branch (or its base), so its script must too: carrying ours into a
#     master-based worktree exported seven loop-getter symbols that upstream's
#     mdxmini/wrapper do not define, and the link failed. Upstream's script is
#     already sibling-path based (`../libvgm/build/bin/...`), so the layout the kit
#     provides (dev/engines.sh) is all it needs -- and then script and sources
#     match by construction, on every branch.
KIT_NEVER="${KIT_NEVER:-dev/features scripts/build-chip-core.js}"
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

# The overlay to capture from. Defaults to the CANONICAL overlay, not whatever
# branch you happen to be on: capture publishes a template, and a feature overlay's
# kit-path edits (a rebuild script, a build flag) are that feature's, not
# everyone's -- publishing them by standing in the wrong directory is exactly how
# one feature's baggage becomes the next feature's starting point. Publish from
# another overlay on purpose with KIT_SOURCE=<overlay>.
KIT_CANONICAL="${KIT_CANONICAL:-dev/overlay}"
kit_source() {
  if [ -n "${KIT_SOURCE:-}" ]; then echo "$KIT_SOURCE"; return; fi
  echo "$KIT_CANONICAL"
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
    elif git -C "$dest" cat-file -e "HEAD:$bare" 2>/dev/null; then
      git -C "$dest" rm -r -q --ignore-unmatch -- "$bare"
    fi
    printf '%s\n' "$bare"
  done
}

cmd_capture() { # [<path>...] -- naming paths publishes just those (from the source)
  local src wt; src="$(kit_source)"
  git -C "$ROOT" rev-parse --verify -q "$src" >/dev/null || die "source overlay $src not found"
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
        && die "'$p' is a branch, not a path. The source is $KIT_CANONICAL; use KIT_SOURCE=$p $0 capture <path>"
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
  for nev in $KIT_NEVER; do
    if [ -e "$wt/$nev" ]; then
      git -C "$wt" rm -r -q -f --ignore-unmatch -- "$nev"
    fi
  done
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
  kit_exists || die "$KIT_BRANCH does not exist; build it with 'kit.sh capture' first"

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

  # Refuse to clobber pending work in the paths the kit owns.
  if [ -n "$(git -C "$wt" status --porcelain -- "${paths[@]}")" ]; then
    die "$ov has uncommitted changes in kit paths; commit or stash first"
  fi

  populate_from "$KIT_BRANCH" "$wt" "${paths[@]}" >/dev/null
  # populate_from already staged (checkout updates the index; rm stages the
  # deletion), so there is nothing to add -- and `git add -A -- <gone path>`
  # would fail on the deleted vendored tree.
  if [ -n "$(git -C "$wt" status --porcelain -- "${paths[@]}")" ]; then
    git -C "$wt" commit -q -m "kit: sync overlay-only content from $KIT_BRANCH" -- "${paths[@]}"
    echo "kit: $ov updated from $KIT_BRANCH ($(git -C "$wt" rev-parse --short HEAD))"
  else
    echo "kit: $ov already current with $KIT_BRANCH"
  fi
}

cmd_list() {
  local src; src="$(kit_source)"
  echo "kit:    $KIT_BRANCH $(kit_exists && git -C "$ROOT" rev-parse --short "$KIT_BRANCH" || echo '(absent)')"
  echo "source: $src"
  echo "carries (dev/promote-paths.txt minus $KIT_EXCLUDE and the seeds):"
  kit_paths "$(kit_exists && echo "$KIT_BRANCH" || echo "$src")" --no-seed | sed 's/^/  /'
  echo "seeded (delivered only to a target that has none, never captured up):"
  kit_paths "$(kit_exists && echo "$KIT_BRANCH" || echo "$src")" --seed | sed 's/^/  /'
  echo "never captured (not template material):"
  local nev; for nev in $KIT_NEVER; do echo "  $nev"; done
}

case "${1:-}" in
  capture) shift; cmd_capture "$@" ;;
  pull)    [ -n "${2:-}" ] || die "usage: dev/kit.sh pull <target>"; cmd_pull "$2" ;;
  list)    cmd_list ;;
  "")      sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)       die "unknown command '$1' (capture|pull|list)" ;;
esac
