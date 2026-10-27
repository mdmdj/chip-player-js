# The dev overlay — how to use it

The app runs from a **dev overlay**: a reusable dev layer plus one working branch
per feature. Two pieces are shared and maintained once; everything else is a
per-target binding.

| Piece | What it is |
| --- | --- |
| `dev/kit` | the **canonical** dev layer as its own branch — `dev/**`, the engine layout and inventory, the test registry and runner, and the `AGENTS.md` **template**. Edit it here; overlays receive it by `pull`. |
| `feature/<name>` | the reviewable PR branch for one feature. Never carries `dev/` |
| `dev/overlay-<name>` | the branch you work on: `feature/<name>` + the kit + feature work |
| `dev/overlay.conf` | the manifest — one line per target: name, feature branch, overlay branch, ports |
| `.git/dev-targets` | the live registry, shared by every worktree: which targets exist and the ports they claimed |

A worktree *is* one target's dev tree. You commit normally on the overlay;
publishing is deliberate, and has two paths — **feature → promote**, **dev files →
edit `dev/kit` → pull** (see "Where your work goes" below).

## Start here

```sh
./dev/overlay.sh                 # every command, with the target syntax
./dev/overlay.sh list            # the targets and their ports
./dev/overlay.sh <name> bringup  # make THIS worktree runnable (~20 s, idempotent)
./dev/overlay.sh <name> dev      # run it, on its claimed ports
./dev/run-tests.sh               # the registered tests
```

`bringup` is the whole setup in one command: branches and worktrees if they are
missing, a port pair claimed from the registry, the engine farm, `node_modules`
from the main checkout, `dev/apply.sh`, the sample catalog, and a chip-core. A
worktree created from `dev/kit` (or from another overlay) needs nothing else first.

## The five rules it is built on

1. **`dev/kit` is canonical.** A dev tool or doc is edited on `dev/kit` and pulled
   down. `AGENTS.md` is *seeded*: a new worktree gets the template, and `pull`
   never overwrites a worktree's own notes. A feature's history belongs in
   `dev/features/<name>.md`, which is never carried into the kit and never promoted.
2. **Tests are source-coupled.** `dev/tests.manifest` is the registry: the kit ships
   the *infrastructure* tests, and a branch's own tests travel with it. Derive from
   a branch that has the code and its tests run (and are expected to pass); derive
   from one with none and the feature tests are **skipped with the reason**.
3. **The chip-core is source-coupled.** `dev/core.sh` treats a core as a build of
   the *engine sources*, so you choose its base — `CORE_REF` (default `master`) for
   a fresh feature, or the branch it extends.
4. **The catalog sample is cheap.** 16 files, one per engine family plus the
   harness fixtures (`dev/sample.manifest`), placed by symlink → hardlink → copy.
   Large collections are never copied automatically; take one deliberately.
5. **Promotion is your act.** `dev/overlay-subtunes` (or any overlay) and the
   reviewable branch are different things: the arm key is the decision, and nothing
   else promotes.

## Workflows

