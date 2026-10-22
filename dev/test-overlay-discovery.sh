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

pass=0; fail=0; skipped=0
ok()   { echo "ok   - $1"; pass=$((pass+1)); }
bad()  { echo "FAIL - $1"; fail=$((fail+1)); }
skip() { echo "skip - $1"; skipped=$((skipped+1)); }
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

# 5. ...and carries them CURRENT. "Everything it carries" is the carried pathspecs
#    minus the never-carried paths (the seeded AGENTS.md, per-feature notes, and the
#    feature tests): those are deliberately absent, so they cannot read as drift.
KLIST="$(./dev/kit.sh list)"
mapfile -t KPATHS < <(printf '%s\n' "$KLIST" | awk '/^carries/{f=1;next} f && !/^  /{exit} f{sub(/^ +/,"");print}')
mapfile -t NEVER < <(./dev/kit.sh never)
if [ ${#KPATHS[@]} -gt 0 ]; then ok "kit path list is readable (${#KPATHS[@]} paths)"
else bad "kit path list is readable"; fi
EXCL=()
for n in "${NEVER[@]}"; do [ -n "$n" ] && EXCL+=(":(exclude)$n"); done
SOURCE_OVERLAY="$(awk 'NF >= 3 && $1 !~ /^#/ { print $3; exit }' dev/overlay.conf 2>/dev/null || true)"
[ -n "$SOURCE_OVERLAY" ] || SOURCE_OVERLAY=dev/overlay-subtunes
DRIFT="$(git diff --name-only dev/kit "$SOURCE_OVERLAY" -- "${KPATHS[@]}" "${EXCL[@]}" 2>/dev/null || true)"
if [ -z "$DRIFT" ]; then
  ok "the kit matches $SOURCE_OVERLAY for everything it carries"
else
  # A hard failure belongs where capture is the only right next step: the source
  # overlay. Every OTHER tree is "stale" by definition until it refreshes, and a
  # red suite there reads as a broken tree rather than "pull the kit" -- so it is
  # a reported skip with the exact command.
  if [ "$(git rev-parse --abbrev-ref HEAD)" = "$SOURCE_OVERLAY" ]; then
    bad "the kit is stale for: $(tr '\n' ' ' <<< "$DRIFT") -- run ./dev/kit.sh capture"
  else
    skip "this tree's kit is behind (run ./dev/overlay.sh <target> refresh): $(tr '\n' ' ' <<< "$DRIFT")"
  fi
fi

# 5b. A de-listing needs its region to exist. src/config/index.js was de-listed with
#     a comment claiming its dev block was a DEV region; it was not -- the block
#     REPLACES the feature branch's localhost block, and the plan carried the LAN
#     host / port override toward the PR. Pinned so a tidier-looking comment cannot
#     repeat it (and the entry is what protects overlays that predate any fix).
if grep -qx 'src/config/index.js' dev/promote-paths.txt; then
  ok "src/config/index.js stays path-listed (its dev block replaces; it cannot strip)"
else
  bad "src/config/index.js is not path-listed -- its dev block replaces the feature branch's localhost block, so it cannot be a DEV region (see promote-paths.txt)"
fi

# 6. AGENTS.md is a SEED: the template a new worktree gets, never captured up, and
#    never overwriting an overlay's own notes.
SEEDED="$(printf '%s\n' "$KLIST" | awk '/^seeded/{f=1;next} f && !/^  /{exit} f{print}')"
expect_contains "the kit reports AGENTS.md as seeded" "$SEEDED" "AGENTS.md"
expect_contains "the kit reports dev/features as never captured" "$KLIST" "dev/features"
TEMPLATE="$(git show dev/kit:AGENTS.md)"
if [ "$TEMPLATE" != "$(git show dev/overlay-subtunes:AGENTS.md)" ]; then
  ok "the template differs from dev/overlay-subtunes's notes (seeded, not synced)"
else
  bad "the template differs from dev/overlay-subtunes's notes (a sync would clobber history)"
fi
if [ "$(wc -l <<< "$TEMPLATE")" -ge 80 ]; then ok "the template is a real playbook"
else bad "the template is a real playbook ($(wc -l <<< "$TEMPLATE") lines)"; fi

# 7. The template must be ready for a NEW feature: none of the last one's
#    feature-specific material (its concepts, branch, PR plan, hand-offs). Format
#    names and in-repo engine names are repo context, not baggage.
for baggage in subtune SongRef 'Repeat One' feature/subtunes pr-body UPSTREAM_PR_PLAN '## Current state' 'Handoff (2026'; do
  case "$TEMPLATE" in
    *"$baggage"*) bad "the template still carries '$baggage' baggage" ;;
    *) ok "the template has no '$baggage' baggage" ;;
  esac
done
expect_contains "the template says where a feature's notes go" "$TEMPLATE" "dev/features/"
if git cat-file -e dev/kit:dev/features 2>/dev/null; then
  bad "the kit must not carry dev/features (per-feature notes)"
else ok "the kit carries no dev/features"; fi
# The build script's export list is coupled to the engine sources a tree actually
# has, and the kit carries one script for every base -- so the script must adapt
# (drop an export the sources do not define) rather than be swapped per branch.
if git show dev/kit:scripts/build-chip-core.js 2>/dev/null | grep -q 'OPTIONAL_EXPORTS'; then
  ok "the kit's build script adapts its exports to the tree's sources"
else
  bad "the kit's build script adapts its exports to the tree's sources"
fi
AGENTS_KIT="$(git show dev/kit:AGENTS.md)"
case "$AGENTS_KIT" in
  *"sibling"*' '*"in-repo"*) ok "the template explains the two engine sources" ;;
  *) bad "the template explains the two engine sources" ;;
