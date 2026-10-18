# AGENTS.md — the dev-overlay playbook

This is the shared playbook for working in this repository's **dev overlay**. It is
a **template**: every worktree created from `dev/kit` gets this copy, and nothing
overwrites it — so keep it to what is true for *every* feature.

**Put your feature's own history somewhere else.** Design decisions, measurements,
benchmarks, hand-offs and "what the last session found" belong in
`dev/features/<name>.md`. That file is never captured into the kit (so it cannot
follow the next feature around) and never promoted (it is inside `dev/**`). Notes
from features that came before live on the overlay branch that produced them, not
here. If a lesson is true for every feature, it belongs *here*; if it is the story
of one, it belongs in that feature's note.

## Session start

Begin every session with `nvm use` (`.nvmrc` pins **Node 24.21.0**), then confirm
with `node -v`. The host default `node` is newer and `better-sqlite3` is compiled
per Node ABI, so running `npm`/`node` under the wrong version fails with
`NODE_MODULE_VERSION`. In a **non-interactive shell `nvm` is not on `PATH`**, so
export it directly:

    export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

Also check whether an `npm run dev` is already up before assuming the environment
is wrong — a long-running server may have been started under a different Node.

### If you just landed in a new worktree

A worktree created from `dev/kit` has the tooling but is not yet runnable. One
command fixes that — do **not** `npm install` by hand and do **not** pick ports:

    ./dev/overlay.sh <name> bringup      # ~20s: branches, worktrees, ports, engines, deps, core
    ./dev/overlay.sh <name> dev          # run it (background it, log to your own file)
    curl -s -o /dev/null -w '%{http_code}\n' localhost:<api>/

`./dev/overlay.sh` with no arguments lists every command. `dev/registry.sh list`
shows every target and its ports; **3000/8080 are reserved**, targets draw from
WDS 3300-3399 / API 8300-8399, and claiming is automatic. Two trees can run at
once, but the preview browser reaches one port at a time.

### Shell and search hygiene — check this first, it keeps costing us time

The shell is **zsh**, not bash. Confirm with `echo $0`. The traps below have each
burned real calls:

| wrong — zsh eats it | right | what you see |
| --- | --- | --- |
| `gh api repos/$R/contents/a.js?ref=$S` | `gh api "repos/$R/contents/a.js?ref=$S"` | `no matches found` |
| `gh pr view --json x --jq '.x[0:9]'` unquoted | quote the jq program | `no matches found` |
| `H=ref; git show $H:src/f.js` | `git show "${H}:src/f.js"` | `bad substitution` (`$H:s` is a modifier) |
| `grep -rn pat src --include=*.js` | `grep -rn pat src --include='*.js'` | `no matches found` |
| `for f in $(ls …)` | `find … -print0 \| xargs -0`, or quote | paths with spaces split |
| `kill $pids` (several) | `printf '%s\n' $pids \| xargs -r kill -9` | silently kills nothing |
| `pkill -f <pattern>` | kill explicit PIDs from `ps` | matches the shell running it |

An unquoted variable in zsh is **one word** — `read` from `$(…)` never splits, so
loops over it silently do nothing while reading correctly.

**Never grep or print a built/minified file.** Emscripten glue (`src/chip-core.js`),
`*.wasm`, `main.<hash>.js` are megabytes on **one line** — a matched-line grep
prints all of it into context. Use `grep -c` for a count, `grep -o` for matches
only, or search the source that produced it.

### Delegated work

A subagent starts **cold**: no session history, no memory of this file. Its prompt
must carry the repo path, the exact commands, the acceptance criteria and the rules
(no push, no promote, no rebase; commit on the overlay; revert and report if the
single attempt fails). Ask for numbers first, and for **fail-before / pass-after**
on every check — "all green" with no before/after has told you nothing. Prefer not
to build, promote or push from a child. Run delegated tasks sequentially when they
touch the same checkout; two children editing one tree is how a tree is corrupted.

## The project

**chip-player-js** is a web music player for chiptune/game formats (NSF/NSFE, SID,
SPC, VGM, MOD/XM/IT/S3M, MIDI, MDX, V2M, …): a React frontend, an Express +
better-sqlite3 server, and C/C++ player engines compiled to WebAssembly with
Emscripten. Upstream is `mmontag/chip-player-js`; our fork is `origin`. Never push
to `upstream`; everything stays in the fork.

## Branches and the overlay

    master ──> feature/<name>            the PR: feature work ONLY, no dev/ at all
                    │
                    └──> dev/overlay-<name>   where you work: feature work + ALL dev content
                                 ▲
    dev/kit ─────────────────────┘        the reusable dev layer, as its own branch

- **`feature/<name>`** is reviewable and clean. It needs each engine's public API
  or our wrapper — nothing else — and it must build against upstream.
- **`dev/overlay-<name>`** is a normal branch where you commit normally. It
  deliberately mixes feature work and dev tooling.
