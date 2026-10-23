#!/usr/bin/env bash
#
# DEV-ONLY: the shared target registry -- who is working where, on which ports.
#
# Every worktree of this checkout has its own copy of dev/, so dev/overlay.conf
# (a worktree file) cannot be a registry: a target registered in one worktree is
# invisible from another, which is exactly how `dev/overlay.sh <t> dev` failed
# from the main checkout after a bring-up elsewhere. The registry therefore lives
# in the repository's COMMON git dir (`.git/dev-targets`), which every worktree
# shares, and `dev/overlaylib.sh` reads it alongside the local manifest.
#
# A row is one manifest line, so discovery and port claiming are one act:
#
#   name  feature-branch  overlay-branch  wds  api  [base]
#
# The target name must appear in BOTH branches (the slug rule). A row whose
# "feature" is really the BASE that the work extends is how a visualizer promote
# landed on the shared sub-tunes branch: `bringup <name> <base>` registered the
# base as the promote target. The base is the optional last field, for information
# only -- nothing resolves through it.
#
# Port policy (the rule):
#   * 3000 / 8080 are reserved for the long-lived target (dev/overlay-subtunes).
#   * pool: WDS 3300+i, API 8300+i for i in 0..99 (`WDS_BASE`/`API_BASE`/`POOL`).
#   * a pair is taken if the registry names it OR a socket listens on it.
#
# Usage:
#   dev/registry.sh claim <name> [<feature> [<overlay> [<base>]]] [--allow-mismatch]
#   dev/registry.sh port  <name>                           # prints "wds api"
#   dev/registry.sh list                                   # the registry + what is live
#   dev/registry.sh release <name>
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

WDS_BASE="${WDS_BASE:-3300}"
API_BASE="${API_BASE:-8300}"
POOL="${POOL:-100}"
# Reserved for the long-lived target; never allocated.
RESERVED_WDS="${RESERVED_WDS:-3000}"
RESERVED_API="${RESERVED_API:-8080}"

