# First Class Sub-Tunes and More Powerful Looping

A file that holds several songs (NSF/NSFE, SID, GBS, AY) becomes a **song folder**, and every sub-tune is an ordinary song: its own favorites, share link, chart rank, shuffle slot, search hit, SEO page. Local files get the same treatment, read from their own header.

**Repeat One** works for every engine, natively where the engine can loop: VGM/VGZ, MDX and MOD/XM/IT/S3M use the engine's own loop region; MIDI uses the file's markers (CC 102/103 or CC 110/111) and wraps in JS, since a synth engine has no loop of its own; NSFE, SID, N64 and GSF get an ending detector instead. The bar draws the region it actually plays, and toggling repeat never jumps the transport.

**Write-up with a video for every behaviour:** https://mdm.dj/dev/chip-player-js/subtunes-as-first-class/

53 files, +4,893/−651. Three pieces are structural — the catalog schema, the client's song identity, and the loop wrappers — and nothing is taken out of `master`: the shared-file changes are additive, the two wrappers only add loop getters, and the one vendored engine touched is `mdxmini`.

## Suggested Review Phases

1. **Catalog** — `scripts/build-music.js`, `scripts/metadata-parsers.js`, `scripts/subtune-headers.js`
2. **API** — `server/database.js`, `server/index.js`, `server/schemas.js`. Search now returns a file and its sub-tunes as peers, and shuffle/random return one item per playable song instead of one per file.
3. **Client identity and nav** — `src/util.js`, `src/Sequencer.js`, `src/components/`
4. **Repeat One, per engine** — `src/players/`, and the hooks in `Player.js`
5. **Engine surface** — `src/bindings/*.cpp`, `mdxmini/`, `scripts/build-chip-core.js`
6. **Share links and SEO** — `App.js`, `AppFooter.js`, `scripts/build-sitemap.js`

## ⚠ Before Deploying

- **Rebuild the catalog:** `node scripts/build-music.js` (no `--reset-db`, no `-n`). This replaces `music_fts` with `song`/`song_fts` and adds `subtune` and `music.subtune_count`; against an old catalog the server throws `SqliteError: no such table: subtune` at require time and `/top`, `/search`, `/browse`, `/user/favorites` go down. About 12 s on the full catalog. `playbacks.subtune` and favorites need no migration.
- **Rebuild the chip-core:** the loop calls need the new entries in `scripts/build-chip-core.js`, plus the `mdxmini` patch (loop points, fade latch, microsecond position). Drop them and the core fails to link rather than working quietly.
- **To try it:** open a multi-song file (any NSF/NSFE or SID, or `?play=<song id>` into one), play a tune, then hit Repeat One and watch the bar.

## How I Checked It

A local build of the real core (all engines), the catalog rebuilt and browsed, and every format played and looped on the real engine, with the shared paths A/B'd against `master` for identical output. The same behaviour carries 290 checks in the harness I work with locally — it isn't part of this PR, and I can bring it in as a tracked `node --test` suite if you want it. Every clip in the write-up was recorded with its own assertions, so a video only shows what it claims.

## Known Limits

| issue | status |
| --- | --- |
| V2M: the reported duration doesn't match the engine, so Repeat One keeps the old stop-and-reload (no band) | pre-existing, same as chiptune.app today |
| XMP (MOD/XM/IT/S3M): the loop band appears only after the first wrap | by design, see the [write-up](https://mdm.dj/dev/chip-player-js/subtunes-as-first-class/#xmp-learned-band) |
| SID `seek()` to a non-zero position is unfinished in the fork (some tunes resume, some stay silent) | pre-existing, same as chiptune.app today |
| N64 `.miniusf` seeking can glitch the audio | known, see the write-up |
| The VGM loop band assumes the libvgm tree's `Tick2Second` semantics | see below |

## Chip Core Reproducibility Is A Risk

My dev wasm comes from un-pinned sibling clones (`../libvgm` and friends), the way the README describes, so I can't prove any of this against the exact libvgm tree you build. The loop math is speed-invariant by construction, but it does assume `Tick2Second` divides by the playback speed.

Very excited to contribute, and happy to take comments.

Thank you!
