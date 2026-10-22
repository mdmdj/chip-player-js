#!/usr/bin/env bash
# DEV-ONLY: prove that dev/promote-plan.sh validates a stripped non-JS file by
# compiling it, not by counting braces.
#
# A DEV region in a C file is normally a whole function: brace-BALANCED, but
# removing it changes the open-brace *count*. The old check compared that count,
# so it rejected the normal shape as unsound -- while a region that really broke
# the file (it removed a semicolon) still balanced the count and slipped
# through. The cases are fixture'd here:
#
#   alpha.c  a balanced whole-function region; the stripped file still compiles
#            -> must be ACCEPTED (the old count check rejected it)
#   beta.c   a balanced region whose stripped form does NOT compile
#            -> must be REFUSED, with the compiler's message (the old count
#               check accepted it)
#   gamma.js a JSX-bearing file with a DEV region -> must still validate through
#            the JS path (node --check with the @babel/core fallback), so the
#            C fix does not clobber the JS/JSX branch
#
# The real planner runs over a throwaway repo. PROMOTE_PLAN_SH points at a
# different planner (used to reproduce the old failure); it defaults to this
# checkout's dev/promote-plan.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_SH="${PROMOTE_PLAN_SH:-$ROOT/dev/promote-plan.sh}"
FEATURE=feature

pass=0; fail=0
ok()  { echo "ok   - $1"; pass=$((pass+1)); }
bad() { echo "FAIL - $1"; fail=$((fail+1)); }
expect_contains() { # label haystack needle
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac
}
expect_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
# The list under a header line, up to the next blank line.
section() { # text header
  printf '%s\n' "$1" | awk -v s="$2" 'index($0,s){f=1;next} f&&/^$/{exit} f{print}'
}
run_plan() { # sets OUT, ERR, RC
  # NODE_PATH: the throwaway repo has no node_modules, but the JS path needs
  # @babel/core for JSX (resolved from this checkout).
  RC=0; OUT="$(NODE_PATH="$ROOT/node_modules" PROMOTE_TARGET=$FEATURE \
    bash dev/promote-plan.sh 2>"$ERRDIR/stderr")" || RC=$?
  ERR="$(cat "$ERRDIR/stderr")"
}

WORK="$(mktemp -d)"
WT="$(mktemp -d)"; rmdir "$WT"
ERRDIR="$(mktemp -d)"
cleanup() {
  git -C "$WORK" worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WORK" "$WT" "$ERRDIR"
}
trap cleanup EXIT

cd "$WORK"
git init -q -b overlay
git config user.email dev@example.com
git config user.name dev
mkdir -p dev
cp "$PLAN_SH" dev/promote-plan.sh
# The planner resolves its target through dev/overlaylib.sh (sourced). Copy it
# next to the planner so the real path is exercised here too.
[ -f "$(dirname "$PLAN_SH")/overlaylib.sh" ] \
  && cp "$(dirname "$PLAN_SH")/overlaylib.sh" dev/overlaylib.sh || true
: > dev/promote-paths.txt

# Feature (prod) versions.
cat > alpha.c <<'EOF'
int alpha_value(void)
{
  return 0;
}
EOF
cat > beta.c <<'EOF'
int beta_value(void)
{
  return 0;
}
EOF
# JSX-bearing, so node --check alone fails and the @babel/core fallback carries
# it -- the same shape as src/components/UserProvider.js.
cat > gamma.js <<'EOF'
export const Gamma = () => <span>hi</span>;
EOF
git add -A && git commit -qm base
git branch "$FEATURE"
git worktree add -q "$WT" "$FEATURE"

# --- accept: whole-function region, brace-balanced, still compiles ---------
# The feature change (return 1) makes stripping leave a real diff, so the file
# is actually checked rather than skipped as "nothing but dev regions".
cat > alpha.c <<'EOF'
int alpha_value(void)
{
  return 1; /* feature change */
}

/* DEV-BEGIN (stripped for promotion; dev-only helper) */
static int alpha_dev_helper(void)
{
  return 2;
}
/* DEV-END */
EOF
# The JSX region is stripped too; `hello` vs `hi` is the feature change.
cat > gamma.js <<'EOF'
export const Gamma = () => <span>hello</span>;

// DEV-BEGIN (stripped for promotion; dev-only probe)
export const GammaDevProbe = () => <b>{1}</b>;
// DEV-END
EOF
git commit -qam "alpha/gamma: feature change + dev regions"

run_plan
PLAN_LIST="$(section "$OUT" 'Will promote')"
expect_eq       "accept: planner exits 0" "$RC" "0"
expect_contains "accept: balanced C region is planned" "$PLAN_LIST" "  alpha.c"
expect_contains "accept: JSX file still validates (planned)" "$PLAN_LIST" "  gamma.js"
expect_contains "accept: reports two files to promote" "$OUT" "Will promote 2 file(s)"
case "$OUT" in *"ERROR"*) bad "accept: no error expected" ;; *) ok "accept: no error expected" ;; esac

