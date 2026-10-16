import MIDIEvents from './MIDIEvents';
import MIDIFile from './MIDIFile';
const { EVENT_MIDI, EVENT_MIDI_CONTROLLER, EVENT_MIDI_NOTE_ON, EVENT_MIDI_NOTE_OFF } = MIDIEvents;

const CC_64_SUSTAIN = 64;
// Loop-point controllers. N64 marks a CC102 (start) / CC103 (end) pair on
// every track (CC104/105 counts are ignored -- Repeat One loops forever and
// repeat-off plays the two expanded passes, the two-pass libvgm compromise);
// HMI (Descent) marks one loop track with CC110/CC111 (others carry CC108
// alignment marks); a lone CC111 is the RPG Maker convention (loop to the end).
const CC_102_TRACK_LOOP_START = 102;
const CC_103_TRACK_LOOP_END = 103;
const CC_110_HMI_LOOP_START = 110;
const CC_111_LOOP_END = 111;
const CC_123_ALL_NOTES_OFF = 123;

// Backstop for the merged event list, so a pathological file cannot exhaust
// memory in the browser: at a few hundred bytes per event this is around half a
// gigabyte of them. A MIDI runs about four bytes per event, so crossing it takes
// roughly 2 MB of file inside the loop. It never truncates -- the loop region is
// dropped and the song plays through once, the shape a file with no markers gives.
const MAX_MERGED_EVENTS = 1000000;

function isLoopStartCC(cc) {
  return cc === CC_102_TRACK_LOOP_START || cc === CC_110_HMI_LOOP_START;
}

function isLoopEndCC(cc) {
  return cc === CC_103_TRACK_LOOP_END || cc === CC_111_LOOP_END;
}

// Iterative minimum. `Math.min(...markers)` throws RangeError (argument list too
// long) for a file carrying ~1e5 loop CCs, before MAX_MERGED_EVENTS could guard
// the merge. Same value, no argument list.
function minOf(values) {
  let min = Infinity;
  for (const v of values) {
    if (v < min) min = v;
  }
  return min;
}

function isLoopEvent(event) {
  return event.type === EVENT_MIDI && event.subtype === EVENT_MIDI_CONTROLLER &&
    (isLoopStartCC(event.param1) || isLoopEndCC(event.param1));
}

// The loop region is global to the song: HMI defines it once on its loop
// track while every other track just plays through it, and N64 sequences
// repeat the same range on every track. So resolve one absolute-tick range
// up front instead of looping each track on its own markers.
//
// Returns {startTick, endTick} (endTick null = RPG Maker style, loop runs to
// the end of each track) or null when the file defines no loop.
MIDIFile.prototype.findLoopRange = function (tracks) {
  let tpq = 120;
  try {
    tpq = this.header.getTicksPerBeat();
  } catch (e) {
    // SMPTE timing has no ticks-per-beat; keep the fallback threshold below.
  }
  const starts = [];
  const ends103 = [];
  const ends111 = [];
  for (const events of tracks) {
    let tick = 0;
    for (const event of events) {
      if (!event) continue;
      tick += event.delta || 0;
      if (event.type === EVENT_MIDI && event.subtype === EVENT_MIDI_CONTROLLER) {
        if (isLoopStartCC(event.param1)) {
          starts.push(tick);
        } else if (event.param1 === CC_103_TRACK_LOOP_END) {
          ends103.push(tick);
        } else if (event.param1 === CC_111_LOOP_END) {
          ends111.push(tick);
        }
      }
    }
  }

  let startTick;
  let endTick;
  if (starts.length > 0) {
    // Paired loop points (N64 or HMI): first end past the earliest start.
    startTick = minOf(starts);
    const ends = ends103.concat(ends111).filter(t => t > startTick);
    if (!ends.length) return null;
    endTick = minOf(ends);
  } else if (ends103.length > 0) {
    // N64 loop end with the start left implicit at 0 (plus a CC104 count).
    startTick = 0;
    endTick = minOf(ends103);
  } else if (ends111.length > 0) {
    // Lone CC111: RPG Maker loop start, running to the end of each track.
    startTick = minOf(ends111);
    endTick = null;
  } else {
    return null;
  }

  // A loop shorter than a beat is a marker, not a region (e.g. an RPG Maker
  // "don't loop" jingle flag sitting at the very end of the song).
  if (endTick != null && endTick - startTick < Math.max(24, Math.floor(tpq / 4))) {
    return null;
  }
  return { startTick, endTick };
};

