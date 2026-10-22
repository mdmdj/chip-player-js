#!/usr/bin/env bash
# DEV-ONLY: shared planning logic for the promote pair. Sourced, not run.
#
# Sets FEATURE, FEATURE_WT and the `plan` array (files to lift), prints the
# plan, and dies on anything that would make the plan untrustworthy. Callers:
# dev/promote.sh (plan only) and dev/promote-apply.sh (the only writer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Which feature branch / overlay pair this run is for. The pair comes from
# dev/overlay.conf (or PROMOTE_TARGET/PROMOTE_OVERLAY), never from HEAD, so one
# checkout can drive any target. An optional first argument names it.
# shellcheck source=dev/overlaylib.sh
source "$ROOT/dev/overlaylib.sh"
overlay_resolve "${1:-}"
FEATURE="$OV_FEATURE"
OVERLAY_BRANCH="$OV_OVERLAY"
PATHS_FILE="dev/promote-paths.txt"

# Sentinel pair marking dev-only additive regions. Stripped on promotion.
BEGIN='DEV-BEGIN'
END='DEV-END'

die() { echo "promote: $*" >&2; exit 1; }

# 1. Clean worktree? (so the plan matches exactly what you reviewed). Both the
# overlay and the feature branch are usually checked out in their own worktree
# (both open at once), so operate on the overlay's rather than failing on a busy
# branch.
#
# Two kinds of dirt are invisible to a plan and so are not blockers: UNTRACKED
# files (a dev/features note; the plan diffs COMMITTED trees) and the two applied
# dev patches, which live as uncommitted edits in server/index.js and
# src/components/UserProvider.js by design. Excluding the patch paths means a
# plan works on a live tree with the patches applied -- the case where reverting
# them by hand used to be the only way to dry-run. Any feature work in those two
# files must still be committed first: they are path-listed/hand-carried, so the
# plan cannot see uncommitted hunks there anyway.
overlay_require_worktrees
cd "$OV_OVERLAY_WT"
if [ -n "$(git status --porcelain -uno -- . \
        ':(exclude)server/index.js' ':(exclude)src/components/UserProvider.js')" ]; then
  die "$OVERLAY_BRANCH worktree has uncommitted changes. Commit or stash, then re-run so the plan matches what you reviewed."
fi

git rev-parse --verify -q "$FEATURE" >/dev/null || die "branch $FEATURE not found"
FEATURE_WT="$OV_FEATURE_WT"

# 2. Candidate files: differ from feature, minus the overlay-only areas.
mapfile -t OVERLAY < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$PATHS_FILE")
pathspec_exclusions=()
for p in "${OVERLAY[@]}"; do pathspec_exclusions+=(":(exclude)$p"); done
mapfile -t CANDIDATES < <(git diff --name-only "$FEATURE...$OVERLAY_BRANCH" -- . "${pathspec_exclusions[@]}" 2>/dev/null | sort -u)

# A sentinel only counts when it is the first WORD on the line, behind nothing
# but whitespace and comment punctuation. Matching the bare substring meant a
# line that merely mentioned "DEV-BEGIN" in prose turned on skipping and
# silently swallowed every line after it. The balance check caught the usual
# case (an odd number of mentions), but a stray mention that happened to
# balance stripped the wrong span and committed truncated code.
#
# "first word" rather than an enumeration of comment styles, because the styles
# are not enumerable in practice: Settings.js wraps a region in a JSX comment
# (`{/* DEV-BEGIN ... */}`), which no list of // # -- * would have matched.
# Anything non-alphanumeric before the sentinel is comment punctuation; a
# letter means prose, and prose is not a marker.
SENTINEL_RE='^[^A-Za-z0-9_]*(DEV-BEGIN|DEV-END)([[:space:]]|$)'

# Strip DEV-BEGIN..DEV-END regions (inclusive) from stdin.
strip_regions() {
  awk -v b="$BEGIN" -v e="$END" -v re="$SENTINEL_RE" '
    $0 ~ re {
      if (match($0, b)) { skip=1; next }
      if (match($0, e)) { skip=0; next }
    }
    skip==0 { print }
  '
}

