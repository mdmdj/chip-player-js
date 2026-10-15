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
check FACE04.MDX  182452 45613  "two period groups, entering their loops 22.8s apart -- the region starts at the last, not at a crossing minus the joint period (was 159645)"

# Where the engine actually starts its fade, with the section count handed to
# mdx_set_max_loop -- the claim mdxmml_ym2151.c's loop_gate_value exists for.
# Gated on the raw per-track minimum the fade begins early: with one section
# worth `per` repeats of the longest track, a limit in sections turns after that
# many per-track repeats, i.e. about 1/per of the way into the section (measured
# 20-90% short on these files). Reduced to sections per track it turns at the
# boundary. The fade can only begin on a tick and the joint period is measured,
# so allow 1% of the loop (floor 500ms); the pre-fix error is far outside it.
check_sections() { # file  note
  f="$catalog/$1"
  if [ ! -f "$f" ]; then printf 'skip  %s (%s)\n' "$1" "$2"; return; fi
  line=$(printf '%s\n' "$f" | ./region)
  intro=$(printf '%s' "$line" | cut -f2)
  loop=$(printf '%s' "$line" | cut -f3)
  per=$(printf '%s' "$line" | cut -f5)
  # A position a quarter into the section after the first, so the boundary the
  # limit names is a whole section away rather than the tick under the playhead.
  play=$((intro + loop + loop / 4))
  row=$(printf '%s\n' "$f" | ./region --play "$play" --sections)
  limit=$(printf '%s' "$row" | cut -f6)
  end=$(printf '%s' "$row" | cut -f10)
  onset=$(printf '%s' "$row" | cut -f11)
  tol=$((loop / 100)); [ "$tol" -lt 500 ] && tol=500
  d=$((onset - end)); [ "$d" -lt 0 ] && d=$((0 - d))
  if [ "$per" -gt 1 ] && [ "$onset" -ge 0 ] && [ "$d" -le "$tol" ]; then
    printf 'ok    %s per=%s limit=%s fade=%s vs section_end=%s  %s\n' \
      "$1" "$per" "$limit" "$onset" "$end" "$2"
  else
    printf 'FAIL  %s per=%s limit=%s fade=%s vs section_end=%s (allow %s)  %s\n' \
      "$1" "$per" "$limit" "$onset" "$end" "$tol" "$2"
    status=1
  fi
}

check_sections DES_80.MDX   "one section = 2 repeats"
check_sections ran321.MDX   "one section = 3 repeats"
check_sections NOS123.MDX   "one section = 5 repeats"
check_sections VAL5.MDX     "one section = 6 repeats"
check_sections 27_CLEAR.MDX "one section = 8 repeats"
check_sections MTS2_32.MDX  "one section = 16 repeats"

exit $status