// The seam, in one place: a loop's own events re-establish its state, so the
// iterator intervenes only where no event can -- notes still sounding at the
// boundary (cut; for a pedal-sustained note that cut is a pedal lift, then the
// pedal's own seam value is re-applied) -- and where the replay changes what time
// means (the loop-start tempo latched and restored per pass, which is what gives
// the replayed pass's events the right ms mapping). Transport policy is the
// player's business.
class EventIterator {
  constructor(events, loop) {
    // getTrackEvents can trail a null on empty tracks; drop it early so tick
    // math below never sees it.
    this.events = (events || []).filter(e => e != null);
    this.loop = loop || null;
    this.pos = 0;
    this.elapsedLoops = 0;
    this.curTick = 0;
    // Passes of the loop segment still to play (first pass + repeats).
    this.passesLeft = loop ? loop.maxLoops : 1;
    this.absTicks = null;
    this.startIdx = 0;
    // Post-loop events keep their authored position (see next()): an event's
    // offset from the loop end places it after the passes. Nothing is clamped
    // onto the loop boundary; the song's end comes from the sounding content
    // (getLoopedEvents), so a converter's note-less tail cannot inflate it.
    // Tick shift owed to a skipped replay, applied to the next emitted event's
    // delta (see next()).
    this.pendingExtra = 0;
    if (loop) {
      // Absolute tick of each event, so the shared range cuts every track at
      // the same musical point regardless of which track holds the markers.
      this.absTicks = new Array(this.events.length);
      let tick = 0;
      for (let i = 0; i < this.events.length; i++) {
        tick += this.events[i].delta || 0;
        this.absTicks[i] = tick;
      }
      this.startIdx = this.absTicks.findIndex(t => t >= loop.startTick);
      if (this.startIdx < 0) this.startIdx = this.events.length;
      // Each completed pass ends one loop length further along the emitted
      // timeline; rebaseReplay() uses this so a repeated segment keeps the beat
      // instead of re-adding the gap from its pre-loop neighbor.
      //
      // With no end marker (a lone CC111: the RPG Maker loop-start convention)
      // the loop runs to the end of the *song*, not this track's own end -- a
      // part that ends early must keep its trailing silence and wait for the
      // song end, or it repeats while the longer parts are still on their first
      // pass. getLoopedEvents resolves that song-wide tick once (songEndTick).
      const lastTick = this.absTicks.length ? this.absTicks[this.absTicks.length - 1] : 0;
      const endTick = loop.endTick != null ? loop.endTick
        : (loop.songEndTick != null ? loop.songEndTick : lastTick);
      this.boundaryTick = endTick;
      this.loopLength = endTick - loop.startTick;
      this.replayDelta = null;
      // Decision (2026-10): a note that starts inside the loop and is released
      // after it is cut at the seam -- its release is emitted at each replay
      // boundary (see rebaseReplay) so the replay never sends a second NoteOn for
      // a still-sounding note, which the MIDI spec calls invalid. The composer's
      // authored release past the loop end still plays in the outro, at its
      // authored position. See dev/MIDI_LOOP_TEST_GAPS.md.
      // Notes that cross the seam, released at every replay boundary (see
      // rebaseReplay). A release sitting past the loop end is still pending when
      // the replay re-triggers the same pitch, and a second NoteOn for a
      // sounding note is invalid, so the crossing notes are tracked and cut
      // explicitly -- every track, every replay. Nothing is cut when the loop
      // *plays out* into the outro: there the release is the composer's, and the
      // note rings on as written.
      this.pendingReleases = null;
      this.seamReleases = [];
      // Channels whose sustain pedal is down at the seam, with the value it has:
      // a note released while the pedal is down is gone from `ringing` but still
      // sounds, so the seam has to lift the pedal as well (see rebaseReplay).
      this.seamSustain = [];
      const ringing = new Map();
      const sustain = new Map();
      for (let i = 0; i < this.events.length && this.absTicks[i] <= endTick; i++) {
        const e = this.events[i];
        if (e.type !== EVENT_MIDI) continue;
        if (e.subtype === EVENT_MIDI_NOTE_ON && e.param2 > 0) {
          ringing.set(`${e.channel}-${e.param1}`, { channel: e.channel, pitch: e.param1 });
        } else if (e.subtype === EVENT_MIDI_NOTE_OFF ||
                   (e.subtype === EVENT_MIDI_NOTE_ON && e.param2 === 0)) {
          ringing.delete(`${e.channel}-${e.param1}`);
        } else if (e.subtype === EVENT_MIDI_CONTROLLER && e.param1 === CC_64_SUSTAIN) {
          sustain.set(e.channel, e.param2);
        }
      }
      for (const note of ringing.values()) {
        this.seamReleases.push({
          delta: 0,
          type: EVENT_MIDI,
          subtype: EVENT_MIDI_NOTE_OFF,
          channel: note.channel,
          param1: note.pitch,
          param2: 0,
          absTick: endTick,
        });
      }
      for (const [channel, value] of sustain) {
        if (value >= 64) this.seamSustain.push({ channel, value });
      }
    }
  }

