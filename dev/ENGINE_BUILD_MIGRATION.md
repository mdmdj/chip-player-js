# Engine vendoring → sibling clones: migration notes

Working notes for the 2026-10-08 attempt to "fix the vendored-tree vs built-core
contradiction once and for all" by following the README instead of the vendored
subtrees.

Status: **DONE** (2026-10-08). Migration committed on branch `t3/813b0752` as
`Engine vendoring: build from sibling clones per README`; the pre-state is tagged
`pre-vendoring-experiment`.

## Why

Three artifacts disagree about where the engine sources live:

1. `README.md` tells you to `git clone` each engine **side-by-side** with the
   repo (`../libvgm`, `../libxmp`, `../FluidLite`, `../game-music-emu`,
   `../libsidplayfp`) and calls the in-repo subtrees **deprecated**.
2. `scripts/build-subprojects.sh` builds the **in-repo** subtrees and its header
   says the README's sibling instructions "are out of date".
3. `scripts/build-info.js` records the **in-repo** tree hashes as the engine
   identity (`git rev-parse HEAD:<dir>`), and `scripts/build-chip-core.js`
   prefers a sibling if one exists but falls back to the in-repo tree, gated by
   an engine-content check.

So the same "engine" can be: vendored, sibling, or neither, and which one gets
linked depends on what happens to exist in `../`. This is the contradiction.

## Plan

1. Delete the four subtrees the README explicitly calls deprecated:
   `libvgm/`, `libxmp/`, `fluidlite/`, `game-music-emu/`.
   (Not deprecated per README, so kept: `libADLMIDI/`, `lazyusf2/`, `psflib/`,
   `mdxmini/`, `farbrausch-v2m/`; `libsidplayfp` was never vendored.)
2. Clone the engines as siblings, as the README describes.
3. Rebuild `chip-core.wasm`.
4. Run `dev/run-tests.sh`.
5. Record what worked, what broke, and what the tree should look like after.

## Environment

- Worktree: `/home/mdm/.t3/worktrees/chip-player-js/t3-813b0752`
  (branch `t3/813b0752`, off `dev/overlay`), safety tag
  `pre-vendoring-experiment`.
- Node via `.nvmrc` = 24.21.0 (host default is 26.x → better-sqlite3 ABI trap).
- Emscripten at `/usr/lib/emscripten` (Arch package), `cmake`, `xa` present.

## Reconnaissance findings (2026-10-08)

- The four subtrees the README calls deprecated are tracked in git:
  `libvgm/` (296 files), `libxmp/` (2309), `fluidlite/` (134),
  `game-music-emu/` (318). They are all already listed in
  `dev/promote-paths.txt`, so none of this reaches the PR — the migration is
  overlay-only.
- `scripts/build-chip-core.js` already prefers a sibling: `normalizeInput()`
  rewrites `../libvgm/...` to `libvgm/...` only when the sibling is **absent**
  and the in-repo path exists. So once siblings exist, the linker uses them with
  no script change — but the engine-content gate then compares them against the
  recorded in-repo manifest and **refuses to build** unless
  `CHIP_ALLOW_ENGINE_FALLBACK=1` is set (see below).
- `scripts/build-info.js` identifies the four as `source: 'in-repo'` via
  `git rev-parse HEAD:<dir>`. With the dirs deleted, those entries have to become
  sibling entries or provenance reports `present: false`.
- Cloned versions differ from what was vendored:

  | engine | vendored identity | cloned HEAD (2026-10-08) |
  | ------ | ----------------- | ------------------------ |
  | libvgm | upstream `91b6542` | `c8b998b6` |
  | libxmp | upstream `041c9ee5` | `37227299` |
  | fluidlite | upstream `3504d48` | `4a01cf1c` |
  | game-music-emu | local 0.6.2 + CMake edits | `1bab5aba` (mmontag fork) |

- The wrapper `src/bindings/libvgm-wrapper.cpp` still carries compat shims for
  the stale vendored libvgm (`DEVID_MSM6258`/`DEVID_MSM6295` aliases and
  unconditional `PLAYTIME_TIME_FILE`/`PLAYTIME_LOOP_INCL` defines). Upstream
  HEAD now defines both `PLAYTIME_*` itself (`player/playera.hpp`), so the local
  defines are redundant redefinitions (same values, warning only). The
  `parentIdx` note is stale but harmless — the code never dereferences it.
- README build commands are **not sufficient on their own**: `emcmake cmake ..`
  for libvgm does not pass the Emscripten zlib paths or `-DIconv_LIBRARY=c`
  (without which VGZ/iconv are lost), and a default GME build re-enables
  VGM/GYM/HES/KSS, which collides with libvgm's OPN symbols. The real recipe
  lives in `scripts/build-subprojects.sh`. Build used here = its flags applied
  to the sibling clones (with `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` for CMake 4).

## Log

(chronological; appended as the work proceeds)

### 2026-10-08 — clones

Cloned into the worktree's parent (`/home/mdm/.t3/worktrees/chip-player-js/`),
which is what `../` resolves to for `build-chip-core.js`:

