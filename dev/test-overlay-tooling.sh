#!/usr/bin/env bash
# DEV-ONLY: prove the overlay tooling is target-portable.
#
# Over a throwaway repo: one overlay's overlay-only content is captured into
# dev/kit; a second feature branch gets it by commit (no rebase of the tooling,
# no force-push); the seam file is NOT carried; the vendored-tree deletion
# travels; promote still lifts only the stripped feature work onto that branch
# and leaves the other target alone; and an ambiguous retarget refuses.
#
# It exercises the real scripts (dev/overlaylib.sh, kit.sh, overlay-new.sh,
# overlay.sh, promote*.sh, rebase.sh) over a tiny tree, so a regression in the
# manifest resolution, the kit sync or the promote tail fails here.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/otool-XXXXXX")"
export TMPDIR="$WORK" # keep the kit's temp worktree inside the sandbox
REPO="$WORK/repo"

pass=0; fail=0
ok()   { echo "ok   - $1"; pass=$((pass+1)); }
bad()  { echo "FAIL - $1"; fail=$((fail+1)); }
expect_eq()       { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac; }
expect_not()      { case "$2" in *"$3"*) bad "$1 (unexpected: $3)" ;; *) ok "$1" ;; esac; }

cleanup() {
  git -C "$REPO" worktree list --porcelain 2>/dev/null \
    | awk '$1=="worktree"{print $2}' | tail -n +2 \
    | while read -r w; do git -C "$REPO" worktree remove --force "$w" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$REPO"; cd "$REPO"
git init -q -b master
git config user.email dev@example.com
git config user.name dev

# Base: a feature file, the seam file, and a vendored tree the overlay deletes.
mkdir -p src server libvgm
printf 'export const app = () => 0;\n' > src/app.js
printf '// prod\n' > server/index.js
printf 'int eng(void){return 0;}\n' > libvgm/eng.c
printf 'BASE TEMPLATE\n' > AGENTS.md
printf 'dev/.promote-armed\ndev/.pre-rebase\ndev/.pre-rebase.mb\n' > .gitignore
git add -A && git commit -qm base

# feature/a: real feature work in the feature file and the seam.
git branch feature/a
git worktree add -q "$WORK/feat-a" feature/a
(
  cd "$WORK/feat-a"
  printf 'export const app = () => 1; /* a feature */\n' > src/app.js
  printf '// prod\n// a feature hunk\n' > server/index.js
  git commit -qam "a: feature work"
)

# dev/overlay-a: the overlay -- the dev kit, the vendored deletion, a dev seam.
git branch dev/overlay-a feature/a
git worktree add -q "$WORK/ov-a" dev/overlay-a
mkdir -p "$WORK/ov-a/dev"
for f in overlaylib.sh promote.sh promote-plan.sh promote-apply.sh rebase.sh \
         push-overlay.sh kit.sh overlay-new.sh overlay.sh refresh.sh registry.sh \
         bringup.sh; do
  cp "$SRC/dev/$f" "$WORK/ov-a/dev/$f"
done
chmod +x "$WORK/ov-a/dev/"*.sh
cat > "$WORK/ov-a/dev/promote-paths.txt" <<'EOF'
# overlay-only areas (fixture)
dev/**
AGENTS.md
libvgm/**
server/index.js
EOF
printf 'a  feature/a  dev/overlay-a  3000 8080\n' > "$WORK/ov-a/dev/overlay.conf"
(
  cd "$WORK/ov-a"
  git rm -rq libvgm
  printf '// prod\n// a feature hunk\n// dev seam\n' > server/index.js
  printf 'OVERLAY A NOTES\n' > AGENTS.md
  mkdir -p dev/features
  printf 'feature a notes\n' > dev/features/a.md
  git add -A && git commit -qm "a: dev overlay content"
)

# --- kit: capture the overlay-only content from overlay-a (explicit import) --
KIT_OUT="$(cd "$WORK/ov-a" && KIT_SOURCE=dev/overlay-a bash dev/kit.sh capture)"
expect_contains "kit: capture reports the update" "$KIT_OUT" "dev/kit updated from dev/overlay-a"
NOSRC="$(cd "$WORK/ov-a" && env -u KIT_SOURCE bash dev/kit.sh capture 2>&1 || true)"
expect_contains "kit: capture requires an explicit import source" "$NOSRC" "dev/kit is canonical"
KIT_LIST="$(cd "$WORK/ov-a" && bash dev/kit.sh list)"
expect_contains "kit: carries dev/**"        "$KIT_LIST" "dev/**"
expect_contains "kit: carries the vendored tree" "$KIT_LIST" "libvgm/**"
expect_not      "kit: excludes the seam"     "$KIT_LIST" "  server/index.js"

# --- kit semantics: the template is seeded, feature notes never travel --------
expect_contains "kit: reports AGENTS.md as seeded" "$KIT_LIST" "AGENTS.md"
expect_contains "kit: reports dev/features as never captured" "$KIT_LIST" "dev/features"
KIT_AGENTS="$(git -C "$REPO" show dev/kit:AGENTS.md)"
expect_contains "kit: keeps the base template, not the overlay's notes" "$KIT_AGENTS" "BASE TEMPLATE"
expect_not      "kit: capture did not take the overlay's notes up"     "$KIT_AGENTS" "OVERLAY A NOTES"
if git -C "$REPO" cat-file -e dev/kit:dev/features/a.md 2>/dev/null; then
  bad "kit: feature notes must never be captured"
else ok "kit: feature notes are not captured"; fi
# An explicit path publishes a seed anyway -- that is the deliberate route.
(cd "$WORK/ov-a" && KIT_SOURCE=dev/overlay-a bash dev/kit.sh capture AGENTS.md) >/dev/null
expect_contains "kit: an explicit path publishes a seed" "$(git -C "$REPO" show dev/kit:AGENTS.md)" "OVERLAY A NOTES"
# A branch mistaken for a path is refused, not silently read as one.
REFUSED="$(cd "$WORK/ov-a" && KIT_SOURCE=dev/overlay-a bash dev/kit.sh capture dev/overlay-a AGENTS.md 2>&1 || true)"
expect_contains "kit: a branch passed as a path is refused" "$REFUSED" "is a branch, not a path"

# --- new target: feature/b + the kit, in its own worktrees -------------------
NEW_OUT="$(cd "$WORK/ov-a" && bash dev/overlay-new.sh b feature/b)"
OVB="$WORK/chip-player-js-overlay-b"
FEB="$WORK/chip-player-js-feature-b"
expect_contains "new: reports the overlay branch" "$NEW_OUT" "created dev/overlay-b from feature/b"
[ -d "$OVB" ] && ok "new: overlay worktree exists" || bad "new: overlay worktree exists"
[ -d "$FEB" ] && ok "new: feature worktree exists" || bad "new: feature worktree exists"
[ -f "$OVB/dev/overlaylib.sh" ] && ok "new: kit dev/ content arrived" || bad "new: kit dev/ content arrived"
[ ! -e "$OVB/libvgm" ] && ok "new: vendored-tree deletion travelled" || bad "new: vendored-tree deletion travelled"
expect_not "new: the seam file is not carried" "$(cat "$OVB/server/index.js")" "dev seam"
# A pull must not overwrite a worktree's own notes: feature/b came from master with
# its own AGENTS.md, so the seed leaves it alone.
expect_eq  "pull: a target's own AGENTS.md is not overwritten" "$(cat "$OVB/AGENTS.md")" "BASE TEMPLATE"

# A worktree's own feature notes sit UNTRACKED under dev/** -- a path the kit
# carries -- so counting them as pending work would refuse every kit sync forever.
mkdir -p "$OVB/dev/features" && printf 'b notes\n' > "$OVB/dev/features/b.md"
PULL="$(cd "$OVB" && bash dev/kit.sh pull dev/overlay-b 2>&1 || true)"
expect_contains "kit: an untracked feature note does not block a pull" "$PULL" "already current"
rm -rf "$OVB/dev/features"

# And a SECOND sync must not die on the vendored-tree pathspec: by then those trees
# are gone from both sides, and `git commit -- <pathspec>` is fatal when a pathspec
# matches nothing. (The first sync removes them, so the first sync always worked.)
PULL2="$(cd "$OVB" && bash dev/kit.sh pull dev/overlay-b 2>&1 || true)"
expect_contains "kit: a second sync succeeds (no dangling pathspec)" "$PULL2" "already current"
expect_not      "kit: a second sync does not report a pathspec error" "$PULL2" "pathspec"

# Register target b in the overlay's manifest (as overlay-new tells you to).
# Register target b the way the real flow does: in the SHARED REGISTRY, not in the
# carried manifest -- a kit pull legitimately resets dev/overlay.conf to the kit's
# copy, and the registry is the live source (that is why bringup registers there).
(cd "$OVB" && WDS_BASE=3900 API_BASE=8900 bash dev/registry.sh claim b feature/b dev/overlay-b >/dev/null)

# A fresh overlay has nothing to promote: the kit content is all overlay-only.
FRESH="$(bash "$OVB/dev/promote.sh" b)"
expect_contains "plan: fresh overlay has nothing to promote" "$FRESH" "Nothing to promote"
expect_contains "plan: names the resolved pair" "$FRESH" "feature/b <- dev/overlay-b (b)"

# --- refresh: dry-run first, then the real thing, and it is verified ---------
PRE_HEAD="$(git -C "$OVB" rev-parse HEAD)"
DRY_OUT="$(cd "$OVB" && bash dev/refresh.sh b --dry-run 2>&1 || true)"
expect_contains "refresh: --dry-run reports the kit's state" "$DRY_OUT" "kit is current here"
expect_contains "refresh: --dry-run reports the rebase status" "$DRY_OUT" "rebase:"
expect_eq "refresh: --dry-run changes nothing" "$(git -C "$OVB" rev-parse HEAD)" "$PRE_HEAD"

REF_OUT="$(cd "$OVB" && bash dev/refresh.sh b 2>&1 || true)"
expect_contains "refresh: reports the target ok" "$REF_OUT" "  ok"
expect_contains "refresh: summary counts it" "$REF_OUT" "1 refreshed, 0 skipped, 0 failed"

# ...and `all` reaches every registered target
ALL_OUT="$(cd "$OVB" && bash dev/refresh.sh all --dry-run 2>&1 || true)"
expect_contains "refresh: all covers the registered targets" "$ALL_OUT" "== a =="

# --- b's feature work is promoted, stripped, without touching a --------------
(
  cd "$OVB"
  cat > src/app.js <<'EOF'
export const app = () => 2; /* b feature change */

// DEV-BEGIN (stripped for promotion; dev-only probe)
export const appDev = () => 9;
// DEV-END
EOF
  git commit -qam "b: feature + dev region"
)
PLAN="$(bash "$OVB/dev/promote.sh" b)"
expect_contains "plan: b's stripped work is planned" "$PLAN" "  src/app.js"
expect_not      "plan: nothing else is planned"     "$PLAN" "  dev/overlaylib.sh"

