#!/usr/bin/env bash
# DEV-ONLY: prove the shared target registry allocates ports predictably and that
# overlaylib discovers rows from it.
#
# This is the "discover and claim independently" contract: two agents must get
# different pairs without being told, the pool must be lowest-free and idempotent,
# and a released pair must become available again. Uses a throwaway registry and a
# private pool range so a live dev server cannot make the test flaky.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
WORK="$(mktemp -d /tmp/opencode/regtest-XXXXXX)"
export OVERLAY_REGISTRY="$WORK/dev-targets"
export WDS_BASE=3900 API_BASE=8900 POOL=4

pass=0; fail=0
ok()   { echo "ok   - $1"; pass=$((pass+1)); }
bad()  { echo "FAIL - $1"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac; }

reg="$DIR/registry.sh"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

R1="$("$reg" claim alpha)"             # -> "alpha feature/alpha dev/overlay-alpha 3900 8900"
R1b="$("$reg" claim alpha)"
expect_eq "claim is idempotent" "$R1" "$R1b"
# ...but naming a different TARGET branch must CORRECT the row: re-running bringup
# with a new target is how a target gets re-pointed, and silently keeping the old one
# would mis-target the promote. The new branch must still carry the slug (see the
# guard below); a base is no longer expressible here.
R1c="$("$reg" claim alpha feature/alpha-v2)"
expect_eq "re-claiming with a new target branch reconciles the row" "$(awk '{print $2}' <<< "$R1c")" "feature/alpha-v2"
expect_eq "a bare re-claim keeps the corrected row" "$("$reg" claim alpha)" "$R1c"
expect_eq "first claim takes the pool base" "$(awk '{print $4, $5}' <<< "$R1")" "3900 8900"
expect_eq "claim derives feature/overlay names" "$(awk '{print $2, $3}' <<< "$R1")" "feature/alpha dev/overlay-alpha"

R2="$("$reg" claim beta)"
expect_eq "second claim takes the next pair, not the same one" "$(awk '{print $4, $5}' <<< "$R2")" "3901 8901"
expect_eq "port subcommand reads the row back" "$("$reg" port beta)" "3901 8901"
expect_eq "explicit names are honoured" "$("$reg" claim gamma feature/gamma-g dev/overlay-gamma-g | awk '{print $2, $3}')" "feature/gamma-g dev/overlay-gamma-g"

# The slug rule: a target whose name is in neither branch is almost always a BASE
# registered as the target (the incident that motivated it). Refused, unless said
# explicitly -- and then loudly. Its own registry file: the pool below is 4 ports.
export OVERLAY_REGISTRY="$WORK/guard-targets"
M_RC=0
M_OUT="$("$reg" claim visualizer feature/subtunes-as-first-class dev/overlay-visualizer 2>&1)" || M_RC=$?
expect_eq       "a base-as-target pair is refused" "$M_RC" "1"
expect_contains "the refusal names the mismatch" "$M_OUT" "does not match its branches"
expect_contains "an explicit shared target is allowed, loudly" \
  "$("$reg" claim visualizer feature/subtunes-as-first-class dev/overlay-visualizer --allow-mismatch 2>&1)" "MISMATCH ACCEPTED"
expect_eq       "the base is recorded as the last field" \
  "$("$reg" claim theta feature/theta dev/overlay-theta feature/subtunes-as-first-class | awk '{print $6}')" \
  "feature/subtunes-as-first-class"
expect_eq       "a slug in both branches passes (subtunes)" \
  "$("$reg" claim subtunes feature/subtunes-as-first-class dev/overlay-subtunes | awk '{print $1, $2}')" \
  "subtunes feature/subtunes-as-first-class"
export OVERLAY_REGISTRY="$WORK/dev-targets"   # back to the port-policy registry

LIST="$("$reg" list)"
expect_contains "list shows the claims" "$LIST" "alpha"
expect_contains "list states the policy" "$LIST" "policy:"

# Reserved ports are never allocated (the pool cannot reach them by construction,
# and an explicit claim of them is not how the pool works).
case "$R1$R2" in *"3000"*|*"8080"*) bad "reserved ports must not be allocated" ;; *) ok "reserved ports are not allocated" ;; esac

# Release frees the pair for reuse (lowest-free).
"$reg" release alpha >/dev/null
R4="$("$reg" claim delta)"
expect_eq "a released pair is reused (lowest-free)" "$(awk '{print $4, $5}' <<< "$R4")" "3900 8900"

# The pool is bounded: exhaust it and the next claim must fail loudly.
"$reg" claim e4 >/dev/null 2>&1 || true
OUT="$(WDS_BASE=3900 API_BASE=8900 POOL=2 "$reg" claim zz 2>&1 || true)"
expect_contains "an exhausted pool fails loudly" "$OUT" "no free port pair"

# overlaylib reads the registry alongside the local manifest.
rows="$(OVERLAY_REGISTRY="$OVERLAY_REGISTRY" bash -c '
  cd "'"$ROOT"'"
  source dev/overlaylib.sh
  overlay_rows | awk "{print \$1}" | tr "\n" " "
')"
expect_contains "overlaylib discovers registry rows" "$rows" "beta"
expect_contains "overlaylib still has the local manifest row" "$rows" "subtunes"

echo
echo "overlay-registry: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
