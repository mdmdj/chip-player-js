# First Class Sub-Tunes and More Powerful Looping

A file that holds several songs (NSF/NSFE, SID, GBS, AY) becomes a **song folder**, and every sub-tune is an ordinary song. **Repeat One** is implemented for every engine.

**Sub-tunes** are each their own song (`{path, sub-tune}`), with its own favorites, share link, chart rank, shuffle slot, search hit, and SEO page; local files get the same treatment, read from their own header.

**Repeat One** is improved: native region looping where the engine exposes one (VGM/VGZ, MDX, MOD/XM/IT/S3M), file-region looping for MIDI (its own CC 102/103 or CC 110/111 markers; no engine loop, so the wrap is JS), an ending detector where it doesn't (NSFE, SID, N64), a drawn loop band, and no jumps when toggling.

**Full write-up with video for every behaviour: https://mdm.dj/dev/chip-player-js/subtunes-as-first-class/**

## Suggested Review Phases

1. **Catalog:** `scripts/build-music.js`, `scripts/metadata-parsers.js`, `scripts/subtune-headers.js`
2. **API:** `server/database.js`, `server/index.js`, `server/schemas.js`
3. **Client identity & nav:** `src/util.js`, `src/Sequencer.js`, `src/components/`
4. **Repeat One, per engine:** `src/players/` (and `Player.js` hooks)
5. **Engine surface:** `src/bindings/*.cpp`, `mdxmini/`, `scripts/build-chip-core.js`
6. **Share links & SEO:** `App.js`, `AppFooter.js`, `scripts/build-sitemap.js`

## ⚠ Before Deploying

- **Rebuild the catalog:** `node scripts/build-music.js` (no `--reset-db`, no `-n`). The new statements reference `subtune` / `song_fts` / `music.subtune_count`; against an old catalog the server throws `SqliteError: no such table: subtune` **at require time** and `/top`, `/search`, `/browse`, `/user/favorites` go down. ~12 s on the full catalog. `playbacks.subtune` and favorites need no migration.
- **Rebuild the chip-core:** `npm run build-chip-core` has seven new loop exports, and the `mdxmini` patch (loop points, fade latch, microsecond position).

## Known Limits
 [full list in the changelog](https://mdm.dj/dev/chip-player-js/subtunes-as-first-class/)

| issue | status  |
| --- | --- |
| V2M: reported duration doesn't match the engine, so Repeat One keeps the old stop-and-reload (no band) | pre-existing, same as prod |
| XMP (MOD/XM/IT/S3M): the loop band appears only after the first wrap | by design, see the [changelog](https://mdm.dj/dev/chip-player-js/subtunes-as-first-class/#xmp-learned-band) |
| SID `seek()` to a non-zero position is unfinished in the fork (some tunes resume, some stay silent) | pre-existing, same as prod |
| N64 `.miniusf` seeking can glitch the audio | known, see the changelog |
| The VGM loop band assumes the libvgm tree's `Tick2Second` semantics | see below |

**Nothing here regresses `master` beyond the intended feature.** The changes to shared files are additive; the two wrappers carry only the loop getters and the SID sub-tune reload; the only vendored-engine source touched is `mdxmini`.

## Chip Core Reproducibility Is A Risk

My dev wasm is built from **un-pinned sibling clones** (`../libvgm`, etc.), the way the README describes, so I can't prove functionality against the exact libvgm tree you build. Particularly, the libvgm loop math is speed-invariant by construction, but it assumes `Tick2Second` divides by the speed factor.

Very excited to contribute and happy to receive comments.

Thank you!
