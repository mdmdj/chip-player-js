# MIDI loop-test asset gaps

Reference notes for the MIDI Repeat-One / loop-expansion work
(`src/players/midi/midi-helpers.js`, `src/players/MIDIFilePlayer.js`), written
after the review round that added `dev/test-midi-loops.js` coverage. The point
is to record **which edge cases our catalog MIDI files exercise and which they
do not**, so a future round can decide whether to author real fixtures.

Two modes, per `getPlaybackEvents(useTrackLoops)`: **detection is always on** —
the region is reported from any file, the slider band shows, and Repeat One wraps
(`MIDIPlayer`); the **expansion is the opt-in** (the SoundFont MIDI sets) — intro
+ two passes so the piano roll draws across the seam. Without the opt-in the list
is the file's own timeline and the wrap goes from the loop end back to the loop
start; with it, to the second pass, and the band marks that last instance.
Loop+tempo fixtures now live in `catalog/midi/tempo_stress/` (see AGENTS.md); they
are not a SoundFont set, so they exercise the default path unless the stripped
`cpDevExpandTempoStress` toggle is set.

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
- **Lone CC111 (RPG Maker "loop to end"): none in the catalog** — the authored
  `catalog/midi/tempo_stress/loop/*.rpgmaker.mid` fixtures cover it (note their
  region is the *ending* section: a lone CC111 has no partner, so it reads as
  "loop from here to the song end", not "end at this tick").
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
| lone CC111 (RPG Maker, loop to track end) | synthetic + the `*.rpgmaker.mid` fixtures | gap (real file) |
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

The expansion never moves an event: a post-loop event keeps its authored offset
from the loop end, and the song's end is taken from the last *note* event
(`getLoopedEvents`), so converter padding cannot inflate the duration. A note
that *starts* inside the loop and is *released* after it is cut at each *replay*
boundary (`seamReleases`), so the replay never sends a second NoteOn for a
still-sounding note (the MIDI spec calls that invalid); the composer's authored
release still plays in the outro, at its written position.

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

