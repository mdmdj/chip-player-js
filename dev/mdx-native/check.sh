#!/bin/sh
# Golden loop regions for the catalog MDX fixtures. catalog/ is gitignored, so
# each check skips when its file is absent (the repo convention). Guards the
# mdxmini region fix (2026-10-15): the verified-good file must not move, and the
# files whose band was wrong must stay corrected.
set -e
cd "$(dirname "$0")"
[ -x ./region ] || make region
root=$(cd ../.. && pwd)
catalog="$root/catalog/mdx"

status=0
check() { # file  expected_intro_ms  expected_loop_ms  note
  f="$catalog/$1"
  if [ ! -f "$f" ]; then printf 'skip  %s (%s)\n' "$1" "$4"; return; fi
  got=$(printf '%s\n' "$f" | ./region | cut -f2-3)
  want=$(printf '%s\t%s' "$2" "$3")
  if [ "$got" = "$want" ]; then
    printf 'ok    %s -> [%s]  %s\n' "$1" "$got" "$4"
  else
    printf 'FAIL  %s -> [%s] (want [%s])  %s\n' "$1" "$got" "$want" "$4"
    status=1
  fi
}

check G2MST6.MDX  34603  34603  "verified-good; the fix must not move it"
check DTWNB18.MDX 0      14942  "one-shot held the min; band was [5078, 12403]"
check FACE04.MDX  159645 45613  "2:1 loop periods -> the joint period (was 22806)"

exit $status
