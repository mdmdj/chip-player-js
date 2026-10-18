#!/usr/bin/env bash
#
# DEV-ONLY: give a worktree a catalog -- the cheap canonical sample, or one
# deliberately stolen from another branch. This is the "artifact from another
# worktree" mechanism, for catalogs.
#
#   dev/sample.sh seed  [<worktree>]           # the sample in dev/sample.manifest
#   dev/sample.sh steal <from> [<worktree>]    # that worktree's whole catalog
#   dev/sample.sh list                         # the sample, and where each entry resolves
#
# Per file, cheapest first: **symlink** (no copy at all), then **hardlink** (same
# filesystem only), then **copy**. If the source does not have the file it is
# reported as unavailable -- nothing is downloaded here; the opt-in fetch for the
# full SEO set is `dev/fetch-seo-fixtures.mjs`.
#
# Sources, in order: the main checkout's `catalog/`, then `SAMPLE_FROM` (or the
# `steal` argument). The large hand-curated collections under a branch's catalog
# are never copied automatically -- only the ~16-file sample is -- so a worktree
# that wants one asks for it.
#
# Indexing is the target tree's job (its schema is its own): `seed` runs the
# target's `scripts/build-music.js` unless NO_INDEX=1.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=dev/overlaylib.sh
source "$DIR/overlaylib.sh"

SAMPLE="${SAMPLE_MANIFEST:-$DIR/sample.manifest}"
die() { echo "sample: $*" >&2; exit 1; }

main_wt="$(git -C "$ROOT" worktree list --porcelain | awk '$1 == "worktree" { print $2; exit }')"
[ -n "$main_wt" ] || die "could not find the main worktree"

# The target worktree: an argument, a target name, or this worktree's overlay.
resolve_target() { # [<arg>]
  local a="${1:-}" wt
  [ -n "$a" ] || { overlay_resolve "" 2>/dev/null || true; a="${OV_OVERLAY:-}"; }
  [ -n "$a" ] || die "cannot tell which worktree; pass one"
  if [ -d "$a" ]; then echo "$a"; return; fi
  wt="$(overlay_wt "$a")"; [ -n "$wt" ] || { overlay_resolve "$a" 2>/dev/null || true; wt="$OV_OVERLAY_WT"; }
  [ -n "$wt" ] || die "no worktree for '$a'"
  echo "$wt"
}

# Roots to take files from, best first.
source_roots() { local from="${1:-${SAMPLE_FROM:-}}"; printf '%s\n' "$main_wt"; [ -n "$from" ] && printf '%s\n' "$(resolve_target "$from")"; }

# Put $2 (source abs path) at $3 (dest abs path), cheapest mechanism that works.
place() { # src dest -> prints the mechanism
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if ln -s "$src" "$dst" 2>/dev/null; then echo symlink
  elif cp -l "$src" "$dst" 2>/dev/null; then echo hardlink
  elif cp "$src" "$dst" 2>/dev/null; then echo copy
  else echo failed; fi
}

index_target() { # wt
  local wt="$1"
  [ "${NO_INDEX:-0}" = 1 ] && return 0
  ( cd "$wt" && node scripts/build-music.js ) >"$wt/../.sample-index.log" 2>&1 \
    || { echo "sample: indexing failed; see $(cd "$wt/.." && pwd)/.sample-index.log" >&2; return 1; }
  local n
  n="$( ( cd "$wt" && node -e '
      const db = require("better-sqlite3")("server/catalog.db");
      const t = db.prepare("select name from sqlite_master where type = \u0027table\u0027").all().map(r => r.name);
      const song = t.includes("song") ? "song" : "music";
      console.log(db.prepare("select count(*) c from " + song).get().c);
    ' ) 2>/dev/null || echo '?')"
  echo "sample: indexed ($n songs)"
}

cmd_seed() {
  local wt; wt="$(resolve_target "${1:-}")"
  local -a roots=(); while IFS= read -r r; do roots+=("$r"); done < <(source_roots "")
  local seeded=0 present=0 missing=0 p src dst mech placed
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    dst="$wt/$p"
    if [ -e "$dst" ]; then present=$((present + 1)); continue; fi
    placed=""
    for src in "${roots[@]}"; do
      if [ -f "$src/$p" ]; then placed="$(place "$src/$p" "$dst")"; break; fi
    done
    case "$placed" in
      symlink|hardlink|copy) seeded=$((seeded + 1)); printf '  %-9s %s\n' "$placed" "$p" ;;
      "") echo "  unavailable  $p" >&2; missing=$((missing + 1)) ;;
      *) echo "  FAILED       $p" >&2; missing=$((missing + 1)) ;;
    esac
  done < <(grep -vE '^[[:space:]]*(#|$)' "$SAMPLE")
  echo "sample: ${#roots[@]} source(s); $seeded placed, $present already there, $missing unavailable"
  [ "$missing" -eq 0 ] || echo "sample: run 'node dev/fetch-seo-fixtures.mjs' in the main checkout to have every entry available" >&2
  index_target "$wt"
}

cmd_steal() {
  local from="${1:-}"; [ -n "$from" ] || die "usage: dev/sample.sh steal <from-worktree-or-target> [<worktree>]"
  local wt from_wt; wt="$(resolve_target "${2:-}")"; from_wt="$(resolve_target "$from")"
  [ "$wt" != "$from_wt" ] || die "source and target are the same worktree"
  [ -d "$from_wt/catalog" ] || die "$from_wt has no catalog/"
  local n; n="$(find "$from_wt/catalog" -type f | wc -l)"
  echo "sample: stealing $n file(s) from $from_wt (cheapest mechanism each)"
  local seeded=0 present=0 p dst mech
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    dst="$wt/catalog/$p"
    case "$p" in server/catalog.db|*.db|*.db-wal|*.db-shm) continue ;; esac
    if [ -e "$dst" ]; then present=$((present + 1)); continue; fi
    mech="$(place "$from_wt/catalog/$p" "$dst")"
    [ "$mech" = failed ] && { echo "  FAILED $p" >&2; continue; }
    seeded=$((seeded + 1))
  done < <(cd "$from_wt/catalog" && find . -type f | sed 's|^\./||')
  echo "sample: $seeded placed, $present already there"
  index_target "$wt"
}

cmd_list() {
  local -a roots=(); while IFS= read -r r; do roots+=("$r"); done < <(source_roots "")
  printf '%-58s %s\n' SAMPLE 'RESOLVES FROM'
  local p src where
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    where="-- none of: ${roots[*]}"
    for src in "${roots[@]}"; do [ -f "$src/$p" ] && { where="$src"; break; }; done
    printf '%-58s %s\n' "$p" "$where"
  done < <(grep -vE '^[[:space:]]*(#|$)' "$SAMPLE")
  echo
  echo "manifest: ${SAMPLE#"$ROOT"/} (the cheap sample; large collections are never copied)"
}

case "${1:-}" in
  seed)  shift; cmd_seed "${1:-}" ;;
  steal) shift; cmd_steal "${1:-}" "${2:-}" ;;
  list)  cmd_list ;;
  "")    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)     die "unknown command '$1' (seed|steal|list)" ;;
esac
