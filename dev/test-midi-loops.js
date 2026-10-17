#!/usr/bin/env node
// DEV-ONLY MIDI loop check: region extraction + Repeat-One wrap, no wasm.
// Run: node dev/test-midi-loops.js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
// The outer MIDIPlayer (the class the sequencer holds) pulls in Player.js, which
// shims window.requestIdleCallback at module level.
global.window = global.window || {};
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (filename.startsWith(ROOT) && !filename.includes('node_modules') && /\.jsx?$/.test(filename)) {
    const { code } = babel.transformSync(content, {
      filename,
      configFile: false,
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    });
    content = code;
  }
  return originalCompile.call(this, content, filename);
};

const MIDIFile = require('../src/players/midi/midi-helpers').default;
const { usesTrackLoops } = require('../src/players/midi/midi-helpers');
const { END_LAYERS, songEndMs } = require('../src/players/midi/endRule');
const MIDIFilePlayer = require('../src/players/MIDIFilePlayer').default;
const MIDIPlayerClass = require('../src/players/MIDIPlayer').default;
const MIDIEvents = require('../src/players/midi/MIDIEvents').default;
const { EVENT_MIDI, EVENT_MIDI_NOTE_ON } = MIDIEvents;
const { parseMidiData } = require('../src/piano-roll/midi-parser');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n')}`);
    process.exitCode = 1;
  }
}

function loadMidi(rel) {
  const buf = fs.readFileSync(path.join(ROOT, 'catalog', rel));
  const u8 = new Uint8Array(buf);
  return new MIDIFile(u8.buffer);
}
function tracksOf(mf) {
  return mf.tracks.map((_, i) => mf.getTrackEvents(i));
}

// Raw event count for a whole file, one event at a time: a stress file's events
// will not fit in an array here.
function countTrackEvents(mf) {
  let count = 0;
  for (let t = 0; t < mf.tracks.length; t++) {
    const parser = MIDIEvents.createParser(mf.tracks[t].getTrackContent(), 0, false);
    while (parser.next()) count++;
  }
  return count;
}
function stubSynth(silent = true) {
  return {
    log: [],
    noteOn(c, p, v) { this.log.push(['on', c, p]); },
    noteOff(c, p) { this.log.push(['off', c, p]); },
    pitchBend(c, v) { this.log.push(['bend', c, v]); }, controlChange(c, cc, v) { this.log.push(['cc', c, cc, v]); }, programChange(c, p) { this.log.push(['prog', c, p]); }, panic() {}, panicChannel() {},
    render() {},
    reset() {},
    getValue() { return silent ? 0 : 1; },
  };
}
function makePlayer(synth) {
  return new MIDIFilePlayer({
    programChangeCb: () => {},
    output: { send: () => {} },
    skipSilence: false,
    sampleRate: 44100,
    synth,
  });
}

// The catalog's Mario Kart MIDI. This used to be
// `midi/Nintendo 64 (SoundFont MIDI)_Mario Kart 64_01 - Main Theme.mid`, a flattened
// copy whose `/` had been replaced with `_`; that file is gone from disk and the
// directory now holds only `03 - 3 Raceways, Wario Stadium.mid` and the sf2. The
// replacement has the same *shape* of markers, so the checks below are the same tests
// on a file that is actually there: no CC102 at all (9 x CC103, 8 x CC104), which is
// the implicit-start branch, and the CC103 sits at the very end of the song.
const MARIO = 'Nintendo 64 (SoundFont MIDI)/Mario Kart 64/03 - 3 Raceways, Wario Stadium.mid';
const DESCENT = 'midi/Game MIDI_Descent (PC∕DOS, 1995)_Game01.mid';
const DOOM = 'midi/DOOM/Game MIDI_Doom (PC∕DOS, 1993)_02 - At Doom\'s Gate (E1M1).mid';
// Deliberately dense MIDI (black-MIDI style). Nothing musical depends on it: it
// is here only to calibrate what the merge ceiling means in file size, and the
// check that uses it skips when this catalog has none.
const STRESS = 'midi/black/2 million notes in a second 60 Million BPM.mid';

// Catalog is user-supplied and gitignored, so a missing file skips its check rather
// than failing it -- but per fixture, which this did not used to be. A single
// `process.exit(0)` when *any* of the three paths was missing meant that when the
// Mario Kart path went stale, the Descent and DOOM checks stopped running too, with
// two perfectly good files sitting on disk and nothing in the output but one
// "skip:" line to say so. Naming the fixture at each call site also makes it obvious
// which check depends on which file.
function catalogCheck(rel, name, fn) {
  if (!fs.existsSync(path.join(ROOT, 'catalog', rel))) {
    console.log(`skip  ${name}\n      (catalog/${rel} not present)`);
    return;
  }
  check(name, fn);
}

catalogCheck(MARIO, 'Mario Kart: loop range is implicit-start [0, 8071] ticks', () => {
  const mf = loadMidi(MARIO);
  // Format 1 shares a timeline, so the song-global range below is honoured; format 2
  // would make every number in this file meaningless (see midi-helpers getLoopedEvents).
  assert.strictEqual(mf.header.getFormat(), 1, 'expected format 1');
  const range = mf.findLoopRange(tracksOf(mf));
  assert.deepStrictEqual(range, { startTick: 0, endTick: 8071 });
});

catalogCheck(MARIO, 'Mario Kart: region is the whole song, [0, ~72062] ms, two passes', () => {
  const mf = loadMidi(MARIO);
  const tracks = tracksOf(mf);
  const range = mf.findLoopRange(tracks);
  const { events, loopStartMs, loopEndMs } = mf.getLoopedEvents(tracks, 2, range);
  assert.strictEqual(loopStartMs, 0);
  assert.ok(Math.abs(loopEndMs - 72062.43) < 1, `endMs=${loopEndMs}`);
  // This file's CC103 is the last event of the song, so the region *is* the whole
  // track and two passes are exactly twice the song with no tail. Descent below is
  // the other shape: its loop ends 3596 ms before the song does. Pinning both is the
  // point -- "loop end" and "song end" are not the same thing, and neither is
  // assumed anywhere.
  const single = mf.getEvents();
  assert.ok(Math.abs(loopEndMs - single[single.length - 1].playTime) < 1,
    `loopEnd=${loopEndMs} songEnd=${single[single.length - 1].playTime}`);
  const dur = events[events.length - 1].playTime;
  assert.ok(Math.abs(dur - 2 * loopEndMs) < 1500, `dur=${dur} (2 passes)`);
});

catalogCheck(DESCENT, 'Descent Game01: HMI range [12, 23939] ticks -> [~100, ~200194] ms', () => {
  const mf = loadMidi(DESCENT);
  const tracks = tracksOf(mf);
  const range = mf.findLoopRange(tracks);
  assert.deepStrictEqual(range, { startTick: 12, endTick: 23939 });
  const { loopStartMs, loopEndMs } = mf.getLoopedEvents(tracks, 2, range);
  assert.ok(Math.abs(loopStartMs - 100) < 2, `startMs=${loopStartMs}`);
  assert.ok(Math.abs(loopEndMs - 200194) < 2, `endMs=${loopEndMs}`);
});

catalogCheck(DOOM, 'DOOM (no markers): no range, plain single-pass merge', () => {
  const mf = loadMidi(DOOM);
  const tracks = tracksOf(mf);
  assert.strictEqual(mf.findLoopRange(tracks), null);
  const { events, loopStartMs, loopEndMs } = mf.getLoopedEvents(tracks, 2, null);
  assert.strictEqual(loopStartMs, null);
  assert.strictEqual(loopEndMs, null);
  const single = mf.getEvents();
  assert.ok(Math.abs(events[events.length - 1].playTime - single[single.length - 1].playTime) < 1);
});

catalogCheck(MARIO, 'wrap: looping Mario jumps to second-pass start at list end', () => {
  const mf = loadMidi(MARIO);
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(mf, true);
  assert.ok(p.loop, 'expected a loop region');
  assert.ok(Math.abs(p.loop.startMs - 0) < 0.001);
  assert.ok(Math.abs(p.loop.jumpMs - p.loop.startMs - p.loop.lengthMs) < 0.001);
  p.play(() => {});
  p.setLooping(true);
  // Park just before the end, then render past it: one block crosses the band
  // end and wraps inside the buffer, so the remainder of this same call already
  // plays from the band start (position is past jumpIndex, not parked on it).
  p.setPosition(p.getDuration() - 30);
  const before = synth.log.length;
  p.processPlaySynth(0, 2048);
  assert.ok(p.elapsedTime >= p.loop.jumpMs && Math.abs(p.elapsedTime - p.loop.jumpMs) < 200,
    `elapsed=${p.elapsedTime} jumpMs=${p.loop.jumpMs}`);
  assert.ok(p.position >= p.loop.jumpIndex,
    `wrapped into the band in the same buffer: position=${p.position} jumpIndex=${p.loop.jumpIndex}`);
  assert.ok(!p.paused, 'still playing after wrap');
  p.processPlaySynth(0, 2048);
  assert.ok(p.elapsedTime > p.loop.jumpMs && !p.paused, 'keeps playing into the band');
  void before;
});

catalogCheck(MARIO, 'no wrap: repeat off ends the song at list end', () => {
  const mf = loadMidi(MARIO);
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(mf, true);
  p.play(() => {});
  p.setLooping(false);
  p.setPosition(p.getDuration() - 30);
  for (let i = 0; i < 40; i++) p.processPlaySynth(0, 2048);
  assert.ok(p.paused, 'expected paused at song end');
  assert.strictEqual(p.position, 0);
});