- **`dev/kit`** holds the whole-file dev content (`dev/**`, the engine build
  scripts, the vendored-tree deletion, the engine-config files) and the seeded
  `AGENTS.md`. It is a curated *template*, not a snapshot of a feature.

**Two mechanisms decide what is dev-only**, and both are path/region based rather
than commit based: whole dev-only **paths** (`dev/promote-paths.txt`) and
**`DEV-BEGIN`/`DEV-END` regions** inside feature files. A third bucket — the
`server/index.js` dev deltas — is never committed at all: `dev/apply.sh` patches
it in place and `dev/remove.sh` reverts it.

## Dev overlay & promotion

> **Promotion is user-initiated.** Never run `dev/promote-apply.sh` and never
> create `dev/.promote-armed` unless the user asked for that promotion in that
> turn. "Fix this bug", "make it clean", "commit and push" are not that ask. The
> arm key exists so the decision is a person's.

```sh
./dev/overlay.sh <t> plan     # plan only; no write path (or ./dev/promote.sh)
touch dev/.promote-armed      # the user arms the writer
./dev/overlay.sh <t> promote  # commits on the feature branch, then rebase + push
```

`promote.sh` requires a **clean tree** (so the plan matches what you reviewed),
skips every path in `dev/promote-paths.txt`, strips `DEV-BEGIN…DEV-END` from the
rest, and promotes only files whose *stripped* content still differs. A stripped
file must still parse/compile or the promotion is refused.

`dev/remove.sh` reverts the in-place patches so the tree is clean before a promote.
`dev/rebase.sh` puts the overlay back on top of the feature branch **and verifies
the tree did not move** — never rebase by hand; an interrupted rebase must be
aborted, not resumed. The rebase rewrites the overlay's history, so publishing it
is `dev/push-overlay.sh` (`--force-with-lease`) — never `git pull` the overlay.

**Publishing has two paths** (feature → promote; dev files → `dev/kit.sh
capture`/`pull`), and `AGENTS.md` is seeded, not synced. The model, four buckets
and the capture caveats are in `dev/README.md` §"Where your work goes".

### What promotes, and what does not

1. **Personal dev tooling → never.** Anything that exists for our working style
   rather than the product. Rule of thumb: if upstream would have to *remove* it
   to run their own setup, it stays out.
2. **Short-term hacks → do not promote.** Hard-coded local values, disabled code,
   duplicated logic, workarounds whose root cause is unknown. Fix properly or leave
   it overlay-only; never promote a hack "temporarily".
3. **Real feature work and compatible bug fixes → promote.** The test: *does it
   improve the user experience, and is it compatible with upstream?*

Vendored engine *sources* promote only as minimal, obviously-correct fixes. Our
build *scripts* and core *selection* never do — upstream builds their own way.

### The seam, and the hand-carry hazard

`server/index.js` is **path-listed**: its dev deltas are applied by `dev/apply.sh`
instead of committed, and any feature hunks in it are **hand-carried** to the
feature branch. Because the file is skipped by the planner, feature work landing
there is easy to forget — `dev/check-promotable-refs.js` runs in the test suite and
guards against it naming dev tooling.

A related hazard: a promote that **removes** a symbol exports it in two places (the
definition and `scripts/build-chip-core.js`'s `EXPORTED_FUNCTIONS`), and only the
first promotes. When a promote removes such a symbol, edit both in the same cycle.

## Dev environment

- **Node** is pinned; `better-sqlite3` is ABI-matched. Root install:
  `npm install --ignore-scripts` then `npm rebuild better-sqlite3`. Server deps:
  `npm install` inside `server/`.
- **`npm install --no-save` is a trap here.** Each `--no-save` install prunes the
  previous one, upgrades existing deps as a side effect, and rebuilds native modules
  against whatever `node` is on `PATH`. Install everything in **one** command with
  `--no-package-lock`, and keep `package.json`/the lockfile unmodified (verify with
  `git diff --stat package.json package-lock.json`).
- **Dev shims** live in `dev/` on the overlay only. `./dev/apply.sh` stages
  untracked, gitignored modules (a no-op core, a placeholder Firebase config, an
  auth bypass, browser test hooks) rather than patching tracked files, seeds the dev
  databases and writes `server/.env.local`. `./dev/remove.sh` undoes it. A worktree
  is made runnable in one step by `bringup`, which runs `apply.sh` for you.
- **Run it:** `npm run dev` (webpack dev server + API server). In a multi-target
  tree use `dev/overlay.sh <t> dev`, which sets the target's ports. **Restart after
  editing any webpack config** — the config is read once at startup, so a live
  rebuild keeps serving the old one.
- **`node --watch` does not reliably reload the API server here.** After editing
  anything under `server/` — or after a rebase/promote, which rewrites `server/` —
  restart `npm run dev` and confirm the **HTML** route, not just `/api`:
  `curl -s -o /dev/null -w '%{http_code}' localhost:<api>/`. A half-written
  `server/index.js` caches and every HTML route 500s while `/api` still answers 200.
- **Catalog fixtures** are gitignored and user-supplied under `catalog/`; rebuild
  with `node scripts/build-music.js` (use `-n` to reprocess everything; a
  schema-changing merge needs it before the server will boot). A worktree's catalog
  is its own.

### Building the real chip-core

Engines are **siblings of the checkout** (`../libvgm`, `../libxmp`, `../FluidLite`,
`../game-music-emu`, `../libgsf`, `../libsidplayfp`); a worktree created by t3 has
none, so `dev/engines.sh link` symlinks them into the worktree's parent (one farm
serves every t3 worktree of the repo) and reuses the archives already built inside
the clones.

