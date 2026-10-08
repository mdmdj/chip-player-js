# Upstreaming plan: sub-tunes + Repeat One, and killing the vendored/sibling confusion

**Premise (accepted 2026-10-08):** the maintainer builds the **sibling** engine
checkouts per `README.md`, not the in-repo vendored subtrees. We take him at his
word.

**Corroboration from the tree itself:** `master`'s `scripts/build-chip-core.js`
exports `_gme_disable_echo`, `_gme_seek_scaled`, `_xmp_seek_time_frame`, none of
which exist in `master`'s vendored `game-music-emu`/`libxmp`. So `master` cannot
link its own vendored trees. They are dead weight.

**Motivation:** the subtrees are not just dead, they are *actively confusing* —
they are a second, stale copy of every engine, they made the wrapper carry compat
for a library nobody builds, and they made "which libvgm am I compiling against?"
unanswerable. That is why we deleted them. The upstream goal is to make that
deletion land too, so the confusion cannot come back.

## 0. Two separate changes → two PRs

| | PR A | PR B |
| --- | --- | --- |
| topic | Remove the deprecated engine subtrees | Sub-tunes as first-class songs + Repeat One |
| size | ~3000 deleted files + small edits | 41 files, feature-only |
| depends on | nothing | nothing, but **rebases cleanly on A** |
| reviewability | trivial logic, big diff | the actual feature |

Bundling the deletion into the feature PR would bury a 3000-file diff inside a
sub-tunes review. Keep them separate; land A first if possible.

## 1. PR A — remove the deprecated subtrees

Delete `libvgm/`, `libxmp/`, `fluidlite/`, `game-music-emu/`.

**Coupling you cannot skip:** `src/tinyplayer.c` includes
`../fluidlite/include/fluidlite.h`, which resolves to the *repo-root lowercase*
vendored tree. Delete that tree and the maintainer's build breaks. So PR A must
carry the fluidlite fixes with it:

- `src/tinyplayer.c`: `#include <fluidlite.h>` instead of the vendored relative
  path, plus local `extern` decls for `fluid_synth_all_notes_off` /
  `fluid_synth_all_sounds_off` (the modern sibling moved them out of its public
  header).
- `scripts/build-chip-core.js`: add `-I../FluidLite/include` and
  `-I../FluidLite/build` (the latter for the generated `fluidlite/version.h`) to
  the fluidlite module.
- `README.md`: drop the four "a … subtree was previously included … deprecated"
  lines; the clone instructions above them already say the right thing.
- `.gitignore`: drop the now-dead `libxmp/lite/...` /
  `libxmp/libxmp-lite-stagedir/` entries.

Everything else the deletion touches is ours, not upstream:
`scripts/build-subprojects.sh` and `scripts/build-info.js` are **absent on
`master`** (our tooling); the `normalizeInput` in-repo fallback and the
engine-content gate are ours. They stay overlay-only, or are offered as an
optional convenience, but no PR needs them.

`scripts/build-chip-core.split.js` is dead code on `master` that still describes
the in-repo layout — a good thing to delete in PR A, but optional.

## 2. PR B — sub-tunes + Repeat One

`master..feature/subtunes-as-first-class`, 41 files, feature-only. It keeps the
vendored trees exactly as `master` has them **until PR A lands**; once A is in,
the rebase is clean and B carries no subtree content at all.

### Fixes to make in B (stale compat the migration surfaced)

Against the sibling engines these snippets are at best dead, at worst wrong:

