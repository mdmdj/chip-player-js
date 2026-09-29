# AGENTS.md — Sub-songs as first-class songs

This file documents a feature branch and its development setup for AI agents
(and humans) picking up the work. Read it fully before making changes.

## Session start

Begin every session with `nvm use` (repo `.nvmrc` pins **Node 24.21.0**), then
confirm with `node -v` / `nvm current`. The host default `node` is newer (26.x)
and `better-sqlite3` is compiled per Node ABI, so running `npm`/`node` under the
wrong version fails with `NODE_MODULE_VERSION` mismatches. Also check whether an
`npm run dev` is already up before assuming the environment is correct — a
long-running server may have been started under a different Node than the shell.

## Project

**chip-player-js** is a web music player for chiptune/game audio formats
(NSF/NSFE, SID, SPC, VGM, MOD/XM/IT/S3M, MIDI, etc.), by **Matt Montag**.
React (class + hooks) frontend, Express + better-sqlite3 server, C/C++ player
engines compiled to WebAssembly via Emscripten.

- Upstream: `git@github.com:mmontag/chip-player-js.git` (remote `upstream`)
- Our fork: `https://github.com/mdmdj/chip-player-js.git` (remote `origin`)

**Important:** Matt has personally given permission for this feature fork, and
the goal is a merge he will accept. Match existing conventions, keep the diff
minimal and coherent, and do not ship "slop." Read surrounding code before
editing; mirror its style (comment tone, SQL formatting, naming, etc.).

## Branches

Two long-lived branches, one concern each. The PR is defined by topology, not by
a list of commits to remember:

- **`feature/subtunes-as-first-class`** — the PR. Based on `master` and contains
  **only** the sub-tunes feature: `scripts/{build-music,metadata-parsers}.js`,
  `server/{database,index,schemas}.js`, and the feature parts of `src/`
  (components, `Sequencer`, `util`, plus the small `Player.handleSongEnd`
  change). No `dev/` shims, no engine/build tooling, no `AGENTS.md`/`.nvmrc`.
  `git diff master..feature/subtunes-as-first-class` is the reviewable PR.
- **`dev/overlay`** — stacked on top of the feature branch and holds everything
  that must **not** be part of the PR: engine build scripts, `src/bindings/`,
  `src/tinyplayer.c`, the audio parts of `src/players/*Player.js`, vendored-tree
  fixes, `config/webpack.config.dev.js`, the `dev/` shims and browser test hooks,
  `AGENTS.md`, `.nvmrc`, `.gitignore`. Think of it as our personal dev overlay:
  the local setup and tooling we need to work, layered on the reviewable feature.
  This is where the app is developed and run. Lives in our fork (`origin`);
  nothing here is part of the PR.

Workflow: commit feature changes on the feature branch; commit dev/overlay changes
only on `dev/overlay`; then `git rebase feature/subtunes-as-first-class` on the
overlay branch to pick up feature moves. Never commit overlay changes to the
feature branch, and never push either branch to `upstream` — everything stays in
our fork (`origin`). The main worktree (`chip-player-js/`) runs `dev/overlay`; the
feature branch is checked out in the sibling `chip-player-js-feature/` worktree.

## Dev overlay & promotion

`dev/overlay` is the **dirty working branch**: it deliberately mixes feature,
audio/engine and dev-tooling commits, and that is fine. The goal is not a clean
tree — it is a **deterministic, low-effort way to promote feature work to the
parent** without leaking overlay content. The intended path is a single button:

```sh
./dev/promote.sh            # dry run: show the plan
./dev/promote.sh --apply    # promote to feature/subtunes-as-first-class
```

`promote.sh` requires a clean overlay tree, then, for every file that differs
from the feature branch, it:
- skips anything listed in `dev/promote-paths.txt` (overlay-only **areas**:
  `dev/**`, the engine build scripts, `src/bindings/**`, vendored trees, and the
  few "seam" files),
- strips `DEV-BEGIN … DEV-END` regions from the rest,
- promotes only files whose stripped content still differs from the feature
  branch (i.e. real feature work).

It writes the result into the feature-branch worktree and commits it there as one
commit ("Promote feature work from dev/overlay"), leaves `dev/overlay`
untouched, and refuses if `DEV-BEGIN`/`DEV-END` sentinels are unbalanced. After
promoting, `git rebase feature/subtunes-as-first-class` on `dev/overlay` so both
share the feature state.

### Two mechanisms — how to choose

- **Whole files → physical paths.** Dev/engine areas live under paths that never
  overlap feature code, so they never appear in the promoted diff. Add an entry
  to `dev/promote-paths.txt` only for a whole AREA (directory / build file /
  vendored tree) — **not** for individual feature files.
- **Chunks inside a shared file → additive sentinel regions.** Wrap the dev-only
  code so *removing the region restores prod behavior exactly*:
  ```
  // DEV-BEGIN (stripped for promotion; <why>)
  ...dev-only code that only ever ADDS behavior...
  // DEV-END
  ```
  Prefer moving dev-only code into `dev/` or an untracked module; prefer a region
  over a path-list entry. "Additive" is the key property: do not put code inside
  a region that prod also needs.

### The 1–2 hard-coded seams

A few seams genuinely cannot be additive regions, because prod must still load
the real module while dev loads an alternative *instead of* it. These live in
`server/index.js` (`DEV_AUTH_MODULE` require fallback; skia-canvas try/catch) and
are handled by listing the file as overlay-only. At final PR prep these are the
"1–2 lines" to remove by hand. (`src/components/UserProvider.js` can be
region-stripped, but is currently listed for safety.)

### Known gaps (handoff state)

- `dev/promote-paths.txt` still names a few individual shared files
  (`src/config/index.js`, `src/players/{MIDI,N64,XMP}Player.js`) whose dev deltas
  are engine/remote-dev, not feature. That is the "bloat" to remove: convert each
  dev delta to a `DEV-BEGIN/DEV-END` region, then delete the entry.
- A dry run currently promotes ~9 files (`App`, `AppFooter`, `Slider`,
  `TimeSlider`, `index.css`, `winamp.css`, `{GME,Player,VGM}Player`). Confirm
  each is really feature before `--apply`; the classification was made at handoff
  and is due for review.
- After the reverted libvgm attempt, the working tree is clean and VGM/looping
  work (see "Building the real chip-core").

## The feature

Today a "song" is a file. Some formats (NSF/NSFE, SID) contain **multiple
songs (sub-songs / sub-tunes)** in one file. Currently sub-songs have a separate
UI (footer `Tune N of M`, prev/next buttons), and cannot be favorited, shuffled,
or handled like single-file songs.

**Goal:** a single-file song and a sub-song are identical in the UI. A file with
multiple sub-songs is displayed as a **"song folder"**; each sub-song can be
favorited, looped, shuffled, shared, and (in future) playlisted.

## Dev environment

- Node is pinned via **`.nvmrc`** (`24.21.0`, LTS). Use `nvm use` before any
  Node/npm command. (`better-sqlite3@12.5.0` supports 20–25, not 26.)
- Root install: `npm install --ignore-scripts` then `npm rebuild better-sqlite3`.
  (The unused `sqlite3` devDependency cannot build on Node 24; `--ignore-scripts`
  skips it. Root `better-sqlite3` is needed by `scripts/build-music.js`.)
- Server deps: `npm install` inside `server/` (builds `better-sqlite3` and
  `skia-canvas` fine).
