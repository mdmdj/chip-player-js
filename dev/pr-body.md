# Sub-tunes as first-class songs, and a per-format Repeat One

A file that holds several songs (NSF/NSFE, SID, GBS, AY) becomes a **song folder**, and every sub-tune is an ordinary song — favoritable, searchable, shufflable, charted, shareable, and loopable. On top of that, **Repeat One** is implemented for every engine.

Sub-tunes: each is its own song (`{path, sub-tune}`), with its own favorites, share link, chart rank, shuffle slot, search hit, and SEO page; local files get the same treatment, read from their own header. Repeat One: native region looping where the engine exposes one (VGM/VGZ, MDX, MIDI, MOD/XM/IT/S3M), a tail detector where it doesn't (NSFE, SID, N64), a drawn loop band, and no jump on toggle.

**Full write-up with video for every behaviour: https://mdm.dj/dev/chip-player-js/subtunes-as-first-class/**

## It's a big diff — suggested review order

1. **Catalog** — `scripts/build-music.js`, `scripts/metadata-parsers.js`, `scripts/subtune-headers.js`
2. **API** — `server/database.js`, `server/index.js`, `server/schemas.js`
3. **Client identity & nav** — `src/util.js`, `src/Sequencer.js`, `src/components/`
4. **Repeat One, per engine** — `src/players/` (and `Player.js` hooks)
5. **Engine surface** — `src/bindings/*.cpp`, `mdxmini/`, `scripts/build-chip-core.js`
6. **Share links & SEO** — `App.js`, `AppFooter.js`, `scripts/build-sitemap.js`

## ⚠ Two things to do before deploying

- **Rebuild the catalog:** `node scripts/build-music.js` (no `--reset-db`, no `-n`). The new statements reference `subtune` / `subtune_fts` / `music.subtune_count`; against an old catalog the server throws `SqliteError: no such table: subtune` **at require time** and `/top`, `/search`, `/browse`, `/user/favorites` go down. ~12 s on the full catalog. `playbacks.subtune` and favorites need no migration.
- **Rebuild the chip-core:** `npm run build-chip-core` — seven new loop exports, and the `mdxmini` patch (loop points, fade latch, microsecond position).

## Scope: ship together, or split

I'd prefer to ship this in one review, but I know it's large. The two halves are coupled: sub-tunes without the loop work is *worse* than either alone (a 28-tune NSFE would play 28 tunes that each stop-and-reload — the exact thing this is meant to fix), and the loop work is hard to justify without the sub-tune context. If you'd rather review it as two PRs — sub-tunes first, Repeat One second — say so and I'll open them that way.

## Known limits (full list in the changelog)

| | status |
| --- | --- |
| V2M: reported duration doesn't match the engine, so Repeat One keeps the old stop-and-reload (no band) | ours, open |
| SID `seek()` to a non-zero position is unfinished in the fork (some tunes resume, some stay silent) | pre-existing — same as prod |
| N64 `.miniusf` seeking can glitch the audio | known — see the changelog |
| The VGM loop band assumes the libvgm tree's `Tick2Second` semantics | see below |

**Nothing here regresses `master` beyond the intended feature.** The changes to shared files are additive; the two wrappers carry only the loop getters and the SID sub-tune reload; the only vendored-engine source touched is `mdxmini`.

## A reproducibility caveat, yours to call

My dev wasm is built from **un-pinned sibling clones** (`../libvgm`, etc.), the way `README.md` describes, so I can't prove the loop band against the exact libvgm tree you build. The band math is speed-invariant by construction, but it assumes `Tick2Second` divides by the speed factor. If you want, I can add a pin (repo + commit per engine) — but that's a decision about *your* build, not this feature.

## Testing

This repo has no test runner, so the harnesses behind every number in the changelog live in `dev/` and are **not** in this diff; they're the reason I'm confident in the behaviour, not something for you to maintain. If you'd like a tracked subset, I can extract the fixture-free ones (parser edge cases, synthetic MIDI loop shapes) into `test/` running on `node --test`, with no new dependencies.

Happy to split, shrink, or rework anything.
