# replaygain — design, measurements and the catalog scanner

Feature branch: `feature/replaygain`, stacked on `feature/subtunes-as-first-class`
(the sub-tune identity model is what makes per-sub-tune loudness and the
multi-song-file album meaningful). Overlay: `dev/overlay-replaygain`.

## The problem

Volume varies by engine, game and song by more than the volume slider can
compensate for. The slider tops out at 150% (+3.5 dB); the ear-labelled samples
below span about 10.6 dB of integrated loudness. Some engines are also very loud:
the V2M fixture measures about -10 LUFS with a peak above 0 dBFS, so it is already
clipping before the user touches anything.

## What was measured

The specimens are rendered through the same player classes and wasm core the app
uses, at 48 kHz, with BS.1770-4 gating (400 ms blocks, 100 ms hop, -70 LUFS and
relative -10 dB gates). Peak is sample peak.

| Label | File | LUFS | Peak dBFS | Gain at -18 (peak-safe) |
| --- | --- | ---: | ---: | ---: |
| quiet | Wild Guns / Theme of Wild Guns | -31.7 | -12.7 | +11.7 |
| quiet | Rise of the Robots / End of Match | -22.8 | -8.3 | +4.8 |
| medium | Zelda ALttP / Staff Roll | -30.6 | -12.1 | +11.1 |
| medium | Shougi Saikyou / Which Scenario | -30.4 | -14.3 | +13.3 |
| medium | BattleClash / Garam | -27.9 | -8.8 | +7.8 |
| medium | Earthworm Jim / Andy Asteroids | -29.8 | -10.7 | +9.7 |
| kinda loud | Lufia / Battle of the Island in the Void | -21.1 | -6.6 | +5.6 |
| kinda loud | Mega Man X3 / Doppler Stage | -22.5 | -7.2 | +6.2 |

Raw spread: 10.6 dB. After peak-safe normalization to -18 LUFS: 2.1 dB. The
quietest tracks stop around -20 LUFS because their peaks cannot go higher without
clipping; see "Limits".

Four of the supplied links were 403 from this network (`9AR51lDC`, `NWA8rHky`,
`xqUWlAHK`, `MCRZHzfs`). Add them under
`catalog/replaygain-samples/loud/` and both the browser and scanner tests pick
them up.

## Catalog: server-side, stored in catalog.db

The browser does **no analysis for catalog tracks**. A separate scanner fills
`catalog.db`; the server serves the rows; the client applies a lookup.

```sh
node scripts/build-music.js          # first, as usual
node scripts/analyze-loudness.js     # then the loudness pass (resumable)
node scripts/analyze-loudness.js --filter spc --limit 100 --verbose
node scripts/analyze-loudness.js --force        # after a measurement change
node scripts/analyze-loudness.js --retry-failed # retry errors/timeouts
```

`scripts/analyze-loudness.js` is a batch tool, not an HTTP runtime dependency:

- One child process pool (default `min(4, cpus-1)`), each with its own wasm core.
  The parent owns the only SQLite writer.
- A tiny local HTTP server serves the catalog, `public/soundfonts`, `/metadata`
  and `/hvsc`; `CHIP_LOUDNESS_BASE` points `src/config` at it, so a scan is
  offline and reproducible.
- Resumable/incremental: candidates are rows whose size, mtime or
  `LOUDNESS_VERSION` moved. Progress is committed per file. A killed run resumes.
- Watchdog: if a child does not answer within `--timeout` (default 120 s), it is
  killed and respawned. A pathological file is recorded as `timeout`, not allowed
  to wedge the scan (JavaScript cannot interrupt a wasm C loop).
- Files over `--max-size` (default 32 MB) are recorded as skipped. The catalog's
  black MIDIs are the reason this exists.
- Multi-song files are measured **per sub-tune** (the analyzer reloads each
  sub-tune, capped by `--max-subtunes`, default 64) and get a duration-weighted
  file aggregate.

### Schema (created by build-music, ensured at server startup)

- `loudness_files` — one row per file: status, `subtune_count`,
  `analyzed_subtunes`, the file-level aggregate (`lufs`, `peak_db`,
  `duration_sec`), engine, reason.
- `loudness` — one row per `(path, subtune)`; what song mode uses.
- `loudness_albums` — one row per directory; used for a normal album. It is
  `complete` only when every file in the folder measured successfully; a partial
  album is not applied.

The client treats a multi-song file as its own album (the file aggregate); a
single-song file uses its containing directory. This is the "album for songdir
(multi-song file)" rule.

### API

`GET /api/loudness?path=<relative>&subtune=<n>`