```sh
./scripts/build-subprojects.sh      # sibling clones + the in-repo engines
./scripts/build-libsidplayfp.sh     # SID core (needs xa65)
node scripts/build-chip-core.js     # links everything into src/chip-core.{js,wasm}
```

Optional env: `CHIP_NO_SID`, `CHIP_ASSERTIONS=2`, `CHIP_DEBUG_NAMES=1`,
`CHIP_MALLOC=dlmalloc|emmalloc`, `CHIP_INITIAL_MEMORY`, `CHIP_STACK_SIZE`. Recorded
provenance is readable from a running app via `window.ChipCoreBuildInfo`.

**Never edit a sibling repo.** Anything an engine needs must be an existing public
API, code in our wrapper composing those APIs, or a patch to an in-repo tree (only
`mdxmini` is in-repo). Engines are built per Node ABI and the wasm embeds its build
path, so it is reproducible within a checkout, not across checkouts — never build
the dev core from an unpinned clone.

### Dev tooling

`window.__cpDev` (staged by `apply.sh` as an untracked module): `snapshot()`,
`setRepeat()`, `seek()`, `play()`/`pause()`, `click(selectorOrText)`,
`setParam(id, value)`, `waitUntil(fn, ms)`, `startRecord()`/`stopRecord()`,
`runTimeline(...)`. Use it to drive the real UI and spy on player state instead of
listening.

`./dev/run-tests.sh` runs every harness (plain Node + `assert`, plus a few bash
checks — no framework, no new deps). `dev/test-overlay-*.sh` cover the overlay
tooling itself: kit capture/pull, port claiming, discovery. Prefer driving the real
UI, and assert on the **artefact** the user would see, not the state you set.

## Conventions & cautions

- Comments explain **why**, in the author's voice; do not over-comment and do not
  reformat unrelated code.
- SQL: match the existing formatting; add prepared statements to `dbStatements`
  and destructure them where they are used. **Never put backticks inside SQL
  template strings** (it has broken the builder twice).
- The client is React 16 + react-router-dom v5 + react-virtualized + lodash +
  `auto-bind`. Match those.
- Verify with `curl` against the running server; a 200 on `/api` is not proof that
  the HTML route works.
- Dev shims stage **untracked** modules rather than patching tracked files, so
  `git status` stays clean. The one in-place patch is `dev/patch-server.js`
  (reversible, and reverted by `remove.sh`).

## The bar a review finding has to clear

A finding — ours or a bot's — does not get a commit for being correct in principle.
Act on it only when **all four** hold:

1. **Audio, or a control beyond its own resolution.** It changes what is heard, or
   moves a UI element by more than that element resolves.
2. **Reachable on real content.** A catalog/corpus file, or a fixture modelling a
   shape shown to exist in measured data. "Constructible in principle" is not
   reachable.
3. **A complete fix.** No half-mechanism: if correcting a unit forces a length
   measurement (or any other consumer) to move with it, that is *one* fix.
4. **Provable, fail-before → pass-after, asserting the claimed magnitude.** Not
   "does not crash": the check must fail against the pre-fix code for the claimed
   reason, and state the number.

Otherwise, record it with the measurement that disqualified it and stop. Apply the
same bar to your own new code: state units and bounds in the comment and assert
them in a harness.

## Lessons that cost real time

- **Measure behaviour; do not derive it from source.** Three separate conclusions
  here were overturned by reasoning from code instead of running it. A measurement
  takes minutes and settles the question.
- **Never reason about someone else's build from our tree.** Our vendored engines
  are demonstrably not what production builds from.
- **Make a harness non-destructive *before* running a negative control.** A
  fail-before run once reset a live database because the test had no snapshot.
- **Verify the artefact, not the state you manipulated.** A clip recorder shipped
  out-of-sync video with every assertion green.
- **Check the premise before defending a design.** `git log -S` settles "did this
  ever work?" in one command.
- **A wrong answer is worse than a late one.** Prefer no band to a plausible wrong
  one.
- **Re-verify claims inherited from notes.** One note's "unreachable" was a wrap.
- **The PR head is not the promote target.** A squash branch serves the PR; a
  promote does not move it, so refresh it and cite *its* sha.
- **Kill the port owners *and* count the trees.** A stale `node --watch` whose
  parent was killed re-grabs the port, and a "fresh" tree then proxies to a broken
  one. Check `ss -ltn` and `ps` are clear before starting.