- `../libvgm`      = `ValleyBell/libvgm`      @ `c8b998b6`
- `../libxmp`      = `libxmp/libxmp`          @ `37227299`
- `../FluidLite`   = `divideconcept/FluidLite` @ `4a01cf1c`
- `../game-music-emu` = `mmontag/game-music-emu` @ `1bab5aba`
- `../libsidplayfp` = symlink → `/home/mdm/dev/libsidplayfp` (already built; not
  vendored, so untouched by the migration).

### 2026-10-08 — sibling builds

Built with `-DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS/-DCMAKE_CXX_FLAGS="-Oz -flto
-DNDEBUG" -DCMAKE_POLICY_VERSION_MINIMUM=3.5` plus the engine flags copied from
`scripts/build-subprojects.sh` (zlib paths, YM2612 cores, `-DIconv_LIBRARY=c`,
GME prune). All four succeeded (log: `/tmp/opencode/{libxmp,fluidlite,
game-music-emu,libvgm}.log`):

| engine | artifact |
| ------ | -------- |
| libxmp  | `build/libxmp-lite.a` (484 KB) — note the CMake path also emits `libxmp.a` (full) |
| FluidLite | `build/libfluidlite.a` (419 KB) |
| game-music-emu | `build/gme/libgme.a` (923 KB) — the fork already lists `Spc_Cpu.cpp`/`Spc_Dsp.cpp`/`Snes_Spc.cpp`, so no vendored CMake patch was needed |
| libvgm | `build/bin/libvgm-{emu,utils,player}.a` (plus a new upstream `libvgm-audio.a`) |

Findings so far:
- Upstream libxmp is **4.7.3** (the vendored one was 4.5) and its lite layout is
  `src/lite/lite-*.c`, **not** the vendored `lite/src/format.c` that
  `build-subprojects.sh` compiles by hand. So for libxmp the README's CMake
  recipe is the only one that works against a clone; the in-repo script recipe
  cannot.
- libvgm HEAD builds `libvgm-audio.a` in addition to what the linker lists.

### 2026-10-08 — vendored trees deleted

`git rm -r libvgm libxmp fluidlite game-music-emu` → 3057 tracked files removed.
All four were already in `dev/promote-paths.txt`, so this is overlay-only.

Still needed in-repo (not deprecated by README, so kept and still built from the
in-repo source): `libADLMIDI/`, `psflib/`, `lazyusf2/`, plus `mdxmini/` and
`farbrausch-v2m/` which `build-chip-core.js` compiles directly.

### 2026-10-08 — first link failed: fluidlite case/relative-path coupling

`node scripts/build-chip-core.js` failed:

```
src/tinyplayer.c:12:10: fatal error: '../fluidlite/include/fluidlite.h' file not found
```

`tinyplayer.c` (which is overlay-only, listed in `dev/promote-paths.txt`) includes
the header by the **in-repo lowercase** relative path `../fluidlite/...`. That
path is `src/../fluidlite` = the repo-root `fluidlite/` subtree, which is exactly
what we just deleted. The sibling is `../FluidLite` (capital) and is *outside* the
repo, so a plain `../` from `src/` cannot reach it.

This is the case-sensitivity landmine the old `build_fluidlite` bridged (it copied
`fluidlite/build/libfluidlite.a` into an in-repo `FluidLite/build/`). README is
itself inconsistent — it clones `FluidLite` but says the goal is
`../fluidlite/build/libfluidlite.a`.

Fix (both files already overlay-only): tinyplayer.c now includes `<fluidlite.h>`,
and the fluidlite module in `build-chip-core.js` passes
`-I../FluidLite/include`. A **second** divergence then surfaced: the newer clone
generates `fluidlite/version.h` into `FluidLite/build/fluidlite/version.h`
(the vendored, older FluidLite used a `fluidsynth/` subdir and *tracked*
`version.h`), so `-I../FluidLite/build` is needed as well.

Then a **third** divergence: the newer clone dropped
`fluid_synth_all_notes_off` / `fluid_synth_all_sounds_off` from the public header
(they are still defined in `src/fluid_synth.c` and declared in the internal
`src/fluid_synth.h`). `tinyplayer.c` calls them, so it now carries local `extern`
declarations. This is exactly the class of "vendored code vs cloned code"
contradiction the migration is meant to surface: three separate API drifts in one
engine before the link even succeeds.

### 2026-10-08 — link succeeds

`node scripts/build-chip-core.js` → `Built src/chip-core.wasm.` (2,083,689 bytes,
sha256 `8819cc66ba0db5a1afe4705c4fbd3195d29f4ad534e881a4275162069ff511b9`).
Two non-fatal warnings remain: `libvgm-wrapper.cpp` redefines
`PLAYTIME_TIME_FILE`/`PLAYTIME_LOOP_INCL`, which upstream now defines itself
(same values: 0 and 1). The duplicate-symbol tripwire reports no clashes.