touch "$OVB/dev/.promote-armed"
PROM="$(cd "$OVB" && PROMOTE_SKIP_PUSH=1 bash dev/promote-apply.sh b 2>&1 || true)"
expect_contains "promote: committed on feature/b" "$PROM" "committed on feature/b"
expect_contains "promote: feature change reached feature/b" "$(cat "$FEB/src/app.js")" "b feature change"
expect_not      "promote: DEV region did NOT reach feature/b" "$(cat "$FEB/src/app.js")" "DEV-BEGIN"
[ ! -e "$OVB/dev/.promote-armed" ] && ok "promote: arm key consumed" || bad "promote: arm key consumed"
expect_contains "promote: feature/a is untouched" "$(cat "$WORK/feat-a/src/app.js")" "a feature"

# push-overlay: the two applied dev patches are uncommitted by design, so they must
# not block publishing the committed overlay. The old check refused the whole tree.
git init --bare -q "$WORK/origin.git"
git -C "$OVB" remote add origin "$WORK/origin.git" 2>/dev/null || true
printf '\n// applied dev patch\n' >> "$OVB/server/index.js"
mkdir -p "$OVB/src/components"
printf '// applied dev user patch\n' >> "$OVB/src/components/UserProvider.js"
PUSH_OUT="$(cd "$OVB" && bash dev/push-overlay.sh 2>&1 || true)"
expect_contains "push: applied dev patches do not block publish" "$PUSH_OUT" "push-overlay: dev/overlay-b -> origin"

