import MIDIEvents from './MIDIEvents';
import MIDIFile from './MIDIFile';
const { EVENT_MIDI, EVENT_MIDI_CONTROLLER, EVENT_MIDI_NOTE_ON } = MIDIEvents;

const CC_64_SUSTAIN = 64;
// Loop-point controllers. N64 compressed sequences mark every track with a
// CC102 (start) / CC103 (end) pair (CC104/105 counts, if present, are
// ignored: Repeat One loops forever and repeat-off plays the two expanded
// passes, the same compromise as the two-pass libvgm default); HMI
// (Descent) marks one loop track with CC110 (start) / CC111 (end) and the
// rest with CC108 alignment markers. A lone CC111 with no pair is the RPG
// Maker convention: the loop starts there and runs to the end of the song.
const CC_102_N64_LOOP_START = 102;
const CC_103_N64_LOOP_END = 103;
const CC_110_HMI_LOOP_START = 110;
const CC_111_LOOP_END = 111;
const CC_123_ALL_NOTES_OFF = 123;

function isLoopStartCC(cc) {
  return cc === CC_102_N64_LOOP_START || cc === CC_110_HMI_LOOP_START;
}

function isLoopEndCC(cc) {
  return cc === CC_103_N64_LOOP_END || cc === CC_111_LOOP_END;
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
        } else if (event.param1 === CC_103_N64_LOOP_END) {
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
    startTick = Math.min(...starts);
    const ends = ends103.concat(ends111).filter(t => t > startTick);
    if (!ends.length) return null;
    endTick = Math.min(...ends);
  } else if (ends103.length > 0) {
    // N64 loop end with the start left implicit at 0 (plus a CC104 count).
    startTick = 0;
    endTick = Math.min(...ends103);
  } else if (ends111.length > 0) {
    // Lone CC111: RPG Maker loop start, running to the end of each track.
    startTick = Math.min(...ends111);
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
    // Whether the track has real music (note-ons) past the loop end. Outro
    // cleanup (controllers, END_OF_TRACK, converter track padding) carries
    // no timing information, so it attaches right at the loop end instead of
    // pushing the duration out with dead air; a composed ending with notes
    // keeps its exact timing.
    this.postHasNotes = false;
    this.postStarted = false;
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
      if (loop.endTick != null) {
        this.postHasNotes = this.events.some((e, idx) =>
          this.absTicks[idx] > loop.endTick &&
          e.type === EVENT_MIDI && e.subtype === EVENT_MIDI_NOTE_ON && e.param2 > 0);
      }
    }
  }

  next() {
    // A track that runs past the loop end — or ends exactly on it — replays
    // the loop segment until its passes run out. Anything past the loop end
    // then plays once as the outro.
    if (this.loop && this.loop.endTick != null &&
        (this.pos >= this.events.length || this.absTicks[this.pos] > this.loop.endTick)) {
      if (this.passesLeft > 1) {
        this.passesLeft--;
        this.elapsedLoops++;
        console.debug('Channel looped at tick %d (%d passes left)', this.curTick, this.passesLeft);
        this.pos = this.startIdx;
      } else if (this.pos >= this.events.length) {
        return null;
      } else if (!this.postHasNotes && !this.postStarted) {
        // Noteless outro: attach it at the loop end (see postHasNotes).
        this.postStarted = true;
        const event = this.events[this.pos++];
        if (!event) return null;
        this.curTick += event.delta;
        return { ...event, delta: 0 };
      }
      // Else fall through: the outro plays once, then the track ends.
    } else if (this.pos >= this.events.length) {
      // RPG Maker style: the loop runs to the end of the track, so replay it.
      if (this.loop && this.loop.endTick == null && this.passesLeft > 1 &&
          this.startIdx < this.events.length) {
        this.passesLeft--;
        this.elapsedLoops++;
        this.pos = this.startIdx;
      } else {
        return null;
      }
    }

    const event = this.events[this.pos++];
    if (!event) return null;

    this.curTick += event.delta;

    // Sanity cap; jumps are bounded by passesLeft so this is just insurance.
    if (this.curTick > 100000000 || this.elapsedLoops > 1000) return null;

    // Return a copy because track consolidation will mutate the events.
    return { ...event };
  }
}

