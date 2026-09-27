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
- **`dev/audio-tooling`** — stacked on top of the feature branch (currently one
  commit) and holds everything else: engine build scripts, `src/bindings/`,
  `src/tinyplayer.c`, the audio parts of `src/players/*Player.js`,
  vendored-tree fixes, `config/webpack.config.dev.js`, the `dev/` shims,
  `AGENTS.md`, `.nvmrc`. This is where the app is developed and run. Lives in
  our fork (`origin`); nothing here is part of the PR.

Workflow: commit feature changes on the feature branch; commit audio/dev/tooling
changes only on `dev/audio-tooling`; then `git rebase
feature/subtunes-as-first-class` on the dev branch to pick up feature moves.
Never commit audio/dev changes to the feature branch, and never push either
branch to `upstream` — everything stays in our fork (`origin`).

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
- **Dev shims** live in `dev/` on `dev/audio-tooling` only (never on the feature
  branch), tracked so the dev environment is reproducible:
  - `./dev/apply.sh` — installs stub `src/chip-core.js`, placeholder Firebase
    config, server auth bypass, optional-skia-canvas patch, a dev-user
    `UserProvider` patch, a silent-SID fallback patch, seeds `users.db` /
    `csdb.db`, writes `server/.env.local`, builds `catalog/` +
    `server/catalog.db`.
  - `./dev/remove.sh` — reverts everything (in-place patches via `--revert`;
    wholly replaced files restored from `*.dev-backup`; generated files removed).
  - `node dev/test-parsers.js` — parser harness (20 checks; synthetic buffers +
    real files under `catalog/`).
  - `node dev/test-build.js` — build-music round-trip on a temp catalog subdir
    (sub-tune rows, dates, idempotency, FK-safe delete); cleans up after itself.
  - `node dev/test-sequencer.js` — sequencer navigation with a fake player
    (each sub-tune plays once, mixed contexts advance entry-by-entry). Uses an
    inline Babel require hook; no new deps.
  - `./dev/run-tests.sh` — runs all three. Dev-only, not part of the PR.
  - `dev/README.md` documents the shims.
  - `dev/shims/devtools.js` + `dev/patch-devtools.js` — install `window.__cpDev`
    (browser test hooks: `snapshot`, `setRepeat`, `seek`, `startRecord`, ...).
    Staged to `src/chip-player-devtools.js` and patched into `App.js` by
    `apply.sh`; reverted + deleted by `remove.sh`. See "Repeat One / looping
    model".
- Run the app: `npm run dev` (webpack dev server on :3000, API server on :8080).
- **Audio:** the dev stub `src/chip-core.js` is a no-op (no audio). A **real
  chip-core was built** in this session — see "Building the real chip-core"
  below. It is gitignored and not committed.

### Building the real chip-core

Real audio works locally. `scripts/build-subprojects.sh` + changes to
`scripts/build-chip-core.js` build all vendored engines into
`src/chip-core.{js,wasm}`. This work touches vendored trees and lives on
`dev/audio-tooling`, **not** the feature branch. See "Audio engine roadmap" for
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
switching, voice mask, and tempo are unaffected. `dev/patch-sid-stub.js` (silent
SID) only applies to cores without `_sid_*` exports and does not trigger now.

`sid_set_subtune` must call `engine->load(currentTune)` after `selectSong()`:
selectSong only marks the `SidTune`'s current song, so without the reload the
engine keeps playing song 0 while `sid_get_subtune()` reports the requested
index (every sub-tune sounds identical).

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
  usable, but the client's own `user` state (Firebase) stays null. The
  `dev/patch-user-provider.js` shim injects a fake `user` with `getIdToken()`
  (uid `dev-user`, token `dev-token`), so the heart button and favorites API
  work in the browser. It is backed up/restored by `dev/apply.sh` /
  `dev/remove.sh`.

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
    V2M/MDX/fluidlite MIDI). Uncommitted, separate from the feature — see
    "Building the real chip-core".
13. Repeat One for VGM (libvgm) — the looping baseline. Native loop count plus a
    band-relative "playlist position" so the head repeats the highlighted loop
    region, and switching repeat off plays past into the fade with no head jump.
    See "Repeat One / looping model". Verified via the t3 preview + `window.__cpDev`
    (deep-loop toggle has `jump: 0`). Uncommitted on `dev/audio-tooling`.

**Caveat:** `Sequencer.playContext` copies its context, so array-identity
checks no longer work. Compare a live context to a stored one with
`songRefListsEqual` (used by the local-files checks in `App` and the
`LocalFiles` highlight); compare rows with `songRefKey`.

## Session hand-off notes (read me first)

- **Branch model:** see "Branches" above. `feature/subtunes-as-first-class` is
  the PR (feature only); `dev/audio-tooling` is stacked on it and holds the
  audio/engine/build/dev work. There is no commit list to maintain — a change
  either belongs to the feature branch or it does not. Run the app from the dev
  branch.
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
   `dev/audio-tooling`. The diff is `git diff master..feature/subtunes-as-first-class`.

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
`AppFooter` currently always shows the band for a looping track ("for DX now");
make it a flag later.