- **Dev shims** live in `dev/` on `dev/overlay` only (never on the feature
  branch), tracked so the dev environment is reproducible. They stage
  **untracked, gitignored** modules rather than patching tracked files, so a
  working tree stays clean (`git status` shows only intentional overlay edits):
  - `./dev/apply.sh` — stages untracked `src/chip-core.js`,
    `src/chip-player-devtools.js`, `server/middleware/auth.dev.js` and a
    placeholder Firebase config; patches a dev-user `UserProvider` and a
    silent-SID `SIDPlayer` (reversible, no backups); seeds `users.db` /
    `csdb.db`; writes `server/.env.local` (with `DEV_AUTH_MODULE`); builds
    `catalog/` + `server/catalog.db`.
  - `./dev/remove.sh` — reverts the in-place patches (`--revert`) and deletes
    the staged untracked files. No tracked file is restored from a backup.
  - `node dev/test-parsers.js` — parser harness (20 checks; synthetic buffers +
    real files under `catalog/`).
  - `node dev/test-build.js` — build-music round-trip on a temp catalog subdir
    (sub-tune rows, dates, idempotency, FK-safe delete); cleans up after itself.
  - `node dev/test-sequencer.js` — sequencer navigation with a fake player
    (each sub-tune plays once, mixed contexts advance entry-by-entry). Uses an
    inline Babel require hook; no new deps.
  - `./dev/run-tests.sh` — runs all three. Dev-only, not part of the PR.
  - `dev/README.md` documents the shims.
  - Two tracked seams keep the untracked overrides loadable without touching
    feature files: `server/index.js` requires `process.env.DEV_AUTH_MODULE ||
    './middleware/auth.js'` (overlay-only delta), and the overlay-only
    `config/webpack.config.dev.js` prepends `src/chip-player-devtools.js` to the
    entry. `dev/shims/devtools.js` self-installs `window.__cpDev` (browser test
    hooks: `snapshot`, `setRepeat`, `seek`, `startRecord`, ...) and polls for
    `window.ChipPlayer`. See "Repeat One / looping model".
- Run the app: `npm run dev` (webpack dev server on :3000, API server on :8080).
- **Audio:** the dev stub `src/chip-core.js` is a no-op (no audio). A **real
  chip-core was built** in this session — see "Building the real chip-core"
  below. It is gitignored and not committed.

### Building the real chip-core

Real audio works locally. `scripts/build-subprojects.sh` + changes to
`scripts/build-chip-core.js` build all vendored engines into
`src/chip-core.{js,wasm}`. This work touches vendored trees and lives on
`dev/overlay`, **not** the feature branch. See "Audio engine roadmap" for
what remains.

Prereqs (Arch): `sudo pacman -S cmake emscripten xa` (emcc lands in
`/usr/lib/emscripten`, added by `/etc/profile.d/emscripten.sh`; the script adds
it to PATH; `xa` is the 6502 assembler libsidplayfp needs). Then:

```sh
./scripts/build-subprojects.sh          # all vendored engines
./scripts/build-libsidplayfp.sh         # SID core (mmontag fork, needs xa65)
node scripts/build-chip-core.js
```

Build env vars (all optional):
- `CHIP_NO_SID=1` — skip libsidplayfp. Default already skips when the lib is
  absent.
- `CHIP_ASSERTIONS=2` — assertions + readable aborts (diagnostics).
- `CHIP_DEBUG_NAMES=1` — keep wasm function names for stack traces.
- `CHIP_MALLOC=dlmalloc|emmalloc` — allocator (default `dlmalloc`).
- `CHIP_INITIAL_MEMORY`, `CHIP_STACK_SIZE` — heap/stack sizing.

Status: **GME, libvgm, libxmp, N64 (lazyusf2), V2M, MDX, fluidlite MIDI, SID,
libADLMIDI (OPL3 MIDI)** build and run.

Vendored-tree fixes needed to build (all pre-existing upstream breakage):
- `game-music-emu/gme/CMakeLists.txt`: exclude `Spc_Sfm.cpp` (SFM type disabled);
  add missing `Spc_Cpu.cpp`/`Snes_Spc.cpp`/`Spc_Dsp.cpp` (needed by SPC + VRC7).
- `game-music-emu/gme/blargg_source.h`: define `debug_printf` in the `NDEBUG`
  branch (missing; breaks with `HAVE_ZLIB_H`).
- `libvgm/player/CMakeLists.txt`: drop stale `player_wrapper.cpp` reference (the
  file moved to `src/bindings/` in `cad9a5545` and was never re-added).
- `src/bindings/libvgm-wrapper.cpp`: compat defines (`DEVID_MSM6258/6295` →
  `DEVID_OKIM6258/6295`, `PLAYTIME_*`, drop `parentIdx`).
- libvgm uses its own iconv charset conversion (`utils/StrUtils-CPConv_IConv.c`);
  Emscripten's musl iconv supports the tags libvgm needs (UTF-16LE/CP1252/CP932).
  The libvgm configure passes `-DIconv_LIBRARY=c` because CMake's `FindIconv`
  detects iconv built into libc but then fails its `find_library(c)` check. (An
  earlier no-op `src/bindings/cpconv-shim.c` was removed: it passed UTF-16LE
  bytes through untouched, truncating VGM GD3 tags.)
- `scripts/build-chip-core.js`: `--allow-multiple-definition` (GME and libvgm both
  ship MAME YM2203/YM2608 globals); in-repo `../`→local path normalization; drop
  dead `ALLOC_NORMAL` export; SID/SGC skip logic.