# --- reject: balanced region whose stripped form does not compile ----------
# Stripping drops the semicolon after `int v = 1`, so the leftover is a syntax
# error -- but the open-brace count is unchanged, which is exactly what the old
# check could not tell. delta.txt also rides along: a language we have no check
# for must be refused, not silently accepted.
cat > beta.c <<'EOF'
int beta_value(void)
{
  int v = 1
  /* DEV-BEGIN (stripped for promotion; drops the semicolon) */
  ;
  /* DEV-END */
  return v; /* feature change */
}
EOF
cat > delta.txt <<'EOF'
data = 1; /* feature change */

/* DEV-BEGIN (stripped for promotion; no compiler for .txt) */
scratch = 2;
/* DEV-END */
EOF
git add -A && git commit -qm "beta/delta: feature changes + regions that cannot be validated"

run_plan
PLAN_LIST="$(section "$OUT" 'Will promote')"
UNSOUND_LIST="$(section "$OUT" 'ERROR (stripping')"
expect_eq       "reject: planner exits non-zero" "$RC" "1"
expect_contains "reject: broken C region is in the unsound list" "$UNSOUND_LIST" "  beta.c"
expect_contains "reject: unknown language is in the unsound list" "$UNSOUND_LIST" "  delta.txt"
case "$PLAN_LIST" in *"beta.c"*) bad "reject: beta.c must not be planned" ;; *) ok "reject: beta.c must not be planned" ;; esac
expect_contains "reject: refusal names the compile failure" "$ERR" "does not compile after stripping DEV regions"
expect_contains "reject: carries the compiler message" "$ERR" "expected"
expect_contains "reject: unknown language refused, not silently accepted" "$ERR" "no syntax check for delta.txt"
expect_contains "reject: reports the unsound list" "$OUT" "ERROR (stripping DEV regions does not produce a valid file)"

# --- accept: JSON and CSS, the shapes a feature dependency/stylesheet adds ----
# These used to hit "no syntax check", which refused the plan and blocked a
# feature that legitimately adds a dependency or a stylesheet. JSON.parse and
# postcss are the tools the app already ships; postcss' parse is brace-aware,
# which is the damage stripping does. data.json carries no region on purpose:
# a dependency file is not a dev-only file, and the checker must still run.
rm -f delta.txt
cat > beta.c <<'EOF'
int beta_value(void)
{
  return 0;
}
EOF
cat > data.json <<'EOF'
{ "feature": true }
EOF
cat > style.css <<'EOF'
.slider { --track: 1px; }
.slider:hover { color: red; }

/* DEV-BEGIN (stripped for promotion; dev-only style) */
.slider-dev { color: blue; }
/* DEV-END */
EOF
git add -A && git commit -qm "json/css: valid shapes"

run_plan
PLAN_LIST="$(section "$OUT" 'Will promote')"
expect_eq       "json/css: planner exits 0" "$RC" "0"
expect_contains "json/css: valid JSON is planned" "$PLAN_LIST" "  data.json"
expect_contains "json/css: valid CSS is planned" "$PLAN_LIST" "  style.css"

# --- gate: the applied dev patches do not block a plan -----------------------
# server/index.js and src/components/UserProvider.js are dirty by design (the
# applied dev patches), and untracked files are invisible to a plan that diffs
# committed trees. Both must be tolerated; real uncommitted work must still be
# refused.
mkdir -p server src/components
printf '// prod form\n' > server/index.js
printf 'export const U = 1;\n' > src/components/UserProvider.js
git add -A && git commit -qm "patch targets in prod form"
printf '// dev patch\n' >> server/index.js
printf '// dev patch\n' >> src/components/UserProvider.js
printf 'a feature note\n' > dev/features-note.md
run_plan
expect_eq       "gate: applied dev patches and an untracked note do not block the plan" "$RC" "0"
printf '\n.unrelated { color: red; }\n' >> style.css
run_plan
expect_eq       "gate: real uncommitted work still refuses the plan" "$RC" "1"
expect_contains "gate: refusal says uncommitted changes" "$ERR" "uncommitted changes"
git checkout -- style.css

# --- reject: broken JSON and CSS, each named with its reason -----------------
cat > data.json <<'EOF'
{ "feature": true,
EOF
cat > style.css <<'EOF'
.slider { color: red;

/* DEV-BEGIN (stripped for promotion; dev-only style) */
.slider-dev { color: blue; }
/* DEV-END */
EOF
git commit -qam "json/css: unbalanced"

run_plan
UNSOUND_LIST="$(section "$OUT" 'ERROR (stripping')"
expect_eq       "json/css reject: planner exits non-zero" "$RC" "1"
expect_contains "json/css reject: broken JSON is unsound" "$UNSOUND_LIST" "  data.json"
expect_contains "json/css reject: broken CSS is unsound" "$UNSOUND_LIST" "  style.css"
expect_contains "json/css reject: names the JSON failure" "$ERR" "is not valid JSON"
expect_contains "json/css reject: names the CSS failure" "$ERR" "does not parse as CSS"

echo
echo "promote-syntax: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
