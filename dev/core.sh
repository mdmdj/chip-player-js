#!/usr/bin/env bash
#
# DEV-ONLY: choose which chip-core a worktree uses -- by which SOURCES it was built
# from. A core is a build of the engine sources, and those differ per branch, so
# the choice is per worktree and it is deliberate:
#
#   * a feature that extends unmerged engine work (the sub-tune / Repeat One loop
#     API, say) needs a core built from THAT branch, or the player's calls have no
#     exports behind them;
#   * a fresh feature is better served by a core built from master, so it behaves
#     like upstream rather than picking up unmerged engine behaviour.
#
#   dev/core.sh list                      # which worktrees have a core, and what it was built from
#   dev/core.sh use [<ref>] [<worktree>]  # copy in that core (default: this tree's HEAD; a ref or a commit)
#   dev/core.sh steal <from> [<worktree>] # same, naming a worktree/target instead of a ref
#   dev/core.sh build [<worktree>]        # build one FROM THAT worktree's sources
#
# `use`/`steal` only copy `src/chip-core.{js,wasm,buildinfo.json}` -- they never
# build -- and they record the source in the copied build-info, so a later reader
# (or agent) can see which sources the core in front of them came from. If no
# worktree has a core from <ref>, it fails and lists what does exist, so the caller
# can fall back knowingly instead of silently getting the wrong core.
#
# `bringup` sets its own policy: CORE_REF (default master), so a fresh feature
# behaves like upstream while a feature extending unmerged engine work names that
# branch.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

ARTIFACTS='src/chip-core.js src/chip-core.wasm src/chip-core.wasm.buildinfo.json'
# `use` with no argument means "the core for the sources this tree has".
DEFAULT_REF="${CORE_REF:-HEAD}"
die() { echo "core: $*" >&2; exit 1; }