  next() {
    // A crossing note's release, queued by the replay that triggered it (see
    // rebaseReplay), is emitted before the replayed pass resumes.
    if (this.pendingReleases && this.pendingReleases.length) {
      return this.pendingReleases.shift();
    }
    // A track that runs past the loop end — or ends exactly on it — replays
    // the loop segment until its passes run out. Anything past the loop end
    // then plays once as the outro.
    if (this.loop && this.loop.endTick != null &&
        (this.pos >= this.events.length || this.absTicks[this.pos] > this.loop.endTick)) {
      if (this.passesLeft > 1 &&
          this.startIdx < this.events.length &&
          this.absTicks[this.startIdx] <= this.loop.endTick) {
        this.passesLeft--;
        this.elapsedLoops++;
        this.rebaseReplay();
        this.pos = this.startIdx;
        // The releases queued by rebaseReplay come first: the replay's own
        // events start on the following call, with replayDelta already set.
        if (this.pendingReleases && this.pendingReleases.length) {
          return this.pendingReleases.shift();
        }
      } else {
        if (this.passesLeft > 1) {
          // Nothing inside the loop to replay (this track's first event is past
          // the loop end), but the passes still add time: shift the outro past
          // them so it follows the loop instead of overlapping the last pass,
          // and never duplicate it.
          const extra = (this.passesLeft - 1) * this.loopLength;
          this.pendingExtra = (this.pendingExtra || 0) + extra;
          this.boundaryTick += extra;
          this.elapsedLoops += this.passesLeft - 1;
          this.passesLeft = 1;
        }
        if (this.pos >= this.events.length) {
          return null;
        }
        // Else fall through: the outro plays once, at its authored position,
        // then the track ends.
      }
      // Else fall through: the outro plays once, then the track ends.
    } else if (this.pos >= this.events.length) {
      // RPG Maker style: the loop runs to the end of the track, so replay it.
      if (this.loop && this.loop.endTick == null && this.passesLeft > 1 &&
          this.startIdx < this.events.length) {
        this.passesLeft--;
        this.elapsedLoops++;
        this.rebaseReplay();
        this.pos = this.startIdx;
        // The releases queued by rebaseReplay come first: the replay's own
        // events start on the following call, with replayDelta already set.
        if (this.pendingReleases && this.pendingReleases.length) {
          return this.pendingReleases.shift();
        }
      } else {
        return null;
      }
    }

    const event = this.events[this.pos++];
    if (!event) return null;

    // The first event of a replayed pass carries the rebased delta, plus any
    // shift owed to passes a loop-empty track skipped; every other event keeps
    // its own delta, so a post-loop event keeps its authored offset.
    const delta = (this.replayDelta != null ? this.replayDelta : event.delta) +
      (this.pendingExtra || 0);
    this.replayDelta = null;
    this.pendingExtra = 0;
    this.curTick += delta;

    // Sanity cap; jumps are bounded by passesLeft so this is just insurance.
    if (this.curTick > 100000000 || this.elapsedLoops > 1000) return null;

    // Return a copy because track consolidation will mutate the events.
    return { ...event, delta, absTick: this.absTicks ? this.absTicks[this.pos - 1] : null };
  }

