# Native MDX harness

Dev-only. Builds this repo's `mdxmini` as a normal Linux binary so the engine's
loop-region logic can be run and inspected without Emscripten.

It exists because the rest of `dev/` is JavaScript and **cannot reach the C**:
`dev/test-mdx-loops.js` fakes `_mdx_get_loop_start_ms` / `_mdx_get_loop_length_ms`,
so it exercises the player, never the recording. The region comes from
`mdxmini/src/mdxmml_ym2151.c`, and the only way to test it is to run it.

## Build and run

```sh
make -C dev/mdx-native region                 # -> dev/mdx-native/region
find catalog/mdx -iname '*.MDX' | dev/mdx-native/region
```

`region` reads MDX paths from stdin (one per line) and prints, tab-separated:

```
<path>   <intro_ms>   <loop_ms>   <length_s>
```

`intro_ms` / `loop_ms` are exactly what `mdx_get_loop_start_ms` /
`mdx_get_loop_length_ms` return — the same numbers `MDXPlayer._readLoopRegion`
puts on `metadata.intro_length` / `loop_length`, i.e. the slider band. It forks
per file, so a malformed MDX cannot abort a corpus run.

With `--play <ms>` it first renders that much audio (with `mdx_set_max_loop(0)`,
as Repeat One does), then appends:

```
<per_section>  <limit>  <played_ms>  <ended_ms>  <engine_min>
<section_end_ms>  <fade_onset_ms>
```

`per_section` is `mdx_get_loops_per_section()` — how many per-track repeats one
joint section is worth. `--sections` hands the engine the joint-section count
(the unit `MDXPlayer` uses now) and sets `section_end_ms` to the boundary that
count names, `intro + limit * loop`; without it `limit` is the old
`mdx_get_section_loop_limit()` projection and `section_end_ms` is the next
boundary. `fade_onset_ms` is the elapsed time the engine actually starts its
fade (a dev-only getter, `mdx_parse_mml_get_fade_out`), or -1 if it never did
inside the render bound. `--limit N` overrides what is applied, which is the
negative control.

Golden fixtures (skipped when `catalog/mdx` is absent — `catalog/` is
gitignored):

```sh
make -C dev/mdx-native check
# ok    G2MST6.MDX -> [34603  34603]  verified-good; the fix must not move it
# ok    DTWNB18.MDX -> [0      14942]  one-shot held the min; band was [5078, 12403]
# ok    FACE04.MDX -> [182452 45613]  two period groups, entering their loops 22.8s apart
# ok    DES_80.MDX per=2 limit=2 fade=11097 vs section_end=11058  one section = 2 repeats
# ...
```

## The fade gate counts sections, not tracks (fixed 2026-10-16)

`mdx_set_max_loop(N)` is compared against the engine's pass counter, which is
the **smallest per-track loop count**. The band, though, is the *joint* section:
when the tracks differ in period one section is several repeats of the longest
track (`loops_per_section > 1`), so a limit in sections fired a whole section
early. `loop_gate_value` (in `mdxmml_ym2151.c`) reduces each live track's count
to the sections it has finished and takes the smallest, which turns exactly on
the joint boundary; `loops_per_section <= 1` keeps the raw minimum, so the per=1
path is untouched.

`check_sections` in `check.sh` is the evidence: with the section count handed to
the engine, the fade must begin at `intro + limit * loop`. Against the pre-fix
engine the same rows fail by 20-90% of the loop (e.g. `RANCE11.MDX`
`fade=67429 vs section_end=695598`). The onset can only land on a tick and the
joint period is measured, so the check allows 1% of the loop, floor 500 ms.
Fixtures for `per` 2/3/5/6/8/16 are in `catalog/mdx/` (see `curate-sample.js`
below); `dev/test-mdx-loops.js` pins the player half against a fake core.

## What it found — the loop-region bug (fixed 2026-10-15)