worktrees() { git -C "$ROOT" worktree list --porcelain | awk '$1 == "worktree" { print $2 }'; }
branch_of() { git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(detached)'; }
has_core() { [ -f "$1/src/chip-core.wasm" ]; }

# A worktree's ref matches if its branch name is <ref> or its HEAD equals <ref>.
wt_matches() { # wt ref
  local wb wh r
  wb="$(branch_of "$1")"; wh="$(git -C "$1" rev-parse HEAD 2>/dev/null || true)"
  r="$(git -C "$ROOT" rev-parse --verify -q "$2^{commit}" 2>/dev/null || true)"
  [ "$wb" = "$2" ] || { [ -n "$r" ] && [ "$wh" = "$r" ]; }
}

resolve_target() { # [<arg>] -> worktree
  local a="${1:-}" wt
  [ -n "$a" ] || { overlay_resolve "" 2>/dev/null || true; a="${OV_OVERLAY:-}"; }
  [ -n "$a" ] || die "cannot tell which worktree; pass one"
  [ -d "$a" ] && { echo "$a"; return; }
  wt="$(overlay_wt "$a")"
  if [ -z "$wt" ]; then overlay_resolve "$a" 2>/dev/null || true; wt="${OV_OVERLAY_WT:-}"; fi
  [ -n "$wt" ] || die "no worktree for '$a'"
  echo "$wt"
}

cmd_list() {
  printf '%-58s %-30s %-18s %s\n' WORKTREE BRANCH CORE 'BUILT FROM'
  local wt
  while IFS= read -r wt; do
    printf '%-58s %-30s %-18s %s\n' "$wt" "$(branch_of "$wt")" \
      "$(has_core "$wt" && echo 'src/chip-core.wasm' || echo -)" \
      "$(has_core "$wt" && core_origin "$wt" || echo -)"
  done < <(worktrees)
  echo
  echo "a core is a build of the ENGINE SOURCES. 'BUILT FROM' is what the core records"
  echo "about where it came from; pick the one whose sources match your branch."
}

copy_from() { # src-wt dst-wt -> copies the artifacts and RECORDS where they came from
  local src="$1" dst="$2" f
  for f in $ARTIFACTS; do
    [ -f "$src/$f" ] || continue
    mkdir -p "$dst/$(dirname "$f")"
    cp -f "$src/$f" "$dst/$f"
  done
  # Record the source in the core's own build-info, so the state is discoverable
  # later: "which core is this, and what was it built from" is the question an agent
  # (or you, next week) asks, and a branch name alone would not answer it for a core
  # built from another branch's sources.
  local ref commit
  ref="$(branch_of "$src")"
  commit="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [ -f "$dst/src/chip-core.wasm.buildinfo.json" ]; then
    node -e '
      const fs = require("fs");
      const [file, from, ref, commit] = process.argv.slice(1);
      let j = {};
      try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
      j.coreSource = { copiedFrom: from, ref, commit, copiedAt: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
    ' "$dst/src/chip-core.wasm.buildinfo.json" "$src" "$ref" "$commit" 2>/dev/null || true
  fi
  echo "core: $dst now uses the core from $src (branch $ref $commit)"
}

# What a worktree's core says it was built from (recorded by copy_from) or that it
# was built in place.
core_origin() { # wt
  local f="$1/src/chip-core.wasm.buildinfo.json"
  [ -f "$f" ] || { echo '-'; return; }
  node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(j.coreSource ? `${j.coreSource.ref}@${j.coreSource.commit}` : "built here");
    } catch (e) { process.stdout.write("built here"); }
  ' "$f" 2>/dev/null || echo built here
}

cmd_use() { # [<ref>] [<worktree>]
  local ref="${1:-}" dst; dst="$(resolve_target "${2:-}")"
  # Default: the ref this tree's sources are at -- a branch name, or a commit sha
  # (the same either way: wt_matches resolves the ref to a commit).
  if [ -z "$ref" ]; then
    ref="$(git -C "$dst" rev-parse -q --verify HEAD 2>/dev/null || true)"
    [ -n "$ref" ] || ref="$DEFAULT_REF"
  fi

  local wt found=""
  while IFS= read -r wt; do
    [ "$wt" = "$dst" ] && continue
    if has_core "$wt" && wt_matches "$wt" "$ref"; then found="$wt"; break; fi
  done < <(worktrees)

  if [ -z "$found" ]; then
    # It may already have what it needs: say so instead of failing.
    if has_core "$dst"; then
      echo "core: $dst already has a core (built from $(core_origin "$dst")); nothing to copy"
      return 0
    fi
    local have=""
    while IFS= read -r wt; do has_core "$wt" && have="$have $(branch_of "$wt")"; done < <(worktrees)
    die "no worktree has a core built from '$ref'.
       Cores that exist are on:${have:- none}
       Build one with: dev/core.sh build <worktree on $ref>"
  fi
  copy_from "$found" "$dst"
}

cmd_steal() { cmd_use "$1" "$2"; }

# Copy a core from a named WORKTREE (a path), recording where it came from. This is
# what bringup's fallback uses, so a copied core is never recorded as "built here".
cmd_from() { # <src-worktree> [<dst-worktree>]
  local src="${1:-}" dst; [ -n "$src" ] || die "usage: dev/core.sh from <src-worktree> [<dst>]"
  [ -d "$src" ] || die "no such worktree: $src"
  has_core "$src" || die "$src has no core to copy"
  dst="$(resolve_target "${2:-}")"
  [ "$src" != "$dst" ] || { echo "core: $dst is that worktree"; return 0; }
  copy_from "$src" "$dst"
}

cmd_build() {
  local wt; wt="$(resolve_target "${1:-}")"
  echo "core: building in $wt from its own sources ($(branch_of "$wt"))"
  ( cd "$wt" && node scripts/build-chip-core.js )
}

case "${1:-}" in
  list)  cmd_list ;;
  use)   shift; cmd_use "${1:-}" "${2:-}" ;;
  steal) shift; cmd_steal "${1:-}" "${2:-}" ;;
  from)  shift; cmd_from "${1:-}" "${2:-}" ;;
  build) shift; cmd_build "${1:-}" ;;
  "")    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)     die "unknown command '$1' (list|use|steal|build)" ;;
esac