Rebuilt once more after `build-info.js` was taught that the four are siblings;
the wasm came back **byte-identical** (`8819cc66…`), so the link is deterministic.

### 2026-10-08 — test suite

`PATH=<node 24> ./dev/run-tests.sh` → **exit 0**. All sections green:

```
parsers          30 passed, 0 failed
build-music       8 passed, 0 failed
sequencer         5 passed, 0 failed
vgm loops        15 checks passed, 2 known failures   (the documented xfails)
gme loops        10 passed
mdx loops        15 passed
v2m loops         6 passed
midi loops       10 passed (1 skip: a catalog MIDI fixture not in this catalog)
xmp loops        10 passed
end detector     12 passed
sub-tunes server 20 passed
song refs        11 passed
devtools          4 passed
scenario check   15 clips, 14 recorded, 1 warning (v2m-tier3, expected)
```

**Caveat: the suite does not load the wasm.** Every loop harness drives a fake
core, so a green suite says nothing about whether the *new* engines render. That
is what the next section is for.

### 2026-10-08 — real-core probe (the thing the suite cannot show)

Loaded `src/chip-core.{js,wasm}` in Node (ESM factory + `instantiateWasm`) and
rendered one file per engine, summing `|sample|`; a silent engine would read 0:

| engine | file | energy over 12×4096 frames |
| ------ | ---- | -------------------------- |
| libvgm (`c8b998b`) | `catalog/vgz-genesis/…Green Hill Zone.vgz` | 5.5e11 (peak 5.9e7) |
| GME (`1bab5aba`) | `catalog/nsf/Gradius II ….nsf` | 3.9e8 |
| libxmp (`37227299`) | `catalog/mods/One Must Fall/04-ARENA0.S3M` | 4.1e8 |
| SID (`mmontag/libsidplayfp`, unchanged) | `catalog/sid/Cybernoid_II.sid` | 6.5e3 (quiet, non-zero) |

All four render. **This directly contradicts the AGENTS.md note** that libvgm
`c8b998b` (the exact commit cloned here) leaves `GetPlayer()` null and renders
VGM silence — with the current wrapper it plays normally. Either that drift was
fixed upstream since 2026-09, or the earlier attempt differed in some way not
recorded. Worth re-checking before trusting the old note.

Not runtime-verified: **fluidlite MIDI/OPL3 playback** (needs a SoundFont and the
`tinyplayer.c` path). The FluidLite archive links and the three API drifts were
compile-time only, so risk is low, but it is not measured.

### 2026-10-08 — tooling brought back into agreement

The migration cannot leave the tooling referencing deleted dirs, so:

- `scripts/build-subprojects.sh` now builds the four engines from their
  siblings (`../libvgm`, `../libxmp`, `../FluidLite`, `../game-music-emu`) and
  keeps building `libADLMIDI`/`psflib`/`lazyusf2` from the in-repo trees. The
  hand-compiled libxmp recipe is gone (upstream's lite layout no longer supports
  it); it uses the CMake lite target instead. Also fixed a pre-existing bug:
  `want()` tested `$#` (always 1) instead of `${#SELECTED[@]}`, so a bare
  `./scripts/build-subprojects.sh` built **nothing** despite its header claiming
  "all".
- `scripts/build-info.js` records the four as siblings (revision + submodules)
  rather than in-repo tree hashes.
- `scripts/build-chip-core.js` gives the fluidlite module the FluidLite include
  paths.
- `src/tinyplayer.c` includes `<fluidlite.h>` and declares the two all-notes-off
  functions locally.
- `dev/apply.sh`'s sample-NSF copy points at `../game-music-emu/test.nsf`.

`README.md` was **not** touched: it already documents the sibling layout, and
editing it would promote into the sub-tunes PR (README is not path-listed), which
is out of scope.

### Verdict

The migration works: the deprecated subtrees are gone, the engines come from
sibling clones as the README says, a fresh core links, the test suite is green,
and every engine the suite cannot exercise was probed directly and renders audio.
What it does **not** buy is reproducibility — the builds now depend on external
clones at whatever commit the cloner fetched, which is the opposite of the
in-repo trees' `git rev-parse HEAD:<dir>` identity. If this is adopted, the
siblings should be **pinned** (the `repo`/`revision` recorded by `build-info.js`
is the start; a pinned clone script would finish it).

### Follow-ups (not done here)

- Pin the sibling clones (or vendor them again via `git subtree` at specific
  commits) so a rebuild from scratch is reproducible.
- `scripts/build-chip-core.split.js` is unreferenced dead code that still
  describes the old in-repo layout; delete or update it.
- `dev/promote-paths.txt` still lists the four deleted trees; harmless no-ops, but
  it could be tidied.
- Dead `.gitignore` entries for `libxmp/lite/...` and
  `libxmp/libxmp-lite-stagedir/`.
- Verify MIDI/OPL3 playback with a SoundFont.
- Clean the two `libvgm-wrapper.cpp` `PLAYTIME_*` redefinition warnings (drop the
  local defines, which the current libvgm provides).