  // Rebase the first event of a replayed pass onto the loop boundary (see
  // next()). boundaryTick is where that pass ends; it advances one loop length
  // per pass. The event's own delta would instead be the gap from its pre-loop
  // neighbor, which shifts every repeat by that intro gap.
  rebaseReplay() {
    // The pass that just ended left its crossing notes sounding (seamReleases):
    // release them at the boundary, before the replay re-triggers the same
    // pitch. The first release carries the gap to the boundary, and the
    // replay's own first event then starts one loop length from there -- where
    // it would have started anyway -- so only the cut is new.
    //
    // A note released while the pedal was down is not in seamReleases (its
    // NOTE_OFF already ran) but keeps sounding all the same, so the seam also
    // lifts the pedal -- for the channels that had it down -- and re-arms it for
    // the next pass. That is the pair loopJump() sends on the live wrap, and the
    // two have to agree about what the seam sounds like: without the lift a
    // sustained note runs into the second pass and overlaps its notes.
    const gap = this.boundaryTick - this.curTick;
    const replay = this.absTicks[this.startIdx] - this.loop.startTick;
    const cuts = this.seamReleases ? this.seamReleases.slice() : [];
    const pedal = (channel, param2) => ({
      delta: 0,
      type: EVENT_MIDI,
      subtype: EVENT_MIDI_CONTROLLER,
      channel,
      param1: CC_64_SUSTAIN,
      param2,
      absTick: this.boundaryTick,
    });
    for (const held of this.seamSustain || []) {
      cuts.push(pedal(held.channel, 0));
    }
    for (const held of this.seamSustain || []) {
      cuts.push(pedal(held.channel, held.value));
    }
    if (cuts.length) {
      this.pendingReleases = cuts.map((event, i) => ({ ...event, delta: i === 0 ? gap : 0 }));
      // The releases are emitted at the boundary, so the emitted timeline
      // reaches it: without this the *next* boundary would add this gap again
      // (curTick is what the deltas are measured from).
      this.curTick += gap;
      this.replayDelta = replay;
    } else {
      this.replayDelta = gap + replay;
    }
    this.boundaryTick += this.loopLength;
  }
}

// The MIDI files that opt into the two-pass loop expansion -- the SoundFont
// MIDI sets (the folder master gated on). Loop *detection* is separate
// (findLoopRange): a file that merely carries loop points still plays through
// once. Both the audio player and the piano roll key off this one predicate, so
// the roll expands exactly when the audio does.
export function usesTrackLoops(filepath) {
  if (!filepath) return false;
  // DEV-BEGIN (stripped for promotion; also expand the local tempo_stress
  // fixtures, which sit outside a SoundFont folder. Toggle from the browser
  // console, then reload:
  //   localStorage.setItem('cpDevExpandTempoStress', '1')   // on
  //   localStorage.removeItem('cpDevExpandTempoStress')     // off
  // Inert without a browser (scripts/build-music.js).)
  try {
    if (filepath.includes('tempo_stress') &&
        window.localStorage.getItem('cpDevExpandTempoStress') === '1') {
      return true;
    }
  } catch (e) { /* no window/localStorage (node) */ }
  // DEV-END
  return filepath.includes('SoundFont MIDI');
}