# After stripping, the result must still parse / compile. A region that removes
# a brace or a paren produces a file that is wrong but still commits; the only
# cheap guard is to ask the language. Anything we cannot check is reported
# rather than assumed fine.
#
# JS goes through node --check, with @babel/core's parser (jsx plugin) as the
# fallback, because node --check rejects JSX outright and several src/ files use
# it.
#
# C/C++ is COMPILED (-fsyntax-only). A DEV region in C is normally a whole
# function, which is brace-BALANCED but changes the open-brace *count* when
# removed. Counting braces therefore rejected exactly the normal shape, while a
# region that really broke the file (it removed a semicolon, say) left the count
# untouched and slipped through. The compiler can tell the two apart; a count
# cannot.
# JSON and CSS are parsed, not guessed: JSON.parse (node itself) and postcss (a
# declared dependency of the CRA toolchain, so it is already in node_modules). A
# feature that adds a dependency or a stylesheet touches package.json, the
# lockfile and *.css, and those used to read as "no checker" -- which blocked a
# legitimate plan. postcss' parse is brace-aware, which is the damage stripping
# does; if it is not installed, CSS is still refused rather than accepted
# unvalidated, the same rule as every other language.
# Parse a .js file that may contain JSX, which node --check rejects outright.
parses_as_jsx() {
  node -e '
    const fs = require("fs");
    require("@babel/core").parseSync(fs.readFileSync(process.argv[1], "utf8"), {
      filename: process.argv[1], configFile: false, babelrc: false,
      parserOpts: { plugins: ["jsx"] },
    });
  ' "$1" >/dev/null 2>&1
}

# A C/C++ front end for this extension, or non-zero when none is installed. cc
# first, matching dev/mdx-native's native build (whose emscripten.h stub
# satisfies mdxmini's unconditional include); emcc is the fallback, since it
# supplies <emscripten.h> itself.
c_compiler() { # ext
  local c
  case "$1" in
    c++|cc|cpp|cxx|hpp|hh|hxx)
      for c in c++ g++ clang++ em++; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }; done ;;
    *)
      for c in cc gcc clang emcc; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }; done ;;
  esac
  return 1
}

# Compile the stripped text to a syntax check. The temp file keeps the source's
# basename (so the compiler reports the real name and picks the right front end
# from the extension), and -I its original directory resolves quoted includes.
check_compiles() { # file stripped
  local file="$1" stripped="$2" cc
  cc="$(c_compiler "${file##*.}")" || {
    echo "promote: no C/C++ compiler found to validate $file" >&2
    return 1
  }
  local -a inc=(-I "$(dirname "$file")")
  # mdxmini includes <emscripten.h> unconditionally; the native stub here
  # satisfies a plain cc. emcc brings its own, but the extra -I is harmless.
  if [ -d dev/mdx-native ]; then inc+=(-I dev/mdx-native); fi
  if ! "$cc" -fsyntax-only -Wno-unknown-pragmas "${inc[@]}" "$stripped" 2>"$TMPDIR_P/cc.err"; then
    echo "promote: $file does not compile after stripping DEV regions" >&2
    head -5 "$TMPDIR_P/cc.err" >&2
    return 1
  fi
}

check_json() { # file stripped
  local file="$1" stripped="$2"
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
      "$stripped" 2>"$TMPDIR_P/json.err"; then
    echo "promote: $file is not valid JSON after stripping DEV regions" >&2
    head -3 "$TMPDIR_P/json.err" >&2
    return 1
  fi
}

check_css() { # file stripped
  local file="$1" stripped="$2"
  if ! node -e 'require.resolve("postcss")' >/dev/null 2>&1; then
    echo "promote: no CSS parser (postcss) installed; refusing to promote $file unvalidated" >&2
    return 1
  fi
  if ! node -e '
      const fs = require("fs");
      require("postcss").parse(fs.readFileSync(process.argv[1], "utf8"), { from: undefined });
    ' "$stripped" 2>"$TMPDIR_P/css.err"; then
    echo "promote: $file does not parse as CSS after stripping DEV regions" >&2
    head -3 "$TMPDIR_P/css.err" >&2
    return 1
  fi
}