| Task | Command |
| --- | --- |
| New target on master | `./dev/overlay.sh <name> bringup` |
| New target stacked on an existing one | `./dev/overlay.sh <name> bringup <base-branch>` — the argument is the **base**; the target is always `feature/<name>` (`--target` overrides) |
| See what a worktree is | `./dev/overlay.sh <name> status` |
| Run the app | `./dev/overlay.sh <name> dev` (background it; one log per target) |
| Run the tests | `./dev/run-tests.sh` (`VERBOSE=1` for full output) |
| Add a test | one `infra`/`feature` line in `dev/tests.manifest` (+ a `group` line naming the feature's marker files) |
| Choose the chip-core's base | `./dev/core.sh list`, then `use <ref>`; or `CORE_REF=<ref> bringup`; `build` builds from this tree's sources |
| Give a worktree a bigger catalog | `./dev/sample.sh steal <other-worktree>` (or `node dev/fetch-seo-fixtures.mjs`) |
| Publish feature work | `./dev/overlay.sh <t> refresh --dry-run` (refresh if stale) → `./dev/backup.sh <t>` → `./dev/overlay.sh <t> plan` (works with the dev patches applied) → arm → `./dev/overlay.sh <t> promote` |
| Back up before a promote | `./dev/backup.sh <t>` — tags both branches and tars the gitignored dev artifacts |
| Publish dev tooling | edit + commit on **`dev/kit`**, then `./dev/kit.sh pull <target>` on each target (or `./dev/overlay.sh <t> refresh`) |
| Refresh an overlay | `./dev/overlay.sh <t> refresh [--dry-run]` — kit sync + rebase, **verified**; `all` refreshes every target, skipping the ones it cannot |
| Publish the overlay / the kit | `./dev/push-overlay.sh`, `git push origin dev/kit` |
| Stage/undo the dev environment | `./dev/apply.sh`, `./dev/remove.sh` |

Details for each are in the sections below: "The tools", "Promoting feature work",
"More than one target", "Spinning up a new target", "The registry", "Engines and
modules", "Where your work goes", "Tests".

## The tools

One entry point (`overlay.sh`) and the tools it and the workflows call. All of it
lives under `dev/`, is carried to every target by the kit, and never reaches the PR.

| Tool | What it is for |
| --- | --- |
| `overlay.sh` | the front end: `list`, `status`, `plan`, `promote`, `refresh`, `rebase`, `push`, `dev`, `arm`, `new`, `bringup`, `help` |
| `bringup.sh` | one-command setup of a worktree (branches, port, engines, modules, apply, sample, core) |
| `overlay-new.sh` | create `feature/<name>` + `dev/overlay-<name>` and their worktrees, from the kit |
| `refresh.sh` | bring an overlay (or `all`) up to date: kit sync + rebase, verified; `--dry-run` |
| `backup.sh` | before a promote: tag the overlay + feature branches and tar the gitignored dev artifacts (`dev/.backups/`) |
| `registry.sh` | the shared target/port registry, in the common git dir |
| `kit.sh` | the canonical dev layer itself: `pull` (into a target), `list`, `owned`, `never`; `import`/`capture` only bootstraps/rebuilds it from an overlay |
| `engines.sh` | the engine inventory: `check` (flags a decoy), `link` (farms the siblings) |
| `core.sh` | choose the chip-core's base: `list`, `use`, `steal`, `from`, `build` |
| `sample.sh` | the cheap catalog sample: `seed`, `steal`, `list` |
| `apply.sh` / `remove.sh` | stage / undo the dev environment (shims, DBs, the in-place patches) |
| `patch-server.js` / `patch-client.js` | those in-place deltas: idempotent and reversible, applied by `apply.sh`, undone by `remove.sh` |
| `run-tests.sh` | the registered harnesses, driven by `tests.manifest` |
| `promote.sh` → `promote-plan.sh` → `promote-apply.sh` | publish feature work to the reviewable branch (the plan is read-only; `promote-apply.sh` needs the arm key) |
| `rebase.sh` / `push-overlay.sh` | put the overlay back on top and verify the tree / publish it `--force-with-lease` |
| `check-promotable-refs.js` | the gate: nothing that can reach the PR may name overlay-only material |
| `record/` | the clip recorder and page builder for the PR changelog (its own `record/README.md`) |
| `overlaylib.sh`, `patch-lib.js` | internal libraries for the tools above, documented in their own headers |
| `fixtures.js`, `make-loop-pedal-midi.js`, `seed-dbs.js`, `import-songlengths.js`, `fetch-seo-fixtures.mjs` | the harness and catalog helpers: synthetic parser fixtures, a built loop-pedal MIDI, `apply.sh`'s DB seeding, song lengths, SEO fixtures |

What it all reads:

| File | What it holds |
| --- | --- |
| `overlay.conf` | the manifest: `name feature-branch overlay-branch [wds api]` per target |
| `promote-paths.txt` | the paths that are overlay-only **areas** — whole trees that never promote |
| `tests.manifest` | the test registry: a `group` line per feature, one `infra`/`feature` line per harness |
| `sample.manifest` | the files the cheap catalog sample fetches |
| `.promote-armed` | the arm key (gitignored, per-worktree): the one act that lets a promotion write |

The other two mechanisms are not files: a `DEV-BEGIN … DEV-END` region inside a
feature file (a chunk that strips to prod behaviour exactly) and the single
hand-carry list, `server/index.js`. Both are explained under "Where your work goes".

## Adding a dependency

A feature that adds a package commits `package.json` **and** the lockfile, and
touches nothing else:

```sh
npm install --save-exact <pkg>@<version>          # --save-exact matches the repo's pins
git diff --stat package.json package-lock.json    # exactly those two files
```

The plan validates both: `*.json` goes through `JSON.parse` and `*.css` through
postcss, so a dependency or a stylesheet promotes with the same protection as JS
and C rather than as an unvalidated blank.

**Never `npm install --no-save`.** It resolves the whole tree against
`package.json`, so it prunes what a previous `--no-save` added *and* upgrades
existing deps as a side effect (it moved webpack 5.106 → 5.112 once, which removed
`webpack/hot/log.js` and broke the dev build). A killed reify can leave
`node_modules` half-written, so repair a drifted tree with a clean install rather
than re-running the same command:

```sh
rm -rf node_modules && npm ci --ignore-scripts && npm rebuild better-sqlite3
```

`--ignore-scripts` is not optional under Node 24 (the unused `sqlite3`
devDependency cannot build there); `better-sqlite3` is then rebuilt for the pinned
Node — `nvm use`, or the PATH export in a non-interactive shell.

A worktree whose `node_modules` `bringup` hardlinked does **not** see a new
dependency automatically: the install replaces directory entries in the tree that
ran it, so run the sequence above in each tree that needs the package.

## Housekeeping

- **The kit is canonical, and the test says whether this tree is current.**
  `dev/kit` is the source; `dev/test-overlay-discovery.sh` compares this
  worktree's carried kit paths with `dev/kit` and, in a feature overlay, reports
  a stale tree with the `refresh` command rather than treating it as a broken
  branch. A kit-path change is authored on `dev/kit`, not on an overlay.
- **A refresh is verified, and can be looked at first.** `./dev/overlay.sh <t>
  refresh --dry-run` prints what the kit would change in that worktree (the files
  the kit *supplies*, so nothing is listed that a pull would not touch) and whether
  the rebase would do anything, and touches nothing. A real refresh then syncs the
  kit, rebases, and **asserts that nothing outside the paths the kit owns moved** —
  a refresh that touched feature code is a bug, and it says so and names the
  pre-refresh tip to restore from. `./dev/overlay.sh all refresh` does every
  registered target and prints one verdict each.
- **If a `pull`/`refresh` refuses naming `dev/features/`** (or any of the tests the
  kit does not carry), that worktree predates the guard learning to ignore
  never-carried paths: move the note aside once, pull, and put it back. Only
  *tracked* modifications to a kit path genuinely block a sync.
- **Ports:** 3000/8080 belong to the long-lived target; a target claims a pair from
  WDS 3300-3399 / API 8300-8399 (`dev/registry.sh list` shows what is taken).
- **Never push to `upstream`** — everything stays in the fork (`origin`).
- **Before a PR:** `./dev/remove.sh` (it reverts the in-place patches), then delete
  or exclude this directory; nothing here is part of the PR.

## Prerequisites

- `nvm` with the repo-pinned Node version: `nvm install && nvm use`
- `npm install` in the repo root and in `server/`

In a non-interactive shell `nvm` is not on `PATH`, so export the pinned version
directly (it is ABI-matched to `better-sqlite3`):
`export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"`.

## Usage

**Starting a new target** — a new feature branch, or a worktree created from
`dev/kit` — is one command. It creates the branches and worktrees, claims a port
pair from the shared registry, links the engine clones, hardlinks `node_modules`,
runs `dev/apply.sh` and copies in a real chip-core (~20s):

```sh
./dev/overlay.sh <name> bringup
./dev/overlay.sh <name> dev        # run it, on the registry's ports
```

`dev/overlay.sh` with no arguments lists every command. See "Spinning up a new
target" below for what bring-up does and the port policy.

For the long-lived `dev/overlay-subtunes` itself the original two steps still apply:

```sh
./dev/apply.sh   # install shims, seed databases, build a tiny catalog
npm run dev      # webpack dev server (:3000) + API server (:8080)
```

Recording the clips for the PR communication page is a separate, occasional
activity — see `dev/record/README.md` for the design and `dev/record/FINDINGS.md`
before touching the recorder. Nothing about it runs as part of the normal dev
loop.

It needs two things the normal setup does not:

- **`playwright`** in `node_modules`, installed without touching `package.json`:
  `npm i --no-save --no-package-lock playwright@1.63.0 webpack@5.106.0`. One
  command for both — each `--no-save` install prunes the previous one, and the
  install also rebuilds `better-sqlite3` against whatever `node` is on PATH (the
  host default is 26.x, so it ends up compiled for the wrong ABI). If
  `dev/run-tests.sh` starts failing with `NODE_MODULE_VERSION`, run
  `PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH" npm rebuild better-sqlite3`.
  Full list of the ways this bites: AGENTS.md §Dev environment.
- **Chromium**, already fetched into `~/.cache/ms-playwright`.

Recording is one command per clip: `node dev/record/shoot.mjs --clip <clip-id>`.
Repeat `--clip` for a few, or `--all` for the whole registry (no clip id at all is
an error, not an implicit full re-shoot). See `dev/record/README.md`.

## Promoting feature work to the reviewable branch

`dev/overlay-subtunes` is the working branch; the reviewable PR branch
(`feature/subtunes-as-first-class`) must contain only feature work. Promoting is
two steps, and the second one is deliberately not a flag on the first:

```sh
./dev/promote.sh           # plan only; it has no write path at all
touch dev/.promote-armed   # arm the writer
./dev/promote-apply.sh     # commits to the feature branch, then disarms itself
```

The key file exists so promoting is an act a person does on purpose.
`promote-apply.sh` then runs the whole mechanical tail: it puts `dev/overlay-subtunes`
back on top (`dev/rebase.sh`, which verifies the tree did not move) and
publishes both branches (the feature branch, then `dev/push-overlay.sh`).
`PROMOTE_SKIP_PUSH=1` stops after the rebase.

That verification is the point. A rebase can silently drop a commit or resolve
an overlapping hunk the wrong way while printing "Successfully rebased" and
exiting 0 — it happened, and the only reason it was caught was a manual diff
against the pre-rebase tip. The script takes that diff as its job, names any
commit the rebase emptied or dropped, and tells you to `git rebase --abort`
rather than `--continue` if a rebase stops.

The rebase rewrites `dev/overlay-subtunes`'s history, so its push is `--force-with-lease`
(`dev/push-overlay.sh`) — never `git pull` `dev/overlay-subtunes` after a rebase.

See "Dev overlay & promotion" in the repo-root `AGENTS.md` for what counts as
feature work and how the DEV-region stripping works.

### More than one target

The promote scripts resolve the (feature, overlay) pair from `dev/overlay.conf`,
so one checkout can drive any number of targets:

```sh
./dev/overlay.sh list          # the targets and their ports
./dev/overlay.sh status        # what the current branch resolves to
./dev/overlay.sh gba plan      # name the target explicitly
```

To add a target, the kit is already the canonical source; create the pair from
it — or, in one command, `./dev/overlay.sh <name> bringup` (see "Spinning up a
new target" below):

```sh
./dev/overlay-new.sh gba       # feature/gba + dev/kit, its own worktrees
```

`./dev/overlay.sh <t> refresh` syncs the kit onto an overlay and then rebases it;
promotion is unchanged and the arm key is per overlay worktree, so two targets
cannot arm each other. The seam file `server/index.js` is deliberately not in the
kit (its dev delta is not a whole-file copy).

Two trees at once: `./dev/overlay.sh <t> dev` runs `npm run dev` with that
target's `WDS_PORT`/`API_PORT`. The client reads the API port from
`window.__devApiPort`, which the dev server injects, so a second tree needs no
rebuild. The t3 preview reaches one port, so one tree is live at a time.

### Spinning up a new target — one command

```sh
./dev/overlay.sh <name> bringup      # from the main checkout or from a kit worktree
```

`bringup` is idempotent and covers the whole sequence: it creates `feature/<name>`
and `dev/overlay-<name>` with their worktrees — or uses *this* worktree when you
are already on `dev/overlay-<name>`, which is the case in a worktree created from
`dev/kit` — claims a port pair from the shared registry, links the engine
siblings, hardlinks `node_modules` from the main checkout, runs `dev/apply.sh`,
and copies in a real chip-core when the main checkout has one. It takes about 20
seconds and prints the run command:

```sh
./dev/overlay.sh <name> dev
curl -s -o /dev/null -w '%{http_code}\n' localhost:<api>/   # the HTML route
```

**The positional branch is the BASE, not the target.** `bringup <name> <base>`
creates `feature/<name>` *from* `<base>` (`--base` is the explicit form) and
registers `feature/<name>` as the promote target; `--target <branch>` overrides
the target deliberately and loudly. This distinction is load-bearing: before it
existed, `bringup visualizer feature/subtunes-as-first-class` meant "based on
sub-tunes" to the caller and "promote into sub-tunes" to the tool, and a promote
put the visualizer's files on the shared branch. A target whose name appears in
neither branch is now refused by `registry.sh claim`, and the plan warns when the
pair looks like two different features.

`dev/apply.sh` is what makes the tree runnable: it patches the dev-only deltas
into `server/index.js` (auth bypass, per-target ports, the dev HTML injection),
which the kit deliberately does not carry. `dev/patch-server.js --revert` (run by
`dev/remove.sh`) restores the plain file before a promote.

#### The registry — targets and ports

`dev/registry.sh` owns the shared registry at `.git/dev-targets`. It must live in
the **common git dir**: every worktree has its own copy of `dev/`, so a row in
`dev/overlay.conf` is invisible from another worktree — which is why a target
registered by one agent could not be reached by another, or by the main checkout.
A row is a manifest line: `name feature overlay wds api [base]`. The last field is
the base the work sits on, for information only — nothing resolves through it, and
`-` means "not recorded".

**The slug rule.** The target name must appear in *both* branches: `visualizer` →
`feature/visualizer` + `dev/overlay-visualizer`, and `subtunes` →
`feature/subtunes-as-first-class` + `dev/overlay-subtunes`. `claim` refuses a pair
that fails it, because the usual reason is a *base* branch registered as the
target. A deliberate shared target is explicit: `claim <name> <feature> <overlay>
--allow-mismatch`, which registers it and prints `MISMATCH ACCEPTED`. The promote
plan also warns when the pair looks like two different features — a warning, not a
refusal, since the override exists.

Port policy (the rule):

- **3000/8080 are reserved** for the long-lived target (`dev/overlay-subtunes`).
- targets take a pair from the pool: **WDS 3300-3399, API 8300-8399**, i.e.
  `WDS 3300+i`, `API 8300+i` for `i` in `0..99` (API = WDS + 5000 by
  construction). Allocated lowest-free, never a pair the registry names or a
  socket is listening on.
- `dev/registry.sh list` shows the claims and what is live; `release <name>`
  frees one. `port <name>` prints a target's pair.

`dev/overlay.sh list` / `status` read the registry, so every worktree sees the
same targets.

#### Engines and modules without the wait

**`dev/engines.sh check` is the answer to "which libraries does the build use, and
from where".** There are exactly two sources and nothing else is used:

| Source | Engines | Where it lives | How a worktree gets it |
| --- | --- | --- | --- |
| **sibling** | `game-music-emu` (GME), `libxmp`, `libvgm`, `FluidLite`, `libgsf`, `libsidplayfp` | clones beside the main checkout; built by `scripts/build-subprojects.sh` | `dev/engines.sh link` symlinks each clone into this worktree's **parent** — every t3 worktree of a repo shares one parent, so one farm serves them all, and the archives already built inside the clones are reused |
| **in-repo** | `libADLMIDI`, `psflib`, `lazyusf2`, plus `mdxmini` and `farbrausch-v2m` (sources only — compiled by `build-chip-core.js`) | sources travel in git (and in `dev/kit`) | their archives are gitignored, so `link` symlinks the archive or build directory from the main checkout |

Anything else is a **decoy**: the vendored trees this overlay deleted (`libvgm/`,
`libxmp/`, `fluidlite/`, `game-music-emu/`) are not the build's source, and an
in-tree directory carrying a sibling's name is not used either. `engines.sh check`
flags one — a stale `FluidLite/build/libfluidlite.a` in the tree is exactly the
sort of thing that gets mistaken for the real library.

`node_modules` is hardlinked (`cp -al`, ~1.5 s) from the main checkout rather
than installed — same Node, same lockfile, and real paths, so nothing has to
resolve through a symlink (`link_modules` falls back to a symlink across
filesystems). Re-run `npm install` in the worktree if a branch changes
dependencies. A real `chip-core` is copied from the main checkout, so audio works
with no build; `NO_REAL_CORE=1 dev/bringup.sh <name>` keeps the silent stub.

Each run should log to its own file — two agents sharing one log clobber each
other's crash output. Verify with `curl`; open the t3 preview at `mms-1:<api>`
(not `localhost` — the preview browser cannot reach the loopback name) when it is
your turn, since the preview reaches one port at a time.

### Where your work goes — two publication paths

You commit normally on the overlay; the split between "feature" and "dev kit"
happens when work is **published**, not when it is committed. Two paths each take
their own subset of an overlay that deliberately mixes both:

| Your change | Path | Command |
| --- | --- | --- |
| Feature code in a feature file | **promote** onto the feature branch | `dev/overlay.sh <t> plan` → arm → `promote` |
| A whole dev-only file (`dev/**`, the build scripts, `src/config/index.js`) | **edit it on `dev/kit`**, then **pull** it into the overlays | commit on `dev/kit`; `dev/kit.sh pull <t>` or `overlay.sh <t> refresh` |
| Dev-only code *inside* a feature file | wrapped in `DEV-BEGIN`/`DEV-END`; promote strips it, so it never ships | — |
| `server/index.js`'s dev deltas | neither: `dev/apply.sh` patches them in place, `dev/remove.sh` reverts | — |

Four buckets, two publication paths — and nothing is ever "on the wrong branch"
while you work. The filters are the path list (`dev/promote-paths.txt`) and the
regions, not your commit discipline.

`dev/kit` is the **canonical** copy: edit the tool or doc there, commit on
`dev/kit`, and pull it into the targets. `import`/`capture` is only a bootstrap
or a deliberate rebuild from an overlay; it requires an explicit source
(`dev/kit.sh import <ref> [<path>...]`, or `KIT_SOURCE=<ref> dev/kit.sh capture`)
and is last-write-wins. There is no implicit "canonical overlay" to import from.

`AGENTS.md` is **seeded, not synced**: `dev/kit` holds the shared playbook as a
template, `pull` delivers it only to a worktree that has none, and an import never
takes an overlay's copy up. A new feature therefore starts from a clean playbook
while the overlay that earned the detail keeps it.

#### Keep a feature's detail out of AGENTS.md

Put a feature's design decisions, measurements, hand-offs and history in its own
note — `dev/features/<name>.md` — and keep `AGENTS.md` to what is true for *every*
feature. `dev/features/**` is never carried into the kit, so one feature's notes
cannot follow the next feature around, and it sits inside `dev/**`, so it never
reaches the PR either.

The older, pre-`dev/features/` notes are still on the overlay that wrote them (they
are tracked on its branch, so they are never lost) but the kit deliberately does not
carry them — they are one feature's record rather than the kit's tooling, and a new
worktree should not inherit them. `ENGINE_BUILD_MIGRATION.md` *is* tooling, and is
carried.

To revert:

```sh
./dev/remove.sh
```

## What gets installed

| Shim | Target | Tracked? | Notes |
| --- | --- | --- | --- |
| `shims/chip-core.js` | `src/chip-core.js` | target gitignored | No-op Emscripten module + in-memory FS. No audio. |
| `shims/firebaseConfig.js` | `src/config/firebaseConfig.js` | target gitignored | Placeholder Firebase config. |
| `shims/server-auth.js` | `server/middleware/auth.dev.js` | staged file gitignored | Per-worktree `dev-user-<target>` (from `dev/dev-user.js`); loaded via `DEV_AUTH_MODULE` in `server/.env.local`. No tracked file patched. |
| `shims/devtools.js` | `src/chip-player-devtools.js` | staged file gitignored | Browser test hooks (`window.__cpDev`); injected by the dev webpack entry. Also drops the previous dev user's localStorage copy when the per-worktree id changes. |
| `shims/recorder.js` | `src/chip-player-record.js` | staged file gitignored | Clip-recording hooks (`window.__cpRec`): settings pinning, an audio mirror off the app's gain node, the green sync mark, click-by-exact-name. For the PR communication page — see `dev/record/README.md`. |
| `patch-server.js` | `server/index.js` | target tracked (reversible) | Applies the dev-only server deltas: `skia-canvas` optional, the dev auth bypass (`DEV_AUTH_MODULE`), per-target `API_PORT`/`WDS_PORT`, the dev `window.__devApiPort` injection, and no-cache in dev. `--revert` restores the plain file, so run `dev/remove.sh --revert` before a promote. |
| `patch-client.js` | `src/components/UserProvider.js` | target tracked (reversible) | Applies the fake dev user (`REACT_APP_DEV_USER`), which the file cannot carry in the kit because it is a feature file. No-ops on a file that already delivers one (an overlay's own DEV regions). |
| `seed-dbs.js` | `server/users.db`, `server/csdb.db` | gitignored | Creates `users`/`playlists`/`playbacks` schemas and the per-worktree dev user (`dev-user-<target>`). |
| `import-songlengths.js` | `server/csdb.db` (`hvsc_files`) | gitignored | Imports HVSC `Songlengths.txt` lengths for local SIDs, matched by the libsidplayfp fingerprint (not md5-of-file). Fetches the canonical copy to a tmp cache unless `--file` is given; `--dry-run` changes nothing. |
| generated | `server/.env.local` | gitignored | Points server at local dirs; sets `DEV_AUTH_MODULE`. |
| generated | `catalog/`, `server/catalog.db` | gitignored | Built by `scripts/build-music.js`. |

The dev user on the client comes from `REACT_APP_DEV_USER` in the dev webpack
config (`UserProvider` turns it into a fake `user` with `getIdToken()`), so the
favorites UI works without Firebase and without patching any tracked file.
The uid is **per worktree** (`dev-user-<target>`, derived by `dev/dev-user.js`);
the server auth shim, the webpack config and `seed-dbs.js` all call the same
helper, so they agree. That is deliberate: a single `dev-user` made every target
the same account, and a copied DB, a reused browser origin or a client pointed at
the wrong API could carry settings/favorites between features. The devtools shim
also clears the old `settings`/`faves` localStorage keys whenever the uid changes.

## Auth modes

The bypass supports two modes via `DEV_AUTH_MODE`:

- `bypass` (default): every authenticated request uses this worktree's
  `dev-user-<target>`.
- `proxy`: uses the `x-dev-uid` request header.

`optionalAuth` only sets a user when an `Authorization` header is present.
`DEV_AUTH_MODE=proxy` is unused by the client today but kept for a future
header-based shim.

## Test fixtures

Drop extra files into `catalog/` (NSF/NSFE/SID/MOD/etc.), then rebuild:

```sh
node scripts/build-music.js --filter <subdir>
```

`game-music-emu/test.nsf` is a convenient multi-track NSF and is copied in
automatically for a starter fixture.

`scripts/test-seo.js` (upstream's SEO engine test) asserts against production
directory paths, so it needs rows for 14 directories the dev catalog does not
otherwise contain. Fetch them with a delay between each request, then index:

```sh
node dev/fetch-seo-fixtures.mjs   # 574 files under catalog/; re-runnable/idempotent
node scripts/build-music.js -n
npm run test:seo
```

## Real audio (optional)

By default the dev app uses a silent stub `chip-core.js`. To build a real one
(see AGENTS.md "Building the real chip-core"):

```sh
./scripts/build-subprojects.sh                 # vendored engines
./scripts/build-libsidplayfp.sh                # SID core (mmontag fork, needs xa65)
node scripts/build-chip-core.js
```

This writes `src/chip-core.{js,wasm}` (gitignored) which the app loads instead
of the stub. Re-running `dev/apply.sh` overwrites a real build with the stub
again, so build after applying.

## Tests

Dev-only harnesses (plain Node + `assert`, no framework and no new deps). They
are removed with the rest of `dev/` before the PR.

```sh
./dev/run-tests.sh    # registry-driven; see dev/tests.manifest
```

**Tests are source-coupled, like the core's export list: they belong to the branch
whose code they test, not to the kit.** `dev/tests.manifest` is the registry — a
`group` line names the files that prove a feature is present, and each harness is
either `infra` (tests the tooling; always shipped) or `feature` (tests the app;
travels with the branch):

- derived from a branch that has the code → you inherit its tests, and they are
  expected to pass;
- derived from one with none (current master) → you get the bare infrastructure and
  the feature tests are **skipped with the reason**, not failed.

One consequence to know: **a harness fix does not travel.** Because feature tests
are pruned from the kit, an overlay cut before the fix keeps running the old check
— a stale `test-midi-loops.js` reported a failure for a file its source overlay had
already learned to skip. Copy the file from the source overlay and commit it on that
overlay; the copy is deliberate, because the branch owns its tests.

`run-tests.sh` is driven by that file and nothing is hard-coded in it; the kit
derives its never-carried list from the same file, so a feature's tests are pruned
automatically. Add a feature with one `group` line plus a `test feature` line per
harness. Plain Node + `assert` and a few bash harnesses — no framework, no new
deps, and removed with the rest of `dev/` before the PR.

`test-build.js` writes a temp subdir under `catalog/`, runs the builder filtered
to it (twice, to exercise reprocessing), asserts the `music`/`subtune` rows, and
removes its temp dir and rows afterwards.

`test-sequencer.js` requires `src/Sequencer.js` with a small inline Babel require
hook (the client code is ESM/JSX and the repo has no test runner), so it needs no
build and no new dependencies.

`dev/mdx-native/` is the one harness that is not JavaScript. The JS harnesses
fake the region getters, so they never reach the C; this builds the repo's
`mdxmini` as a normal Linux binary and runs the loop-region recording directly.
`make -C dev/mdx-native check` runs golden fixtures from `catalog/mdx` (skipped
when absent). It also holds the corpus triage tools (`scan-tracks`,
`curate-sample.js`). See `dev/mdx-native/README.md`.

## Browser devtools (`window.__cpDev`)

`shims/devtools.js` is staged to `src/chip-player-devtools.js` and prepended to
the dev webpack entry, so the running app exposes a scripting console for
looping/seek tests. From the browser console (or the t3 preview):

```js
__cpDev.snapshot()          // player state + VGM loop fields (curLoop,
                            //   fadeStartMs, fadeTailStartMs)
__cpDev.play() / pause()
__cpDev.seek(ms)            // also drops a captured fade tail
__cpDev.setRepeat(0|1|2)    // Off / All / One
__cpDev.cycleRepeat()       // through the footer button path
__cpDev.click(selOrText)    // real DOM click on a UI control
__cpDev.setParam(id, value) // player parameter via App.handleParamChange
__cpDev.waitUntil(fn, ms)   // poll snapshot() until fn(s) holds
__cpDev.startRecord(ms) / stopRecord()   // sample state on an interval
__cpDev.runTimeline([{atMs, fn|setRepeat|seek}, ...], {record: true})
```

See "Repeat One test matrix" in the repo's `AGENTS.md` for the permutations
these hooks exist to exercise (Hurry Up!.vgz is the reference fixture).

## Limitations

- No audio with the stub core (build the real chip-core for playback; SID is
  silent on it too unless `./scripts/build-libsidplayfp.sh` has been run).
- No real login (placeholder Firebase config). A fake `dev-user-<target>` is
  injected so favorites can be added/removed and persist through the local API
  (`server/users.db`), which is seeded automatically. It is per worktree, not a
  shared account.
- `/preview` images are disabled if skia-canvas is unavailable.
