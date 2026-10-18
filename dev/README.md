# Dev shims

This directory exists so the app can run locally without a full chip-core
WebAssembly build, Firebase credentials, or a real music catalog. **It is all
removable.** Before opening a PR, run:

```sh
./dev/remove.sh
```

That undoes every change `dev/apply.sh` made. Then delete this directory (or
keep it out of the PR).

## Prerequisites

- `nvm` with the repo-pinned Node version: `nvm install && nvm use`
- `npm install` in the repo root and in `server/`

In a non-interactive shell `nvm` is not on `PATH`, so export the pinned version
directly (it is ABI-matched to `better-sqlite3`):
`export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.

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

For the long-lived `dev/overlay` itself the original two steps still apply:

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
  `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" npm rebuild better-sqlite3`.
  Full list of the ways this bites: AGENTS.md §Dev environment.
- **Chromium**, already fetched into `~/.cache/ms-playwright`.

Recording is one command per clip: `node dev/record/shoot.mjs --clip <clip-id>`.
Repeat `--clip` for a few, or `--all` for the whole registry (no clip id at all is
an error, not an implicit full re-shoot). See `dev/record/README.md`.

## Promoting feature work to the reviewable branch

`dev/overlay` is the working branch; the reviewable PR branch
(`feature/subtunes-as-first-class`) must contain only feature work. Promoting is
two steps, and the second one is deliberately not a flag on the first:

```sh
./dev/promote.sh           # plan only; it has no write path at all
touch dev/.promote-armed   # arm the writer
./dev/promote-apply.sh     # commits to the feature branch, then disarms itself
```

The key file exists so promoting is an act a person does on purpose.
`promote-apply.sh` then runs the whole mechanical tail: it puts `dev/overlay`
back on top (`dev/rebase.sh`, which verifies the tree did not move) and
publishes both branches (the feature branch, then `dev/push-overlay.sh`).
`PROMOTE_SKIP_PUSH=1` stops after the rebase.

That verification is the point. A rebase can silently drop a commit or resolve
an overlapping hunk the wrong way while printing "Successfully rebased" and
exiting 0 — it happened, and the only reason it was caught was a manual diff
against the pre-rebase tip. The script takes that diff as its job, names any
commit the rebase emptied or dropped, and tells you to `git rebase --abort`
rather than `--continue` if a rebase stops.

The rebase rewrites `dev/overlay`'s history, so its push is `--force-with-lease`
(`dev/push-overlay.sh`) — never `git pull` `dev/overlay` after a rebase.

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

To add a target, put `dev/kit` (the overlay-only whole-file content) in one place
and build the pair from it — or, in one command, `./dev/overlay.sh <name> bringup`
(see "Spinning up a new target" below):