catalogCheck(DESCENT, 'Descent loads a loop and wraps too', () => {
  const mf = loadMidi(DESCENT);
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(mf, true); // the opted-in HMI loop
  assert.ok(p.loop, 'expected a loop region');
  assert.ok(Math.abs(p.loop.startMs - 100) < 2, `startMs=${p.loop.startMs}`);
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.getDuration() - 30);
  p.processPlaySynth(0, 2048);
  assert.ok(p.position >= p.loop.jumpIndex, 'wrapped into the band in the same buffer');
  assert.ok(!p.paused);
});

catalogCheck(DESCENT, 'a loop wrap releases the sustain pedal', () => {
  // A note whose NOTE_OFF runs under the pedal is no longer tracked as ringing,
  // so the wrap must release the pedal (CC 64 = 0) or it keeps sounding into
  // later passes when the release falls outside the repeated region.
  const mf = loadMidi(DESCENT);
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(mf, true);
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.getDuration() - 30);
  synth.log.length = 0;
  p.processPlaySynth(0, 2048);
  assert.ok(p.position >= p.loop.jumpIndex, 'wrapped into the band');
  assert.ok(synth.log.some(([kind, , cc, v]) => kind === 'cc' && cc === 64 && v === 0),
    'expected a sustain-off at the wrap: ' + JSON.stringify(synth.log.slice(0, 10)));
});

catalogCheck(DESCENT, 'setPosition still restores program state (seek regression)', () => {
  const mf = loadMidi(DESCENT);
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  p.play(() => {});
  p.setPosition(60000);
  assert.ok(p.elapsedTime === 60000);
  assert.ok(p.events[p.position].playTime >= 60000);
  assert.ok(p.channelProgramNums.some(v => v !== 0) || p.events.length > 0);
});

// --- Synthetic fixtures -----------------------------------------------------
// The catalog files above cover the real shapes, but the edge cases (an N64
// CC102/103 pair in a format-2 file, a lone CC111 near the end, post-loop
// padding with no notes) are exactly the ones we would not want to depend on a
// user-supplied file for, so they are built here as minimal SMFs. tpq = 120, so
// one beat is 120 ticks and 1000ms.
const TPQ = 120;