**Corrected 2026-10-16 — the per-track collapse is gone.** The cut used to be
the *track's* job: a track with no post-loop note-on had its whole outro moved
onto the loop boundary (`postHasNotes` / `postHasContent`), which cut a crossing
release and dropped converter padding in one move. That gate keyed on the wrong
property. A Type-1 conductor track carries the ending's *tempo changes* and no
notes, so its tempos were collapsed onto the boundary while the note tracks kept
their timing, and the ending played at the wrong tempo (greptile P1 on PR #13).
"Noteless" is not "dead air", and no per-track property can be — so the two
concerns it fused are now separate rules, and nothing is moved:

- **The cut is the replay boundary's job** (`seamReleases`), for every track: the
  notes ringing at the loop end are released at each replay, so the replay never
  sends a second NoteOn for a still-sounding note. This is the 2026-10-15 fix
  below, now uniform instead of gated.
- **Position is the file's**: a post-loop event (a release included) keeps its
  authored offset from the loop end, landing after the passes.
- **The duration is the sounding content**: `getLoopedEvents` ends the song at the
  last note event and drops trailing meta/cleanup, which is what actually kept
  converter padding from inflating the duration.

Both rules are pinned by `dev/test-midi-loops.js`. The earlier measurement stands
— on the synthetic shape (release one tick past the end, plus a composed ending)
`on@0 off@500 on@2000 on@4000 off@6500`, the replay no longer runs the note
underneath its own re-trigger.

**Corrected 2026-10-15 (greptile's `midi-helpers.js:176`).** This section used to
end "there is no note-tracking to add", reasoning that a release "looks the same
to that test" as padding. Under the old collapse that held only when the track had
no note-on past the loop end. `EventIterator` already tracks the notes ringing at
the loop end (`seamReleases`) and releases them at every *replay* boundary, so the
expanded two-pass list cuts the way the Repeat One wrap (`loopJump`) already does.

The cut is **not** applied at the loop → *outro* transition. There the release is
the composer's own and the note rings into the ending as written — `off@6500` in
the same measurement — which is what "a composed ending keeps its exact timing"
means. Pinned by `dev/test-midi-loops.js` ("a note crossing the seam is cut at the
replay, composed ending or not"), which fails with the cut disabled.

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

## Fixed 2026-10-16: enabling Repeat One in the outro rewound the transport

An adversarial pass over the whole MIDI loop surface (27 catalog marker files ×
{1-pass, 2-pass}, probes under `dev/`'s harness shapes) found one real defect: the
wrap was gated only on `position >= endIndex && elapsed >= endMs`, so a listener
who played past the band with Repeat One off and then switched it on satisfied
that condition on the next callback and `loopJump()` rewound one loop. Measured
`7846 -> 3893 ms` (**-3953**) on the harness's loop+ending shape; both engines
(Web MIDI `7400 -> 4900`).

Fixed by `loopRegionLeft` (`MIDIFilePlayer.js`): set when the clock passes the band
with Repeat One off, it gates the wrap and lifts the band-end cap so the outro
plays out and the song ends -- the VGM `#4` precedent (enabled at the tail: finish
it and end, never fold back). Cleared on load and on a seek. Pinned by
`dev/test-midi-loops.js` ("Repeat One enabled in the outro does not rewind the
transport"), which fails against the unfixed code at that magnitude.

Same pass, two smaller things: `findLoopRange`'s `Math.min(...markers)` spreads
became an iterative `minOf` (a file with ~1e5 loop CCs would throw `RangeError`
before the merge cap; behavior identical, max observed marker count 9), and
master's leftover `console.debug(combinedEvents)` was removed (every marker file
reaches `getLoopedEvents` now, so Descent was dumping 15097 objects per load).

## Fixed 2026-10-17: seeking into the ending rewound the transport (greptile, `MIDIFilePlayer.js:576`)

Same contract as the outro toggle above, reached through the seek: `setPosition()`
cleared `loopRegionLeft` outright, so a listener who sought into the ending — with
Repeat One on, or before enabling it — had the next callback wrap and pull the
transport back into the band, overriding the position they asked for.

Both wrap guards read that flag (`processPlaySynth` returns into `loopJump()` when
`position >= loop.endIndex`; `processPlay` at its look-ahead), and it is only ever
*set* when `!this.looping`, so with Repeat One already on nothing re-set it.
Measured on the synth path (the default — the app's MIDI output is the dummy one),
an 8 s file with a region `[0,1000]`:

| seek | the first block after it |
| --- | --- |
| 7800 ms (the ending), repeat on | **rewound 6954 ms**, landing at 846 ms inside the band |
| 500 ms (inside the band) | held position (546 ms), then wraps at the band end |

Fixed by deriving the flag from where the seek landed instead of clearing it:

```js
this.loopRegionLeft = !!(this.loop && !this.isAuditioning && ms > this.loop.endMs);
```

So the ending plays out and the song ends — which is the ending Repeat One then
repeats — while a seek inside the band still re-arms the wrap. Both paths share the
flag, so Web MIDI is fixed by the same line.

Pinned by `dev/test-midi-loops.js`: the existing outro check now expects the flag
*set* after a seek into the ending (it asserted the cleared flag, which was the bug
itself), plus "a seek into the ending does not rewind, in either repeat order"
(seeking first and then enabling, and repeat already on) and "a Web MIDI seek into
the ending does not rewind either". All three fail against the previous code, and
the same check keeps a seek into the band wrapping at the band end, so the fix
cannot quietly disable the wrap.

## Fixed 2026-10-17: a marker file cut a held note at the song end, not its track's (greptile, `midi-helpers.js:599`)

"Notes outlast their tracks": the per-track release pass — release every channel a
track has sounded at that track's own `END_OF_TRACK`, so a note the writer never
released cannot run past its track — lived only in the `getEvents()` patch.
`80cbba069` sent marker files outside the SoundFont set through `getLoopedEvents()`,
which appends releases only at the *song* end, so those files lost the cut.

Reproduced with the tracks kept apart (track 0 holds a note and ends at 1 s; track 1
plays to 5 s and carries the loop end, so the region is real and the marker path —
not the `getEvents` fallback — is the one under test):

| path | track0/ch0 releases | the held note is cut at |
| --- | --- | --- |
| `getEvents()` | `[1000, 1000, 5000, 5000]` | 1000 ms — its own track's end |
| `getPlaybackEvents(false)` | `[5000, 5000]` | 5000 ms — the song's end |

**Fixed by moving the pass, not by copying it.** Two lists cannot drift again if
there is one implementation: `insertTrackEndReleases(events)` now holds it, and both
`getEvents()` and the loop path call it. A copy would not even have been faithful —
the pass accumulates per track and clears at each of its end-of-track events, while
the loop path's `channelsByTrack` accumulates across the whole track, so a copy keyed
on that would release every channel at the first EOT.

**Scope is the file's own timeline**: `if (loopCount === 1)`. The expanded list is
replayed and the seam owns its crossings; applying the pass there broke two existing
checks *while testing* — `a note released past the loop end rings into the ending at
its authored offset` lost the authored release, and the pedal-held seam check found
"nothing was sustained" because an inserted CC64=0 landed inside the body. Those two
failures are why the gate exists, so it is evidence from the test run rather than a
preference.

**No regressions, measured.** A before/after probe over all 54 catalog MIDI files,
hashing every event's type/subtype/track/channel/params/time:

- `getEvents()` is byte-identical in both runs — the extraction is a verbatim move
  (plain hash `922c1940` over 305572 events).
- Exactly **one** merged list changed: `catalog/midi/loop-pedal-seam.mid`, 15 → 17
  events, and its merged hash became *equal to its own plain hash*. Every other
  file — the three expanded SoundFont files included — is byte-identical.
- Note-level reachability is **0 of 27** marker files (a note held past its own
  track's end while the song continues), so nothing shipped is affected; the one
  file that changed is the dev fixture authored for the pedal-seam shape, where the
  inserted pair is a redundant safety release.

Checks: `a marker file cuts a held note at its own track end, like the plain path`
asserts the parity (both paths `[1000, 5000]`), that the region is real, and that
asking twice does not accumulate releases. It fails against the previous code with
the merged path's `[5000]`.

## Fixed 2026-10-17: the wrap replayed a program before the bank select it belongs to (greptile, `MIDIFilePlayer.js:596`)

Bank select (CC0/CC32) takes effect on the *next* program change, so a replayed
program must not go out ahead of the bank it was authored with. `collectStateEvents`
returned `Object.values(eventMap)`, and those keys are not array indices, so the
order was **first-seen**: a channel that picked a program before it ever picked a
bank replayed the program first — onto the bank the finished pass left, i.e. the
wrong instrument for the rest of the pass.

Reproduced (program at 0, bank 1 at 1 TPQ, loop start at 3, bank 2 *inside* the
loop). The order the wrap actually plays, captured from the synth calls:

| | |
| --- | --- |
| before | `P0:2, B0:0=1, B0:32=0` — the program lands on bank 2 |
| now | `B0:0=1, B0:32=0, P0:2` — on bank 1, where it was authored |

Fixed in the collector, so the wrap, the seek and both output paths share it: the
replay is ordered **banks (MSB, then LSB) → programs → the rest of the last-wins
state → the sequenced RPN/NRPN pair**. The middle step is not decoration: a program
change may itself reset controllers, so a program ahead of them — and ahead of the
RPN that sets the bend range — leaves the pass sounding the way the file wrote it.

**No regressions, measured** (A/B over every catalog MIDI with a region, 27 files):
the *set* of collected events is identical for all 27 (nothing added or dropped),
the bank-before-program invariant holds in both runs, and the replay order changed
for exactly **4** files — Wario, `Star Fox 64/05 - Map`, Gyrocopter and Descent
Game01 — all by the intended regrouping. The *bad* order is **0 of 27**: only Wario
and Star Fox collect a bank select, and both already authored bank-then-program.

Checks: `a wrap replays bank select before the program that uses it` asserts the
collector's order *and* the order the synth is called in at the wrap; it fails
against the previous code with `P0:2` first.

## Fixed 2026-10-17: a note-off for a note that never played held the end open (greptile, `endRule.js`)

`endNote` handed any note-off to the pedal whenever the channel's pedal was down,
without asking whether the note was playing:

```js
sounding.delete(key);
if (layers.sustain && (pedal.get(e.channel) || 0) >= 64) pedalHeld.add(key);
```

A converter's trailing cleanup can release a note that was never on, so a phantom
sat in `pedalHeld`, `held()` stayed true, and the end ran on to the pedal release —
or, since the dangling rule credits a trailing event, to the track end — with
nothing playing:

| shape | before | after |
| --- | --- | --- |
| pedal lifted at 2000 ms, `END_OF_TRACK` at 6000 ms | **2000 ms** | **500 ms** |
| pedal never lifted, `END_OF_TRACK` at 6000 ms | **6000 ms** | **500 ms** |
| a note that *did* sound, released under the pedal | 900 ms | 900 ms |

The fix is the gate greptile suggested — `const wasSounding = sounding.delete(key)`
and only then add to `pedalHeld` — which also makes a second note-off for a note the
pedal already holds a no-op, i.e. what it is: the hold was taken when the note
stopped sounding.

**Reachability: the shape is on disk, the effect is not.** 1 of the 54 catalog files
has a pedal-down note-off for a note that never sounded, and 0 have an inflated end
— on that file something else is genuinely audible later. A before/after probe over
all 54 (merged list and its duration, the plain list and its duration, and
`songEndMs`): **byte-identical**, so nothing shipped moves.

Check: `end layers: a note-off for a note that never played does not hold the end`
pins both shapes and the real pedal case; it fails against the previous code at
2000/6000.

## Recorded, not fixed: the band can reach a few ms past the song (2026-10-16)

`MIDIPlayer.getLoopBandMs` returns the wrap span as-is, where the base
`Player.getLoopBandMs` clamps -- or returns null -- when a region reaches past
`getDurationMs`. Measured across the 54 catalog marker loads: **16 rows differ,
by 27-458 ms** (`Pilotwings 64/13 - Gyrocopter.mid` band `0..106667` vs duration
`106640`; `Descent Game01` `100..200194` vs `200144`; the RPG-Maker fixtures
`6400..24400` vs `24317`).

Not fixed, per the review bar (audio, or a control beyond its own resolution):
`AppFooter` clamps the band end to 1, `loopStart` is at or below 1 on every real
file, and `Slider` hides a reversed band, so nothing is drawn off-slider.
Revisit if those stop clamping.

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

## Documented, not fixed: "the PR adds no tests for the expansion" (2026-10-16)

greptile P2 on PR #12 (`midi-helpers.js:375`): the loop expansion serves both
playback and the piano roll, the PR ships no automated tests for it, and it changes
timing across tracks, tempo changes, held notes and composed endings — "listening
tests alone can miss errors shared by the audio and piano roll".

**The tests exist; they are deliberately not in the PR.** `dev/test-midi-loops.js`
has 39 checks covering exactly those shapes: exact times ("replayed pass keeps the
beat", "a seam release moves the emitted timeline to the boundary", "post-loop
content *with* notes keeps its exact timing"); loop bounds ("Mario Kart: region is
the whole song, [0, ~72062] ms, two passes", plus the CC102/103, CC111 and
format-2 shapes); tracks that end early ("a track whose only events are past the
loop end still shifts its ending", "Gyrocopter: padded END_OF_TRACK does not
inflate duration"); tempo changes inside a loop (three checks, including the
third-pass case); held notes and composed endings (the seam cuts, the pedal
fixture, "wrapping at the band end leaves the composed ending").

The "shared by the audio and piano roll" worry is answered by construction: the
expansion is one source for both (`getPlaybackEvents`), and the checks assert the
list the roll reads, so a shared error is one error in one place rather than two
implementations drifting.

Why they are not shipped: the repo has no test runner and no CI, `catalog/` is
gitignored so the real-file checks would silently skip elsewhere, and the benefit
is consumed before the PR is written while the maintenance cost lands on the
reviewer. If a durable suite is ever wanted, the same harnesses move to a tracked
`test/` dir under `node --test` with no new dependencies. No new information since
that decision, so: not a bug, documented.

## Fixed on the overlay, not on the PR head: held MIDI endings were shortened (F-B, 2026-10-17)

greptile P1 on PR #15 (`midi-helpers.js:602`): "For a MIDI file with loop markers,
the last `NOTE_OFF` can occur while the sustain pedal still holds the note. This
code deletes the later authored pedal release and adds `sustainOff` at the last
note event instead. That cuts the held sound early, even with Repeat One off."

**Real against the PR head, and the overlay already fixes it.** The head's
`getLoopedEvents` takes the end from the NOTE_ON/NOTE_OFF classes alone:

```js
for (const e of combinedEvents)
  if ((e.subtype === EVENT_MIDI_NOTE_ON || e.subtype === EVENT_MIDI_NOTE_OFF) && e.playTime > endMs)
    endMs = e.playTime;
if (endMs > 0) splice everything with playTime > endMs;   // the pedal lift is a CC64 -> deleted
```

Measured on the shape (markers, `on@0`, `CC64=127@100`, `off@500`, `CC111`,
`CC64=0@1500` — the release last, which is what the finding needs):

| tree | last event | CC64 events | duration |
| --- | --- | --- | --- |
| `feature/subtunes-as-first-class` (PR head) | **500 ms** | `100=127`, `500=0` (appended) | **500 ms** |
| `dev/overlay` | 1500 ms | `100=127`, `1500=0` (authored), `1500=0` (appended) | 1500 ms |

So the held ending is cut at the last note-off (500 ms) on the head and runs to
its authored pedal lift (1500 ms) on the overlay. The fix is the layered end rule
(`endRule.js`, `a9786dd64`) — unpromoted, which is why the PR head still has it.
`endLayersFor`'s `sustain` layer credits the pedal lift (`songEndMs`), the splice
only drops events *after* that end, and the appended `sustainOff` lands on it.
Pinned by the harness check "end layers: the sustain pedal is what makes a held
ending audible". **Disposition: a promote, not a commit.**

## Fixed 2026-10-17: the wrap centres a pitch bend the file never authored (F-C)

greptile P1 on PR #15 (`MIDIFilePlayer.js:590`): "`loopJump()` leaves the finished
pass's pitch bend in place when the file has no bend message before the loop
start... For a non-expanded MIDI that starts centered and bends later in the loop,
`collectStateEvents(0, loop.jumpMs)` returns no bend to restore. The next pass
therefore opens bent instead of centered. Restore default values for changed
controls that have no earlier authored value, then replay the saved state."

**Real, and reproduced.** Synthetic non-expanded fixture (markers, a bend after
the loop start, no bend before it), wrap at the band end:

| | `pitchBend` calls at the wrap |
| --- | --- |
| gate off (the file's own timeline, `jumpMs` = loop start) | **none** — the finished pass's bend is carried |
| gate on (expanded, `jumpMs` = second pass) | `[pitchBend 0, value 0]` — the collected state, restored |

**This is a hole the permissive loop change opened, not a policy choice.**
`collectStateEvents` returns only the values the file *changed*, so "the state at
the jump target" is under-determined when the target's value is the engine's
initial one (a centred bend): there is no entry to restore, and the finished
pass's value silently wins. The wrap code is unchanged (`MIDIFilePlayer.js:590` is
identical on both branches) — it was written for the *expanded* case, where
`jumpMs` is a continuation point and the collected state is the carry. What
changed is that `80cbba069` ("detect the loop region always") made the
non-expanded wrap the **default path for every marker file**; before it, a file
outside a SoundFont set had no region at all, so the path did not exist.

**Reachability measured: 0 of 24.** Scanner over the catalog (57 MIDIs, 27 with a
region, 24 of those non-expanded): only **2** bend inside the loop — both Descent —
and **both also bend before the loop start**, where the target-state restore
applies and nothing leaks. The shape is absent from the arbiter (`catalog/`; there
is no MIDI corpus in `dev/`), so it did not clear the bar's criterion 2 on its
own; fixed anyway as a one-class consistency fix (the user's call), because it is
the same act as cutting the ringing notes and has no catalog delta. The convention
where it is most likely to appear in the wild is the lone-CC111 RPG-Maker one
(loop from the marker to the song end), where a late bend is plausible and the
catalog has only the authored `*.rpgmaker.mid` fixtures (no bends).

Two resolutions were on the table:

- **(A) Complete the target state** — before replaying the collected list, reset
  the controls whose target value the file never authored to their engine-initial
  value. Unambiguous for pitch bend (8192); the general case needs a per-control
  notion of "initial" (synth/soundfont vs receiver defaults).
- **(B) Take the carry literally** — grounds 2 and 3 of the 2026-10-15 decision
  say the wrap should match the expansion and the sequence-jump driver, so make
  the non-expanded wrap collect from the loop *end* (or restore nothing at all)
  and stop presenting the intro's value. **This is the one with an audible catalog
  effect**: the two Descent files would open pass 2 with the body's last bend
  instead of the intro's.

**Chosen: (A), scoped to the pitch bend.** `loopJump` now centres the bend on all
16 channels at the boundary in both paths — `send([0xE0|ch, 0, 64], boundary)` and
`synth.pitchBend(ch, 8192)` — *before* the collected state is replayed, so an
authored bend still wins. Same act as cutting the notes ringing at the seam: end
what the finished pass left, then present the target's state.

Pinned by two checks: "a wrap centres a bend the file never authored (no
expansion)" (fails against the unfixed code with an empty bend list) and "and the
expanded wrap still restores the bend the file did author" (the reset must not
clobber the carry — passes either way). The Web MIDI path is covered by the
existing "the wrap cleanup lands on the band end, not the last event", which now
also asserts the centre message and its timestamp, and fails against the unfixed
code too.

### The rest of the state, audited (same scanner; 27 catalog files with a region)

| class | leaking keys | audible |
| --- | --- | --- |
| pitch bend | 0 (centred now) | — |
| channel aftertouch (never collected at all) | 0 | — |
| the RP-015 CCs (modulation, expression, sustain, portamento, soft/legato) | 0 | — |
| volume (CC7) | 10 | **0** |
| pan (CC10) | 9 | **0** |
| program | 13 | **0** |

"Leaking" = the value at the wrap-from point differs from the target's (GM
defaults assumed for the CCs RP-015 excludes); "audible" = a note starts on that
channel *before* the file re-authors it, the only window where the wrong value can
be heard, since the wrap cuts every ringing note and a pass therefore begins
silent. So the remaining classes are exposed in principle and inaudible on every
file we have — which is the general form of the 2026-10-16 measurement that all
five looped files open pass 2 on the same instrument.

Why the rest are not centred the same way: RP-015 names pitch bend, aftertouch,
modulation, expression, the pedals and switches and RPN/NRPN as the state with a
defined default, and deliberately *excludes* volume, pan, program, bank select and
the effect depths, because those belong to the receiver or the patch rather than
to a spec constant. Resetting them would be the engine inventing state the file
did not ask for — the ground the earlier re-raises were declined on — and a
receiver's preset is not ours to guess. They stay carried, now *documented* as
carried, with the counts above as the evidence that it costs nothing audible here.
The same comment in `loopJump` states the scope, so the next reader sees a
contract rather than a gap.

## How to regenerate the inventory

A scanner was used to produce the table above (parse each file with the repo's
`MIDIFile`, call `findLoopRange`, count CC 102/103/110/111, tempo meta events,
per-track in-loop/after-end event counts). A standalone script needs the same
`@babel/core` require hook the harness uses (see the top of
`dev/test-midi-loops.js`) because `midi-helpers.js` is transpiled. Re-run it
after changing the catalog to refresh this document.