```sh
./dev/kit.sh capture           # once: capture the overlay-only content
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

`dev/apply.sh` is what makes the tree runnable: it patches the dev-only deltas
into `server/index.js` (auth bypass, per-target ports, the dev HTML injection),
which the kit deliberately does not carry. `dev/patch-server.js --revert` (run by
`dev/remove.sh`) restores the plain file before a promote.

#### The registry — targets and ports

`dev/registry.sh` owns the shared registry at `.git/dev-targets`. It must live in
the **common git dir**: every worktree has its own copy of `dev/`, so a row in
`dev/overlay.conf` is invisible from another worktree — which is why a target
registered by one agent could not be reached by another, or by the main checkout.
A row is a manifest line: `name feature overlay wds api`.

Port policy (the rule):

- **3000/8080 are reserved** for the long-lived target (`dev/overlay`).
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
| A whole dev-only file (`dev/**`, the build scripts, `src/config/index.js`) | **capture** to `dev/kit`, then **pull** into the other overlays | `dev/kit.sh capture` / `dev/kit.sh pull <t>` |
| Dev-only code *inside* a feature file | wrapped in `DEV-BEGIN`/`DEV-END`; promote strips it, so it never ships | — |
| `server/index.js`'s dev deltas | neither: `dev/apply.sh` patches them in place, `dev/remove.sh` reverts | — |

Four buckets, two commands — and nothing is ever "on the wrong branch" while you
work. The filters are the path list (`dev/promote-paths.txt`) and the regions, not
your commit discipline.

`capture` is a **snapshot, not a merge**: it copies the named paths from the
source overlay onto `dev/kit`, so two agents capturing at once are
last-write-wins. It publishes from the **canonical overlay**
(`KIT_CANONICAL`, default `dev/overlay`), *not* from whatever branch you are
standing on — otherwise a feature overlay's kit-path edits (a rebuild script, a
build flag) would silently become every future feature's starting point. To
publish from another overlay, say so: `KIT_SOURCE=<overlay> dev/kit.sh capture`.
Naming paths publishes just those, seeds included (`dev/kit.sh capture AGENTS.md`),
and read `git diff dev/kit` before relying on the result.

`AGENTS.md` is **seeded, not synced**: `dev/kit` holds the shared playbook as a
template, `pull` delivers it only to a worktree that has none, and `capture` never
takes an overlay's copy up. A new feature therefore starts from a clean playbook
while the overlay that earned the detail keeps it.

#### Keep a feature's detail out of AGENTS.md

Put a feature's design decisions, measurements, hand-offs and history in its own
note — `dev/features/<name>.md` — and keep `AGENTS.md` to what is true for *every*
feature. `dev/features/**` is never captured into the kit, so one feature's
notes cannot follow the next feature around, and it sits inside `dev/**`, so it
never reaches the PR either.

To revert:

```sh
./dev/remove.sh
```

## What gets installed

| Shim | Target | Tracked? | Notes |
| --- | --- | --- | --- |
| `shims/chip-core.js` | `src/chip-core.js` | target gitignored | No-op Emscripten module + in-memory FS. No audio. |
| `shims/firebaseConfig.js` | `src/config/firebaseConfig.js` | target gitignored | Placeholder Firebase config. |
| `shims/server-auth.js` | `server/middleware/auth.dev.js` | staged file gitignored | Fixed `dev-user`; loaded via `DEV_AUTH_MODULE` in `server/.env.local`. No tracked file patched. |
| `shims/devtools.js` | `src/chip-player-devtools.js` | staged file gitignored | Browser test hooks (`window.__cpDev`); injected by the dev webpack entry. |
| `shims/recorder.js` | `src/chip-player-record.js` | staged file gitignored | Clip-recording hooks (`window.__cpRec`): settings pinning, an audio mirror off the app's gain node, the green sync mark, click-by-exact-name. For the PR communication page — see `dev/record/README.md`. |
| `patch-server.js` | `server/index.js` | target tracked (reversible) | Applies the dev-only server deltas: `skia-canvas` optional, the dev auth bypass (`DEV_AUTH_MODULE`), per-target `API_PORT`/`WDS_PORT`, the dev `window.__devApiPort` injection, and no-cache in dev. `--revert` restores the plain file, so run `dev/remove.sh --revert` before a promote. |
| `patch-client.js` | `src/components/UserProvider.js` | target tracked (reversible) | Applies the fake dev user (`REACT_APP_DEV_USER`), which the file cannot carry in the kit because it is a feature file. No-ops on a file that already delivers one (an overlay's own DEV regions). |
| `seed-dbs.js` | `server/users.db`, `server/csdb.db` | gitignored | Creates `users`/`playlists`/`playbacks` schemas. |
| `import-songlengths.js` | `server/csdb.db` (`hvsc_files`) | gitignored | Imports HVSC `Songlengths.txt` lengths for local SIDs, matched by the libsidplayfp fingerprint (not md5-of-file). Fetches the canonical copy to a tmp cache unless `--file` is given; `--dry-run` changes nothing. |
| generated | `server/.env.local` | gitignored | Points server at local dirs; sets `DEV_AUTH_MODULE`. |
| generated | `catalog/`, `server/catalog.db` | gitignored | Built by `scripts/build-music.js`. |

The dev user on the client comes from `REACT_APP_DEV_USER` in the dev webpack
config (`UserProvider` turns it into a fake `user` with `getIdToken()`), so the
favorites UI works without Firebase and without patching any tracked file.

## Auth modes

The bypass supports two modes via `DEV_AUTH_MODE`:

- `bypass` (default): every authenticated request uses `dev-user`.
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
./dev/run-tests.sh    # every harness (parser/build checks need catalog/)
```

Plain Node + `assert`, plus a few bash harnesses — no framework, no new deps, and
removed with the rest of `dev/` before the PR. The overlay work has its own:
`test-overlay-tooling.sh` (kit capture/pull, a second target promoted end to
end), `test-overlay-registry.sh` (port claiming and discovery),
`test-server-seams.js` (the `server/index.js` dev patches, on both bases),
`test-dev-ports.js` (per-target port wiring), `test-promote-syntax.sh` (the
strip/compile validation), and `test-overlay-discovery.sh` (the entry points and
the docs a new worktree needs).

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
- No real login (placeholder Firebase config). A fake `dev-user` is injected so
  favorites can be added/removed and persist through the local API
  (`server/users.db`), which is seeded automatically.
- `/preview` images are disabled if skia-canvas is unavailable.