// The event list playback actually renders — and the piano roll must show:
// loop files expand to intro + two passes, everything else merges once.
// Single source of truth for the audio engine and the roll parser so the two
// can never disagree about what the song contains.
MIDIFile.prototype.getPlaybackEvents = function (useTrackLoops = false) {
  const tracks = this.tracks.map((_, i) => this.getTrackEvents(i));
  // Expansion is opt-in, not marker-triggered: findLoopRange only supplies the
  // region to loop over. Files that do not opt in play exactly once.
  if (!useTrackLoops) {
    return { events: this.getEvents(), loopStartMs: null, loopEndMs: null };
  }
  return this.getLoopedEvents(tracks, 2, this.findLoopRange(tracks));
};

// Monkey patch MIDIFile class.
//
// Expands the song-global loop range (see findLoopRange) to intro + two
// passes — the same shape as a two-pass libvgm track — so duration, slider
// band and head fold all work the same way. Post-loop content (outro) plays
// once at the end. Returns {events, loopStartMs, loopEndMs} in first-pass
// milliseconds; both are null when range is null (plain merge, no looping).
MIDIFile.prototype.getLoopedEvents = function (tracks, loopCount = 2, range = null) {
  let event;
  let playTime = 0;
  const combinedEvents = [];
  const format = this.header.getFormat();
  let tickResolution = this.header.getTickResolution();
  let i;
  let j;
  let smallestDelta;
  // Set when the merge passes MAX_MERGED_EVENTS; the list is then abandoned (see
  // the fallback below) rather than returned short.
  let overflowed = false;
  const type = null;
  const subtype = null;
  // First-pass loop region in ms. The start latches off the first loop-start
  // controller (0 when implicit); the end is the latest first-pass playTime --
  // the end of the first iteration, since later passes carry a higher pass
  // number. One global latch, so only the outermost loop is reported.
  let loopStartMs = null;
  let loopEndMs = null;
  // Tempo in force at the loop start, latched on the first pass and restored at
  // each replay so an in-loop tempo change reapplies from the top. An implicit
  // start at tick 0 with no event there never latches below, so seed it.
  let loopStartTickResolution = range != null && range.startTick === 0 ? tickResolution : null;
  // In the multi-track merge, restore that tempo once per pass, at the shared
  // boundary (the first event any track replays in that pass) -- not per track,
  // or a later track's replay erases a tempo change an earlier one already
  // re-applied. Keyed by pass rather than a one-shot flag, so a third and later
  // pass restores it too.
  let passTempoRestoredAt = 0;
  const isRpgMaker = range != null && range.endTick == null;
  // Format-2 tracks have no shared timeline, so a song-global range is
  // meaningless: they play once and must not report a band. Reporting one
  // would make the "end of the first iteration" latch degenerate to the end of
  // the song, highlighting the whole file as the loop region.
  const expandLoop = range != null && format !== 2;
  // DEV-BEGIN (stripped for promotion; catalog tripwire. If a format-2 file ever
  // carries loop markers it plays once with no band, so warn where it can be
  // spotted: on playback, and (see scripts/build-music.js) at catalog build
  // time. Reachable via a share link or local files, never via a marker search,
  // so a warning at parse time alone would not reach us.)
  if (range != null && !expandLoop) {
    console.warn('[midi] format-2 file defines loop markers; the song-global loop is ignored for async patterns, so it plays once with no loop band.');
  }
  // DEV-END
  const channelsByTrack = {};
  const capturePush = (trackIdx, srcElapsedLoops, ev) => {
    if (ev.channel !== undefined) {
      (channelsByTrack[trackIdx] || (channelsByTrack[trackIdx] = new Set())).add(ev.channel);
    }
    if (!expandLoop) return;
    if (loopStartMs == null && isLoopEvent(ev) &&
        (isLoopStartCC(ev.param1) || (isRpgMaker && ev.param1 === CC_111_LOOP_END))) {
      loopStartMs = playTime;
    }
    // End of the first iteration. `srcElapsedLoops === 0` bounds it to the first
    // pass when there is more than one; the loop-end tick bounds it when the
    // caller asked for a single pass (no passes to distinguish).
    if (srcElapsedLoops === 0 &&
        (range.endTick == null || ev.absTick == null || ev.absTick <= range.endTick) &&
        (loopEndMs == null || playTime > loopEndMs)) {
      loopEndMs = playTime;
    }
  };

  // A lone CC111 fixes the loop start but not its end: by the RPG Maker
  // convention the loop ends at the last track-end event in the song, so resolve
  // one song-wide end tick (the longest track) and hand it to every iterator. A
  // shared boundary is what keeps a short part in sync with a longer one.
  let songEndTick = null;
  if (expandLoop && range.endTick == null) {
    songEndTick = 0;
    for (const trackEvents of tracks) {
      let tick = 0;
      for (const event of trackEvents) {
        if (event) tick += event.delta || 0;
      }
      if (tick > songEndTick) songEndTick = tick;
    }
  }
  const loop = expandLoop
    ? { startTick: range.startTick, endTick: range.endTick, maxLoops: loopCount, songEndTick }
    : null;

  // Reading events
  // if the read is sequential
  if (1 !== format || 1 === this.tracks.length) {
    for (i = 0, j = this.tracks.length; i < j; i++) {
      // reset playtime if format is 2
      playTime = 2 === format && playTime ? playTime : 0;
      const eventIterator = new EventIterator(tracks[i], loop);
      let lastLoops = 0;
      // loooping through events
      event = eventIterator.next();
      while (event) {
        if (eventIterator.elapsedLoops !== lastLoops) {
          lastLoops = eventIterator.elapsedLoops;
          if (loopStartTickResolution != null) tickResolution = loopStartTickResolution;
        }
        playTime += event.delta ? event.delta * tickResolution / 1000 : 0;
        if (event.type === MIDIEvents.EVENT_META) {
          // tempo change events
          if (event.subtype === MIDIEvents.EVENT_META_SET_TEMPO) {
            tickResolution = this.header.getTickResolution(event.tempo);
          }
        }
        // Latch the tempo in force at the loop start -- the last tempo event at
        // or before startTick -- so a replay can restore it.
        if (expandLoop && event.absTick != null && event.absTick <= range.startTick) {
          loopStartTickResolution = tickResolution;
        }
        // push the asked events
        if (
          (!type || event.type === type) &&
          (!subtype || (event.subtype && event.subtype === subtype))
        ) {
          event.playTime = playTime;
          capturePush(i, eventIterator.elapsedLoops, event);
          combinedEvents.push(event);
        }
        event = eventIterator.next();
        if (combinedEvents.length > MAX_MERGED_EVENTS) {
          overflowed = true;
          break;
        }
      }
    }
    // the read is concurrent
  } else {
    smallestDelta = -1;

    const trackIterators = [];

    // Creating iterators
    for (i = 0, j = tracks.length; i < j; i++) {
      printTrack(i, tracks[i]);
      trackIterators[i] = new EventIterator(tracks[i], loop);
      trackIterators[i].curEvent = trackIterators[i].next();
    }
    // Filling events
    do {
      smallestDelta = -1;
      // Find the shortest event
      for (i = 0, j = trackIterators.length; i < j; i++) {
        if (trackIterators[i].curEvent) {
          if (
            -1 === smallestDelta ||
            trackIterators[i].curEvent.delta <
            trackIterators[smallestDelta].curEvent.delta
          ) {
            smallestDelta = i;
          } else if (
            // Prioritize tracks that haven't caught up with the loop count
            trackIterators[i].curEvent.delta ===
            trackIterators[smallestDelta].curEvent.delta &&
            trackIterators[i].elapsedLoops <
            trackIterators[smallestDelta].elapsedLoops
          ) {
            smallestDelta = i;
          }
        }
      }
      if (-1 !== smallestDelta) {
        // Subtract delta of previous events
        for (i = 0, j = trackIterators.length; i < j; i++) {
          if (i !== smallestDelta && trackIterators[i].curEvent) {
            trackIterators[i].curEvent.delta -=
              trackIterators[smallestDelta].curEvent.delta;
          }
        }
        // filling values
        event = trackIterators[smallestDelta].curEvent;
        // Restore the loop-start tempo once per pass, at the shared boundary
        // (the first event any track replays in that pass), not per track.
        if (trackIterators[smallestDelta].elapsedLoops > passTempoRestoredAt) {
          passTempoRestoredAt = trackIterators[smallestDelta].elapsedLoops;
          if (loopStartTickResolution != null) tickResolution = loopStartTickResolution;
        }
        playTime += event.delta ? event.delta * tickResolution / 1000 : 0;
        if (event.type === MIDIEvents.EVENT_META) {
          // tempo change events
          if (event.subtype === MIDIEvents.EVENT_META_SET_TEMPO) {
            tickResolution = this.header.getTickResolution(event.tempo);
          }
        }
        // Same loop-start tempo latch as the sequential path.
        if (expandLoop && event.absTick != null && event.absTick <= range.startTick) {
          loopStartTickResolution = tickResolution;
        }
        // push midi events
        if (
          (!type || event.type === type) &&
          (!subtype || (event.subtype && event.subtype === subtype))
        ) {
          event.playTime = playTime;
          event.track = smallestDelta;
          capturePush(smallestDelta, trackIterators[smallestDelta].elapsedLoops, event);
          combinedEvents.push(event);
        }
        // get next event
        trackIterators[smallestDelta].curEvent = trackIterators[smallestDelta].next();
        if (combinedEvents.length > MAX_MERGED_EVENTS) {
          overflowed = true;
          break;
        }
      }
    } while (-1 !== smallestDelta);
  }

  if (overflowed) {
    // A truncated list would end the song early (the appended all-notes-off
    // closes it out), which is worse than losing the loop: fall back to a single
    // pass so every note still plays, with no loop region -- the same shape as a
    // file that defines no markers. Only a file far larger than anything real
    // reaches this.
    console.warn('[midi] loop expansion exceeded ' + MAX_MERGED_EVENTS +
      ' events; playing once with no loop region.');
    return { events: this.getEvents(), loopStartMs: null, loopEndMs: null };
  }

  // The song ends at the last event that can sound, not at trailing cleanup:
  // a converter's note-less tail (controller resets, END_OF_TRACK) must not
  // push the duration out with dead air. Every event keeps its authored
  // position (EventIterator); only the end comes from the sounding content.
  let endMs = 0;
  for (const e of combinedEvents) {
    if ((e.subtype === EVENT_MIDI_NOTE_ON || e.subtype === EVENT_MIDI_NOTE_OFF) &&
        e.playTime > endMs) {
      endMs = e.playTime;
    }
  }
  if (endMs > 0) {
    for (let k = combinedEvents.length - 1; k >= 0; k--) {
      if (combinedEvents[k].playTime > endMs) combinedEvents.splice(k, 1);
    }
  }
  const tailMs = endMs > 0 ? endMs : playTime;

  // Same stuck-note fix as the getEvents patch below: release every channel
  // heard in each track at the song's end, so the song (and its silence tail)
  // always terminates when repeat is off.
  for (const [track, channels] of Object.entries(channelsByTrack)) {
    for (const ch of channels) {
      combinedEvents.push(allNotesOff(Number(track), ch, tailMs));
      combinedEvents.push(sustainOff(Number(track), ch, tailMs));
    }
  }

  if (expandLoop && loopStartMs == null) loopStartMs = 0;
  if (!expandLoop || loopEndMs == null || loopEndMs <= loopStartMs) {
    loopStartMs = null;
    loopEndMs = null;
  }
  return { events: combinedEvents, loopStartMs, loopEndMs };
};