function varlen(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

// events: [{ delta, bytes }], or an array of such lists for a multi-track file.
// Returns the whole file as bytes. Header layout is MThd + 6-byte payload:
// format and track count are 2 bytes each, division 2 bytes.
function buildMidi(events, { format = 1, division = TPQ } = {}) {
  const trackLists = Array.isArray(events[0]) ? events : [events];
  const chunks = trackLists.map((list) => {
    const track = [];
    for (const ev of list) track.push(...varlen(ev.delta), ...ev.bytes);
    track.push(...varlen(0), 0xff, 0x2f, 0x00); // end of track
    return [0x4d, 0x54, 0x72, 0x6b,
      (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
      (track.length >> 8) & 0xff, track.length & 0xff, ...track];
  });
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    (format >> 8) & 0xff, format & 0xff,
    (chunks.length >> 8) & 0xff, chunks.length & 0xff,
    (division >> 8) & 0xff, division & 0xff];
  return new Uint8Array([...header, ...chunks.flat()]);
}

// The merge ceiling is a constant in the source; read it here so that raising it
// cannot leave the overflow check quietly under it.
const MAX_MERGED_EVENTS = Number(
  fs.readFileSync(path.join(ROOT, 'src/players/midi/midi-helpers.js'), 'utf8')
    .match(/const MAX_MERGED_EVENTS = (\d+)/)[1]);

// One track holding `count` controller events inside a CC110..CC111 region,
// written byte by byte. buildMidi above is fine for the small fixtures but takes
// seconds at the size the merge ceiling needs. extraTracks adds marker-less
// tracks, which is what sends the merge down its concurrent path.
function buildBulkMidi(count, extraTracks = 0) {
  const mainLen = 7 + 4 + count * 4 + 4 + 4; // tempo, loop start, count CC7, loop end, end
  const total = 14 + (8 + mainLen) + extraTracks * (8 + 11);
  const out = new Uint8Array(total);
  let p = 0;
  const put = (...bytes) => { for (const b of bytes) out[p++] = b; };
  const chunk = (len) => put(0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  put(0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1 + extraTracks, 0, TPQ);
  chunk(mainLen);
  put(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // tempo, 500000us/beat
  put(0x00, 0xb0, 110, 0);                        // loop start
  for (let i = 0; i < count; i++) put(0x01, 0xb0, 7, i & 127);
  put(0x01, 0xb0, 111, 0);                        // loop end
  put(0x00, 0xff, 0x2f, 0x00);                    // end of track
  for (let t = 0; t < extraTracks; t++) {
    chunk(11);
    put(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
    put(0x00, 0xff, 0x2f, 0x00);
  }
  return out;
}

// Set the tempo so the ms assertions are exact (default 500000 us/beat = 120bpm).
const tempo = (usPerQuarter = 500000) => ({ delta: 0, bytes: [0xff, 0x51, 0x03,
  (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] });
const cc = (controller, value = 0) => ({ delta: 0, bytes: [0xb0, controller, value] });
const ccAt = (delta, controller, value = 0) => ({ delta, bytes: [0xb0, controller, value] });
const noteOnAt = (delta, channel = 0, pitch = 60, velocity = 100) =>
  ({ delta, bytes: [0x90 | channel, pitch, velocity] });
const noteOffAt = (delta, channel = 0, pitch = 60) => ({ delta, bytes: [0x80 | channel, pitch, 0] });
const programChangeAt = (delta, channel = 0, program = 0) => ({ delta, bytes: [0xc0 | channel, program] });
const bendAt = (delta, channel = 0, value = 0x2000) =>
  ({ delta, bytes: [0xe0 | channel, value & 0x7f, (value >> 7) & 0x7f] });   // 0x2000 = centre

function parseBytes(bytes) {
  return new MIDIFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function rollFor(rel) {
  const buf = fs.readFileSync(path.join(ROOT, 'catalog', rel));
  // Same opt-in the player and the Visualizer use.
  return parseMidiData(new Uint8Array(buf), usesTrackLoops(rel));
}

catalogCheck(MARIO, 'piano roll covers the same two passes the audio plays (Mario)', () => {
  const mf = loadMidi(MARIO);
  const audio = mf.getPlaybackEvents(true);
  const audioDur = audio.events.slice(-1)[0].playTime;
  const roll = rollFor(MARIO);
  assert.ok(roll.notes.length > 100, `notes=${roll.notes.length}`);
  assert.ok(Math.abs(roll.durationMs - audioDur) < 1, `roll=${roll.durationMs} audio=${audioDur}`);
  // Second pass (the slider band) is populated, so the roll survives the
  // loop point and Repeat-One wraps instead of going empty. The band start comes
  // from the file's own markers rather than a literal: this used to be the old
  // fixture's 58348, which went stale with the file and left a check that passed
  // against the wrong number for as long as the piano roll had notes past 58s.
  const bandStart = audio.loopEndMs;
  assert.ok(bandStart > 0, `loopEndMs=${bandStart}`);
  assert.ok(roll.notes.some(n => n.startMs >= bandStart), 'no notes in second pass');
});

catalogCheck(DESCENT, 'Descent: the region is detected, the roll and the audio both play it once', () => {
  // Descent carries HMI loop markers but is not a SoundFont MIDI set, so it opts
  // out of the expansion: the region is still detected (band + Repeat One), but
  // the list is one pass, so the roll and the audio both play it through once.
  const mf = loadMidi(DESCENT);
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(false);
  assert.ok(loopEndMs > loopStartMs, 'the HMI markers are detected without the opt-in');
  const audioDur = events[events.length - 1].playTime;
  const roll = rollFor(DESCENT);
  assert.ok(Math.abs(roll.durationMs - audioDur) < 1, `roll=${roll.durationMs} audio=${audioDur}`);
  const expanded = mf.getPlaybackEvents(true);
  assert.ok(expanded.events[expanded.events.length - 1].playTime - audioDur >
    (loopEndMs - loopStartMs) * 0.9, 'the opt-in adds a pass the default does not');
});

check('expansion is opt-in: the region is detected, the list stays one pass', () => {
  // The gate is the SoundFont MIDI sets (usesTrackLoops). Detection is not
  // gated -- a marker-bearing file reports its region and wraps it in
  // MIDIPlayer -- but the *expansion* is, so the piano roll draws across the
  // seam only where the opt-in applies.
  assert.strictEqual(usesTrackLoops('Nintendo 64 (SoundFont MIDI)/Pilotwings 64/13 - Gyrocopter.mid'), true);
  assert.strictEqual(usesTrackLoops('midi/Game MIDI_Descent (PC∕DOS, 1995)_Game01.mid'), false);
  assert.strictEqual(usesTrackLoops('local/dropped.mid'), false);
  assert.strictEqual(usesTrackLoops(null), false);
  const mf = loopWithIntroGapAndEnding(); // CC110/CC111 markers
  assert.ok(mf.findLoopRange(mf.tracks.map((_, i) => mf.getTrackEvents(i))) != null);
  const off = mf.getPlaybackEvents(false);
  const on = mf.getPlaybackEvents(true);
  assert.ok(off.loopEndMs > off.loopStartMs, 'the region is detected without the opt-in');
  assert.deepStrictEqual({ s: off.loopStartMs, e: off.loopEndMs }, { s: on.loopStartMs, e: on.loopEndMs },
    'the region does not depend on the opt-in');
  const offDur = off.events[off.events.length - 1].playTime;
  const onDur = on.events[on.events.length - 1].playTime;
  assert.ok(onDur - offDur > (off.loopEndMs - off.loopStartMs) * 0.9,
    `the opt-in adds about one loop length: off=${Math.round(offDur)} on=${Math.round(onDur)}`);
  // The wrap: expanded jumps to the second pass, default goes back to the start.
  const p1 = makePlayer(stubSynth(true));
  p1.load(mf, false);
  assert.ok(p1.loop, 'a loop region is installed without the opt-in');
  assert.strictEqual(p1.loop.jumpMs, off.loopStartMs, 'default wraps at the loop start');
  assert.strictEqual(p1.loop.endMs, off.loopEndMs);
  const p2 = makePlayer(stubSynth(true));
  p2.load(mf, true);
  assert.strictEqual(p2.loop.jumpMs, on.loopEndMs, 'expanded wraps at the second pass');
  // MIDIPlayer.getLoopBandMs (the class the sequencer holds; this harness builds
  // the nested file player) projects that wrap span onto the slider band.
  const bandFor = (loop) => MIDIPlayerClass.prototype.getLoopBandMs
    .call({ midiFilePlayer: { getLoopRegion: () => loop } });
  assert.deepStrictEqual(bandFor(p1.loop), { startMs: off.loopStartMs, endMs: off.loopEndMs });
  assert.deepStrictEqual(bandFor(p2.loop), { startMs: on.loopEndMs, endMs: p2.loop.endMs });
  assert.strictEqual(bandFor(null), null, 'no region, no band');
  assert.strictEqual(bandFor({ jumpMs: 100, endMs: 100 }), null, 'a zero-length span is no band');
});

catalogCheck(DOOM, 'piano roll unchanged for files without loops (DOOM)', () => {
  const mf = loadMidi(DOOM);
  const audioDur = mf.getPlaybackEvents(false).events.slice(-1)[0].playTime;
  const roll = rollFor(DOOM);
  assert.ok(roll.notes.length > 0);
  assert.ok(Math.abs(roll.durationMs - audioDur) < 1, `roll=${roll.durationMs} audio=${audioDur}`);
});

const GYRO = 'Nintendo 64 (SoundFont MIDI)/Pilotwings 64/13 - Gyrocopter.mid';

check('Gyrocopter: padded END_OF_TRACK does not inflate duration', () => {
  const mf = loadMidi(GYRO);
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  const dur = events[events.length - 1].playTime;
  const B = loopEndMs - loopStartMs;
  assert.ok(Math.abs(loopEndMs - 106667) < 1, `endMs=${loopEndMs}`);
  // Dead air clamped: duration is two passes, band is the second half.
  assert.ok(dur - (loopStartMs + 2 * B) < 1000, `dur=${dur} bandEnd=${loopStartMs + 2 * B}`);
  assert.ok(dur / B < 2.01, `dur/B=${dur / B}`);
});

// --- Synthetic shapes -------------------------------------------------------

// A loop whose start marker sits 480 ticks (2000 ms) into the song, so the
// marker's own delta is that intro gap, plus a composed ending after the loop.
// tpq=120 => 4.1667 ms/tick.
function loopWithIntroGapAndEnding() {
  return parseBytes(buildMidi([
    tempo(),
    noteOnAt(0), noteOffAt(TPQ),        // intro note, ticks 0..120
    ccAt(TPQ * 3, 110),                 // loop start at tick 480
    noteOnAt(0), noteOffAt(TPQ),        // ticks 480..600
    noteOnAt(TPQ * 6), noteOffAt(TPQ),  // ticks 1320..1440
    cc(111),                            // loop end at tick 1440
    noteOnAt(TPQ * 3), noteOffAt(TPQ),  // composed ending, ticks 1800..1920
  ]));
}

check('replayed pass keeps the beat (loop-start delta is rebased)', () => {
  const mf = loopWithIntroGapAndEnding();
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  assert.ok(Math.abs(loopStartMs - 2000) < 1, `startMs=${loopStartMs}`);
  assert.ok(Math.abs(loopEndMs - 6000) < 1, `endMs=${loopEndMs}`);
  // The second pass places the loop-start marker at the boundary (6000 ms), not
  // its own 480-tick (2000 ms) intro gap later.
  const starts = events.filter(e => e.subtype === 11 && e.param1 === 110)
    .map(e => Math.round(e.playTime));
  assert.deepStrictEqual(starts, [2000, 6000], `loop-start playTimes=${starts}`);
});

check('Repeat One wraps at the band end, leaving the composed ending', () => {
  const mf = loopWithIntroGapAndEnding();
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  assert.ok(p.loop, 'expected a loop region');
  assert.ok(p.loop.endIndex < p.events.length, 'the ending is past the band end');
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.loop.endMs - 10);
  p.processPlaySynth(0, 2048);
  assert.ok(p.position >= p.loop.jumpIndex, 'wrapped at the band end, not the list end');
  assert.ok(!p.paused, 'still playing after the wrap');
});

check('Repeat One wraps a non-expanded list back to the loop start', () => {
  // No opt-in: the list is the file's own timeline, and the wrap goes from the
  // loop end back to the loop start (the band is the region itself).
  const mf = loopWithIntroGapAndEnding();
  const p = makePlayer(stubSynth(true));
  p.load(mf, false);
  assert.ok(p.loop, 'expected a loop region without the opt-in');
  assert.strictEqual(p.loop.jumpMs, p.loop.startMs, 'the wrap target is the loop start');
  assert.ok(p.loop.endIndex < p.events.length, 'the composed ending is past the loop end');
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.loop.endMs - 10);
  p.processPlaySynth(0, 2048);
  assert.ok(p.position >= p.loop.jumpIndex, 'wrapped to the loop start, not the list end');
  assert.ok(!p.paused, 'still playing after the wrap');
  assert.ok(Math.abs(p.elapsedTime - p.loop.startMs) < p.loop.lengthMs,
    `the clock lands back in the loop (elapsed=${Math.round(p.elapsedTime)} start=${Math.round(p.loop.startMs)})`);
});

check('Repeat One enabled in the outro does not rewind the transport', () => {
  // The contract: enabled after the region, finish the outro and end -- never
  // jump the transport backward into the loop. The wrap is gated on
  // `loopRegionLeft`, set when the clock passes the band with Repeat One off.
  const mf = loopWithIntroGapAndEnding(); // loop [480,1440], composed ending after
  const p = makePlayer(stubSynth(true));
  p.load(mf, false);
  assert.ok(p.loop, 'expected a loop region');
  p.play(() => {});
  p.setLooping(false);
  p.setPosition(p.getDuration() - 200); // in the outro
  p.processPlaySynth(0, 2048);
  assert.ok(p.elapsedTime > p.loop.endMs,
    `parked past the band end: ${Math.round(p.elapsedTime)} > ${Math.round(p.loop.endMs)}`);
  const before = p.elapsedTime;
  p.setLooping(true);
  p.processPlaySynth(0, 2048);
  assert.ok(p.elapsedTime >= before,
    `enabling must not rewind: ${Math.round(before)} -> ${Math.round(p.elapsedTime)}`);
  assert.ok(Math.abs(p.elapsedTime - before) < 200,
    `and must not jump forward either: +${Math.round(p.elapsedTime - before)} ms`);
  assert.strictEqual(p.loopRegionLeft, true, 'the region-left flag is set by playing past the band');
  // The outro keeps playing to the end rather than hanging on the band end.
  let advanced = false;
  for (let i = 0; i < 60 && !p.paused; i++) {
    const t = p.elapsedTime;
    p.processPlaySynth(0, 2048);
    if (p.elapsedTime > t) advanced = true;
  }
  assert.ok(advanced, 'the outro keeps playing after the toggle');
  // A seek is a transport move, so the flag describes where it landed: into the
  // ending, the region is still left, and the position the listener asked for
  // stands (see the check below).
  p.setPosition(p.getDuration() - 200);
  assert.strictEqual(p.loopRegionLeft, true, 'a seek into the ending leaves the region left');
});

check('a seek into the ending does not rewind, in either repeat order', () => {
  // `setPosition()` used to clear the flag outright, so the next callback wrapped
  // and pulled the transport back into the band -- overriding the position the
  // listener asked for, by the whole ending on an ordinary file. It now says
  // where the seek landed, the same contract as enabling Repeat One in the outro.
  const mf = loopWithIntroGapAndEnding();
  const park = (p, repeatFirst) => {
    p.load(mf, false);
    p.play(() => {});
    p.setLooping(repeatFirst);
    p.setPosition(p.getDuration() - 200);   // into the ending
    if (!repeatFirst) p.setLooping(true);   // ...then enable, as a listener would
    return p.elapsedTime;
  };
  for (const repeatFirst of [true, false]) {
    const p = makePlayer(stubSynth(true));
    const at = park(p, repeatFirst);
    const how = repeatFirst ? 'repeat already on' : 'seeking first, then enabling';
    assert.strictEqual(p.loopRegionLeft, true, `${how}: the ending is still the ending`);
    p.processPlaySynth(0, 2048);
    assert.ok(Math.abs(p.elapsedTime - at) < 200,
      `${how}: the first block must not move the transport (${Math.round(at)} -> ${Math.round(p.elapsedTime)})`);
  }
  // Seeking back inside the band still re-arms the wrap: the pass plays on and
  // wraps at the band end, which is what a seek is supposed to do there.
  const p = makePlayer(stubSynth(true));
  park(p, true);
  p.setPosition((p.loop.jumpMs + p.loop.endMs) / 2);
  assert.strictEqual(p.loopRegionLeft, false, 'a seek inside the band re-arms the wrap');
  let wrapped = false;
  for (let i = 0; i < 300 && !wrapped; i++) {
    const t = p.elapsedTime;
    p.processPlaySynth(0, 2048);
    if (p.elapsedTime < t - 100) wrapped = true;   // the clock went backward: the wrap
  }
  assert.ok(wrapped, 'and it still wraps at the band end');
});

check('a Web MIDI seek into the ending does not rewind either', () => {
  // Same flag, both paths: the Web MIDI wrap guard reads `loopRegionLeft` too, so
  // it had the same hole. A Web MIDI seek pauses until its resume timer, so the
  // callback is driven directly here.
  const mf = loopWithIntroGapAndEnding();
  const w = new MIDIFilePlayer({
    programChangeCb: () => {}, useWebMIDI: true,
    output: { send: () => {} }, skipSilence: false, sampleRate: 44100, synth: stubSynth(true),
  });
  w.load(mf, false);
  w.play(() => {});
  w.setLooping(true);
  w.setPosition(w.getDuration() - 200);
  assert.ok(w.elapsedTime > w.loop.endMs, 'parked past the band end');
  assert.strictEqual(w.loopRegionLeft, true, 'the seek left the ending as the ending');
  const wAt = w.elapsedTime;
  w.paused = false;
  w.lastProcessPlayTimestamp = performance.now();
  w.lastSendTimestamp = performance.now();
  w.processPlay();
  assert.ok(Math.abs(w.elapsedTime - wAt) < 5,
    `the first callback must not rewind (${Math.round(wAt)} -> ${Math.round(w.elapsedTime)})`);
});

check('a wrap replays bank select before the program that uses it', () => {
  // Bank select applies to the *next* program change, and the collected list is in
  // first-seen order -- so a channel that picks a program before it ever picks a
  // bank replayed the program first, onto the bank the finished pass left. The
  // fixture: program at 0, bank 1 at 1 TPQ, loop start at 3, bank 2 *inside* the
  // loop, loop end at 6.
  const bytes = buildMidi([[
    tempo(), programChangeAt(0, 0, 2), ccAt(TPQ, 0, 1), ccAt(0, 32, 0), noteOnAt(0, 0, 60),
    ccAt(TPQ * 3, 110), noteOnAt(0, 0, 64), ccAt(TPQ * 2, 0, 2), noteOffAt(0, 0, 64), ccAt(TPQ * 4, 111),
  ]]);
  const name = (e) => e.subtype === MIDIEvents.EVENT_MIDI_PROGRAM_CHANGE ? `P${e.channel}:${e.param1}`
    : (e.param1 === 0 || e.param1 === 32) ? `B${e.channel}:${e.param1}=${e.param2}` : null;
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(parseBytes(bytes), false);
  assert.ok(p.loop, 'expected a loop region');
  const collected = p.collectStateEvents(0, p.loop.jumpMs).eventList.map(name).filter(Boolean);
  assert.deepStrictEqual(collected, ['B0:0=1', 'B0:32=0', 'P0:2'],
    'the collector presents the bank before the program');
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.loop.endMs - 20);
  synth.log.length = 0;
  p.processPlaySynth(0, 2048);
  // And the wrap actually plays them in that order: the program lands on bank 1.
  const progAt = synth.log.findIndex(([k]) => k === 'prog');
  const bankAt = synth.log.findIndex(([k, , cc]) => k === 'cc' && (cc === 0 || cc === 32));
  assert.ok(progAt !== -1, `expected a program at the wrap: ${JSON.stringify(synth.log.slice(0, 8))}`);
  assert.ok(bankAt !== -1 && bankAt < progAt,
    `the bank must be sent before the program (bank at ${bankAt}, program at ${progAt})`);
});

check('the slider follows the audio out of the band once the region is left', () => {
  // getDisplayPositionMs folds past the band only for a live wrap. With
  // loopRegionLeft set the audio is playing the outro, so the head must run
  // live there too instead of folding into a band the transport left.
  const band = { startMs: 0, endMs: 6400 };
  const make = (flag) => ({
    metadata: { intro_length: 0, loop_length: 6400 },
    looping: true,
    midiFilePlayer: { loopRegionLeft: flag },
    getPositionMs: () => 9000,
    getLoopBandMs: () => band,
  });
  const fold = (flag) => MIDIPlayerClass.prototype.getDisplayPositionMs.call(make(flag));
  assert.strictEqual(fold(false), 2600, 'a live wrap folds 9000 into the band');
  assert.strictEqual(fold(true), 9000, 'left the region: the head stays with the audio');
});

check('N64 shape: a CC102/103 pair gives a region and a band', () => {
  // Mario Kart marks the loop with CC102 at 0 and CC103 at the end of the body.
  // The real file is format 1 (measured), so that is the shape to test here;
  // format 2 gets its own check below.
  const bytes = buildMidi([
    [tempo(), ccAt(0, 102)],
    [tempo(), noteOnAt(0), noteOffAt(TPQ), noteOnAt(0), noteOffAt(TPQ), cc(103), noteOnAt(0), noteOffAt(TPQ)],
  ], { format: 1 });
  const mf = parseBytes(bytes);
  const range = mf.findLoopRange(mf.tracks.map((_, i) => mf.getTrackEvents(i)));
  assert.ok(range, 'a region was found');
  assert.strictEqual(range.startTick, 0);
  assert.strictEqual(range.endTick, 2 * TPQ, 'the CC103 tick');
  // The player's band must be the same region the file reports, in the same
  // ms the piano roll and the audio use.
  const { loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  assert.ok(p.loop, 'the player picked the region up');
  assert.strictEqual(p.loop.startMs, loopStartMs);
  assert.strictEqual(p.loop.lengthMs, loopEndMs - loopStartMs);
  assert.ok(p.loop.lengthMs > 0, 'the region has a length');
  const roll = parseMidiData(bytes);
  assert.ok(roll.durationMs > 0, 'the piano roll reads the same file');
});

check('a paired loop marker shorter than a beat is not a region', () => {
  // RPG Maker writes a "don't loop" flag at the very end of a song: a
  // start/end pair a few ticks apart must be treated as a marker, not a region.
  const bytes = buildMidi([
    tempo(),
    noteOnAt(0), noteOffAt(TPQ * 4),
    cc(110), noteOnAt(0), noteOffAt(4), cc(111),
  ]);
  const mf = parseBytes(bytes);
  const range = mf.findLoopRange(mf.tracks.map((_, i) => mf.getTrackEvents(i)));
  assert.strictEqual(range, null, `too short to be a region (got ${JSON.stringify(range)})`);
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  assert.ok(!p.loop, 'no band, and repeat one plays straight through');
});

check('lone CC111 (RPG Maker): the region runs to the end of the track', () => {
  const bytes = buildMidi([
    tempo(),
    noteOnAt(0), noteOffAt(TPQ * 2),
    noteOnAt(0), noteOffAt(TPQ * 2),
    cc(111),
    noteOnAt(0), noteOffAt(TPQ * 2),
    noteOnAt(0), noteOffAt(TPQ * 2),
  ]);
  const mf = parseBytes(bytes);
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  assert.ok(p.loop, 'a region starting at the marker');
  assert.ok(Math.abs(p.loop.startMs - 2000) < 1, `start=${p.loop.startMs}ms (2 beats in)`);
  assert.ok(p.loop.jumpMs > p.loop.startMs, 'and it wraps back to the marker');
});

check('lone CC111, multi-track: every part loops to the end of the song', () => {
  // RPG Maker convention: CC111 is the loop start with no end marker, so the
  // loop ends at the last track-end event in the song. A shorter part must keep
  // its trailing silence and wait for the song end, or it repeats early while
  // the longer part is still on its first pass (findLoopRange/getLoopedEvents).
  const bytes = buildMidi([
    [tempo(), cc(111), noteOnAt(0), noteOffAt(TPQ * 2)],  // short part, ends at 2*TPQ
    [noteOnAt(0), noteOffAt(TPQ * 6)],                    // long part, ends at 6*TPQ
  ], { format: 1 });
  const mf = parseBytes(bytes);
  const tracks = mf.tracks.map((_, i) => mf.getTrackEvents(i));
  const range = mf.findLoopRange(tracks);
  assert.deepStrictEqual(range, { startTick: 0, endTick: null });
  const { events, loopEndMs } = mf.getLoopedEvents(tracks, 2, range);
  assert.ok(Math.abs(loopEndMs - 3000) < 1, `loopEnd=${loopEndMs}ms (6*TPQ)`);
  const noteOns = (t) => events
    .filter(e => e.track === t && e.type === EVENT_MIDI && e.subtype === EVENT_MIDI_NOTE_ON)
    .map(e => e.playTime);
  const short = noteOns(0);
  const long = noteOns(1);
  assert.strictEqual(short.length, 2, `short part has one note per pass: ${short}`);
  assert.strictEqual(long.length, 2, `long part has one note per pass: ${long}`);
  // The bug: the short part used its own end (2*TPQ = 1000 ms) as the loop
  // boundary, so its second pass fired 2000 ms before the long part's.
  assert.ok(Math.abs(short[1] - long[1]) < 1,
    `the parts replay together at the song end: short=${short[1]} long=${long[1]}`);
  assert.ok(Math.abs(short[1] - loopEndMs) < 1,
    `the short part waits for the song end, not its own: ${short[1]} vs ${loopEndMs}`);
});

check('post-loop content with no notes does not inflate the duration', () => {
  // Converter output pads with note-less events a whole loop past the loop end
  // (Gyrocopter's END_OF_TRACK). Those must attach at the loop end, not push
  // the song out with dead air.
  const loopLen = 2 * TPQ;
  const bytes = buildMidi([
    tempo(),
    noteOnAt(0), noteOffAt(loopLen),
    noteOnAt(0), noteOffAt(loopLen),
    cc(103),
    // Note-less cleanup a whole loop past the loop end, as converters emit.
    { delta: loopLen, bytes: [0xb0, 7, 100] },
    cc(64, 0), cc(120, 0), cc(121, 0),
  ]);
  const mf = parseBytes(bytes);
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  // The looped event list is two passes, so a clean file ends at 2 * loopLength
  // however far the padding is spaced out.
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  const last = events[events.length - 1].playTime;
  const B = loopEndMs - loopStartMs;
  assert.ok(Math.abs(last - (loopStartMs + 2 * B)) < 1,
    `dead air after the loop: playTime=${last} expected=${loopStartMs + 2 * B}`);
});

check('post-loop content *with* notes keeps its exact timing', () => {
  const loopLen = 2 * TPQ;
  const bytes = buildMidi([
    tempo(),
    noteOnAt(0), noteOffAt(loopLen),
    noteOnAt(0), noteOffAt(loopLen),
    cc(103),
    noteOnAt(0, 0, 64), noteOffAt(TPQ),
  ]);
  const mf = parseBytes(bytes);
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  const events = mf.getPlaybackEvents(true).events;
  const last = events[events.length - 1];
  assert.ok(last.playTime >= p.loop.lengthMs + TPQ / (TPQ / 1000) - 1,
    `a composed ending keeps its timing: playTime=${last.playTime} loopLength=${p.loop.lengthMs}`);
});

check('a file with no loop markers plays straight through under repeat one', () => {
  const bytes = buildMidi([
    tempo(),
    noteOnAt(0), noteOffAt(TPQ),
    noteOnAt(0), noteOffAt(TPQ),
  ]);
  const mf = parseBytes(bytes);
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  assert.ok(!p.loop, 'no markers, no region');
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.getDuration() - 30);
  p.processPlaySynth(0, 2048);
  assert.ok(p.paused, 'repeat one cannot invent a loop, so the song ends');
});

check('format 2 (async patterns): loop markers are ignored, so there is no band', () => {
  // findLoopRange() is format-blind and still finds the region, but a
  // song-global loop cannot be expanded onto independent patterns, so the
  // player must report *no* band rather than latching the whole song as one.
  const bytes = buildMidi([
    [tempo(), ccAt(0, 102)],
    [tempo(), noteOnAt(0), noteOffAt(TPQ), cc(103), noteOnAt(0), noteOffAt(TPQ)],
  ], { format: 2 });
  const mf = parseBytes(bytes);
  assert.ok(mf.findLoopRange(mf.tracks.map((_, i) => mf.getTrackEvents(i))),
    'the markers really are there');
  const { loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  assert.strictEqual(loopStartMs, null);
  assert.strictEqual(loopEndMs, null, 'not the end of the song either');
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  assert.ok(!p.loop, 'no band, so no wrap and repeat one plays straight through');
  const roll = parseMidiData(bytes);
  const audio = mf.getPlaybackEvents(true).events.slice(-1)[0].playTime;
  assert.ok(Math.abs(roll.durationMs - audio) < 1,
    `piano roll and audio agree on a single pass (roll=${roll.durationMs} audio=${audio})`);
});

check('format 1 with the same markers still gets its band (guards the guard)', () => {
  const bytes = buildMidi([
    tempo(), cc(102),
    noteOnAt(0), noteOffAt(TPQ), cc(103),
    noteOnAt(0), noteOffAt(TPQ),
  ], { format: 1 });
  const mf = parseBytes(bytes);
  const { loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  assert.ok(loopEndMs != null && loopEndMs > loopStartMs, 'the band survives format 1');
  const p = makePlayer(stubSynth(true));
  p.load(mf, true);
  assert.ok(p.loop, 'and the player still wraps');
});

// --- Replay/merge edge cases (regression guards) ----------------------------

check('a track whose only events are past the loop end still shifts its ending', () => {
  // Track A defines the loop; track B has no events inside it, only an ending.
  // B's ending must follow both passes -- not overlap the second one, and not
  // be duplicated.
  const bytes = buildMidi([
    [tempo(), ccAt(0, 102), noteOnAt(0), noteOffAt(TPQ * 2), ccAt(0, 103), noteOnAt(0), noteOffAt(TPQ * 2)],
    [noteOnAt(TPQ * 3, 0, 72), noteOffAt(TPQ, 0, 72)],
  ], { format: 1 });
  const mf = parseBytes(bytes);
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  const B = loopEndMs - loopStartMs;
  assert.ok(B > 0, `band length ${B}`);
  const ons = events.filter(e => e.param1 === 72 && e.param2 === 100);
  assert.strictEqual(ons.length, 1, `ending note appeared ${ons.length} time(s), expected 1`);
  // Authored at 3*TPQ = 1500 ms; two passes push it one loop length later.
  assert.ok(Math.abs(ons[0].playTime - (1500 + B)) < 1,
    `ending at ${ons[0].playTime}ms, expected ${1500 + B} (1500 + loop ${B})`);
});

check('a tempo change inside the loop is restored on the replayed pass', () => {
  // Intro at 120bpm; the loop starts at 2*TPQ and runs 120bpm for one beat, then
  // 240bpm. The tempo in force at the loop start (120bpm) is set by the intro
  // event, which the replay does not re-emit -- so it must be restored, or the
  // second pass runs the pre-change beat at the leftover 240bpm.
  const bytes = buildMidi([
    tempo(500000),
    noteOnAt(0), noteOffAt(TPQ * 2),   // intro, ticks 0..2*TPQ
    cc(110),                            // loop start, tick 2*TPQ
    noteOnAt(0), noteOffAt(TPQ),        // 2*TPQ..3*TPQ at 120bpm
    tempo(250000),                      // tick 3*TPQ: 240bpm
    noteOnAt(0), noteOffAt(TPQ),        // 3*TPQ..4*TPQ at 240bpm
    cc(111),                            // loop end, tick 4*TPQ
  ]);
  const mf = parseBytes(bytes);
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  const B = loopEndMs - loopStartMs; // 500ms @120 + 250ms @240 = 750
  const tempos = events.filter(e => e.type === 0xff && e.subtype === 0x51)
    .map(e => Math.round(e.playTime));
  assert.strictEqual(tempos.length, 3, `tempo-event times=${tempos} (intro + one per pass)`);
  assert.ok(Math.abs((tempos[2] - tempos[1]) - B) < 1,
    `the replayed change is one loop apart: ${tempos[2] - tempos[1]}ms vs loop ${B}ms`);
});

check('multi-track: the tempo restore repeats on a third and later pass', () => {
  // A loop that opens after the intro's tempo event (at 2*TPQ), with a tempo
  // change inside it (2.5*TPQ), so the tempo in force at the loop start comes
  // from an event a replay does not re-emit. Track 1's note sits in the
  // pre-change stretch, so its spacing between passes is the loop length only
  // when every pass restores that tempo. The two-pass checks above cover the
  // first restore; this one covers the third pass and beyond.
  const bytes = buildMidi([
    [tempo(500000),
     noteOnAt(0, 0, 60), noteOffAt(TPQ * 2, 0, 60),   // intro, ticks 0..2*TPQ
     cc(110),                                          // loop start
     noteOnAt(0, 0, 60), noteOffAt(Math.round(TPQ / 2), 0, 60),
     tempo(250000),                                    // tick 2.5*TPQ
     noteOnAt(0, 0, 60), noteOffAt(Math.round(TPQ / 2), 0, 60),
     cc(111)],                                         // loop end, tick 3*TPQ
    [noteOnAt(Math.round(2.25 * TPQ), 1, 72), noteOffAt(Math.round(TPQ / 4), 1, 72)],
  ], { format: 1 });
  const mf = parseBytes(bytes);
  const tracks = mf.tracks.map((_, i) => mf.getTrackEvents(i));
  const range = mf.findLoopRange(tracks);
  const { events, loopStartMs, loopEndMs } = mf.getLoopedEvents(tracks, 3, range);
  const B = loopEndMs - loopStartMs;
  assert.ok(B > 0, `band ${loopStartMs}..${loopEndMs}`);
  const ons = events.filter(e => e.param1 === 72 && e.param2 > 0).map(e => e.playTime);
  assert.strictEqual(ons.length, 3, `track-1 note-ons=${ons.length}`);
  assert.ok(Math.abs((ons[1] - ons[0]) - B) < 1,
    `pass 2 starts one loop after pass 1: ${(ons[1] - ons[0]).toFixed(1)}ms vs loop ${B}ms`);
  assert.ok(Math.abs((ons[2] - ons[1]) - B) < 1,
    `pass 3 starts one loop after pass 2: ${(ons[2] - ons[1]).toFixed(1)}ms vs loop ${B}ms`);
});

check('implicit-zero loop with no tick-0 event restores the start tempo', () => {
  // Same tempo restore, but the loop is an implicit-start CC103 (startTick 0)
  // whose first event is not at tick 0, so the loop-start tempo comes from the
  // initial default rather than a latched event.
  const bytes = buildMidi([
    noteOnAt(TPQ, 0, 60), noteOffAt(TPQ, 0, 60),   // first event at tick TPQ
    tempo(250000),                                  // tick 2*TPQ: 240bpm
    noteOnAt(0, 0, 60), noteOffAt(TPQ, 0, 60),      // 2*TPQ..3*TPQ
    cc(103),                                        // loop end, tick 3*TPQ
  ]);
  const mf = parseBytes(bytes);
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  assert.ok(loopEndMs > loopStartMs, `band ${loopStartMs}..${loopEndMs}`);
  const B = loopEndMs - loopStartMs;
  const tempos = events.filter(e => e.type === 0xff && e.subtype === 0x51)
    .map(e => Math.round(e.playTime));
  assert.strictEqual(tempos.length, 2, `tempo-event times=${tempos}`);
  assert.ok(Math.abs((tempos[1] - tempos[0]) - B) < 1,
    `the replayed change is one loop apart: ${tempos[1] - tempos[0]}ms vs loop ${B}ms`);
});

check('Repeat One Web MIDI: the wrap reschedules the new pass in the same call', () => {
  const sends = [];
  const p = new MIDIFilePlayer({
    programChangeCb: () => {},
    useWebMIDI: true,
    output: { send: (message, timestamp) => sends.push([message, timestamp]) },
    skipSilence: false,
    sampleRate: 44100,
    synth: stubSynth(true),
  });
  const mf = loopWithIntroGapAndEnding();
  p.load(mf, true);
  assert.ok(p.loop, 'expected a loop region');
  p.play(() => {});
  p.setLooping(true);
  // Park on the event index at the band end, with the clock just past it.
  p.position = p.loop.endIndex;
  p.elapsedTime = p.loop.endMs + 1;
  p.lastProcessPlayTimestamp = performance.now();
  sends.length = 0;
  p.processPlay();
  // The new pass must be scheduled now, not on the next callback.
  assert.ok(sends.length > 0, 'no events scheduled during the wrap call');
  assert.ok(p.position < p.loop.endIndex, 'position did not move into the new pass');
  // A wrap detected past the boundary keeps the clock absolute (overshoot
  // carried), so the pass still lines up with the original boundary. The reset
  // itself advances the clock by the call's own deltaTime, hence the slack.
  assert.ok(p.elapsedTime >= p.loop.jumpMs && p.elapsedTime - p.loop.jumpMs < 10,
    `clock should be jumpMs + overshoot, got ${p.elapsedTime}`);
});

check('multi-track: a track replayed after an in-loop tempo change keeps that tempo', () => {
  // Track 0 defines the loop and carries a tempo change at TPQ. Track 1's first
  // in-loop event is at 1.5*TPQ, after that change. Restoring the loop-start
  // tempo per track (at track 1's replay) would erase the change; restoring it
  // once at the shared boundary must not.
  const bytes = buildMidi([
    [tempo(500000), cc(110),
     noteOnAt(0, 0, 60), noteOffAt(TPQ, 0, 60),
     tempo(250000),
     noteOnAt(0, 0, 60), noteOffAt(TPQ, 0, 60), cc(111)],
    [noteOnAt(Math.round(1.5 * TPQ), 1, 72), noteOffAt(Math.round(0.4 * TPQ), 1, 72)],
  ], { format: 1 });
  const mf = parseBytes(bytes);
  const { events, loopStartMs, loopEndMs } = mf.getPlaybackEvents(true);
  assert.ok(loopEndMs > loopStartMs, `band ${loopStartMs}..${loopEndMs}`);
  const ons = events.filter(e => e.param1 === 72 && e.param2 > 0).map(e => e.playTime);
  const offs = events.filter(e => e.param1 === 72 && e.param2 === 0).map(e => e.playTime);
  assert.strictEqual(ons.length, 2, `track-1 note-ons=${ons.length}`);
  assert.strictEqual(offs.length, 2, `track-1 note-offs=${offs.length}`);
  const gap1 = offs[0] - ons[0];
  const gap2 = offs[1] - ons[1];
  assert.ok(Math.abs(gap2 - gap1) < 1,
    `the replayed note keeps its length: pass1 ${gap1.toFixed(1)}ms vs pass2 ${gap2.toFixed(1)}ms`);
});

// A note that starts inside the loop and is released past its end crosses the
// seam. The noteless path cuts it when it collapses the outro to the boundary;
// a composed ending keeps its own timing, so the release is *not* moved -- and
// without an explicit cut the replay re-triggers the same pitch while the first
// note is still sounding, which the MIDI spec calls invalid (a second NoteOn for
// a sounding note). EventIterator releases the crossing notes at every replay
// boundary (greptile, midi-helpers.js:176, 2026-10-15). The final pass is not
// cut: it plays out into the ending with the composer's own release.
function noteCrossingTheSeam(composedEnding) {
  const list = [
    tempo(),
    noteOnAt(0), noteOffAt(TPQ),          // intro note, ticks 0..120
    ccAt(TPQ * 3, 110),                   // loop start at tick 480
    noteOnAt(0),                          // the crossing note starts here
    ccAt(TPQ * 4, 111),                   // loop end at tick 960
    noteOffAt(TPQ),                       // its release: tick 1080, past the end
  ];
  if (composedEnding) list.push(noteOnAt(TPQ * 3), noteOffAt(TPQ));
  return parseBytes(buildMidi(list));
}

check('a note crossing the seam is cut at the replay, composed ending or not', () => {
  const NOTE_OFF = MIDIEvents.EVENT_MIDI_NOTE_OFF;
  for (const composedEnding of [false, true]) {
    const mf = noteCrossingTheSeam(composedEnding);
    const { events, loopEndMs } = mf.getPlaybackEvents(true);
    let sounding = false;
    let overlaps = 0;
    let releasesAtBoundary = 0;
    for (const e of events) {
      if (e.type !== EVENT_MIDI || e.param1 !== 60) continue;
      const isOn = e.subtype === EVENT_MIDI_NOTE_ON && e.param2 > 0;
      const isOff = e.subtype === NOTE_OFF || (e.subtype === EVENT_MIDI_NOTE_ON && e.param2 === 0);
      if (isOn) {
        if (sounding) overlaps++;
        sounding = true;
      } else if (isOff) {
        sounding = false;
        if (Math.abs(e.playTime - loopEndMs) < 2) releasesAtBoundary++;
      }
    }
    assert.strictEqual(overlaps, 0,
      `composedEnding=${composedEnding}: re-triggered while still sounding`);
    assert.strictEqual(releasesAtBoundary, 1,
      `composedEnding=${composedEnding}: expected one release at the boundary (${Math.round(loopEndMs)}ms)`);
  }
});

// The seam release is emitted at the boundary, so the iterator's own tick has to
// reach it too -- otherwise the *next* boundary (or the noteless collapse that
// ends the list) measures its gap from a stale tick and places its event one gap
// too late (greptile/macroscope, midi-helpers.js:303). The note lives on a track
// that carries no markers, so the global loop end is set elsewhere and its last
// in-loop event sits before that boundary: gap > 0, which the marker-at-the-end
// shape cannot show.
check('a note released past the loop end rings into the ending at its authored offset', () => {
  const mf = parseBytes(buildMidi([
    [tempo(), cc(110), ccAt(TPQ * 4, 111)],              // loop [0, 480]
    [noteOnAt(0), noteOffAt(TPQ * 5)],                   // on@0, released at 600 -- past the end
  ]));
  const { events, loopEndMs } = mf.getPlaybackEvents(true);
  const last = events[events.length - 1];
  // The release sits one TPQ past the loop end (a quarter of the 4-TPQ loop), so
  // it sounds a quarter of a loop length past the second boundary instead of
  // being clamped onto it. The replay-boundary cut is separate and covered by
  // 'a note crossing the seam is cut at the replay, composed ending or not'.
  const expected = 2 * loopEndMs + loopEndMs / 4;
  assert.ok(Math.abs(last.playTime - expected) < 1,
    `last event at ${Math.round(last.playTime)}ms, expected ${Math.round(expected)}ms (2 boundaries + the authored offset)`);
});

// The two-pass expansion is the real work bound (EventIterator stops after its
// passes); a fixed cap on the merged list instead cut the second pass off
// mid-way, appended all-notes-off and ended the song early (greptile,
// midi-helpers.js:527, 2026-10-16). The ceiling now sits several times above an
// ordinary song -- and crossing it drops the loop region rather than the music,
// see the next check -- so a loop this size still gets both passes and its band.
check('a large loop keeps both passes and its band', () => {
  const N = 101000;
  const list = [tempo(), cc(110)];
  for (let i = 0; i < N; i++) list.push(ccAt(1, 7, i % 128));
  list.push(ccAt(1, 111));
  // getLoopedEvents debug-logs its whole list (master's, pre-existing); silence
  // it here or this check prints ~200k objects.
  const debug = console.debug;
  console.debug = () => {};
  try {
    // The sequential (one track) and concurrent (multi-track) merges each had
    // their own copy of the cap, so exercise both.
    for (const tracks of [list, [list, [tempo()]]]) {
      const { events, loopEndMs } = parseBytes(buildMidi(tracks)).getPlaybackEvents(true);
      const data = events.filter(e => e.subtype === MIDIEvents.EVENT_MIDI_CONTROLLER && e.param1 === 7);
      assert.strictEqual(data.length, 2 * N,
        `expected both passes, got ${data.length} of ${2 * N}`);
      const last = events[events.length - 1].playTime;
      assert.ok(Math.abs(last - 2 * loopEndMs) < 1, `two-pass duration ${last} vs ${2 * loopEndMs}`);
    }
  } finally {
    console.debug = debug;
  }
});

// Crossing the ceiling must not drop music: the merge is abandoned and the song
// falls back to one full pass with no loop region -- the same shape a file with
// no markers gives. A short list (all-notes-off appended, song over) would be a
// worse bug than the memory the ceiling guards.
check('an expansion past the merge ceiling plays one full pass, dropping nothing', () => {
  const N = Math.floor(MAX_MERGED_EVENTS / 2) + 1000; // two passes cross the ceiling
  const msPerTick = (500000 / TPQ) / 1000; // 500000us per beat, TPQ ticks per beat
  const debug = console.debug;
  const warn = console.warn;
  const warnings = [];
  console.debug = () => {};
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // Both merges carry their own copy of the ceiling test.
    for (const extraTracks of [0, 1]) {
      const { events, loopStartMs, loopEndMs } =
        parseBytes(buildBulkMidi(N, extraTracks)).getPlaybackEvents(true);
      assert.strictEqual(loopStartMs, null, 'expected no loop region');
      assert.strictEqual(loopEndMs, null, 'expected no loop band');
      const overflowWarnings = warnings.filter(w => w.includes('loop expansion exceeded'));
      assert.strictEqual(overflowWarnings.length, 1, `expected one warning, got ${warnings.length}`);
      const data = events.filter(e =>
        e.subtype === MIDIEvents.EVENT_MIDI_CONTROLLER && e.param1 === 7);
      assert.strictEqual(data.length, N,
        `expected every controller event once, got ${data.length} of ${N}`);
      // One pass, not two: the last of them sits where its own tick puts it.
      const last = data[data.length - 1].playTime;
      assert.ok(Math.abs(last - N * msPerTick) < 1,
        `one-pass duration ${Math.round(last)}ms vs ${Math.round(N * msPerTick)}ms`);
      warnings.length = 0;
    }
  } finally {
    console.debug = debug;
    console.warn = warn;
  }
});

// The ceiling is written in events, but the number a reader needs is the file
// size it means. A MIDI runs about four bytes per event, so a whole-file loop
// crosses it around 2 MB; measure that ratio on a real dense file rather than
// trusting the arithmetic, and hold the constant's stated size to it.
catalogCheck(STRESS, 'the merge ceiling works out to a few MB of dense file', () => {
  const bytes = fs.statSync(path.join(ROOT, 'catalog', STRESS)).size;
  const events = countTrackEvents(loadMidi(STRESS));
  const bytesPerEvent = bytes / events;
  assert.ok(bytesPerEvent > 3.5 && bytesPerEvent < 4.5,
    `${bytesPerEvent.toFixed(2)} bytes per event`);
  // Two passes over every event, so the ceiling is crossed by this much file.
  const triggerMB = (MAX_MERGED_EVENTS / 2) * bytesPerEvent / 1048576;
  assert.ok(triggerMB > 1.5 && triggerMB < 2.5,
    `ceiling works out to ${triggerMB.toFixed(2)} MB of file`);
});

// The band (second pass) begins on a distinctive note, so the send can be told
// apart from the wrap's own cleanup traffic.
check('Repeat One Web MIDI: the next pass is queued from inside the look-ahead window', () => {
  const sends = [];
  const p = new MIDIFilePlayer({
    programChangeCb: () => {},
    useWebMIDI: true,
    output: { send: (message, timestamp) => sends.push([message, timestamp]) },
    skipSilence: false,
    sampleRate: 44100,
    synth: stubSynth(true),
  });
  // Loop region [4000, 5000] ms, so the band (second pass) is [5000, 6000].
  const mf = parseBytes(buildMidi([
    tempo(),
    noteOnAt(0, 0, 40), noteOffAt(TPQ, 0, 40),        // intro, ticks 0..120
    ccAt(TPQ * 3, 110),                               // loop start, tick 480
    noteOnAt(0, 0, 72), noteOffAt(TPQ, 0, 72),        // the band-start note
    cc(111),                                          // loop end, tick 600
    noteOnAt(TPQ * 6, 0, 50), noteOffAt(TPQ, 0, 50),  // composed ending
  ]));
  p.load(mf, true);
  assert.ok(p.loop, 'expected a loop region');
  p.play(() => {});
  p.setLooping(true);
  // This is where the scheduler really sits once the last in-band event has
  // been sent: `position` has reached the band-end index, but the clock is
  // still one look-ahead window short of the boundary. Waiting for the clock
  // (the old behaviour) queued nothing, so the band-start note was sent on the
  // callback after the boundary -- up to a block late.
  const now = performance.now();
  p.lastProcessPlayTimestamp = now;
  p.lastSendTimestamp = now;
  p.elapsedTime = p.loop.endMs - 20;
  p.position = p.loop.endIndex;
  sends.length = 0;
  p.processPlay();
  assert.ok(sends.length > 0,
    'the next pass must be queued in the wrap call, not on the callback after the boundary');
  // Wrapped, not merely parked: the clock is a music time mod the loop length.
  assert.ok(Math.abs(p.elapsedTime - (p.loop.jumpMs - 20)) < 1,
    `clock should have wrapped to ${p.loop.jumpMs - 20}ms, got ${p.elapsedTime}`);
  // The band-start note is queued for the boundary -- 20 ms out, i.e. ahead of
  // the callback, not sent on it (Web MIDI sends a past timestamp immediately).
  const ts = Math.max(...sends.map(s => s[1]));
  assert.ok(ts - now > 5 && ts - now <= 33,
    `band-start event scheduled ${(ts - now).toFixed(1)}ms out, expected the boundary at ~20ms`);
});

// The wrap's own messages -- the ringing-note cuts, the sustain release and the
// restored state -- belong at the band end. The last event the scheduler sent
// can sit a whole rest before it, so stamping them with lastSendTimestamp cuts
// held notes and switches the sound while the pass is still playing out.
check('Repeat One Web MIDI: the wrap cleanup lands on the band end, not the last event', () => {
  const sends = [];
  const p = new MIDIFilePlayer({
    programChangeCb: () => {},
    useWebMIDI: true,
    output: { send: (message, timestamp) => sends.push([message, timestamp]) },
    skipSilence: false,
    sampleRate: 44100,
    synth: stubSynth(true),
  });
  // Intro program 5, loop [2000, 4000], loop content in its first second: the
  // last in-band event is a full second before the band ends.
  const mf = parseBytes(buildMidi([
    tempo(),
    programChangeAt(0, 0, 5),
    noteOnAt(0, 0, 64), noteOffAt(TPQ, 0, 64),
    ccAt(TPQ * 3, 110),                        // loop start, tick 480
    noteOnAt(0, 0, 72), noteOffAt(TPQ, 0, 72), // loop content, ticks 480..600
    ccAt(TPQ * 4, 111),                        // loop end, tick 960
  ]));
  p.load(mf, true);
  assert.ok(p.loop, 'expected a loop region');
  p.play(() => {});
  p.setLooping(true);
  const now = performance.now();
  p.lastProcessPlayTimestamp = now;
  p.elapsedTime = p.loop.endMs - 20; // the wrap fires inside the look-ahead window
  p.position = p.loop.endIndex;
  p.lastSendTimestamp = now - 1000; // the last event went out a second ago...
  p.activeNotes.set(72, 1);         // ...leaving this note ringing across the seam
  sends.length = 0;
  p.processPlay();
  const boundary = now + 20; // loop.endMs, 20ms out
  const near = (ts) => Math.abs(ts - boundary) < 1;
  const noteOff = sends.find(s => (s[0][0] & 0xf0) === 0x80 && s[0][1] === 72);
  assert.ok(noteOff, 'the ringing note is cut at the wrap');
  assert.ok(near(noteOff[1]),
    `its note-off belongs at the band end (${boundary.toFixed(0)}), got ${noteOff[1].toFixed(0)}`);
  const sustain = sends.find(s => (s[0][0] & 0xf0) === 0xb0 && s[0][1] === 64);
  assert.ok(sustain && near(sustain[1]), 'the sustain release belongs at the band end');
  const program = sends.find(s => (s[0][0] & 0xf0) === 0xc0);
  assert.ok(program, 'the second pass restores its program');
  assert.ok(near(program[1]),
    `the restore belongs at the band end (${boundary.toFixed(0)}), got ${program[1].toFixed(0)}`);
  // The file authored no bend, so the collect has none to restore: the centre
  // this sends is the only thing that clears the finished pass's bend.
  const bend = sends.find(s => (s[0][0] & 0xf0) === 0xe0);
  assert.ok(bend, 'the wrap centres the bend');
  assert.strictEqual(bend[0][1] | (bend[0][2] << 7), 8192, 'and it is centre');
  assert.ok(near(bend[1]), 'and it belongs at the band end too');
});

// The expanded two-pass list is what the audio engine plays for a whole-file
// loop (and what the piano roll shows), and it has to sound like the live wrap:
// loopJump() lifts the sustain pedal at the seam, so the list must too. A note
// released while the pedal is down is gone from the seam's ring scan but still
// sounds, so without the lift it carries into the second pass and overlaps its
// notes.
check('the MIDI seam lifts a pedal-held note like the live wrap does', () => {
  const withPedal = parseBytes(buildMidi([
    tempo(),
    cc(64, 127),                               // pedal down
    noteOnAt(0, 0, 60), noteOffAt(TPQ, 0, 60), // released under the pedal: still sounding
    ccAt(TPQ, 110),                            // loop start
    noteOnAt(0, 0, 64), noteOffAt(TPQ, 0, 64),
    cc(111),                                   // loop end
  ]));
  const { events, loopEndMs } = withPedal.getPlaybackEvents(true);
  assert.ok(loopEndMs > 0, `expected a loop region, got ${loopEndMs}`);
  const seam = events.filter(e => e.subtype === MIDIEvents.EVENT_MIDI_CONTROLLER &&
    e.param1 === 64 && Math.abs(e.playTime - loopEndMs) < 1);
  const lift = seam.findIndex(e => e.param2 === 0);
  assert.ok(lift >= 0,
    `the pedal is lifted at the seam (values there: ${seam.map(e => e.param2).join(',') || 'none'})`);
  assert.ok(seam.slice(lift + 1).some(e => e.param2 >= 64),
    'and re-armed, so the next pass still sustains what it should');
  // Negative control: the same shape without a pedal must add no pedal traffic.
  const bare = parseBytes(buildMidi([
    tempo(),
    noteOnAt(0, 0, 60), noteOffAt(TPQ, 0, 60),
    ccAt(TPQ, 110),
    noteOnAt(0, 0, 64), noteOffAt(TPQ, 0, 64),
    cc(111),
  ])).getPlaybackEvents(true);
  const bareSeam = bare.events.filter(e => e.subtype === MIDIEvents.EVENT_MIDI_CONTROLLER &&
    e.param1 === 64 && Math.abs(e.playTime - bare.loopEndMs) < 1);
  assert.strictEqual(bareSeam.length, 0, 'nothing was sustained, so nothing is added');
});

// The same shape as a real file, generated by dev/make-loop-pedal-midi.js and
// committed to the catalog (catalog/ is gitignored, so this skips elsewhere):
// pedal down throughout, a note released on the seam while it is held.
catalogCheck('midi/loop-pedal-seam.mid', 'the pedal fixture lifts its pedal at the seam', () => {
  const { events, loopEndMs } = loadMidi('midi/loop-pedal-seam.mid').getPlaybackEvents(true);
  assert.ok(loopEndMs > 0, `expected a loop region, got ${loopEndMs}`);
  const seam = events.filter(e => e.subtype === MIDIEvents.EVENT_MIDI_CONTROLLER &&
    e.param1 === 64 && Math.abs(e.playTime - loopEndMs) < 1);
  assert.ok(seam.some(e => e.param2 === 0) && seam.some(e => e.param2 >= 64),
    `seam pedal pair (values there: ${seam.map(e => e.param2).join(',') || 'none'})`);
});

// --- The end rule's layers ---------------------------------------------------
// A wrap must leave every channel at the state the wrap *target* has. The
// collected list carries only values the file authored before that point, so a
// value first set inside the loop has none to restore and would come through from
// the finished pass -- a loop that bends late reopened bent. Same idea as cutting
// the notes still ringing at the boundary: end what the finished pass left, then
// present the target's state.
function bendFixture() {
  return buildMidi([
    tempo(500000), cc(110),
    noteOnAt(0, 0, 60), noteOffAt(120, 0, 60),
    noteOnAt(0, 0, 64), bendAt(72, 0, 0x0000), noteOffAt(48, 0, 64),
    cc(111),
  ]);
}

check('a wrap centres a bend the file never authored (no expansion)', () => {
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(parseBytes(bendFixture()), false);
  assert.ok(p.loop && p.loop.jumpMs < p.loop.endMs, `loop=${JSON.stringify(p.loop)}`);
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.getDuration() - 30);
  synth.log.length = 0;
  p.processPlaySynth(0, 2048);
  assert.ok(p.position >= p.loop.jumpIndex, 'expected a wrap');
  const bends = synth.log.filter(([k]) => k === 'bend');
  assert.ok(bends.some(([, , v]) => v === 8192),
    'expected a centre bend at the wrap: ' + JSON.stringify(bends));
});

check('and the expanded wrap still restores the bend the file did author', () => {
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(parseBytes(bendFixture()), true);
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.getDuration() - 30);
  synth.log.length = 0;
  p.processPlaySynth(0, 2048);
  const bends = synth.log.filter(([k]) => k === 'bend');
  assert.ok(bends.length > 0, 'expected bends at the wrap: ' + JSON.stringify(bends));
  // The reset lands first, the collected value after: the pass opens authored.
  assert.strictEqual(bends[bends.length - 1][2], 0,
    'the authored bend must survive the reset: ' + JSON.stringify(bends));
});

// One class of event per layer, toggled independently: the state layers (what is
// sounding) and the trailing layers (which can only push the end later). These
// pin each toggle, since the layers are how the rule is tuned.
const ev = (playTime, subtype, channel, param1, param2) =>
  ({ playTime, subtype, channel, param1, param2, type: MIDIEvents.EVENT_MIDI });
const evOn = (t, p = 60, ch = 0) => ev(t, MIDIEvents.EVENT_MIDI_NOTE_ON, ch, p, 100);
const evOff = (t, p = 60, ch = 0) => ev(t, MIDIEvents.EVENT_MIDI_NOTE_OFF, ch, p, 0);
const evCc = (t, p1, p2, ch = 0) => ev(t, MIDIEvents.EVENT_MIDI_CONTROLLER, ch, p1, p2);

check('end layers: the sustain pedal is what makes a held ending audible', () => {
  const list = [evOn(0), evCc(100, 64, 127), evOff(500), evCc(900, 64, 0)];
  assert.strictEqual(songEndMs(list, { ...END_LAYERS }), 900, 'sustain on: the pedal lift is the end');
  assert.strictEqual(songEndMs(list, { ...END_LAYERS, sustain: false }), 500, 'sustain off: the note-off is');
  // A note-off after everything has stopped is not an end at all.
  assert.strictEqual(songEndMs([...list, evOff(1400, 62)], { ...END_LAYERS }), 900,
    'an unsounding note-off does not extend the end');
});

check('end layers: trailing events extend the end only when their layer is on', () => {
  const list = [evOn(0), evOff(400), evCc(1200, 7, 100), evCc(1300, 121, 0)];
  assert.strictEqual(songEndMs(list, { ...END_LAYERS }), 400, 'controllers off: volume/reset are padding');
  assert.strictEqual(songEndMs(list, { ...END_LAYERS, controller: true }), 1300, 'controller on: the last CC is the end');
  assert.strictEqual(songEndMs(list, null), 0, 'no layers: leave the list alone');
});

check('end layers: all-sounds-off ends a pedal-held note early', () => {
  const list = [evOn(0), evCc(100, 64, 127), evOff(500), evCc(700, 120, 0), evCc(900, 64, 0)];
  assert.strictEqual(songEndMs(list, { ...END_LAYERS }), 700, 'panic on: the hold ends there');
  assert.strictEqual(songEndMs(list, { ...END_LAYERS, panic: false }), 900, 'panic off: the pedal lift is');
});

check('end layers: a note still sounding at the track end rings to it', () => {
  // A file that never releases its final note carries no end for it, so the track
  // end bounds it: crediting the note's own start would silence it, which is what
  // greptile's "final held notes get cut" (endRule.js:93) describes.
  const eot = (playTime) => ({ playTime, type: MIDIEvents.EVENT_META, subtype: MIDIEvents.EVENT_META_END_OF_TRACK });
  assert.strictEqual(songEndMs([evOn(10000, 72), eot(15000)], { ...END_LAYERS }), 15000,
    'the dangling note rings to the track end');
  // With nothing sounding, that same trailing meta is dead air and must not extend.
  assert.strictEqual(songEndMs([evOn(0), evOff(500), eot(15000)], { ...END_LAYERS }), 500,
    'a trailing meta after silence is not an end');
});

check('a marker file cuts a held note at its own track end, like the plain path', () => {
  // One file, both paths. The per-track release pass lives in one place now, and
  // this is exactly where the two drifted: a marker file lost the cut when it
  // started going through the loop merge, so a note the writer never released rang
  // to the end of the song instead of the end of its track. Track 0 holds a note
  // and ends at 1s (a text meta, then its END_OF_TRACK); track 1 plays to 5s and
  // carries the loop end, so the region is real and the marker path -- not the
  // getEvents fallback -- is the one under test.
  const bytes = buildMidi([
    [tempo(), cc(110), noteOnAt(0, 0, 60), { delta: TPQ * 2, bytes: [0xff, 0x01, 0x00] }],
    [noteOnAt(0, 0, 72), noteOffAt(TPQ * 2, 0, 72), noteOnAt(0, 0, 74), noteOffAt(TPQ * 8, 0, 74), cc(111)],
  ]);
  const cutAt = (events, track, channel) => events
    .filter((e) => e.subtype === MIDIEvents.EVENT_MIDI_CONTROLLER &&
      e.param1 === 123 && (e.track || 0) === track && e.channel === channel)
    .map((e) => Math.round(e.playTime));
  const plain = parseBytes(bytes).getEvents();
  const marker = parseBytes(bytes).getPlaybackEvents(false);
  assert.ok(marker.loopStartMs !== null && marker.loopEndMs > marker.loopStartMs,
    `expected a real region, got [${marker.loopStartMs}, ${marker.loopEndMs}]`);
  assert.deepStrictEqual(cutAt(plain, 0, 0), [1000, 5000],
    'the plain path releases at the track end and again at the song end');
  assert.deepStrictEqual(cutAt(marker.events, 0, 0), [1000, 5000],
    'and the marker path must agree, note for note');
  // The pass runs once per list. Asking the same file twice must not accumulate
  // releases -- that is what would break if it were ever applied in two places.
  const one = parseBytes(bytes);
  const first = one.getEvents();
  const second = one.getEvents();
  assert.deepStrictEqual(cutAt(second, 0, 0), cutAt(first, 0, 0),
    'asking twice does not accumulate releases');
  assert.deepStrictEqual(cutAt(second, 0, 0), [1000, 5000]);
});

check('a dangling final note keeps the track end in the merged loop list', () => {
  // The same shape end to end: the tail trim must not delete the track end that
  // the dangling note is audible *through*. 2400 ticks = 10 s, 3600 = 15 s.
  const bytes = buildMidi([
    tempo(), cc(110),
    noteOnAt(0, 0, 60), noteOffAt(TPQ, 0, 60),
    cc(111),                                            // loop end at 500 ms
    noteOnAt(2280, 0, 72),                              // dangling, 10 s
    { delta: 1200, bytes: [0xff, 0x01, 0x00] },         // trailing meta, 15 s (EOT follows)
  ]);
  const { events } = parseBytes(bytes).getPlaybackEvents(false);
  assert.strictEqual(Math.round(events[events.length - 1].playTime), 15000,
    'the merged list ends at the track end, not at the note-on');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
