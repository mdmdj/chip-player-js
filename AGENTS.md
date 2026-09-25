# AGENTS.md — Sub-songs as first-class songs

This file documents a feature branch and its development setup for AI agents
(and humans) picking up the work. Read it fully before making changes.

## Project

**chip-player-js** is a web music player for chiptune/game audio formats
(NSF/NSFE, SID, SPC, VGM, MOD/XM/IT/S3M, MIDI, etc.), by **Matt Montag**.
React (class + hooks) frontend, Express + better-sqlite3 server, C/C++ player
engines compiled to WebAssembly via Emscripten.

- Upstream: `git@github.com:mmontag/chip-player-js.git` (remote `upstream`)
- Our fork: `https://github.com/mdmdj/chip-player-js.git` (remote `origin`)
- Working branch: `feature/sub-songs-as-first-class`

**Important:** Matt has personally given permission for this feature fork, and
the goal is a merge he will accept. Match existing conventions, keep the diff
minimal and coherent, and do not ship "slop." Read surrounding code before
editing; mirror its style (comment tone, SQL formatting, naming, etc.).

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
- **Dev shims** live in `dev/` and are tracked so they can be committed on the
  feature branch but wiped before PR:
  - `./dev/apply.sh` — installs stub `src/chip-core.js`, placeholder Firebase
    config, server auth bypass, optional-skia-canvas patch, a dev-user
    `UserProvider` patch, seeds `users.db` / `csdb.db`, writes
    `server/.env.local`, builds `catalog/` + `server/catalog.db`.
  - `./dev/remove.sh` — reverts everything (tracked files restored from
    `*.dev-backup`; generated files removed).
  - `node dev/test-parsers.js` — parser test harness (19 checks; uses synthetic
    buffers + real files under `catalog/`).
  - `dev/README.md` documents the shims.
- Run the app: `npm run dev` (webpack dev server on :3000, API server on :8080).
- **Dev-only note:** the stub `chip-core.js` produces no audio; it's a no-op
  Emscripten module for UI work. Real audio needs a GME/SID wasm build (Phase 3,
  not started).

### Dev environment gotcha

The T3 Code browser-preview tool was erroring in this environment
(`Electron sandboxed_renderer.bundle.js script failed to run` /
`Cannot destructure property 'preloadScripts' of 'binding.startupData'`), and
even failed on blank tabs. Verify the app over HTTP with `curl` instead:
`http://localhost:8080/api/...`.

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
   The player's own sub-tune changes (footer tune buttons, auto-advance) sync
   back into `currSongRef` and the context entry.
5. Client migrated to SongRefs: `App.js` (`directoryListingToContext`,
   `fetchDirectory`, `getCurrentSongLink` from `currSongRef.subtune`,
   `songTitleKey`/`subtuneTitle` metadata), `VirtualizedList` (`songRefKey`
   highlight, `songfolder` navigates), `Browse` (`<SONGS>` rows),
   `Favorites`/`FavoriteButton`/`UserProvider` (keyed by `(path, subtune)`),
   `Search` (sub-tune hits), `AppFooter` (favorite + share link carry subtune),
   `LocalFiles`/`TopCharts` (SongRef contexts).
6. Server `/shuffle` and `/random` return `{path, subtune}`; a multi-song file
   shuffles as a random sub-song. (`/random` had a latent leading-slash bug;
   fixed.)
7. Favorites server: `FavoriteSchema.subtune`, add/remove statements keyed by
   `(path, subtune)` — verified via curl (add two sub-tunes + a plain file,
   then remove one sub-tune and confirm the others remain). `getFavoritesStmt`
   also decorates items with `size` and `subtuneTitle`, so the Favorites list
   shows the catalog title and falls back to `Tune N`.
8. Dates and sizes: parsers scrape a release date from free-form metadata
   (`extractDate`), stored as `music.release_date` / `subtune.date`; `/browse`
   sub-tune rows resolve date as subtune -> file metadata -> file mtime, and
   reuse the parent file's `size`. File/songfolder rows also prefer
   `release_date` over mtime. `processFile` clears sub-tune rows before the
   `music` REPLACE (FK ordering fix for incremental reprocessing).
9. `AppFooter` shows the full song-folder path (and links into it) for
   multi-song files; `isSongFolder` is derived from `/metadata`'s
   `subtuneCount` (catalog) with the player's `numSubtunes` as fallback, since
   the dev stub doesn't report sub-tunes.

**Caveat:** `Sequencer.playContext` copies its context, so array-identity
checks no longer work. Compare a live context to a stored one with
`songRefListsEqual` (used by the local-files checks in `App` and the
`LocalFiles` highlight); compare rows with `songRefKey`.

## Remaining TODO / roadmap

1. Verify favorites end-to-end in a browser. The dev-user shim works (the
   server already has real favorites created from the browser), so what's left
   is the UI specifics: old localStorage faves (no `subtune`) render/play as
   sub-tune 0, and toggling one sub-tune doesn't disturb the other sub-tunes of
   the same file.
2. `playbacks.subtune` + top-charts grouping by `(song_id, subtune)`. The real
   `user_db` schema isn't tracked here, so either add an idempotent
   `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN subtune` shim in
   `server/database.js` (like `build-music.js`'s `ensureColumn`) or leave the
   migration to the maintainer. Then: `PlaybackSchema` + `insertPlaybackStmt` +
   the `/playback` post carry subtune, and the top queries return/display it.
3. Regression tests. There is no test script; the only harness is
   `dev/test-parsers.js`. A build-music round-trip test (sub-tune rows, counts,
   dates) and API tests for `/browse`, `/search`, `/shuffle`, favorites would
   de-risk the PR.
4. Known unsupported formats (don't add to `FORMATS` without a player/parser):
   plain `.usf` sets (only `.miniusf` is supported), PSF/PSX (`psflib` is reused
   only by the USF loader; no PSX core), and PSM (`libxmp-lite` = it/mod/s3m/xm;
   the files here are the MASI variant, which needs full libxmp).
5. Phase 3 (later): real GME/SID chip-core wasm build for audio verification.
6. Before PR: `./dev/remove.sh`, decide whether to keep `dev/`, `.nvmrc`, and
   `AGENTS.md` in the PR (currently tracked on the feature branch).

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