function isLoopStart(event) {
  return (
    isLoopStartCC(event.param1) &&
    event.subtype === EVENT_MIDI_CONTROLLER &&
    event.type === EVENT_MIDI
  );
}

function isLoopEnd(event) {
  return (
    isLoopEndCC(event.param1) &&
    event.subtype === EVENT_MIDI_CONTROLLER &&
    event.type === EVENT_MIDI
  );
}

function isAllNotesOff(event) {
  return (
    event.param1 === CC_123_ALL_NOTES_OFF &&
    event.subtype === EVENT_MIDI_CONTROLLER &&
    event.type === EVENT_MIDI
  );
}

function allNotesOff(track, channel, playTime) {
  return {
    channel: channel,
    track: track,
    playTime: playTime,
    type: EVENT_MIDI,
    subtype: EVENT_MIDI_CONTROLLER,
    param1: CC_123_ALL_NOTES_OFF,
    param2: 0,
    delta: 0,
  };
}

function sustainOff(track, channel, playTime) {
  return {
    channel: channel,
    track: track,
    playTime: playTime,
    type: EVENT_MIDI,
    subtype: EVENT_MIDI_CONTROLLER,
    param1: CC_64_SUSTAIN,
    param2: 0,
    delta: 0,
  };
}

// Fix for MIDI files missing note-off or sustain-release events before the end track event
const originalGetEvents = MIDIFile.prototype.getEvents;
MIDIFile.prototype.getEvents = function (...args) {
  const events = originalGetEvents.apply(this, args);
  const trackChannels = {};
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const track = event.track || 0;
    if (event.channel !== undefined) {
      (trackChannels[track] || (trackChannels[track] = new Set())).add(event.channel);
    } else if (event.type === MIDIEvents.EVENT_META && event.subtype === MIDIEvents.EVENT_META_END_OF_TRACK) {
      if (trackChannels[track]) {
        for (const ch of trackChannels[track]) {
          events.splice(i++, 0, allNotesOff(track, ch, event.playTime));
          events.splice(i++, 0, sustainOff(track, ch, event.playTime));
        }
        trackChannels[track].clear();
      }
    }
  }
  return events;
};

function printTrack(t, events) {
  const ticksPerChar = 1000;
  let charArr = [];
  let tick = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    tick += event.delta;
    const j = Math.floor(tick / ticksPerChar);
    if (isAllNotesOff(event)) {
      charArr[j] = 'X';
      tick += ticksPerChar; // force next char so this doesn't get overwritten
    } else if (isLoopStart(event)) {
      charArr[j] = '>';
    } else if (isLoopEnd(event)) {
      charArr[j] = '<';
    } else if (charArr[j] == null) {
      charArr[j] = '·';
    } else if (charArr[j] === '·') {
      charArr[j] = '-';
    } else if (charArr[j] === '-') {
      charArr[j] = '=';
    }
  }
  t = (''+t).padStart(2, '0');
  const viz = [];
  for (let k = 0; k < charArr.length; k++) {
    viz[k] = charArr[k] || ' ';
  }
  console.debug(`Track ${t} |${viz.join('')}|`);
}

export default MIDIFile;
