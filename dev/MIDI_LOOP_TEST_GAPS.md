# MIDI loop-test asset gaps

Reference notes for the MIDI Repeat-One / loop-expansion work
(`src/players/midi/midi-helpers.js`, `src/players/MIDIFilePlayer.js`), written
after the review round that added `dev/test-midi-loops.js` coverage. The point
is to record **which edge cases our catalog MIDI files exercise and which they
do not**, so a future round can decide whether to author real fixtures.

Set aside for now: no fixture work was done, this is documentation only.

## How the suite gets its coverage

`dev/test-midi-loops.js` has two kinds of check:

- **Synthetic** (`buildMidi(...)`) — hand-built SMFs for the odd shapes. These
  always run, so they are the durable coverage.
- **Catalog** (`catalogCheck(MARIO|DESCENT|DOOM|GYRO, ...)`) — real files under
  `catalog/`. The catalog is user-supplied and gitignored, so every one of these
  **skips when the file is absent** (e.g. on another developer's machine).

Real files the suite uses: `MARIO`, `DESCENT` (= `Game01.mid`), `DOOM`,
`GYRO` (Gyrocopter). Everything else in the suite is synthetic.

## Catalog inventory (scanned 2026-10-13)

25 MIDI files under `catalog/midi/` and `catalog/Nintendo 64 (SoundFont MIDI)/`:
**12 format 1, 6 format 0, 7 format 2.**

**Only 5 have a loop region**, using three marker styles:

| file | range (ticks) | markers | notes |
| --- | --- | --- | --- |
| `Nintendo 64 (SoundFont MIDI)/Mario Kart 64/03 - 3 Raceways, Wario Stadium.mid` | `[0, 8071]` | CC103 only (implicit start) | used by the suite |
| `Nintendo 64 (SoundFont MIDI)/Star Fox 64/05 - Map.mid` | `[0, 5050]` | CC103 only (implicit start) | **unused** |
| `Nintendo 64 (SoundFont MIDI)/Pilotwings 64/13 - Gyrocopter.mid` | `[0, 184320]` | CC102 + CC103 | used by the suite |
| `midi/Game MIDI_Descent (PC∕DOS, 1995)_GAME01[ham].MID` | `[55, 23538]` | CC110 + CC111 (+CC108/109) | **unused**; the only real **loop-empty** file |
| `midi/Game MIDI_Descent (PC∕DOS, 1995)_Game01.mid` | `[12, 23939]` | CC110 + CC111 (+CC108/109) | used by the suite |

Everything else (20 files) has no loop markers.

### What the looped files do NOT contain

- **Tempo change inside a loop region: none.** Every looped file has exactly one
  tempo event (at the start). The files with many tempo events (`onestop.mid`
  20, `Nurse Edna` 37, `Tentacle Disco` 4, Windows `flourish`/`town` 2) have
  **no loop region** at all.
- **Post-loop notes (a composed ending after the loop end): none.**
- **Lone CC111 (RPG Maker "loop to end"): none.**
- **Format-2 file with markers: none.** All 7 format-2 files (Day of the
  Tentacle) report no range. `scripts/build-music.js` counts format-2 SMFs in
  its run summary precisely to catch if one ever does carry markers.
- **A loop-empty track** (a track with no events inside `[startTick, endTick]`
  but content past it): **only `Descent FM [ham]`** — and the suite does not
  use it.

## Coverage vs the suite's edge cases

| edge case | exercised by | kind |
| --- | --- | --- |
| implicit-start CC103 region | `Mario` (used), `Star Fox 64` (unused) | real / real-unused |
| CC102 + CC103 pair | `Gyrocopter` | real |
| CC110 + CC111 with start > 0 | `Descent Game01` (used), `Descent FM` (unused) | real / real-unused |
| no markers, single-pass merge | `DOOM` (+20 files) | real |
| noteless padded `END_OF_TRACK` outro | `Gyrocopter` | real |
| multi-track format 1 | `Mario`, `Gyrocopter` | real |
| loop-empty track (replay-skip, #6) | synthetic — `Descent FM` is a real instance and unused | **gap** |
| first event past loop end → outro shifted past the passes (#6) | synthetic only | **gap** |
| tempo change inside the loop restored on replay (#4) | synthetic only | **gap** |
| lone CC111 (RPG Maker, loop to track end) | synthetic only | **gap** |
| paired marker shorter than a beat (not a region) | synthetic only | **gap** |
| format-2 with markers | synthetic only | **gap** |
| post-loop content *with* notes keeps its timing | synthetic only | **gap** |
| Web MIDI wrap reschedules in the same call (#5) | synthetic (player-level) | by nature |

## Gaps and possible closures

1. **Unused real loop files.** `Star Fox 64/05 - Map` (CC103 implicit-start,
  format 1, 13 tracks) and especially `Descent FM [ham]` (the only real
  loop-empty track — the exact shape behind the #6 fix) are on disk but not in
  the suite. Adding a `catalogCheck` for each is cheap and would pin #6 against
  real data. (Note: both are `catalog/` files, so the checks still skip
  elsewhere.)
2. **No real file covers a tempo change inside a loop (#4)**, a post-loop note
  ending (#6/#9), a lone CC111, or format-2 markers. Those rest entirely on
  synthetic buffers. If we ever author fixtures, a multi-track format-1 file
  with a tempo change mid-loop and a composed ending would close several at
  once.
3. **The #4 latch/restore is barely touched by real data**: all looped files
   have a single tempo event at tick 0, so "tempo in force at `startTick`" is
   only meaningfully exercised by the synthetic check.
4. **Durability caveat.** Because `catalog/` is gitignored, the real-file checks
   are opportunistic; the synthetic checks are what always runs.

## How to regenerate the inventory

A scanner was used to produce the table above (parse each file with the repo's
`MIDIFile`, call `findLoopRange`, count CC 102/103/110/111, tempo meta events,
per-track in-loop/after-end event counts). A standalone script needs the same
`@babel/core` require hook the harness uses (see the top of
`dev/test-midi-loops.js`) because `midi-helpers.js` is transpiled. Re-run it
after changing the catalog to refresh this document.