### Repeat One contract

- **Enable (any time):** loop the region natively/forever; no seek, no jump. The
  head cycles inside the band. If enabled after the region, finish the current
  pass first (via `restartAtEndPending` or the player's native equivalent),
  never jump the transport backward into the loop.
- **Disable (any time):** *play past* the loop region as if repeat was never on:
  finish the current pass, then the fade, then end/advance. The head must be
  **continuous across the toggle** (same display mapping before and after), then
  run the fade tail from the band end. Never jump.

### VGM (libvgm) — the working baseline

- Native loop count: repeat-on = `_lvgm_set_loop_count(ctx, 0)` (0 = forever);
  repeat-off = `max(2, curLoop+1)` so the current pass finishes and libvgm fades
  at the next boundary. `setLooping` clears the base `restartAtEndPending`
  (libvgm loops natively; the base late-repeat `seekMs(0)` would fight it).
- The display mapping in `VGMPlayer.getDisplayPositionMs`: phase
  `(abs - A) mod B` mapped as `bandStart + phase`; before the first body
  (`abs <= A+B`) show the real lead-in; while leaving and `abs >= fadeStart`
  (from `_lvgm_get_fade_start_ms`), run the fade tail `bandEnd + (abs -
  fadeStart)`. Using the **same** mapping while looping and leaving is what
  makes the toggle jump-free.
- New wrapper exports (`libvgm-wrapper.cpp` + `build-chip-core.js`):
  `_lvgm_get_cur_loop`, `_lvgm_get_playlist_position_ms` (`GetCurTime(0)`),
  `_lvgm_get_fade_start_ms` (`GetTotalPlayTicks(loopCount)`). Note
  `GetCurTime(0)` folds loops but reports the phase **from A**, i.e. within the
  first body; it must be re-anchored at the band (that mismatch caused a bug
  where the head looped inside I0, not the highlighted band).
- Verified via the t3 preview + `window.__cpDev`: deep-loop toggle has `jump: 0`,
  the head continues the current pass then wraps at the natural boundary, and the
  song ends/advances normally. Caveats: fade is libvgm's default 4 s + 0.5 s
  silence (could shorten on exit); the "Indefinite Playback" setting is left
  as-is (internally repeat-on and it both map to loop count 0).

### Per-format loop capability (what "loop the intended region" means for each)

- **libvgm (VGM/VGZ/GYM/S98/DRO):** native region + loop count — the baseline.
- **GME (NSF/NSFE/SPC/GBS/AY/…):** real region (`intro_length`/`loop_length`) but
  no native loop control; today repeat restarts the *whole track* (intro
  replays). Needs `mmontag/game-music-emu` fork work (roadmap) or a JS region
  loop.
- **N64/USF:** no region exposed; loop inferred from the `fade` tag
  (`song_loops`) + an indefinite flag.
- **SID:** no loop API at all; end only via client-side HVSC lengths.
- **MIDI:** CC 102/103 region, only honored for "SoundFont MIDI"; fluidlite has
  none.
- **XMP / MDX / V2M:** no loop API; currently just stop at the engine end (the
  sequencer reloads in Repeat One).

### Dev tooling

`window.__cpDev` (dev-only; `dev/shims/devtools.js` + `dev/patch-devtools.js`,
installed by `apply.sh`, removed by `remove.sh`): `snapshot()`, `setRepeat()`,
`cycleRepeat()`, `seek()`, `startRecord()`/`stopRecord()` (non-blocking), and
`runTimeline()`. Use it from the t3 preview to script enable/disable timing and
spy on player state instead of listening. Remember the preview throttles
background timers (~½ speed), so seek near a boundary to observe short windows.

## Conventions & cautions

- Comment style: explain *why*, in Matt's voice; avoid over-commenting.
- SQL: match the existing formatting (indentation, trailing comments, prepared
  statement style). Add prepared statements to `dbStatements`, destructure in
  `server/index.js`.
- Don't add comments the codebase wouldn't have; don't reformat unrelated code.
- Templates literals: **do not put backticks inside SQL template strings**
  (broke `build-music.js` twice via SQL comments using backticks).
- Verify with `curl` against `localhost:8080/api/...`.
- Dev shims that edit tracked files in place (`server/index.js`,
  `src/components/UserProvider.js`) are patched by `dev/patch-server.js` /
  `dev/patch-user-provider.js` and undone with `--revert`; `dev/remove.sh`
  calls those, so feature edits in those files are preserved. Files that are
  wholly replaced (`server/middleware/auth.js`, `src/config/firebaseConfig.js`)
  are restored from `*.dev-backup`, so keep those backups correct. Before a PR,
  run `./dev/remove.sh` and double-check `git diff` / `git status`.
- The client uses React 16, react-router-dom v5, react-virtualized, lodash,
  auto-bind. Match those.
