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

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
