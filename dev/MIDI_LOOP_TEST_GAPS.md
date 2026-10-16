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
   only meaningfully exercised by the synthetic check. The multi-track merge's
   restore is per pass (see the check "the tempo restore repeats on a third and
   later pass"); that check is the only one asking for more than two passes, so
   it is what keeps a third-pass regression from going unnoticed.
4. **Durability caveat.** Because `catalog/` is gitignored, the real-file checks
   are opportunistic; the synthetic checks are what always runs.

## Decision: a note crossing the loop end is cut at the seam

`EventIterator` collapses post-loop events that carry no note-on to the loop
boundary (so converter padding cannot inflate the duration). A note that
*starts* inside the loop and is *released* after it looks the same to that test,
so its release is moved to the boundary and the note is cut.

This is deliberate and conventional:

- DAWs cut notes that cross a loop/cycle boundary by default — Logic ("Notes
  cut off when cycles"), Cubasis ("note cut off in loop mode"); Ableton needs a
  manual wrap. Continuing a held note is an explicit opt-in ("note chase" /
  "chase long notes" in Studio One / Bitwig / Reason), with "cut long notes" as
  its counterpart.
- It is also the standard-safe choice: letting the note ring past the boundary
  makes the replay send a second NoteOn for a still-sounding note, which the
  MIDI spec calls invalid (Ardour, "Handling Overlapping Notes").

A file whose loop marker sits mid-note is an authoring error — the loop should
be placed where voices resolve — and cutting is what we do.

**Corrected 2026-10-15 (greptile's `midi-helpers.js:176`).** This section used to
end "there is no note-tracking to add", reasoning that a release "looks the same
to that test" as padding. That holds only when the track has no note-on past the
loop end: the collapse is gated on `!postHasNotes`, so with a composed ending the
release keeps its deferred position and the note is *not* cut — and the replay
then sends a second NoteOn for a still-sounding note, the very thing this
decision calls invalid. Measured on a synthetic shape (release one tick past the
end, plus a composed ending): `on@0 off@500 on@2000 on@4000 off@6500` — the note
running underneath its own re-trigger. `EventIterator` now tracks the notes
ringing at the loop end (`seamReleases`) and releases them at every *replay*
boundary, so the expanded two-pass list cuts the way the Repeat One wrap
(`loopJump`) already does.

The cut is still **not** applied at the loop → *outro* transition. There the
release is the composer's own and the note rings into the ending as written —
`off@6500` in the same measurement — which is what "a composed ending keeps its
exact timing" means. Pinned by `dev/test-midi-loops.js` ("a note crossing the
seam is cut at the replay, composed ending or not"), which fails with the cut
disabled.

## Decision: the wrap restores the state at the jump target, not at the loop entry (2026-10-15)

greptile (`midi-helpers.js:176`, P1) reports that the replay rewinds events
without restoring the controller/program values from the loop's *start*, and
that `loopJump()` "keeps the same wrong state by collecting values through
`loop.jumpMs`, which includes the entire first pass" — its example is an intro
CC7=100 with the loop later setting CC7=0, so the second pass would start
silent.

Declined, on three grounds, and the second is the one that would make the
suggested change a *regression* rather than a fix:

1. **`collectStateEvents` is the seek helper.** `MIDIPlayer.collectStateEvents(fromIdx, toMs)`
   (`MIDIFilePlayer.js:483`) is documented as "newest program/controller state
   before toMs, for restoring the synth after a transport move (seek or loop
   wrap)", and `seekToMs` calls it with the seek target (`:521`). So
   state-at-a-time has exactly one definition here, and a wrap *is* a transport
   move: `loop.jumpMs` is the time it moves to. Including the first pass is not
   an oversight — it is what makes the result the state *at the jump target*.
2. **The two mechanisms agree today, and the proposal would split them.** The
   other path — the expanded two-pass list from `getLoopedEvents`, which also
   feeds the piano roll — carries MIDI state across the boundary, because
   nothing resets it: pass 2 begins with the values pass 1 ended with. The wrap's
   restore reproduces exactly that. Restoring loop-*entry* values at the wrap
   would make the JS wrap and the expanded list sound different at the same
   musical point.
3. **It is what the original driver does.** These markers (CC110/111, CC102/103)
   come from engines that loop by jumping the sequence; a sequence jump does not
   re-initialise controllers, so the game's second pass starts with the state the
   first pass left.

Measured over the catalog (same scanner as below, plus a state map from the
expanded events at `loopStartMs` and at `loopEndMs`): **2** MIDI files have a
loop region, both Descent, and in both the two states *do* differ — 22 and 53
`(channel, controller)` slots. Mostly that is because their loops start at
~100 ms, before the song's own patch setup, which lies *inside* the loop and is
therefore replayed either way; what is genuinely carried is automation such as
`3/cc10` (pan) 23 → 43. So the finding is not vacuous for these files — the
behaviour is a real choice — but it is the choice the format's own player makes,
and it keeps the wrap consistent with the expansion.

A composer who needs the loop to re-enter a known state writes that state inside
the loop, which is what "authored to continue" (the `loopJump` comment) means.

**Re-raised 2026-10-16 (greptile, `midi-helpers.js:340`), held again — and the
measurement says it cannot be reproduced on our files.** The new framing is "even
with Repeat One off": the *expanded two-pass list*, which is what plays for a
whole-file loop by default, opens pass 2 with pass 1's end state. My first measure
("5 of 5 looped files contain program changes inside the loop; 4 of 5 end it with
a different program in force") was a *precondition*, not the finding — the state
at the loop's end differing from its start is expected whenever a loop contains
changes. Measured on what actually matters, the program in force at each pass's
*first note*, **all five open pass 2 on exactly the same instrument as pass 1**:
the loop's own event list re-applies its programs before its notes, and a
whole-file loop naturally begins with the file's own setup. The difference the
finding describes needs a file whose loop's opening notes depend on a patch set
*before* the loop start while the loop changes it later; none of ours does.

Held on the recorded grounds as well as that: the expansion and the live wrap
agree (grounds 2 and 3 above), and the source driver plays a sequence jump by
carrying state. If it is ever wanted it is a product call, not a bug fix: ~10
lines across `getLoopedEvents`/`rebaseReplay` (restoring the state recorded at the
loop's start tick) plus `loopJump`'s `collectStateEvents` tick, and updating the
checks that pin the agreement today. A synthetic file like the pedal fixture would
make the difference audible if a decision ever needs hearing.

## Documented, not fixed: the Web MIDI wrap moves the engine clock one look-ahead early (2026-10-16)

greptile (`MIDIFilePlayer.js:607`, P2) reports that the Web MIDI wrap moves the
displayed clock early — its example: `jumpMs=10000, endMs=20000,
elapsedTime=19980` becomes `9980` "while the listener is still hearing 19980", so
"the slider jumps before the loop finishes and briefly lands before the loop
band". Suggested fix: keep a separate clock for display and for queueing.

The mechanism is real; the magnitude is not. `processPlay` wraps inside its
look-ahead window — `elapsedTime + BUFFER_AHEAD >= endMs` — so the clock lands
`endMs - elapsedTime <= BUFFER_AHEAD` before the band end, i.e. **at most 33 ms
of song time** (`BUFFER_AHEAD`), never the 10-second jump the example implies — the example's
own numbers are the 20 ms case: `9980` is `jumpMs - (endMs - elapsedTime)` with
`endMs - elapsedTime = 20`, not a ten-second move.

Why it cannot be more: the wrap is what makes the *next* pass's events land on
the original boundary. `loopJump` carries the signed overshoot
(`elapsedTime = jumpMs + (elapsedTime - endMs)`), so a schedule computed
afterwards maps the band-start event to `boundary`, not to "now". Clamping the
clock instead (the obvious stateless repair) sends that event up to 33 ms early
and shortens the loop by the same amount on every pass — a real musical error
where the current behaviour has none. The synth path is exact either way: it
wraps mid-batch (sub-millisecond `msPerBatch`) the moment `elapsedTime >= endMs`,
so its clock never lands before the band.

What actually reads the clock, surveyed:

| consumer | effect |
| --- | --- |
| footer head (`AppFooter` → `getDisplayPositionMs`) | the fold shows `abs` inside the band, so at most one 100 ms poll can sample the pre-band `jumpMs - ε`; ≤0.33 % of a 10 s band |
| piano-roll playhead (`App.js:1197` → `PianoRollEngine.getSmoothPositionMs`) | `rawPos` drops, and the existing rewind/loop branch snaps `smoothPos = rawPos` — the same wrap, ≤33 ms early |
| media-session position, `Settings` readout, devtools/record shims | display values |
| relative seek (`App.js:619`) | base is ≤33 ms behind; the seek itself is re-derived |
| **audio** | nothing: Web MIDI sends absolute timestamps derived from the overshoot-carrying map, and the next pass's events are scheduled against the original boundary |

So: display-only, bounded by one look-ahead window, below the resolution of a
control the UI samples every 100 ms. The exact display needs a new "the clock has
wrapped" flag on the engine plus resets on load/seek (the post-wrap window is
indistinguishable from the first pass's last 33 ms by position alone), which is
more mechanism than a sub-poll artifact justifies. Verdict recorded per the
review-finding bar in `AGENTS.md` ("audio, or a control beyond its own
resolution").

Revisit if `BUFFER_AHEAD` grows, or if the UI ever samples the position faster
than the look-ahead — then the pre-band sample becomes reachable on purpose.

## How to regenerate the inventory

A scanner was used to produce the table above (parse each file with the repo's
`MIDIFile`, call `findLoopRange`, count CC 102/103/110/111, tempo meta events,
per-track in-loop/after-end event counts). A standalone script needs the same
`@babel/core` require hook the harness uses (see the top of
`dev/test-midi-loops.js`) because `midi-helpers.js` is transpiled. Re-run it
after changing the catalog to refresh this document.
