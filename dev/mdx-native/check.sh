#!/bin/sh
# Golden loop regions for the catalog MDX fixtures. catalog/ is gitignored, so
# each check skips when its file is absent (the repo convention). Guards the
# mdxmini region fix (2026-10-15): the verified-good file must not move, and the
# files whose band was wrong must stay corrected.
set -e
cd "$(dirname "$0")"
# Always (re)build: make is a no-op when current. Never trust a pre-existing
# binary -- a stale one reads as a different engine, and a leftover pre-fix
# build once looked exactly like a flaky suite (2 FAILs, then 0 for days).
make -s region
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
#
# `per` is a literal per fixture: how many per-track repeats one joint section
# is worth. It used to be read from the engine (a getter since removed), but it
# is a fixed property of each fixture file, so it belongs in the table.
check_sections() { # file  per  note
  f="$catalog/$1"
  if [ ! -f "$f" ]; then printf 'skip  %s (%s)\n' "$1" "$3"; return; fi
  per="$2"
  line=$(printf '%s\n' "$f" | ./region)
  intro=$(printf '%s' "$line" | cut -f2)
  loop=$(printf '%s' "$line" | cut -f3)
  # A position a quarter into the section after the first, so the boundary the
  # limit names is a whole section away rather than the tick under the playhead.
  play=$((intro + loop + loop / 4))
  row=$(printf '%s\n' "$f" | ./region --play "$play")
  limit=$(printf '%s' "$row" | cut -f5)
  end=$(printf '%s' "$row" | cut -f9)
  onset=$(printf '%s' "$row" | cut -f10)
  tol=$((loop / 100)); [ "$tol" -lt 500 ] && tol=500
  d=$((onset - end)); [ "$d" -lt 0 ] && d=$((0 - d))
  if [ "$per" -gt 1 ] && [ "$onset" -ge 0 ] && [ "$d" -le "$tol" ]; then
    printf 'ok    %s per=%s limit=%s fade=%s vs section_end=%s  %s\n' \
      "$1" "$per" "$limit" "$onset" "$end" "$3"
  else
    printf 'FAIL  %s per=%s limit=%s fade=%s vs section_end=%s (allow %s)  %s\n' \
      "$1" "$per" "$limit" "$onset" "$end" "$tol" "$3"
    status=1
  fi
}

check_sections DES_80.MDX   2  "one section = 2 repeats"
check_sections ran321.MDX   3  "one section = 3 repeats"
check_sections NOS123.MDX   5  "one section = 5 repeats"
check_sections VAL5.MDX     6  "one section = 6 repeats"
check_sections 27_CLEAR.MDX 8  "one section = 8 repeats"
check_sections MTS2_32.MDX  16 "one section = 16 repeats"

# mdx_get_length must report the length the engine actually plays under the same
# finite limit. The length parse and playback gate the fade on the same quantity
# (mdxmml_ym2151.c's loop_gate_value, joint sections), so the two must agree. The
# length parse resolves loops_per_section *after* its pass, so for per > 1 it used
# to gate on the raw per-track minimum -- a section's worth early -- and report a
# figure short of the section end: MDXPlayer armed its end detector there and the
# song stopped mid-fade. len is whole seconds, so allow 1 s (plus a tick) of
# truncation; the pre-fix shortfall is whole sections (>> 1 s).
check_length() { # file  limit  note
  f="$catalog/$1"
  if [ ! -f "$f" ]; then printf 'skip  %s (%s)\n' "$1" "$3"; return; fi
  row=$(printf '%s\n' "$f" | ./region --length-check "$2")
  len=$(printf '%s' "$row" | cut -f2)
  ended=$(printf '%s' "$row" | cut -f3)
  d=$(printf '%s' "$row" | cut -f4)
  if [ "$d" -ge 0 ] && [ "$d" -lt 1100 ]; then
    printf 'ok    %s limit=%s len=%s ended=%s delta=%s  %s\n' \
      "$1" "$2" "$len" "$ended" "$d" "$3"
  else
    printf 'FAIL  %s limit=%s len=%s ended=%s delta=%s  %s\n' \
      "$1" "$2" "$len" "$ended" "$d" "$3"
    status=1
  fi
}

check_length DES_80.MDX  2 "per=2: the length must reach the section-grid fade"
check_length MTS2_32.MDX 2 "per=16: the shortfall was a whole section (16 repeats)"
check_length G2MST6.MDX  2 "per=1 must not move"

exit $status
