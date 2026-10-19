#!/usr/bin/env bash
# DEV-ONLY: run the registered test harnesses. Not part of the PR.
#
# Driven entirely by dev/tests.manifest -- nothing is hard-coded here. That file
# states the rule: tests are SOURCE-COUPLED, so a harness belongs to the branch
# whose code it tests, and the kit ships only the bare infrastructure. A feature
# test runs iff every marker file of its group exists in this tree; otherwise it is
# SKIPPED with the marker it wanted, not failed.
#
#   VERBOSE=1 ./dev/run-tests.sh     # show every harness's output, not just failures
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
MANIFEST="$DIR/tests.manifest"
cd "$ROOT"

[ -f "$MANIFEST" ] || { echo "run-tests: no $MANIFEST" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

declare -A GROUP=()
pass=0; fail=0; skip=0; failed=()

group_present() { # name -> 0 when every marker of the group exists here
  local m
  for m in ${GROUP[$1]:-}; do [ -e "$m" ] || return 1; done
  return 0
}

run_one() { # kind group path
  local kind="$1" grp="$2" path="$3" runner=node out
  case "$path" in *.sh) runner=bash ;; esac
  if [ ! -f "$path" ]; then
    skip=$((skip + 1)); printf 'skip   %s (not in this branch)\n' "$path"; return 0
  fi
  if [ "$kind" = feature ] && ! group_present "$grp"; then
    skip=$((skip + 1))
    printf 'skip   %s (feature %s is not in this tree: %s)\n' "$path" "$grp" "${GROUP[$grp]}"
    return 0
  fi
  out="$TMP/$(printf '%s' "$path" | tr '/' '_').log"
  if $runner "$path" >"$out" 2>&1; then
    pass=$((pass + 1)); printf 'ok     %s\n' "$path"
    [ "${VERBOSE:-0}" = 1 ] && sed 's/^/       /' "$out"
  else
    fail=$((fail + 1)); printf 'FAIL   %s\n' "$path"
    tail -6 "$out" | sed 's/^/       /'
    failed+=("$path")
  fi
}

while read -r a b c d; do
  case "$a" in
    group) GROUP["$b"]="${c:-} ${d:-}" ;;
    test)  run_one "$b" "$c" "$d" ;;
  esac
done < <(grep -vE '^[[:space:]]*(#|$)' "$MANIFEST")

# A data-dependent step rather than a harness: the SEO suite needs upstream's own
# test plus 574 fetched fixtures, so it reports itself as skipped when they are not
# indexed instead of failing every run.
if node "$DIR/fetch-seo-fixtures.mjs" --check >/dev/null 2>&1; then
  if node "$ROOT/scripts/test-seo.js" >"$TMP/seo.log" 2>&1; then
    pass=$((pass + 1)); printf 'ok     scripts/test-seo.js\n'
  else
    fail=$((fail + 1)); printf 'FAIL   scripts/test-seo.js\n'; tail -6 "$TMP/seo.log" | sed 's/^/       /'
    failed+=("scripts/test-seo.js")
  fi
else
  skip=$((skip + 1))
  printf 'skip   scripts/test-seo.js (catalog fixtures not fetched: node dev/fetch-seo-fixtures.mjs)\n'
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "run-tests: $pass passed, $skip skipped, 0 failed"
else
  echo "run-tests: $pass passed, $skip skipped, $fail FAILED: ${failed[*]}"
fi
[ "$fail" -eq 0 ]