```json
{
  "track": { "path": "…", "subtune": 3, "status": "ok", "lufs": -23.4,
             "peakDb": -6.4, "durationSec": 101.0, "partial": false, "engine": "gme" },
  "album": { "kind": "file", "status": "complete", "lufs": -27.7,
             "peakDb": -6.4, "trackCount": 28, "durationSec": 1790.9 },
  "subtuneCount": 28
}
```

A missing row returns `{track:null, album:null, subtuneCount:null}`. The client
plays at unity, shows nothing, and logs a warning only inside a `DEV-BEGIN`
region.

## Local files: browser worker, hardened

Local files have no catalog row, so they are the only browser-side scans.

- `src/ReplayGain.js` requests `allSubtunes` in album mode; a multi-song local
  file's album is the file aggregate. A single-song local file is track gain even
  in album mode.
- **Watchdog:** the main thread times out a job (30 s), `worker.terminate()`s it,
  caches the failure for 24 h, and falls back to unity. This is the only reliable
  way to stop a wasm call that never returns.
- **Bounds:** 64 MB file cap, 300 s render cap, 15 s worker wall budget, 30 s job
  timeout, 32 local sub-tunes. The worker checks cancellation/wall time and yields
  to the event loop every ~0.5 s.
- An oversized/failed file is cached as `skipped`/`timeout` and is not retried on
  every play.

## Gain

`gainDb = target - measuredLufs`, capped so `peakDb + gainDb <= -1 dBFS` and
bounded to [-24, +24] dB. This prevents clipping without a limiter and turns hot
engines (V2M) down. The app multiplies the user's volume by the linear gain; the
slider still tops out at 150%.

Target options: Quiet (-23), Balanced (-18, default), Loud (-14). Settings:
Off / Per song / Per folder (album).

## Catalog refresh and format coverage (2026-10-22)

The worktree catalog was refreshed to **383 files / 79 sub-tunes**, and the
scanner was run over all of them (`--force`, 6 workers, 60 s cap):

- **347 files measured, 36 N64 timeouts, 0 errors, 0 skipped.**
- **421 sub-tune rows**; 25 complete directory albums, 5 partial.
- All formats present in the catalog measured: `ay`, `gbs`, `it`, `mdx`, `mid`,
  `midi`, `minigsf`, `miniusf`, `mod`, `nsf`, `nsfe`, `s3m`, `sid`, `smf`, `spc`,
  `v2m`, `vgm`, `vgz`, `xm` (**19 extensions**).
- Fixtures added for the missing practical extensions: `loudness-formats/nsf/
  db_apu.nsf`, and Bach's Goldberg Variation 04 as `.mid`, `.midi` and `.smf`.
- Not covered: `.gsf` (the catalog has only `.minigsf`; same GSF player) and
  `.mus` (no `.mus` fixture exists in the catalog). Both are format-level gaps,
  not scanner failures.
- The 36 N64 timeouts are long tracks that need more than the 60 s cap; a spot
  check completed in **142 s**, so rerun those with `--retry-failed --timeout 300`
  (or longer). The other 294 N64 files measured.
- MIDI initially measured silence because `MIDIPlayer` loads the SoundFont
  asynchronously. The player now exposes `soundfontPromise` and the analyzer
  awaits it; the fixtures measure -20.7 dB (Bach) and -23.3 dB (tempo test).

## Limits / next steps

- **Peak-limited tracks stop short of the target.** A static gain cannot raise a
  track whose peak is already near full scale. A look-ahead limiter would let
  Loud reach -14 on those tracks; not done because it changes the sound and needs
  a listening test.
- The **first local play** is at unity until the worker finishes; later plays are
  instant from IndexedDB. Catalog plays are immediate.
- **Catalog coverage is a scanner responsibility.** A new file plays neutral until
  the next scan; the scanner summary reports measured/failed/skipped.
- **`server/index.js` is path-listed**, so its `/loudness` route is a hand-carry
  at promotion time. So are the route's `dbStatements` if the feature branch is
  promoted without `server/database.js` (it is not path-listed, so normally the
  promote carries it; keep the pair together).
- **`src/config/index.js` now promotes**: its dev block is a DEV region and the
  `CHIP_LOUDNESS_BASE` override is feature code for the scanner. Removing it from
  `dev/promote-paths.txt` is deliberate.

## Verify

```sh
./dev/run-tests.sh
# or individually:
node dev/test-replaygain.js          # measurements + gain math
node dev/test-loudness-catalog.js    # scanner snapshot, album, timeout, sub-tunes
node dev/test-loudness-client.js     # watchdog, catalog lookup, local album
node dev/test-loudness-server.js     # HTTP route (skips if no dev server)
```

The catalog harness snapshots `catalog.db` and never writes the live one. The
server harness skips when the dev server or scanned rows are absent.