check_syntax() {
  local file="$1" stripped="$2"
  case "$file" in
    *.js|*.cjs|*.mjs)
      # node --check can't parse JSX, which several src/ files use, so fall back
      # to @babel/core's parser (a declared dependency) with the jsx plugin. A
      # file that fails both is genuinely broken.
      if ! node --check "$stripped" >/dev/null 2>&1 && ! parses_as_jsx "$stripped"; then
        echo "promote: $file does not parse after stripping DEV regions" >&2
        node --check "$stripped" 2>&1 | head -5 >&2
        return 1
      fi
      ;;
    *.c|*.cc|*.cpp|*.cxx|*.h|*.hpp|*.hh|*.hxx)
      check_compiles "$file" "$stripped" || return 1
      ;;
    *.json)
      check_json "$file" "$stripped" || return 1
      ;;
    *.css)
      check_css "$file" "$stripped" || return 1
      ;;
    *)
      # No compiler for this language means we cannot tell whether stripping
      # broke the file, and a silent accept could commit the break. Refuse and
      # say why rather than fall back to a check we know is unsound.
      echo "promote: no syntax check for $file; refusing to promote it unvalidated" >&2
      return 1
      ;;
  esac
}

plan=()
unbalanced=()
unsound=()
# One temp dir: the stripped file keeps the source basename so the right front
# end (and a real name in compiler messages) is used, and cc.err holds the last
# compiler output.
TMPDIR_P="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_P"' EXIT
for f in "${CANDIDATES[@]}"; do
  [ -e "$f" ] || continue
  # Balanced sentinel check, using the same anchoring as the strip itself --
  # counting raw substring hits here flagged prose as an unbalanced region.
  nb="$(git show "$OVERLAY_BRANCH:$f" | awk -v re="$SENTINEL_RE" -v s="$BEGIN" \
        '$0 ~ re && $0 ~ s { c++ } END { print c+0 }')"
  ne="$(git show "$OVERLAY_BRANCH:$f" | awk -v re="$SENTINEL_RE" -v s="$END" \
        '$0 ~ re && $0 ~ s { c++ } END { print c+0 }')"
  if [ "$nb" != "$ne" ]; then
    unbalanced+=("$f")
    continue
  fi
  # Promote if stripping regions leaves a difference from the feature branch.
  if git show "$OVERLAY_BRANCH:$f" | strip_regions | diff -q - <(git show "$FEATURE:$f" 2>/dev/null) >/dev/null 2>&1; then
    continue  # nothing but dev regions differ
  fi
  git show "$OVERLAY_BRANCH:$f" | strip_regions > "$TMPDIR_P/$(basename "$f")"
  if ! check_syntax "$f" "$TMPDIR_P/$(basename "$f")"; then
    unsound+=("$f")
    continue
  fi
  plan+=("$f")
done

echo "promote: $FEATURE <- $OVERLAY_BRANCH ($OV_NAME)"
echo
if [ ${#plan[@]} -eq 0 ]; then
  echo "Nothing to promote (feature branch is up to date)."
else
  echo "Will promote ${#plan[@]} file(s) (DEV-BEGIN..DEV-END regions stripped):"
  printf '  %s\n' "${plan[@]}"
fi
if [ ${#unbalanced[@]} -gt 0 ]; then
  echo
  echo "ERROR (unbalanced $BEGIN/$END sentinels):"
  printf '  %s\n' "${unbalanced[@]}"
  die "fix the sentinel regions before promoting"
fi
if [ ${#unsound[@]} -gt 0 ]; then
  echo
  echo "ERROR (stripping DEV regions does not produce a valid file):"
  printf '  %s\n' "${unsound[@]}"
  die "a dev region breaks the file when stripped; promoting it would commit broken code"
fi