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
const MIDIFilePlayer = require('../src/players/MIDIFilePlayer').default;
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
function stubSynth(silent = true) {
  return {
    log: [],
    noteOn(c, p, v) { this.log.push(['on', c, p]); },
    noteOff(c, p) { this.log.push(['off', c, p]); },
    pitchBend() {}, controlChange() {}, programChange() {}, panic() {}, panicChannel() {},
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

const MARIO = 'midi/Nintendo 64 (SoundFont MIDI)_Mario Kart 64_01 - Main Theme.mid';
const DESCENT = 'midi/Game MIDI_Descent (PC∕DOS, 1995)_Game01.mid';
const DOOM = 'midi/DOOM/Game MIDI_Doom (PC∕DOS, 1993)_02 - At Doom\'s Gate (E1M1).mid';

// Catalog is user-supplied and gitignored; skip (don't fail) without it.
for (const rel of [MARIO, DESCENT, DOOM]) {
  if (!fs.existsSync(path.join(ROOT, 'catalog', rel))) {
    console.log(`skip: catalog/${rel} not present`);
    process.exit(0);
  }
}

check('Mario Kart: loop range is implicit-start [0, 6535] ticks', () => {
  const mf = loadMidi(MARIO);
  const range = mf.findLoopRange(tracksOf(mf));
  assert.deepStrictEqual(range, { startTick: 0, endTick: 6535 });
});

check('Mario Kart: region is [0, ~58348] ms with two passes', () => {
  const mf = loadMidi(MARIO);
  const tracks = tracksOf(mf);
  const range = mf.findLoopRange(tracks);
  const { events, loopStartMs, loopEndMs } = mf.getLoopedEvents(tracks, 2, range);
  assert.strictEqual(loopStartMs, 0);
  assert.ok(Math.abs(loopEndMs - 58348) < 1, `endMs=${loopEndMs}`);
  const dur = events[events.length - 1].playTime;
  assert.ok(Math.abs(dur - 2 * loopEndMs) < 1500, `dur=${dur} (2 passes + tail)`);
});

check('Descent Game01: HMI range [12, 23939] ticks -> [~100, ~200194] ms', () => {
  const mf = loadMidi(DESCENT);
  const tracks = tracksOf(mf);
  const range = mf.findLoopRange(tracks);
  assert.deepStrictEqual(range, { startTick: 12, endTick: 23939 });
  const { loopStartMs, loopEndMs } = mf.getLoopedEvents(tracks, 2, range);
  assert.ok(Math.abs(loopStartMs - 100) < 2, `startMs=${loopStartMs}`);
  assert.ok(Math.abs(loopEndMs - 200194) < 2, `endMs=${loopEndMs}`);
});

check('DOOM (no markers): no range, plain single-pass merge', () => {
  const mf = loadMidi(DOOM);
  const tracks = tracksOf(mf);
  assert.strictEqual(mf.findLoopRange(tracks), null);
  const { events, loopStartMs, loopEndMs } = mf.getLoopedEvents(tracks, 2, null);
  assert.strictEqual(loopStartMs, null);
  assert.strictEqual(loopEndMs, null);
  const single = mf.getEvents();
  assert.ok(Math.abs(events[events.length - 1].playTime - single[single.length - 1].playTime) < 1);
});

check('wrap: looping Mario jumps to second-pass start at list end', () => {
  const mf = loadMidi(MARIO);
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(mf, true);
  assert.ok(p.loop, 'expected a loop region');
  assert.ok(Math.abs(p.loop.startMs - 0) < 0.001);
  assert.ok(Math.abs(p.loop.jumpMs - p.loop.startMs - p.loop.lengthMs) < 0.001);
  p.play(() => {});
  p.setLooping(true);
  // Park just before the end, then render past it: one block crosses the end
  // and wraps, the next plays from the band start.
  p.setPosition(p.getDuration() - 30);
  const before = synth.log.length;
  p.processPlaySynth(0, 2048);
  assert.ok(Math.abs(p.elapsedTime - p.loop.jumpMs) < 200,
    `elapsed=${p.elapsedTime} jumpMs=${p.loop.jumpMs}`);
  assert.strictEqual(p.position, p.loop.jumpIndex);
  assert.ok(!p.paused, 'still playing after wrap');
  p.processPlaySynth(0, 2048);
  assert.ok(p.elapsedTime > p.loop.jumpMs && !p.paused, 'keeps playing into the band');
  void before;
});

check('no wrap: repeat off ends the song at list end', () => {
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

check('Descent loads a loop and wraps too', () => {
  const mf = loadMidi(DESCENT);
  const synth = stubSynth(true);
  const p = makePlayer(synth);
  p.load(mf, false); // content-gated, not filepath-gated
  assert.ok(p.loop, 'expected a loop region');
  assert.ok(Math.abs(p.loop.startMs - 100) < 2, `startMs=${p.loop.startMs}`);
  p.play(() => {});
  p.setLooping(true);
  p.setPosition(p.getDuration() - 30);
  p.processPlaySynth(0, 2048);
  assert.strictEqual(p.position, p.loop.jumpIndex);
  assert.ok(!p.paused);
});

check('setPosition still restores program state (seek regression)', () => {
  const mf = loadMidi(DESCENT);
  const p = makePlayer(stubSynth(true));
  p.load(mf, false);
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

// Set the tempo so the ms assertions are exact (default 500000 us/beat = 120bpm).
const tempo = (usPerQuarter = 500000) => ({ delta: 0, bytes: [0xff, 0x51, 0x03,
  (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] });
const cc = (controller, value = 0) => ({ delta: 0, bytes: [0xb0, controller, value] });
const ccAt = (delta, controller, value = 0) => ({ delta, bytes: [0xb0, controller, value] });
const noteOnAt = (delta, channel = 0, pitch = 60, velocity = 100) =>
  ({ delta, bytes: [0x90 | channel, pitch, velocity] });
const noteOffAt = (delta, channel = 0, pitch = 60) => ({ delta, bytes: [0x80 | channel, pitch, 0] });

function parseBytes(bytes) {
  return new MIDIFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function rollFor(rel) {
  const buf = fs.readFileSync(path.join(ROOT, 'catalog', rel));
  return parseMidiData(new Uint8Array(buf));
}

check('piano roll covers the same two passes the audio plays (Mario)', () => {
  const mf = loadMidi(MARIO);
  const audioDur = mf.getPlaybackEvents(true).events.slice(-1)[0].playTime;
  const roll = rollFor(MARIO);
  assert.ok(roll.notes.length > 100, `notes=${roll.notes.length}`);
  assert.ok(Math.abs(roll.durationMs - audioDur) < 1, `roll=${roll.durationMs} audio=${audioDur}`);
  // Second pass (the slider band) is populated, so the roll survives the
  // loop point and Repeat-One wraps instead of going empty.
  const bandStart = 58348;
  assert.ok(roll.notes.some(n => n.startMs >= bandStart), 'no notes in second pass');
});

check('piano roll covers the same two passes the audio plays (Descent)', () => {
  const mf = loadMidi(DESCENT);
  const audioDur = mf.getPlaybackEvents(false).events.slice(-1)[0].playTime;
  const roll = rollFor(DESCENT);
  assert.ok(Math.abs(roll.durationMs - audioDur) < 1, `roll=${roll.durationMs} audio=${audioDur}`);
  assert.ok(roll.notes.some(n => n.startMs >= 200194), 'no notes in second pass');
});

check('piano roll unchanged for files without loops (DOOM)', () => {
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

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