# --- an ambiguous retarget refuses rather than guessing ---------------------
REF="$(cd "$OVB" && bash dev/promote.sh feature/zzz 2>&1 || true)"
expect_contains "refuse: ambiguous retarget is refused" "$REF" "is the overlay for feature/b"

# --- wrong-target guard: a base is not a target ------------------------------
# `bringup <name> <base>` used to register the BASE as the promote target, and a
# promote then wrote this feature's commits into the shared sub-tunes branch. The
# target's name must appear in both branches; a deliberate shared target is
# explicit and loud.
MIS_RC=0
MIS="$(cd "$OVB" && WDS_BASE=3900 API_BASE=8900 bash dev/registry.sh claim visualizer feature/subtunes-as-first-class dev/overlay-visualizer 2>&1)" || MIS_RC=$?
expect_eq       "guard: a base-as-target claim is refused" "$MIS_RC" "1"
expect_contains "guard: the refusal names both branches" "$MIS" "does not match its branches"
expect_contains "guard: and points at the explicit override" "$MIS" "--allow-mismatch"

OVR="$(cd "$OVB" && WDS_BASE=3900 API_BASE=8900 bash dev/registry.sh claim visualizer feature/subtunes-as-first-class dev/overlay-visualizer --allow-mismatch 2>&1)"
expect_contains "guard: --allow-mismatch registers a shared target, loudly" "$OVR" "MISMATCH ACCEPTED"