- `src/libxmp-lite`: built directly from `libxmp/src` + lite `format.c` /
  `mod_load.c` (the lite CMake project doesn't configure under CMake 4).
- `src/players/{GME,XMP,MIDI}Player.js`: feature-detect fork-only APIs
  (`gme_disable_echo`, `xmp_seek_time_frame`) and ADLMIDI bank options.

**libADLMIDI (OPL3 MIDI)** is built with the **Nuked** OPL3 core, not DOSBox.
The DOSBox core aborts in `~DosBoxOPL3` (`emscripten_builtin_free`) under this
Emscripten build, so `build-subprojects.sh` compiles ADLMIDI with
`ADLMIDI_DISABLE_DOSBOX_EMULATOR` and without `ADLMIDI_DISABLE_NUKED_EMULATOR`,
and `build-chip-core.js` enables the module and passes `-DTP_ENABLE_ADLMIDI` to
`tinyplayer.c`. The archive is built without `-flto` (global LTO corrupts its
C++ object model). Bank selection and OPL3 playback work; `tinyplayer.c` keeps
`adl_setNumChips` at the default 1 chip.

**libvgm YM2612 core:** libvgm registers the YM2612 device (`SNDDEV_YM2612`) only
when at least one YM2612 core is compiled, and `devDefList_YM2612` picks GPGX
first. The GPGX core (`fmopn.c`) loads YM2612 VGMs but never advances them under
Emscripten (position stuck at 0). Fix: `build-subprojects.sh` builds both
`SNDEMU_YM2612_GPGX=ON` and `SNDEMU_YM2612_GENS=ON` so the device stays
registered, and `libvgm-wrapper.cpp` forces `emuCore[0] = FCC_GENS` for the
YM2612 device after `LoadFile` (same pattern as the SN76496→Maxim and
YMF278B→MAME overrides). Do **not** disable GPGX alone: with no YM2612 core the
device is unregistered and every VGM using it fails with
`RuntimeError: null function`.

**Known issue — N64 seek freeze (pre-existing, not our feature):**
`N64Player.seekMs` → `_n64_seek_ms` → `decode_seek`
(`src/bindings/lazyusf2-wrapper.cpp:368`) synchronously renders every sample to
the target on the main thread, freezing the UI (felt as ~5s). GME avoids this
with a timesliced seek (`GMEPlayer.doIncrementalSeek`, `requestIdleCallback`).
N64 would need the same treatment.

**SID:** built by `scripts/build-libsidplayfp.sh` from **mmontag/libsidplayfp**
(branch `montag-dev-2.14`) (not vendored; clones to `../libsidplayfp`). It is
based on the last release with the classic `ReSIDBuilder` the wrapper uses (3.x
dropped it for residfp) and adds the fast `seek()`/`setTempo()` the wrapper
calls; its reSID changes live in a submodule (`mmontag/resid`), so the clone is
`--recursive` (Matt pushed `mmontag/resid` so this clones reproducibly now —
previously the pinned commits were missing and the fork was unusable). Building
from git assembles the 6502 driver `.bin` files from source, so **`xa65` is
required** (Arch: `pacman -S xa`); the script skips the check when the `.bin`
files already exist (the old v2.9.0 tarball shipped them prebuilt). A
`multilib`/XTREE clone needs `autoreconf -i`, which the script runs.
`build-chip-core.js` probes the header and defines `SIDPLAYFP_HAVE_SEEK=1`, so
`sid_set_position_ms` / `sid_set_speed` are compiled in and call the real fork
APIs (they used to compile out). `setTempo` is verified working and
pitch-invariant. **But `seek()` is WIP in the fork and tune-dependent.** Measured
on the catalog set (seek to 20s mid-playback, then 1s energy per second):

- `Cybernoid_II`: resumes after a ~3s quiet dip, then normal.
- `Monty_on_the_Run`: resumes immediately with a lower first second.
- `Cybernoid`, `Bionic_Commando`: stays silent (all-zero) indefinitely.
- Seek-to-0 (the repeat-one path) is reliable.

Seeking before the first render **hangs** for every tune tested
(`Player::seek`'s `while (timeMs() < ms)` never advances when the event queue is
empty); the app's `?t=` path seeks 100ms after playback starts, so it usually
misses this, but it is reachable. The call is also synchronous: ~10 ms of wall
time per second of target (a 120s seek ≈ 1.3s main-thread block). Until the
fork's seek is finished, expect the slider / `?t=` link to be silent on some
SIDs and to briefly pause on others. This matches prod (its shipped core is
built from the same fork and shows the same Bionic Commando silence), so it is
not a regression from our integration — we deliberately keep the wrapper and app
faithful, with no seek guard or compile-time gate. Plain playback, sub-tune
switching, voice mask, and tempo are unaffected. The old silent-SID dev hack
(`dev/patch-sid-stub.js`) was removed: the real SID core now exports `_sid_*`.

`sid_set_subtune` must call `engine->load(currentTune)` after `selectSong()`:
selectSong only marks the `SidTune`'s current song, so without the reload the
engine keeps playing song 0 while `sid_get_subtune()` reports the requested
index (every sub-tune sounds identical).

### libvgm pin — attempted 2026-09, reverted

The engines are built from **out-of-band clones** that the repo does not track:
`build-chip-core.js` links `../libvgm/build/bin/*.a`, `../libxmp/...`,
`../FluidLite/...`, `../libADLMIDI/...`, `../game-music-emu/...`. The in-repo
`libvgm/`, `libxmp/`, `fluidlite/`, `game-music-emu/` trees are **deprecated
subtrees** (the README says so) and are *not* what the build uses — except that
`normalizeInput` (`build-chip-core.js:478`) falls back to the in-repo copy when
the sibling `../<name>` is **absent**. So a stray clone in `../` silently changes
what gets linked.

Our `libvgm-wrapper.cpp` only carries its `DEVID_OKIM*` / `PLAYTIME_*` /
`LVGM_*` compat because we were building against the **stale in-repo libvgm**
(no `parentIdx`, `DEVID_OKIM*`, bool `GetCurTime`). Against current
`ValleyBell/libvgm` HEAD *all* of that is unnecessary: the wrapper diff vs
master is exactly the 6 loop functions the looping feature adds (+56 / −0).

Attempted to move the pin to HEAD (`c8b998b`, 2026-09-05), reverted because:
- **Runtime drift.** It compiles clean, but `PlayerA::LoadFile` leaves
  `GetPlayer()` null → VGM renders silence (`GetCurTime`, loop getters all 0).
  HEAD is ~8 months ahead of what the wrapper/engagement expects.
- **`wasm-opt`.** The post-link `wasm-opt` step failed (binaryen validation
  error). Cosmetic: the un-optimized wasm is valid and exposes every export, just
  ~600 KB larger. **No pacman package fixes it** — Arch's `emscripten 6.0.9`
  ships its own `wasm-opt` (binaryen 132); `extra/binaryen` is older (130).
- Restored the stale in-repo libvgm + compat; VGM/looping work again (verified
  `loopStart/End`, `fadeStart`, repeat-one.

To resume the pin: target a revision just after `parentIdx` was added
(2026-01-21, upstream `57585ea`) to minimise drift, then fix the `LoadFile` /
`GetPlayer` integration. First `rm -rf ../libvgm` so `normalizeInput` picks the
in-repo tree, or intentionally point the build at the new clone.

### Dev environment gotcha

The T3 Code browser-preview tab logs an Electron sandbox error
(`Electron sandboxed_renderer.bundle.js script failed to run` /
`Cannot destructure property 'preloadScripts' of 'binding.startupData'`) and a
blank tab shows `chrome-error://chromewebdata/`. It still works once you
navigate it to `http://<host>:8080` (e.g. `mms-1:8080`); drive the app there or
verify quickly over HTTP with `curl http://localhost:8080/api/...`.

**Keep tool requests small — treat this as a hard rule.** The frequent failure
is the LLM provider rejecting an entire turn once the session context grows
large, not the tool transport itself. Measured from `~/.local/share/opencode`
(`opencode.log` + `opencode.db`): with `deepseek-v4.1-flash`, sessions up to
~1.8 MB of accumulated message parts completed, while sessions past ~3 MB
returned HTTP 400 (`AI_APICallError: Bad Request`, mid-stream) on every retry.
Context is cumulative, so a few large tool results early poison the rest of the
session — retrying in the same session does not recover, so start a new session
per task. Rules:
- `evaluate`: one step per call. No long inline scripts, big loops, or
  returning arrays/objects of rows. Stash state on `window`/`localStorage` and
  reuse it; return only the few scalar fields you need. If it's more than ~2-3
  lines, split it into separate calls.
- `snapshot`: pass `includeImage:false`; never dump the accessibility tree,
  console, and network at once; prefer a targeted `evaluate`.
- `read`: read a small range (`offset`/`limit`, ~40 lines) around the target;
  `grep` for the line first. Don't re-read whole large files.
- `bash`: redirect noisy output to a log under `/tmp/opencode` and print only a
  few lines (`tail -5`, `grep -c`). Never `find /` or dump full build logs.
- Session hygiene: outputs are cumulative and cannot be removed from context.
  Never paste whole files, whole logs, large JSON, or screenshots into context;
  prefer counts, short tails, scoped ranges, and summaries. If a turn starts
  returning provider 400s, start a fresh session rather than retrying.

Separate, rarer tool-layer flakes exist and are not this issue: the preview
automation can drop a tab (`No active preview tab` / `evaluate failed`), and
`pkill -f <pattern>` can match the shell running it. Re-open/re-navigate the
preview or rerun the command when that happens.

**Verifying playback from the preview.** The app exposes itself as
`window.ChipPlayer` and the live wasm core as `window.ChipPlayer.chipCore`, so
you can drive the exported `_*` functions directly from `evaluate` and measure
the rendered audio instead of listening. E.g. `_sid_init(48000)`,
`_sid_load_data`, then sum `HEAPF32` over a `_malloc`'d buffer filled by
`_sid_render`: files/sub-tunes that are actually different give clearly
different totals (all-equal energies usually mean selection isn't switching —
that's how the `sid_set_subtune` bug was caught). Two preview gotchas:
`preview_navigate` to the *same* URL may not re-instantiate the wasm, so append
a cache-buster (`?r=2`) to force a real reload; and `Player.copyToHeap` does
`HEAPU8.set(data, ptr)`, which silently copies nothing when `data` is an
`ArrayBuffer` — pass a `Uint8Array` (as `Sequencer.playSongBuffer` does). Start
direct probe sessions on a fresh page so they don't collide with the player's
own core state.

### Dev catalog fixtures

`catalog/` is gitignored and user-supplied. As of this branch it holds a
mixed-format set useful for manual testing: the Famicompo NSFE tree (many
multi-song files), a `sid/` set, `n64/Blast Corps/` (65 `.miniusf` + one
shared `.usflib`), `mods/` (`.S3M`), `midi/`, and a `.vgz`. Rebuild with
`node scripts/build-music.js -n` after changing it. Note `.usflib` companions
are intentionally not indexed but must stay next to their `.miniusf`; a
gzipped VGM must use the `.vgz` extension (`.gz` is not recognized).

## Catalog / server data model

### Parsers (`scripts/metadata-parsers.js`)

- `parseNSF`: songs at header `0x06` (count), `0x07` (1-based start).
- `parseNSFe`: chunked format, tags are **forward ASCII** (`INFO`, `auth`,
  `tlbl`, `plst`, `time`, `fade`, `NEND`), stream starts at offset 4 (no
  embedded NSF header). `INFO.track_count` (data offset +8) is the number of
  *physical* tracks; `plst` (byte array of physical indices) is the
  authoritative sub-song list AND order. **This mirrors game-music-emu**
  (`game-music-emu/gme/Nsfe_Emu.cpp:34-46,199-202`): with a non-empty playlist
  `track_count = playlist.size()` and track N remaps to `playlist[N]`;
  otherwise all physical tracks are used 1:1. `tlbl` gives per-track labels.
  NSFE `first_track` is **0-based** (store as `startingSong = first + 1`).
- `parseSID`: PSID/RSID. Strings at fixed offsets `0x16/0x36/0x56` (32 bytes
  each). Song count word at `0x0E`, start song at `0x10`. v2+ packed
  PAL/NTSC speed bits at `0x18`, bit i => PAL. **Do not** read strings from the
  header offset field at `0x06` (that is the *data* offset).
- Release dates: the formats don't have a dedicated date field, so `extractDate`
  scrapes a year (or full date) out of free-form strings — NSF/NSFE/SID
  `copyright` / `released` (e.g. `"1988 Konami"`, `"(C)1984 CAPCOM"`,
  `"2008-2009"`), and VGM GD3's explicit release date. Missing parts default to
  Jan 1 (`"2003"` -> `"2003-01-01"`). `meta.date` is stored on `music` as
  `release_date`; `describeSubtunes` also honors a per-track `meta.trackDates`
  (no parser emits one yet, but the resolution chain supports it).
- Real-file counts were validated against GME semantics (e.g. Castlevania III
  = 36 not 242; Gimmick! = 73 not 106; Gradius II plain NSF = 65 but
  Gradius II NSFE = 16, because only NSFE has `plst`).

### Schema (`scripts/build-music.js`)

`music` = one row **per file** (the downloadable unit). `subtune_count`
(denormalized) is the number of playable sub-songs (1 = single song).
`music.release_date` is the metadata date (ISO), and `subtune.date` a
per-sub-tune date (currently always NULL).

```sql
CREATE TABLE subtune (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  music_id INTEGER NOT NULL,
  subtune INTEGER NOT NULL,   -- 0-based, matches player subtune index
  title TEXT,
  length_ms INTEGER,
  date TEXT,                  -- per-sub-tune date, when a format provides one
  sort_order INTEGER DEFAULT 0,
  UNIQUE(music_id, subtune),
  FOREIGN KEY(music_id) REFERENCES music(id)
);
CREATE INDEX idx_subtune_music ON subtune(music_id);
```

- Only multi-song files get `subtune` rows. A single-song file has none, so a
  sub-song and a plain song are the same kind of thing to the client.
- `subtune.title` is set only when the format provides a label; otherwise it is
  `NULL` and clients fall back to `Tune N`. (`describeSubtunes` no longer invents
  a `Song N` placeholder — that was inconsistent with the fallback.)
- `subtune_fts` (fts5, `content='subtune'`) + `ai/ad/au` triggers mirror
  `music_fts`, making sub-song titles searchable.
- `processFile` clears a file's old sub-tune rows **before** the
  `INSERT OR REPLACE` on `music` (foreign keys are enforced, so the replace
  would otherwise fail). A `ensureColumn` shim adds `release_date`/`date` to
  DBs created before those columns existed.
- `--reset-db` drops child tables **before** `music` (FK order).
- Incremental runs are idempotent (verified, including reprocessed multi-song
  files). A `subtunes` JSON column was tried and **removed** in favor of the
  normalized table.

Verified on the real catalog: 1244 files, 621 subtune rows, 59 multi-song files,
428 files with a parsed `release_date`.

### Server API (`server/database.js`, `server/index.js`)

- `getDirChildrenStmt` now returns `subtune_count`.
- New: `searchSubtuneStmt`, `getSubtunesStmt`, `getSubtuneMetadataStmt`.
- `/browse`:
  - In a directory, a file with `subtune_count > 1` is `type: 'songfolder'`
    with `count = subtune_count`, `url: null`. Client navigates to
    `/browse/<path>` like a directory. A file/folder row's `mtime` prefers the
    parsed `release_date` over the file system mtime.
  - When `path` names a multi-song file, returns its sub-tunes as
    `type: 'file'` rows with `name` (label, or `Tune N` when unlabeled),
    `subtune`, `song_id`,
    `durationMs`, `url = /?play=<songId>&subtune=N`. Each row reuses the parent
    file's `size`, and `mtime` resolves **subtune date -> file `release_date` ->
    file system mtime** (as Unix seconds).
- `/search` unions `searchStmt` (file titles) and `searchSubtuneStmt`
  (sub-song titles); sub-song hits carry `subtune` + `title`, and files already
  matched at file level are de-duplicated.
- `/metadata?path=...&subtune=N` returns `subtuneTitle`.
- `/shuffle` and `/random` return `{path, subtune}`; a multi-song file shuffles
  as a random sub-song.
- `/playback` accepts `subtune`; `playbacks` gains a `subtune` column
  (idempotent `ALTER TABLE` in `server/database.js`, also in the dev seed).
  `/top` (global, user, and metric=favorites) groups by `(song_id, subtune)`
  and returns `subtune`, `subtune_count`, and `subtune_title`.

## Client identity model: `SongRef`

A playable thing is `{ path: string, subtune: number }` (subtune 0 for
single-song files). Helpers in `src/util.js`:

- `songRef(pathOrRef, subtune = 0)` — normalize string/object/item to SongRef.
- `songRefKey(pathOrRef, subtune = 0)` — stable identity string (NUL separator),
  for `===`-style comparisons and React keys.
- `songRefsEqual(a, b)`.

`src/Sequencer.js` (updated):
- `context` is an array of SongRefs; `playContext` normalizes via `songRef`.
- `playContext(context, index = 0, subtune = null)` — `subtune` is now an
  **optional override** for the first song (used by `?play=...&subtune=N`);
  normally the sub-tune lives in the SongRef.
- `playCurrentSong()` / `currContextRef()` derive the ref (shuffle-aware).
- `playSong(songRefOrPath)` accepts a ref or bare string; sets
  `currSongRef` (and `currSongPath` for the player/UI/metadata).
- Emits `songRef` in `sequencerStateUpdate`.
- `getCurrSongRef()` added.
- **Sub-tune navigation is the sequencer's job, not the player's.** A player
  plays exactly one song and stops (`Player.handleSongEnd` no longer chains
  `playSubtune(next)`), so `nextSong()` advances one context entry. Every
  sub-tune is its own SongRef/context entry, which makes a directory of MIDI
  files, a song folder, and a mixed search/favorites context behave the same.
  The old footer `Tune N of M` + back/forward UI is gone; `currentSongSubtune`
  / `currentSongNumSubtunes` state, `Sequencer.prevSubtune` / `nextSubtune` /
  `getSubtune` / `playSubtune`, and `App`'s sub-tune props were removed. The
  only place a sub-tune index lives is the SongRef.

`src/util.js`: `getMetadataUrlForFilepath(filepath, subtune = null)` appends
`&subtune=`. `songRefListsEqual` compares two ordered SongRef lists (needed
because `Sequencer` copies its context).

## Favorites / migration notes

- Favorites are stored per user as JSON `{songId, mtime, href|path, subtune}` in
  `user_db.playlists` (type `favorites`). `songId` is the **file** hash, so the
  sub-tune is what distinguishes entries.
- **Old favorites keep working:** a missing `subtune` means sub-tune 0 / the
  parent file. Add optional `subtune`; do not rewrite old rows. For a multi-song
  file this resolves to the song-folder entry.
- Share links are canonical as `/?play=<songId>&subtune=N`
  (`App.getCurrentSongLink`, `App.js` startup parse). No link migration.
- `getFavoritesStmt` decorates each item with `href`, `path`, `size`,
  `subtuneCount`, and `subtuneTitle` (looked up by `(music_id, subtune)`). The
  Favorites list shows the label, or `Tune N` when unlabeled; toggling
  re-fetches so optimistic entries get the same decoration.
- **Testing favorites in the dev app:** the server auth bypass makes the API
  usable, but the client's own `user` state (Firebase) stays null. The dev
  webpack config sets `REACT_APP_DEV_USER`, which `UserProvider`'s single
  `DEV_USER` gate turns into a fake `user` with `getIdToken()` (uid `dev-user`,
  token `dev-token`), so the heart button and favorites API work in the browser.
  No tracked file is patched; see "Dev overlay & promotion".

## Current state

**Done and verified:**
1. Parsers (NSF/NSFE/SID) with sub-tune counts/labels — tested.
2. Normalized schema (`subtune` table, `subtune_count`, `subtune_fts`) —
   rebuilt and verified against the real catalog.
3. Server API: `/browse` songfolder + sub-tune listing, `/search` union,
   `/metadata` subtune title — verified via curl.
4. `SongRef` helpers in `util.js`; `Sequencer` migrated to SongRef contexts.
   Sub-tune navigation is sequencer-owned: the player plays one song and stops,
   and every sub-tune is its own context entry (see `src/Sequencer.js` notes).
5. Client migrated to SongRefs: `App.js` (`directoryListingToContext`,
   `fetchDirectory`, `getCurrentSongLink` from `currSongRef.subtune`,
   `songTitleKey`/`subtuneTitle` metadata), `VirtualizedList` (`songRefKey`
   highlight, `songfolder` navigates), `Browse` (`<SONGS>` rows),
   `Favorites`/`FavoriteButton`/`UserProvider` (keyed by `(path, subtune)`,
   grouped under directory/song-folder headings), `Search` (sub-tune hits),
   `AppFooter` (favorite + share link carry subtune), `LocalFiles`/`TopCharts`
   (SongRef contexts). The footer's sub-tune-specific nav/label is gone.
6. Server `/shuffle` and `/random` return `{path, subtune}`; a multi-song file
   shuffles as a random sub-song. (`/random` had a latent leading-slash bug;
   fixed.)
7. Favorites server: `FavoriteSchema.subtune`, add/remove statements keyed by
   `(path, subtune)` — verified via curl (add two sub-tunes + a plain file,
   then remove one sub-tune and confirm the others remain). `getFavoritesStmt`
   also decorates items with `size` and `subtuneTitle`, so the Favorites list
   shows the catalog title and falls back to `Tune N`. UI-verified in the dev
   app, including legacy favorites without `subtune` and per-sub-tune isolation.
8. Dates and sizes: parsers scrape a release date from free-form metadata
   (`extractDate`), stored as `music.release_date` / `subtune.date`; `/browse`
   sub-tune rows resolve date as subtune -> file metadata -> file mtime, and
   reuse the parent file's `size`. File/songfolder rows also prefer
   `release_date` over mtime. `processFile` clears sub-tune rows before the
   `music` REPLACE (FK ordering fix for incremental reprocessing).
9. `AppFooter` shows the full song-folder path (and links into it) for
   multi-song files; `isSongFolder` is derived from `/metadata`'s
   `subtuneCount` (catalog) with a cached `subtuneTitle` as fallback (the dev
   stub doesn't report sub-tunes).
10. `playbacks.subtune` + sub-tune-aware Top Charts: `/playback` carries the
    sub-tune, and the global/user/favorites top queries group by
    `(song_id, subtune)`, returning `subtune`/`subtune_count`/`subtune_title`
    so `TopCharts.js` labels and plays the exact sub-song.
11. Downloads: `getUrlFromFilepath` encodes per path segment, so browsers name
    downloads correctly instead of using the whole path.
12. Real audio locally: a chip-core wasm build works (GME/libvgm/libxmp/N64/
    V2M/MDX/fluidlite MIDI). Gitignored and not committed; the current engine
    pin/build is documented under "Building the real chip-core" ("libvgm pin").
13. Repeat One for VGM (libvgm) — the looping baseline. Native loop count plus a
    band-relative "playlist position" so the head repeats the highlighted loop
    region, and switching repeat off plays past into the fade with no head jump.
    The full toggle matrix is green (see "Repeat One test matrix"), including
    the fixes this surfaced: the base end detector respects
    `isPlayingIndefinitely()` (indefinite playback no longer dies at durationMs
    when Skip Silence is on), the head no longer folds into the band with
    repeat off / mid-fade enable, the loop count is only re-derived when
    actually leaving a looping state, and leaving a deep repeat plays the full
    fade (`durationExtended`) instead of ending instantly. On `dev/overlay`.

**Caveat:** `Sequencer.playContext` copies its context, so array-identity
checks no longer work. Compare a live context to a stored one with
`songRefListsEqual` (used by the local-files checks in `App` and the
`LocalFiles` highlight); compare rows with `songRefKey`.

## Session hand-off notes (read me first)

- **Branch model:** see "Branches" above. `feature/subtunes-as-first-class` is
  the PR (feature only); `dev/overlay` is stacked on it and holds the
  audio/engine/build/dev work. There is no commit list to maintain — a change
  either belongs to the feature branch or it does not. Run the app from the dev
  branch.
- **Handoff state (2026-09, read this):**
  - **Looping is now the top priority** and is treated as **feature** work (part
    of completing the sub-tunes feature), not an overlay extra. The VGM Repeat
    One baseline is implemented and the full toggle matrix is verified; see
    "Repeat One / looping model" and the test matrix. This session fixed five
    interaction bugs on `dev/overlay`: indefinite playback ended early under
    Skip Silence (`469a8c78a`), the head folded into the band with repeat off
    (`0b8d76781`) or when repeat was enabled mid-fade (`082b83cb2`), the
    Off→All no-op toggle re-derived the loop count and jumped (`96683ba3e`),
    and leaving a deep repeat cut the song instead of playing the fade
    (`08e3bc86b`). GME was probed in-app and has no loop regions in this
    catalog (whole-track restart already complies); MIDI CC 102/103 is the
    next format.
  - **Overlay/promote system** is in place but **WIP**: `dev/promote.sh` +
    `dev/promote-paths.txt` + `DEV-BEGIN/DEV-END` regions. See "Dev overlay &
    promotion" for the mechanism and the **Known gaps** (a few shared files are
    still path-listed and should become regions).
  - **The libvgm pin move was attempted and reverted** (runtime drift +
    `wasm-opt`). Working VGM again; see "libvgm pin" above. Do not leave a stray
    `../libvgm` clone around — it hijacks the link.
  - **Branches pushed to `origin`**: `dev/overlay`, `feature/subtunes-as-first-class`;
    `origin/master` is untouched. Worktrees: main = `dev/overlay`, sibling
    `chip-player-js-feature/` = feature.
  - **Dev shims are untracked-stage, not tracked patches** (no more
    `*.dev-backup` / `--revert` for auth/UserProvider). `dev/apply.sh` /
    `dev/remove.sh` manage them; `git status` stays clean after apply.
  - The PR was last promoted at commit `51cf89a1e` on the feature branch, then
    reset to `d44899faf` during the promote rework. Re-run `./dev/promote.sh`
    (dry run first) to see the current feature delta.
- **Remote dev access (LAN/WSL/Tailscale):** fixed, dev tooling only (not the
  feature). Two root causes:
  - `scripts/start.js` built its own minimal `WebpackDevServer` options and
    silently ignored the whole `devServer` block in
    `config/webpack.config.dev.js`, so `allowedHosts: 'all'` never applied and
    the WS `Host`/`Origin` check rejected remote clients (`Invalid Host/Origin
    header`, reconnect loop). It now spreads `config.devServer`. This also makes
    the block's `hot: false` effective (HMR off, full live reload) and enables
    its middleware. The stale `.wasm` middleware had to be removed because it
    served from `public/` and 404'd the emitted `static/js/chip-core.*.wasm`;
    webpack-dev-middleware already serves it as `application/wasm`.
  - `src/config/index.js` hardcoded `http://localhost:8080` for the dev API,
    catalog, and soundfonts, so a remote browser called its own localhost
    (`ERR_CONNECTION_REFUSED`). It now uses `window.location.hostname`
    (falling back to `localhost` in Node). Restart `npm run dev` after changing
    either file.
- **Test audio on a remote machine:** start `npm run dev`, then browse the
  remote host on :8080 (the Express server proxies to WDS :3000). Verified via
  the T3 preview at `mms-1:8080`: API/wasm/catalog/soundfont requests 200, WS
  opens, and a clicked song plays. The `/preview` route needs skia-canvas;
  everything else is fine over Tailscale.
- **Verified playing:** NSF/NSFE/SPC/GBS/AY (GME), VGM/VGZ/GYM/S98/DRO (libvgm,
  including the YM2612 Gens fix), TG16/Game Boy/Neo Geo/Capcom/Konami VGZs,
  MOD/S3M/XM/IT (libxmp-lite), N64 `.miniusf`, V2M, MDX, MIDI (fluidlite + a
  SoundFont), SID (mmontag fork; sub-tune switching verified). Repeat-one over
  loop regions and the slider loop band are verified.
- **Still broken / missing:** SID `seek()` to a non-zero position (fork WIP and
  tune-dependent: some tunes resume after a brief dip, others stay silent; a
  seek before first render hangs; seek-to-0 works); N64 seek freezes ~5s while
  timeslicing lands (pre-existing, unrelated to the feature). See "Audio engine
  roadmap" for the ordered plan.

## Remaining TODO / roadmap

1. **Looping / Repeat One across all formats — now the top priority.** The goal
   is one intuitive Repeat One for every format, for single files and sub-tunes,
   with no jarring audio or visual artifacts on enable/disable. See "Repeat One /
   looping model" below for the contract and the VGM baseline.
2. Testing. Dev-only harnesses now cover parsers (`dev/test-parsers.js`) and a
   build-music round-trip (`dev/test-build.js`), run via `./dev/run-tests.sh`.
   They are removed with `dev/` before the PR, which still ships without tests
   (matching the repo, which has no test runner or CI). If Matt wants a durable
   suite, the same harnesses could move to a tracked `test/` dir and run via
   `node --test` with no new deps.
3. Known unsupported formats (don't add to `FORMATS` without a player/parser):
   plain `.usf` sets (only `.miniusf` is supported), PSF/PSX (`psflib` is reused
   only by the USF loader; no PSX core), and PSM (`libxmp-lite` = it/mod/s3m/xm;
   the files here are the MASI variant, which needs full libxmp).
4. **Audio engine roadmap** (separate from the feature; see "Building the real
   chip-core"). Ordered by impact × risk:
   - **Done:** emscripten build of GME/libvgm/libxmp/N64/V2M/MDX/fluidlite; YM2612
     fixed (force the Gens core); GME↔libvgm symbol clash masked with
     `-Wl,--allow-multiple-definition`.
   - **(1) SID — fork builds; `setTempo` done, `seek` still WIP.** Built from
     `mmontag/libsidplayfp` (`montag-dev-2.14`, recursive) by
     `scripts/build-libsidplayfp.sh`; verified rendering, sub-tunes, sub-tune
     switching, voice mask, voice groups, and tempo. Matt pushed `mmontag/resid`
     and pointed the submodule at it, so the clone and build are reproducible
     (`SIDPLAYFP_HAVE_SEEK` probes to 1; requires `xa65` for the 6502 driver
      `.bin` files). **`seek()` is WIP and tune-dependent**: Cybernoid II and
      Monty-on-the-Run resume (with a brief dip), Cybernoid and Bionic Commando
      stay silent, and a seek-before-play hangs for every tune tested (see "SID"
      above). Seek-to-0 is reliable. Prod uses the same fork and behaves the
      same, so this is faithful, not our regression; an upstream fix is still
      needed for the slider / `?t=` links to be trustworthy on SID. Also pin the
      fork branch to a commit for reproducible builds.
   - **(2) GME → `mmontag/game-music-emu` fork + newer libxmp, and prune GME.**
     Restores `gme_disable_echo` / `xmp_seek_time_frame` /
     `fluid_synth_get_active_voice_count` (all feature-detected today). While
     there, delete the `--allow-multiple-definition` hack by not linking GME's
     OPN copy at all (trap below).
   - **(3) Per-engine wasm modules (isolation epic).**
     One Emscripten `Module` per engine (own linear memory/FS) instead of one
     flat blob with global C symbols. Matches the existing per-extension player
     design (`Sequencer.players.find(canPlay)`, libvgm `SetDeviceOptions(FCC_*)`,
     soundfonts via `_tp_*`) and contains the C-global "virus" at a module
     boundary. Caveats: each module owns its heap/FS, so soundfont loading and
     the shared visualizer (`_cqt_*`) need a plan (MIDI's soundfont FS moves with
     the MIDI module). Prefer static per-engine modules over Emscripten
     `SIDE_MODULE`/`dlopen` (dynamic linking is high-risk: memory growth, GOT,
     async init, and the audio callback wants synchronous calls).
   - **(4) libADLMIDI (MIDI OPL3) — done (Nuked core).** Enabled and playing;
     the `~DosBoxOPL3` abort is avoided by building Nuked instead (see
     "libADLMIDI" above). Isolation (step 3) would still shrink the blob and
     contain its OPL cores, but is no longer required to ship OPL3 MIDI.
   - **(5) N64 seek freeze — done.** `N64Player.seekMs` now timeslices
      `_n64_seek_ms` in idle callbacks like GMEPlayer (pre-existing bug,
      unrelated to the feature; committed separately).

   **Traps / learnings:**
   - `SNDDEV_YM2612` is registered only when a YM2612 core is compiled. Disabling
     GPGX alone drops the device and every YM2612 VGM throws
     `RuntimeError: null function`. Keep GPGX compiled and force `FCC_GENS`
     per-device in the wrapper (see "libvgm YM2612 core" above).
   - `--allow-multiple-definition` is luck, not safety: GME's
     `fm.c`/`fm2612.c`/`Ym{2203,2612}_Emu` and libvgm's `fmopn.c` export the same
     MAME OPN C globals (`ym2203_init`, `ym2612_write`, `OPNWriteMode`,
     `FM_OPN`). C has no namespaces and static archives don't scope symbols, so
     one copy is silently dropped. Prefer not linking the unused copy (GME only
     needs OPN for VGM/GYM/HES, which the app routes to libvgm); `objcopy
     --prefix-symbols` is the fallback when you can't.
   - The repo's vendored engines are **not** what prod uses. Upstream has no
     submodules, and both its and our `game-music-emu`/`libxmp` lack APIs the
     build exports. Prod's shipped `chip-core.*.wasm` contains the strings
     `sidplayfp`/`adlmidi`/`GPGX`/`Gens`/`MAME`/`FluidLite`/`OPN2`, proving it is
     built from forks/newer versions. Don't trust the README/vendored source;
     confirm empirically. Prod's wasm **exports are minified**, so compare
     embedded strings plus the JS glue's `_sid_init`/`_adl_init`/… names, not the
     wasm export table.
   - Build/allocator: `dlmalloc` (configurable) and `INITIAL_MEMORY=128MB` vs
     upstream's `emmalloc`/64MB. `-flto` makes duplicate-symbol collisions worse;
     drop it for archives you are trying to keep separate.
5. Before PR: the feature branch is already feature-only, so there is nothing to
   strip. Push `feature/subtunes-as-first-class` to our fork (`origin`) and open
   the PR against `mmontag:master` — never push to `upstream`, and never include
   `dev/overlay`. The diff is `git diff master..feature/subtunes-as-first-class`.

## Repeat One / looping model

The north star for this work (top roadmap item): **one intuitive Repeat One for
every format**, single files and sub-tunes alike, seamless on enable/disable,
with no jarring audio or visual artifacts. Guiding principle: *loop the region
the composer intended, as the game would play it*, using native engine looping
wherever possible and faking it only when there is no alternative.

### The two clocks

Keep these separate; use each for its own purpose:

- **Time playing** (`Player.getPositionMs`, absolute): includes completed loops.
  Drives engine/fade bookkeeping and end detection.
- **Playlist position** (`Player.getDisplayPositionMs`, single pass): what the
  slider head and the left time label follow. It folds/advances within the loop
  region (and into the fade when leaving). `Player` defaults it to
  `getPositionMs`; players that can loop override it.

Position/head flow: `AppFooter` polls `getDisplayPositionMs()` every 100 ms
(`TimeSlider`), so both the head and the label come from the player. Never derive
the displayed position in the component layer (the old `AppFooter` fold hack was
removed).

### The highlighted loop band

The band on the slider is the **last loop instance that is not within the fade**
— with the default intro + two passes + fade it is `I1 = [A+B, A+2B)`, where
`A = intro_length` and `B = loop_length`. Rationale: give the user as long as
possible to decide to stay, and keep the band from moving when repeat toggles.
`AppFooter` shows the band when the track defines a loop region, gated by the
Global Settings "Show Loop Area" toggle (default on; visual only — hiding the
band never changes playback or the head fold).

**Done — the band math used to be engine policy in a component.**
`AppFooter.js` had `const lastLoopInstance = 2`, which is libvgm's
`pCfg.loopCount = 2` (`libvgm-wrapper.cpp`) restated as a magic number in the
view layer. The computation now lives behind the player method
`getLoopBandMs()` returning `{ startMs, endMs }`, and `AppFooter` only maps ms
to the slider's 0..1. The base `Player` holds the generic implementation over
the shared `intro_length`/`loop_length` vocabulary (VGM maps its region into
those field names, so no override is needed today); engines whose loop
semantics differ override it. `VGMPlayer.getDisplayPositionMs` reads the same
hook instead of recomputing the band.

### Repeat One contract

- **Enable (any time):** loop the region natively/forever; no seek, no jump. The
  head cycles inside the band. If enabled after the region, finish the current
  pass first (via `restartAtEndPending` or the player's native equivalent),
  never jump the transport backward into the loop. If a fade is already running
  when repeat is enabled (enabled mid-fade), the audio finishes that fade and
  the song ends; the head must proceed through the fade region, not fold back
  into the band — VGM captures the fade start at enable time for this.
- **Disable (any time):** *play past* the loop region as if repeat was never on:
  finish the current pass, then the fade, then end/advance. The head must be
  **continuous across the toggle** (same display mapping before and after), then
  run the fade tail from the band end. Never jump.

### Code placement (what may know about what)

The engine-specific loop policy lives in the engine's own player class; only
polymorphic hooks reach the shared layers. Keep it that way — the layering is
the whole defense of the design.

| Layer | May know about engines? | Loop surface |
| ------ | ------------------------ | ------------ |
| `Sequencer.js` | no | none; only `setLooping(repeat === REPEAT_ONE)` (pre-existing) |
| `src/components/` | no | none; `getDisplayPositionMs()` ms -> slider 0..1 |
| `Player.js` (base) | no | `getLoopEndMs()`, `getDisplayPositionMs()` (defaults to `getPositionMs`), `isPlayingIndefinitely()` (defaults to `this.looping`) |
| `XxxPlayer.js` | yes, only itself | overrides the above |
| `src/bindings/*-wrapper.cpp` | yes, only itself | capability-neutral getters/setters; no policy |

Two rules that keep it honest:

- **The base class must not name a param or an engine.** Base
  `isPlayingIndefinitely()` deliberately returns only `this.looping`; the
  `indefinitePlayback` param is OR'd in by the players that have it. Don't
  promote that param into the base.
- **The metadata vocabulary is GME's and pre-existing** (`intro_length` /
  `loop_length`, read off `gme_info_t`). `VGMPlayer` maps libvgm's
  `loopStart`/`loopEnd` into those field names rather than inventing a schema,
  which is what lets one generic base method and one component read a single
  shape.

**TODO — `restartAtEndPending` is a half-landed mechanism.** The base honors it
in `processAudio` (only when the position reaches the duration), but no engine
currently leaves it set: `VGMPlayer` clears it in `setLooping` (libvgm loops
natively, so the late `seekMs(0)` would fight it), and `GMEPlayer` restarts the
track itself in its `playIndefinitely` block, making it partly redundant. Either
wire it to a player that actually needs the "finish the song, then restart"
behavior, or drop it from the base until one does. "Who consumes this?" is a
fair review question and "nobody yet" is a weak answer.

### Repeat One test matrix

Every permutation below must be jump-free (head continuous at the toggle
moment) and must not truncate the audio arc. Reference numbers are for
`catalog/arcade-capcom/Ghosts'N_Goblins_(Arcade)/16 Hurry Up!.vgz` — A = 342,
B = 800, band = [1142, 1942), two-pass duration = 6442, libvgm fade = 4 s +
0.5 s silence. Toggle positions: **pre** = abs ≤ A+B (lead-in/first pass),
**band** = fold region while looping, **tail** = abs > A+2B (fade running).

| # | Transition | Toggled at | Expected | Verified |
| - | ---------- | ---------- | -------- | -------- |
| 1 | Off→All | any | No-op for a single track: count and head untouched | ✓ tail |
| 2 | All→Off | any | Same code path as #1 | via #1 |
| 3 | Off→One | pre | Fold takes over at the next band entry; no jump | ✓ |
| 4 | Off→One | tail | Fade already running: audio finishes it and ends; capture rides the head on the tail (no fold-back) | ✓ |
| 5 | All→One | tail | Same code path as #4 | via #4 |
| 6 | One→Off/One→All | pre, curLoop < 2 | Count re-derived `max(2, curLoop+1)`; continuous; plays out pass + fade | ✓ curLoop 3 |
| 7 | One→Off/One→All | deep, curLoop ≥ 2 | `durationExtended`: pass finishes, full fade + silence, ends at extended abs; display lands at 100 % (two-pass duration) | ✓ curLoop 9 → 12843 |
| 8 | Repeat One from start | — | Head cycles in band across deep loops (abs 67541 → disp 1941 over 83 loops) | ✓ |
| 9 | Repeat off from start | — | Head live through intro + 2 passes, then tail from bandEnd to 100 % | ✓ |

Cross-cutting checks (all with Skip Silence 0 *and* None — the end detector is
only armed when `silenceDuration >= 0`, and both arms must end the song):

- Indefinite Playback on/off mirrors #3–#7 through the `setParameter` path
  (`syncFadeTailCapture` + `applyLoopCount(wasLooping)` are shared).
- Seek during a captured tail drops `fadeTailStartMs` (backward seek also
  cancels libvgm's fade); a seek backward after #7 leaves `durationExtended`
  set — benign, cleared on next load, engine still ends the song.
- Song end/advance: engine ends (render 0) under looping/#4/#7; sequencer
  advances and the next entry starts with fresh state.
- Engine keeps looping through the fade (`curLoop` increments); a short loop
  plays several iterations inside the 4 s fade (Hurry Up! ≈ 5), a long loop
  gets cut mid-iteration (`03 Survival.vgz`). Files with no loop region
  (`07 Easy Holiday.vgz`) end after a single pass even with indef on.

### VGM (libvgm) — the working baseline

- Native loop count: repeat-on = `_lvgm_set_loop_count(ctx, 0)` (0 = forever);
  repeat-off = `max(2, curLoop+1)` so the current pass finishes and libvgm fades
  at the next boundary — but only when actually *leaving* a looping state
  (`applyLoopCount(wasLooping)`). The engine keeps looping through the fade
  (curLoop keeps incrementing; a short loop plays several iterations inside the
  fade), so re-deriving the count on a no-op transition (e.g. the Off→All
  repeat toggle mid-tail) moves the configured fade start past the fade that is
  already running and the head folds back into the band. `setLooping` clears the
  base `restartAtEndPending`
  (libvgm loops natively; the base late-repeat `seekMs(0)` would fight it).
- Leaving repeat one after more than the default loop count sets
  `durationExtended`: the position is already past the load-time duration, so
  the base end detector (re-armed now that looping is off) would end the song
  instantly, before the re-scheduled fade starts. `isPlayingIndefinitely()`
  covers the flag so the current pass, the fade, and the trailing silence play
  out and the engine's own end (render 0) ends the song. The playlist clock is
  untouched — the display tail runs from the band end for exactly fade +
  silence, landing at the two-pass duration (= 100%) when the song ends.
- The display mapping in `VGMPlayer.getDisplayPositionMs`: phase
  `(abs - A) mod B` mapped as `bandStart + phase`; before the first body
  (`abs <= A+B`) show the real lead-in; with repeat off and `abs >= fadeStart`
  (from `_lvgm_get_fade_start_ms`), run the fade tail `bandEnd + (abs -
  fadeStart)`. Using the **same** mapping while looping and leaving is what
  makes the toggle jump-free. The display is NOT a pure function of the
  absolute position: `fadeTailStartMs` is captured at enable time when looping
  is switched on mid-fade (the loop count change makes the fade-start getter
  meaningless), and rides the tail until the song ends/seek/loadData clears
  it.
- New wrapper exports (`libvgm-wrapper.cpp` + `build-chip-core.js`):
  `_lvgm_get_cur_loop`, `_lvgm_get_playlist_position_ms` (`GetCurTime(0)`),
  `_lvgm_get_fade_start_ms` (`GetTotalPlayTicks(loopCount)`). Note
  `GetCurTime(0)` folds loops but reports the phase **from A**, i.e. within the
  first body; it must be re-anchored at the band (that mismatch caused a bug
  where the head looped inside I0, not the highlighted band).
- Verified via the t3 preview + `window.__cpDev`: the full test matrix above is
  green on the current build (Hurry Up!.vgz), the song ends/advances normally
  in every case, and the next context entry starts with fresh state. Caveats:
  fade is libvgm's default 4 s + 0.5 s silence (could shorten on exit); the
  "Indefinite Playback" setting is left as-is (internally repeat-on and it both
  map to loop count 0).

### Per-format loop capability (what "loop the intended region" means for each)

- **libvgm (VGM/VGZ/GYM/S98/DRO):** native region + loop count — the baseline.
- **GME (NSF/NSFE/SPC/GBS/AY/…):** no loop region in practice for this catalog:
  NSF has no loop field, the vendored NSFE parser ignores the NSFe `loop`
  chunk, and the SPCs are `[n]` (non-looping) rips — probed via chip-core in
  the live app, `intro_length`/`loop_length` stay -1. The driver loops
  internally, so Repeat One never restarts: the track just keeps rendering
  past `play_length` (restarting there would cut a seamless loop with a hard
  restart; `  restartTrack()` is only for `track_ended` one-shots). Blind-loop
  UI: indefinite with no band, once past the track length, parks the slider
  head at the end (it rides the first pass normally), lets the elapsed time
  climb unbounded, and labels the duration "Looping"
  (`AppFooter.isBlindLoopNow` + `TimeSlider`). The past-the-end condition is
  the scoping: MIDI/XMP/SID end at their length and loop via stop + reload,
  so they never dwell there and keep the normal slider. Toggling repeat off
  restores the clamped head/duration (and the pending JS fade ends the song,
  since the position is already past the length). Repeat-off plays to the
  natural end + JS fade. Real per-track regions would need `mmontag/game-music-emu`
  fork work (roadmap) — NSFe `loop` chunk support and/or a native loop API.
- **N64/USF:** no region exposed; whole-track model like GME, loop inferred
  from the `fade` tag (`song_loops`) + the indefinite flag.
- **SID:** no loop API at all; end only via client-side HVSC lengths.
- **MIDI:** CC 102/103 region, only honored for "SoundFont MIDI"; fluidlite has
  none. **Next candidate** — the only remaining format with a declared loop
  region; plugs into the VGM display pattern directly.
- **XMP / MDX / V2M:** no loop API; currently just stop at the engine end (the
  sequencer reloads in Repeat One).

**Where Repeat One actually works today (audit, 2026-09).** GME and VGM are
seamless. Everything else falls through the engine's own end -> `stop()` ->
`Sequencer.advanceSong` (which leaves `currIdx` alone under `REPEAT_ONE`) ->
re-fetch + reload, i.e. a stop, a network fetch, a decode gap, and a jump to
0:00. This is the behavior prod has today, so the *floor* for a format we have
not converted is "no worse than prod" — but the user-facing promise of the
feature only holds for the two engines above.

| Player | Repeat One mechanism | Seamless? |
| ------ | -------------------- | --------- |
| `GMEPlayer` | in-buffer `restartTrack()` | yes |
| `VGMPlayer` | native libvgm loop count | yes |
| `N64Player` | engine ends at `song_len` -> reload | no; also the "engine keeps rendering past durationMs" comment on `isPlayingIndefinitely()` is wrong — Repeat One never sets the engine flag |
| `SIDPlayer`, `XMPPlayer`, `MDXPlayer`, `V2MPlayer`, `MIDIPlayer` | engine end -> stop -> reload | no |

The fallback ladder to apply per engine, in order: **native region loop ->
in-buffer restart -> stop + reload**. Tier 1 is done (VGM), tier 2 is done
(GME). Tier 3 is the stop + reload every remaining player is on, and it also
re-fetches the whole file per cycle — for a sub-tune that is the entire
multi-song NSF, every loop.

### Dev tooling

`window.__cpDev` (dev-only; `dev/shims/devtools.js`, staged as the untracked
`src/chip-player-devtools.js` by `apply.sh` and injected via the dev webpack
entry; deleted by `remove.sh`): `snapshot()`, `setRepeat()`, `cycleRepeat()`,
`seek()`, `play()`/`pause()`, `click(selectorOrText)` (real DOM click on a UI
control), `setParam(id, value)` (through `App.handleParamChange`),
`waitUntil(fn, timeoutMs)` (poll the snapshot until a condition holds),
`startRecord()`/`stopRecord()` (non-blocking), and `runTimeline(events, opts)`
for timed/conditional scripts. The snapshot exposes player state plus VGM
looping fields (`curLoop`, `fadeStartMs`, `fadeTailStartMs`,
`playlistPositionMs`). Use it from the t3 preview to script enable/disable
timing and spy on player state instead of listening.

Testing gotchas learned the hard way:

- Script a whole scenario (play → wait → toggle → record) inside ONE
  `evaluate` call; the preview host drops tabs between calls and evaluate
  times out at 15 s, so never rely on state surviving across calls for a
  6-second test track.
- The tab can serve a stale bundle after edits: force `?r=N`, and confirm the
  served build with `curl localhost:8080/static/js/bundle.js | grep -c <newSymbol>`.
- Parameter toggles made right after `playSong`/`playContext` are overwritten
  by `resolveParamValues` when the async load finishes — pin the setting first
  (`userContext.settings['vgm.indefinitePlayback'] = true`) or apply it after
  the load's `playerStateUpdate`.
- The preview throttles background timers (~½ speed), so seek near a boundary
  to observe short windows.

## Conventions & cautions

- Comment style: explain *why*, in Matt's voice; avoid over-commenting.
- SQL: match the existing formatting (indentation, trailing comments, prepared
  statement style). Add prepared statements to `dbStatements`, destructure in
  `server/index.js`.
- Don't add comments the codebase wouldn't have; don't reformat unrelated code.
- Templates literals: **do not put backticks inside SQL template strings**
  (broke `build-music.js` twice via SQL comments using backticks).
- Verify with `curl` against `localhost:8080/api/...`.
- Dev shims stage **untracked, gitignored** modules rather than patching tracked
  files. `dev/apply.sh` writes `server/middleware/auth.dev.js`,
  `src/chip-player-devtools.js`, `src/chip-core.js`, `src/config/firebaseConfig.js`
  and `server/.env.local`; `server/index.js` loads the auth module via
  `DEV_AUTH_MODULE`, and the dev webpack config prepends the devtools entry.
  `dev/remove.sh` deletes them. No `*.dev-backup`, no `--revert` for these. The
  remaining in-place patch is `dev/patch-server.js` (skia-canvas), which is
  reversible and preserved by `remove.sh --revert`. Before a PR, run
  `./dev/remove.sh` and double-check `git diff` / `git status`.
- The client uses React 16, react-router-dom v5, react-virtualized, lodash,
  auto-bind. Match those.
