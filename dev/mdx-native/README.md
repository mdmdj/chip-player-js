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

Golden fixtures (skipped when `catalog/mdx` is absent — `catalog/` is
gitignored):

```sh
make -C dev/mdx-native check
# ok    G2MST6.MDX -> [34603  34603]  verified-good; the fix must not move it
# ok    DTWNB18.MDX -> [0      14942]  one-shot held the min; band was [5078, 12403]
# ok    FACE04.MDX -> [182452 22806]  two loop periods; one-shot delayed the first
```

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
