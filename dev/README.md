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

## Usage

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

The key file exists so promoting is an act a person does on purpose. Then put
`dev/overlay` back on top of the feature branch:

```sh
./dev/rebase.sh             # rebases, then verifies the tree did not move
```

That verification is the point. A rebase can silently drop a commit or resolve
an overlapping hunk the wrong way while printing "Successfully rebased" and
exiting 0 — it happened, and the only reason it was caught was a manual diff
against the pre-rebase tip. The script takes that diff as its job, names any
commit the rebase emptied or dropped, and tells you to `git rebase --abort`
rather than `--continue` if a rebase stops.

See "Dev overlay & promotion" in the repo-root `AGENTS.md` for what counts as
feature work and how the DEV-region stripping works.

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
| `patch-server.js` | `server/index.js` | target tracked (reversible) | Makes `skia-canvas` optional. |
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
node dev/test-parsers.js    # parser edge cases + real files under catalog/
node dev/test-build.js      # build-music round-trip (synthetic subdir, cleans up)
node dev/test-sequencer.js  # sequencer sub-tune navigation with a fake player
node dev/test-midi-loops.js # MIDI loop regions (N64/HMI), Repeat-One wrap, roll parity
node dev/test-xmp-loops.js  # XMP loop lever + learned band on scripted frame streams
node dev/test-devtools.js   # __cpDev stall-watch state machine (frozen/paused/song-change)
./dev/run-tests.sh          # all six
```

`test-build.js` writes a temp subdir under `catalog/`, runs the builder filtered
to it (twice, to exercise reprocessing), asserts the `music`/`subtune` rows, and
removes its temp dir and rows afterwards.

`test-sequencer.js` requires `src/Sequencer.js` with a small inline Babel require
hook (the client code is ESM/JSX and the repo has no test runner), so it needs no
build and no new dependencies.

## Browser devtools (`window.__cpDev`)

`shims/devtools.js` is staged to `src/chip-player-devtools.js` and prepended to
the dev webpack entry, so the running app exposes a scripting console for
looping/seek tests. From the browser console (or the t3 preview):

```js
__cpDev.snapshot()          // player state + VGM loop fields (curLoop,
                            //   fadeStartMs, fadeTailStartMs, playlistPositionMs)
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
