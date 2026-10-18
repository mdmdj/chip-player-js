#!/usr/bin/env bash
# DEV-ONLY: prove a new worktree can discover how to work in it.
#
# The failure this guards is small but expensive: the tooling is only useful if
# someone who just landed in a `dev/kit` worktree can find it. Two things have to
# hold -- the entry points must explain themselves, and the docs that point at
# them (AGENTS.md, dev/README.md) must actually be ON the kit branch, since that
# is what a fresh worktree checks out. Forgetting `dev/kit.sh capture` after
# changing dev/ is how a worktree ends up without the script the docs name.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
cd "$ROOT"

pass=0; fail=0
ok()   { echo "ok   - $1"; pass=$((pass+1)); }
bad()  { echo "FAIL - $1"; fail=$((fail+1)); }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac; }

# 1. Every entry point explains itself when run with no arguments.
for s in overlay.sh kit.sh registry.sh engines.sh; do
  out="$("./dev/$s" 2>&1 || true)"
  case "$out" in
    *"$s"*|*"Usage"*|*"dev/overlay.sh"*) ok "dev/$s prints usage on no args" ;;
    *) bad "dev/$s prints usage on no args (got: $(head -c 60 <<< "$out"))" ;;
  esac
done
# bringup has no sensible bare invocation; it must at least say how to use it.
expect_contains "dev/bringup.sh names its usage" "$("./dev/bringup.sh" 2>&1 || true)" "usage:"

# 2. The front end advertises every command, including the one a new worktree needs.
HELP="$(./dev/overlay.sh help)"
for c in bringup dev list status plan promote refresh rebase push arm new; do
  expect_contains "overlay.sh help lists '$c'" "$HELP" "$c"
done

# 3. The docs an agent reads name the entry points.
AGENTS="$(< AGENTS.md)"
README="$(< dev/README.md)"
expect_contains "AGENTS.md names the bring-up command" "$AGENTS" "bringup"
expect_contains "AGENTS.md names the registry"        "$AGENTS" "dev/registry.sh"
expect_contains "dev/README.md names bring-up"        "$README" "bringup"
expect_contains "dev/README.md states the port policy" "$README" "3300-3399"
# The session-start section is where an agent looks first.
SESSION="$(awk '/^## Session start/{f=1} f&&/^## /&&!/Session start/{exit} f{print}' AGENTS.md)"
expect_contains "session start points at bring-up" "$SESSION" "bringup"

# 4. The kit carries them -- otherwise a fresh worktree has docs naming a script
#    and a branch that do not exist there.
for f in AGENTS.md dev/README.md dev/overlay.sh dev/overlaylib.sh dev/bringup.sh dev/registry.sh dev/engines.sh dev/kit.sh dev/promote.sh dev/promote-plan.sh dev/promote-apply.sh dev/rebase.sh dev/push-overlay.sh dev/promote-paths.txt dev/overlay.conf; do
  if git cat-file -e "dev/kit:$f" 2>/dev/null; then ok "kit carries $f"
  else bad "kit carries $f (run ./dev/kit.sh capture)"; fi
done

# 5. ...and carries them CURRENT: a worktree checks out dev/kit, so a doc or tool
#    changed on dev/overlay but not captured is invisible where it is needed --
#    the exact way the first smoke test's worktree lacked the new bring-up script.
mapfile -t KPATHS < <(./dev/kit.sh list | awk '/^carries/{f=1;next} f && /^  /{sub(/^ +/,"");print}')
if [ ${#KPATHS[@]} -gt 0 ]; then ok "kit path list is readable (${#KPATHS[@]} paths)"
else bad "kit path list is readable"; fi
DRIFT="$(git diff --name-only dev/kit dev/overlay -- "${KPATHS[@]}" 2>/dev/null || true)"
if [ -z "$DRIFT" ]; then
  ok "the kit matches dev/overlay for everything it carries"
else
  bad "the kit is stale for: $(tr '\n' ' ' <<< "$DRIFT") -- run ./dev/kit.sh capture"
fi

echo
echo "overlay-discovery: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