| file | current | action | why |
| ---- | ------- | ------ | --- |
| `src/bindings/libvgm-wrapper.cpp` | `#define PLAYTIME_TIME_FILE/LOOP_INCL` | **delete** | modern libvgm defines both; ours only warn "macro redefined" |
| `src/bindings/libvgm-wrapper.cpp` | `DEVID_MSM6258/6295 → DEVID_OKIM*` aliases | **delete** | modern libvgm defines `DEVID_MSM6258/6295` and has no `DEVID_OKIM*`; the `#ifndef` never fires and the comment is false |
| `src/bindings/libvgm-wrapper.cpp` | removed `if (pdi.parentIdx != (UINT32)-1) continue;` | **restore master's line** | the stale tree had no `parentIdx`; the modern tree reports linked devices, so without the filter we enumerate each linked device *and* add it again via the primary's `linkedCount` — duplicated voices or `.at()` throwing |
| `src/players/GMEPlayer.js` | `if (… core._gme_disable_echo)` guard | **call directly** (as master) | the fork has `disable_echo` |
| `src/players/XMPPlayer.js` | `if (this.core._xmp_seek_time_frame)` guard | **call directly** (as master) | libxmp 4.7+ has it |
| `src/players/MIDIPlayer.js` | `if (core._adl_getBanksCount && core._adl_getBankNames)` guard | **call directly** (as master) | ADLMIDI is always built and the exports are unconditional |

Net: the wrapper becomes **master + the loop functions**, and the players lose
three "maybe the API isn't there" fallbacks. Strictly closer to upstream.

### What stays overlay-only
The sibling build itself, `build-info.js`, the engine gate, `dev/**`, `AGENTS.md`,
`.nvmrc`, this document.

## 3. PR B needs **no** sibling-clone changes — keep it that way

Every C/C++ change is in an in-repo file, so it rides in the PR like any other
diff:

| engine | how B touches it | clone change? |
| ------ | ---------------- | ------------- |
| libvgm | loop getters live in **our** `libvgm-wrapper.cpp`, composing existing APIs (`GetCurLoop`, `GetTotalTicks`, `SetLoopCount`, `FadeOut`, `GetPlaybackSpeed`) | no |
| libxmp / GME / fluidlite | only APIs `master` already requires | no |
| libsidplayfp | `mmontag/libsidplayfp` fork — `seek()`/`setTempo()` already required by `master` | no (his fork) |
| mdxmini, libADLMIDI, psflib, lazyusf2, farbrausch-v2m | in-repo; `mdxmini` is patched **by B** | n/a |

**Invariant:** anything we need from an engine must be (a) an existing public API,
(b) code in our wrapper that composes existing APIs, or (c) a patch to an in-repo
tree (only `mdxmini`). If a need ever lands in "edit a sibling repo", the answer is
to reimplement it in our wrapper — not to fork the engine. That is exactly how the
libvgm loop feature works today.

## 4. Reproducibility for our dev build

The sibling build traded a content identity for "whatever was cloned". Close it
with a pin: a `dev/engines.lock` (repo + commit per engine) and a checkout script;
`build-info.js` already records each sibling revision, so lock and manifest can be
diffed. Never build the dev core from an unpinned clone.

## 5. Verification (before any promotion)

1. Restore master's `parentIdx` filter; rebuild; confirm linked-device voices
   (OPNA/OPNBB etc.) enumerate **once**, and VGM still renders.
2. `./dev/run-tests.sh` green (2 known VGM xfails) + the Node real-core probe
   (VGM/GME/XMP/SID energies non-zero).
3. Loop band at 1x/2x/0.5x against the pinned libvgm (the `Tick2Second` speed
   assumption) — must be speed-invariant.
4. Build PR B the way a reviewer would (`npm run build-chip-core` from README
   siblings); confirm no unresolved exports, with and without PR A's tree
   deletion.
5. Record the exact engine versions tested in each PR body.

## 6. Risks

- **libvgm tree dependence.** The loop band multiplies `Tick2Second` by playback
  speed; correct and speed-invariant by construction, but position semantics
  differ between libvgm trees. Verify on the pin; document the tested version.
- **`mdxmini` patch** is a behaviour change to a vendored lib; call it out in B.
- **PR A is a judgement call for the maintainer.** It removes his subtrees. Present
  it as cleanup with the "cannot build them anyway" evidence, and let him decline —
  B does not depend on A landing, only on rebasing cleanly if it does.