esac

# 8. Two dev-environment invariants that cost real debugging (2026-10-18):
#    * a worktree on another filesystem gets a SYMLINKED node_modules, and
#      `.gitignore`'s `node_modules/` (trailing slash) matches only a directory --
#      so the symlink showed as untracked forever and blocked promote/rebase;
#    * the applied dev patches (server/index.js, UserProvider.js) are uncommitted
#      modifications, so a rebase used to refuse every live tree.
if grep -qx 'node_modules' .gitignore; then
  ok ".gitignore ignores a symlinked node_modules (no trailing slash)"
else
  bad ".gitignore ignores a symlinked node_modules (found: $(grep -n 'node_modules' .gitignore | head -1))"
fi
REBASE_SRC="$(< dev/rebase.sh)"
LIB_SRC="$(< dev/overlaylib.sh)"
for needle in overlay_revert_patches overlay_apply_patches PATCHES_REVERTED; do
  case "$REBASE_SRC" in *"$needle"*) ok "rebase.sh handles the in-place patches ($needle)" ;;
  *) bad "rebase.sh handles the in-place patches ($needle)" ;; esac
done
for needle in overlay_revert_patches overlay_apply_patches; do
  case "$LIB_SRC" in *"$needle()"*) ok "overlaylib defines $needle" ;;
  *) bad "overlaylib defines $needle" ;; esac
done

# 9. The engine inventory: every library's SOURCE is stated, and an in-tree copy
#    of a sibling's name (a decoy) is flagged rather than mistaken for the build's.
ENG="$(./dev/engines.sh check)"
for e in game-music-emu libxmp libvgm FluidLite libgsf libsidplayfp; do
  case "$ENG" in *"$e"*sibling*) ok "engines: $e is a sibling" ;;
  *) bad "engines: $e is a sibling" ;; esac
done
for e in libADLMIDI psflib lazyusf2 mdxmini farbrausch-v2m; do
  case "$ENG" in *"$e"*in-repo*) ok "engines: $e is in-repo" ;;
  *) bad "engines: $e is in-repo" ;; esac
done
mkdir -p FluidLite
DECOY="$(./dev/engines.sh check || true)"
rmdir FluidLite 2>/dev/null || true
expect_contains "engines: an in-tree copy of a sibling is flagged as a decoy" "$DECOY" "DECOY"

# 10. The artifact policies: a cheap sample that actually resolves, and a core
#     whose SOURCE branch is knowable.
SAMPLE_LIST="$(./dev/sample.sh list)"
case "$SAMPLE_LIST" in
  *"-- none of:"*) bad "every sample entry resolves from some source" ;;
  *) ok "every sample entry resolves from some source" ;;
esac
mapfile -t SAMPLE_PATHS < <(grep -vE '^[[:space:]]*(#|$)' dev/sample.manifest)
if [ ${#SAMPLE_PATHS[@]} -ge 12 ]; then ok "the sample spans engines (${#SAMPLE_PATHS[@]} entries)"
else bad "the sample spans engines (${#SAMPLE_PATHS[@]} entries, want >= 12)"; fi
for fx in TECHTRIS.MOD 'Green Hill Zone' G2MST6.MDX; do
  case "$SAMPLE_LIST" in *"$fx"*) ok "the sample includes the $fx harness fixture" ;;
  *) bad "the sample includes the $fx harness fixture" ;; esac
done
CORE_LIST="$(./dev/core.sh list)"
case "$CORE_LIST" in *"src/chip-core.wasm"*) ok "core.sh reports which worktrees have a core" ;;
*) bad "core.sh reports which worktrees have a core" ;; esac

# 11. The test registry: tests are source-coupled, so the kit ships the runner and
#     the registry and the INFRASTRUCTURE tests, never a branch's feature tests.
MANIFEST_KIT="$(git show dev/kit:dev/tests.manifest 2>/dev/null || cat dev/tests.manifest)"
REGISTERED="$(printf '%s\n' "$MANIFEST_KIT" | awk '$1 == "test" { print $4 }')"
UNREGISTERED=""
for f in dev/test-*.js dev/test-*.sh dev/check-promotable-refs.js dev/record/scenarios.check.mjs; do
  grep -qxF -- "$f" <<< "$REGISTERED" || UNREGISTERED="$UNREGISTERED $f"
done
if [ -z "$UNREGISTERED" ]; then ok "every harness is registered in tests.manifest"
else bad "unregistered harness(es):$UNREGISTERED"; fi
expect_contains "the kit carries the test registry" "$(git cat-file -e dev/kit:dev/tests.manifest 2>/dev/null && echo yes)" "yes"
expect_contains "the kit carries the runner"        "$(git cat-file -e dev/kit:dev/run-tests.sh 2>/dev/null && echo yes)" "yes"
for f in dev/test-server-seams.js dev/test-client-seams.js dev/test-overlay-tooling.sh dev/test-devtools.js; do
  if git cat-file -e "dev/kit:$f" 2>/dev/null; then ok "kit carries infra test $f"
  else bad "kit carries infra test $f"; fi
done
for f in dev/test-parsers.js dev/test-end-detector.js dev/test-midi-loops.js dev/test-songrefs.js; do
  if git cat-file -e "dev/kit:$f" 2>/dev/null; then bad "kit must not carry feature test $f"
  else ok "kit does not carry feature test $f"; fi
done
# The registry must state the feature markers, or a master-based tree would run
# them and fail instead of skipping.
case "$MANIFEST_KIT" in *"group subtunes"*) ok "the registry declares the feature markers" ;;
*) bad "the registry declares the feature markers" ;; esac

echo
echo "overlay-discovery: $pass passed, $skipped skipped, $fail failed"
[ "$fail" -eq 0 ]