// The event list playback actually renders — and the piano roll must show:
// loop files expand to intro + two passes, everything else merges once.
// Single source of truth for the audio engine and the roll parser so the two
// can never disagree about what the song contains.
MIDIFile.prototype.getPlaybackEvents = function (useTrackLoops = false) {
  const tracks = this.tracks.map((_, i) => this.getTrackEvents(i));
  // Loop expansion runs whenever the file itself defines loop points, not
  // just on the SoundFont MIDI path; files without any play exactly once.
  // The SoundFont MIDI path keeps forcing the looped merge (a no-op when the
  // file has no markers).
  const range = this.findLoopRange(tracks);
  if (range || useTrackLoops) {
    return this.getLoopedEvents(tracks, 2, range);
  }
  return { events: this.getEvents(), loopStartMs: null, loopEndMs: null };
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
  const type = null;
  const subtype = null;
  // First-pass loop region in ms. The start latches off the first loop-start
  // controller (CC102/110 paired; CC111 RPG Maker style; 0 when the start is
  // left implicit); the end is the latest first-pass playTime, which is
  // exactly the end of the first loop iteration — later passes and the outro
  // all carry a higher pass number. Single global latch: only the outermost
  // loop is reported.
  let loopStartMs = null;
  let loopEndMs = null;
  const isRpgMaker = range != null && range.endTick == null;
  const channelsByTrack = {};
  const capturePush = (trackIdx, srcElapsedLoops, ev) => {
    if (ev.channel !== undefined) {
      (channelsByTrack[trackIdx] || (channelsByTrack[trackIdx] = new Set())).add(ev.channel);
    }
    if (range == null) return;
    if (loopStartMs == null && isLoopEvent(ev) &&
        (isLoopStartCC(ev.param1) || (isRpgMaker && ev.param1 === CC_111_LOOP_END))) {
      loopStartMs = playTime;
    }
    if (srcElapsedLoops === 0 &&
        (loopEndMs == null || playTime > loopEndMs)) {
      loopEndMs = playTime;
    }
  };

  // Async format-2 tracks have no shared timeline, so a song-global range is
  // meaningless there; those files play once.
  const loop = range != null && format !== 2
    ? { startTick: range.startTick, endTick: range.endTick, maxLoops: loopCount }
    : null;

  // Reading events
  // if the read is sequential
  if (1 !== format || 1 === this.tracks.length) {
    for (i = 0, j = this.tracks.length; i < j; i++) {
      // reset playtime if format is 2
      playTime = 2 === format && playTime ? playTime : 0;
      const eventIterator = new EventIterator(tracks[i], loop);
      // loooping through events
      event = eventIterator.next();
      while (event) {
        playTime += event.delta ? event.delta * tickResolution / 1000 : 0;
        if (event.type === MIDIEvents.EVENT_META) {
          // tempo change events
          if (event.subtype === MIDIEvents.EVENT_META_SET_TEMPO) {
            tickResolution = this.header.getTickResolution(event.tempo);
          }
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
        if (combinedEvents.length > 200000) {
          console.warn('getLoopedEvents: event cap reached, truncating.');
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
        playTime += event.delta ? event.delta * tickResolution / 1000 : 0;
        if (event.type === MIDIEvents.EVENT_META) {
          // tempo change events
          if (event.subtype === MIDIEvents.EVENT_META_SET_TEMPO) {
            tickResolution = this.header.getTickResolution(event.tempo);
          }
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
        if (combinedEvents.length > 200000) {
          console.warn('getLoopedEvents: event cap reached, truncating.');
          break;
        }
      }
    } while (-1 !== smallestDelta);
  }

  // Same stuck-note fix as the getEvents patch below: release every channel
  // heard in each track at the end of the list, so the song (and its silence
  // tail) always terminates when repeat is off.
  for (const [track, channels] of Object.entries(channelsByTrack)) {
    for (const ch of channels) {
      combinedEvents.push(allNotesOff(Number(track), ch, playTime));
      combinedEvents.push(sustainOff(Number(track), ch, playTime));
    }
  }

  if (range != null && loopStartMs == null) loopStartMs = 0;
  if (range == null || loopEndMs == null || loopEndMs <= loopStartMs) {
    loopStartMs = null;
    loopEndMs = null;
  }
  console.debug(combinedEvents);
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