OKC_RC=0
OKC="$(cd "$OVB" && WDS_BASE=3900 API_BASE=8900 bash dev/registry.sh claim subtunes feature/subtunes-as-first-class dev/overlay-subtunes 2>&1)" || OKC_RC=$?
expect_eq       "guard: a slug that appears in both branches passes (subtunes)" "$OKC_RC" "0"

# bringup: the positional branch is the BASE; the target is feature/<name>.
# Run it from the main checkout: bringup refuses to create a second pair while
# standing in an overlay, and $REPO is the only non-overlay tree in the fixture.
mkdir -p "$REPO/dev"
cp -a "$WORK/ov-a/dev/." "$REPO/dev/"
git -C "$REPO" checkout -q --detach
BU="$(cd "$REPO" && BRINGUP_STOP_AFTER_REGISTER=1 bash dev/bringup.sh delta --base feature/b 2>&1 || true)"
expect_contains "bringup: creates the target from the base" "$BU" "created feature/delta from feature/b"
expect_contains "bringup: registers feature/delta, not the base" "$BU" "registered delta -> feature/delta / dev/overlay-delta (base feature/b)"
expect_eq       "bringup: the new branch starts at the base" \
                "$(git -C "$REPO" rev-parse feature/delta 2>/dev/null)" "$(git -C "$REPO" rev-parse feature/b)"
expect_eq       "bringup: the row records the base" \
                "$(awk '$1 == "delta" { print $6 }' "$REPO/.git/dev-targets")" "feature/b"

echo
echo "overlay-tooling: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