`mdx_get_loop_*` used to be recorded from the **minimum `infinite_loop_times`
across tracks still playing**. A track that never loops — a one-shot; any track
whose data ends with `0xF1 0x00` instead of a loop-back `0xF1 nn` — stays at
count 0 for its whole life, so it *held* that minimum until it ended. The tick
it dropped out was then read as the first loop: the band started late, and if it
outlived a full pass the minimum jumped by more than one and the old guard
dropped the band entirely, even on songs that clearly loop.

The fix records each track's 1st/2nd loop time and resolves the region from the
tracks that loop, so a one-shot cannot gate the boundary. The engine's pass/fade
minimum is untouched, so repeat-off timing is unchanged. Measured over 4,706
candidate MDX from the corpus below: **4,347 unchanged, 311 corrected**. Natively
confirmed here, and in-app for `DTWNB18.MDX` (band `[5078, 12403]` →
`[0, 14942]`) while `G2MST6.MDX` is unchanged.

## The region's two numbers are different in kind

`intro` is the last track to *enter* its loop section; `loop` is the joint
period, the smallest multiple of the longest track period that every looping
track also hits. They come from different measurements, and the first version of
the resolver paired the wrong ones: it took the last *crossing* and subtracted
the joint period, which only cancels when every track shares a period.

FACE04 is the fixture for that. Tracks 2–7 loop every 45.6 s and enter at
114.03 s; tracks 8–11 loop every 22.8 s and enter at 182.45 s, so the mix only
repeats from 182.45 s. The band used to start at 159645 -- neither a section
start nor a crossing. G2MST6 is the counter-fixture: sections at 0 and 34.6 s
with one shared period, where the two derivations agree exactly.

To see those per-track numbers for any file, add a temporary `fprintf` in the
resolver's track loop (`mdxmml_ym2151.c`, after the period is computed) printing
`track_first_us[i]`, the period, and `first - period`; build `region`; run it;
then remove the print. The arrays are internal to mdxmini, so the public API
cannot show them.

## The corpus (`dev/mdx-corpus/`, gitignored)

Two independent reference archives, from `nfggames.com/X68000/Music/`:

| archive | MDX files |
| --- | --- |
| `MDXO_-_MXDRV_Complete_.7z` (120 MB) | 54,738 |
| `MDX.zip` (Eidis, 74 MB) | 12,310 |

`7z x` / `unzip` them, then feed a find into `region` or `scan-tracks`. Note the
corpus is a lot of third-party game music; it stays out of the repo, like
`dev/nes-audio-tests/`.

## `scan-tracks` — find the trigger shape (optional)

Classifies every track by its terminating command, so you can see which files
have a looping track *and* a substantial one-shot — the candidates for the bug:

```sh
git clone --depth 1 https://github.com/vampirefrog/mdxtools /tmp/mdxtools
make -C dev/mdx-native scan-tracks MDXTOOLS_DIR=/tmp/mdxtools
find dev/mdx-corpus -iname '*.mdx' | dev/mdx-native/scan-tracks > /tmp/scan.tsv
```

It prints `<path>  <looping>  <one_shots>  <stubs>`. It uses mdxtools'
command-length table (GPL-3.0), which is why it needs that checkout; `mdx.c`,
`tools.c` and `mdx.h` are compiled in, and the `mdx.h` name clashes with
mdxmini's, hence the separate build flags.

`curate-sample.js` turns that TSV into a catalog sample (MDX + UPPERCASE PDX
companions):

```sh
node dev/mdx-native/curate-sample.js /tmp/scan.tsv catalog/mdx --limit 40
```

## Notes

- **PDX companions must be uppercase.** `MDXPlayer` uppercases the PDX filename
  before fetching it (`pdx.toUpperCase()`), which matters on a case-sensitive
  filesystem. `curate-sample.js` copies them uppercase.
- `mdxmini/src/mdxmini.c` includes `<emscripten.h>` unconditionally; the stub
  `emscripten.h` in this directory (first on the include path) satisfies it for
  the native build, so no engine source is touched.
- 6 files in the corpus segfault mdxmini's parse. Pre-existing, not from the fix,
  and not chased.