common="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$common" in /*) ;; *) common="$ROOT/$common" ;; esac
# OVERLAY_REGISTRY overrides the location (the same name overlaylib.sh reads, so
# the test and the resolver agree on one file).
REG="${OVERLAY_REGISTRY:-${REGISTRY_FILE:-$common/dev-targets}}"

die() { echo "registry: $*" >&2; exit 1; }
rows() { [ -f "$REG" ] && grep -vE '^[[:space:]]*(#|$)' "$REG" || true; }

# Serialize claims: two agents starting at once must not pick the same pair.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$REG.lock"
  flock -x 9
fi

wds_taken() { rows | awk -v w="$1" '$4 == w { f = 1 } END { exit !f }'; }
port_live() { ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]"; }
get_row() { rows | awk -v n="$1" '$1 == n { print; exit }'; }

# Replace (or append) a target's row. Used to reconcile a target whose feature or
# overlay branch is being corrected.
registry_put() { # name feature overlay wds api [base]
  touch "$REG"
  awk -v n="$1" '$1 != n' "$REG" > "$REG.tmp"
  mv "$REG.tmp" "$REG"
  printf '%s %s %s %s %s %s\n' "$1" "$2" "$3" "$4" "$5" "${6:--}" >> "$REG"
}

# The target's own name belongs in both branches it names: `visualizer` ->
# feature/visualizer + dev/overlay-visualizer, and `subtunes` ->
# feature/subtunes-as-first-class + dev/overlay-subtunes. A pair that fails this is
# almost always a BASE (the branch the work sits on) registered as the target.
slug_matches() { # name feature overlay
  case "$3" in *"$1"*) ;; *) return 1 ;; esac
  case "$2" in *"$1"*) ;; *) return 1 ;; esac
}

cmd_claim() {
  local name="" feature="" overlay="" base="" allow=0
  local -a pos=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-mismatch) allow=1 ;;
      *) pos+=("$1") ;;
    esac
    shift
  done
  name="${pos[0]:-}"; feature="${pos[1]:-}"; overlay="${pos[2]:-}"; base="${pos[3]:-}"
  [ -n "$name" ] || die "usage: registry.sh claim <name> [<feature> [<overlay> [<base>]]] [--allow-mismatch]"

  local row; row="$(get_row "$name")"
  local have_f="" have_o="" have_w="" have_a="" have_b="-"
  if [ -n "$row" ]; then
    # A re-run must be able to CORRECT a target: bringup called again with a
    # different feature branch has to reconcile, not silently keep the old pair.
    # Only fields the caller actually named are reconciled -- `claim <name>` alone
    # must not reset an existing target to the derived defaults.
    read -r _ have_f have_o have_w have_a have_b <<< "$row"
    have_b="${have_b:--}"
  fi

  feature="${feature:-${have_f:-feature/$name}}"
  overlay="${overlay:-${have_o:-dev/overlay-$name}}"
  base="${base:-$have_b}"

  if ! slug_matches "$name" "$feature" "$overlay"; then
    if [ "$allow" = 1 ]; then
      echo "registry: MISMATCH ACCEPTED for '$name': feature=$feature overlay=$overlay (--allow-mismatch)" >&2
    else
      die "target '$name' does not match its branches:
       feature=$feature
       overlay=$overlay
     the name '$name' should appear in both. If '$feature' is the BASE the work sits
     on rather than the branch it promotes to, registering it as the target would put
     this feature's commits on that branch -- bringup takes the base positionally and
     always targets feature/<name>. Deliberate shared target: pass --allow-mismatch."
    fi
  fi

  [ "$feature" != "$overlay" ] || die "feature and overlay cannot both be $feature"

  if [ -n "$row" ]; then
    if [ "$feature $overlay $base" != "$have_f $have_o $have_b" ]; then
      registry_put "$name" "$feature" "$overlay" "$have_w" "$have_a" "$base"
      printf '%s %s %s %s %s %s\n' "$name" "$feature" "$overlay" "$have_w" "$have_a" "$base"
      return 0
    fi
    printf '%s\n' "$row"
    return 0
  fi

  local i p q wds="" api=""
  for ((i = 0; i < POOL; i++)); do
    p=$((WDS_BASE + i)); q=$((API_BASE + i))
    wds_taken "$p" && continue
    port_live "$p" && continue
    port_live "$q" && continue
    [ "$p" = "$RESERVED_WDS" ] && continue
    [ "$q" = "$RESERVED_API" ] && continue
    wds="$p"; api="$q"; break
  done
  [ -n "$wds" ] || die "no free port pair in ${WDS_BASE}-$((WDS_BASE+POOL-1)); release one with 'registry.sh release <name>'"

  printf '%s %s %s %s %s %s\n' "$name" "$feature" "$overlay" "$wds" "$api" "$base" >> "$REG"
  printf '%s %s %s %s %s %s\n' "$name" "$feature" "$overlay" "$wds" "$api" "$base"
}

cmd_port() {
  local row; row="$(get_row "${1:-}")"
  [ -n "$row" ] || die "'${1:-}' is not registered"
  set -- $row; echo "$4 $5"
}

cmd_list() {
  printf '%-14s %-38s %-22s %-6s %-6s %s\n' NAME FEATURE OVERLAY WDS API LIVE
  rows | while read -r n f o w a; do
    live=""
    port_live "$w" && live="wds"
    port_live "$a" && live="${live:+$live,}api"
    printf '%-14s %-38s %-22s %-6s %-6s %s\n' "$n" "$f" "$o" "$w" "$a" "${live:--}"
  done
  echo
  echo "registry: ${REG#"$ROOT"/} (shared by every worktree)"
  echo "policy:   $RESERVED_WDS/$RESERVED_API reserved; pool WDS ${WDS_BASE}-$((WDS_BASE+POOL-1)), API ${API_BASE}-$((API_BASE+POOL-1))"
}

cmd_release() {
  local name="${1:-}"; [ -n "$name" ] || die "usage: registry.sh release <name>"
  [ -f "$REG" ] || return 0
  local n f o w a b
  while read -r n f o w a b; do
    case "$n" in ''|'#'*) continue ;; esac
    [ "$n" = "$name" ] || printf '%s %s %s %s %s %s\n' "$n" "$f" "$o" "$w" "$a" "${b:--}"
  done < "$REG" > "$REG.tmp"
  mv "$REG.tmp" "$REG"
  echo "registry: released $name"
}

case "${1:-}" in
  claim)   shift; cmd_claim "$@" ;;
  port)    shift; cmd_port "$@" ;;
  list)    cmd_list ;;
  release) shift; cmd_release "$@" ;;
  "")      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)       die "unknown command '$1' (claim|port|list|release)" ;;
esac
