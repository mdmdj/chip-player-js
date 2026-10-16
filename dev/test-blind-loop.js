#!/usr/bin/env node
// DEV-ONLY isBlindLoop check: the "no honest position" state that parks the
// slider head, keeps the elapsed time climbing, and labels the length
// "Looping" (Player.isBlindLoop; the footer and TimeSlider only render it).
// Driven by a fake SID core and a fake GME core -- no wasm, no HVSC fetch.
//
// What is being pinned:
//   * the scoping terms: a known loop band, a non-indefinite player, no listed
//     length, and a position inside the first pass all mean "not blind"
//   * the paused term: a paused song is still in its indefinite loop, so the
//     UI must keep its label and elapsed time while paused -- but a player the
//     engine reports ended must still drop it, which is what the isPlaying()
//     term is actually for
//   * the live path: SIDPlayer parked past its listed length under Repeat One,
//     through pause(), a parameter change while paused, resume(), a repeat-off
//     toggle, and a seek back into the first pass
// Run: node dev/test-blind-loop.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
let idleQueue = [];
global.requestIdleCallback = (fn) => { idleQueue.push(fn); return idleQueue.length; };
global.cancelIdleCallback = (id) => { idleQueue[id - 1] = null; };
global.window.requestIdleCallback = global.requestIdleCallback;
global.window.cancelIdleCallback = global.cancelIdleCallback;
Module._extensions['.png'] = (module) => { module.exports = ''; };
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (filename.startsWith(ROOT) && !filename.includes('node_modules') && /\.jsx?$/.test(filename)) {
    const { code } = babel.transformSync(content, {
      filename,
      configFile: false,
      // preset-react: SIDPlayer's param label is JSX (the repeat icon).
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        ['@babel/preset-react', { runtime: 'classic' }],
      ],
    });
    content = code;
  }
  return originalCompile.call(this, content, filename);
};

// SIDPlayer fetches HVSC lengths over HTTP; 404 keeps the test offline and
// leaves the default lengths in place (the listed length is set per test).
const redaxios = require('redaxios');
redaxios.get = () => Promise.resolve({ status: 404, data: {} });

const Player = require('../src/players/Player').default;
const SIDPlayer = require('../src/players/SIDPlayer').default;
const GMEPlayer = require('../src/players/GMEPlayer').default;

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 1024;
const STEP_MS = BUFFER_SIZE / SAMPLE_RATE * 1000;
const SID_LENGTH_MS = 60000;

let nextPtr = 4096;

// --- the bare predicate -----------------------------------------------------
// The base class is engine-neutral: isBlindLoop() only asks these five
// questions. Constructed without Player's constructor so no core is needed.
class BarePlayer extends Player {}
function bare({ indefinite = true, band = null, durationMs = 60000,
               positionMs = 0, playing = true, paused = false } = {}) {
  const p = Object.create(BarePlayer.prototype);
  p.paused = paused;
  p.isPlayingIndefinitely = () => indefinite;
  p.getLoopBandMs = () => band;
  p.getDurationMs = () => durationMs;
  p.getPositionMs = () => positionMs;
  // Every engine spells this the same way in effect: a paused player is not
  // playing (GMEPlayer: !isPaused() && !track_ended; SIDPlayer: !isPaused()).
  p.isPlaying = () => playing && !p.paused;
  return p;
}

// --- a fake SID core --------------------------------------------------------
function makeSidCore() {
  const heap = new ArrayBuffer(1 << 20);
  const state = {
    positionMs: 0,
    numSongs: 1,
    currentSubtune: 0,
    stopped: 0,
  };
  const core = {
    HEAPU8: new Uint8Array(heap),
    HEAPF32: new Float32Array(heap),
    UTF8ToString: () => 8,
    copyToHeap: () => nextPtr + 64,
    getValue: () => 0,
    _malloc: (n) => { const p = nextPtr; nextPtr += n * 4 + 64; return p; },
    _free: () => {},
    _sid_init: () => 0,
    _sid_load_data: () => 0,
    _sid_get_song_md5: () => 8,
    _sid_set_voice_mask: () => 0,
    _sid_set_speed: () => 0,
    _sid_get_speed: () => 1,
    _sid_get_num_subtunes: () => state.numSongs,
    _sid_get_subtune: () => state.currentSubtune,
    _sid_get_duration_ms: () => 0,
    _sid_set_subtune: (n) => { state.currentSubtune = n; state.positionMs = 0; },
    _sid_stop: () => { state.stopped++; return 0; },
    sidGetVoiceGroups: () => ({ size: () => 0, get: () => 0 }),
    // The engine clock is the position: parked at another value next buffer.
    _sid_get_position_ms: () => Math.round(state.positionMs),
    _sid_set_position_ms: (ms) => { state.positionMs = ms; return 0; },
    _sid_render: () => 0,
  };
  core.state = state;
  return core;
}

async function makeSidPlayer({ positionMs = 0, listedMs = SID_LENGTH_MS } = {}) {
  const core = makeSidCore();
  const p = new SIDPlayer(core, SAMPLE_RATE, BUFFER_SIZE);
  await p.loadData(new Uint8Array([1, 2, 3, 4]), 'test.sid', {});
  p.subtuneDurations = [listedMs];
  core.state.positionMs = positionMs;
  return { p, core };
}

// --- a fake GME core --------------------------------------------------------
// A one-shot track with a real loop region, and one with none (the catalog's
// common case: the driver loops internally).
const GME_WITH_REGION = {
  length: 120000, intro_length: 20000, loop_length: 50000, play_length: 120000,
  system: 'Sega Genesis', game: 'Test', title: 'Region', artist: '',
  copyright: '', comment: '',
};
const GME_NO_REGION = {
  length: 60000, intro_length: -1, loop_length: -1, play_length: 60000,
  system: 'Nintendo Entertainment System', game: 'Test', title: 'No Region',
  artist: '', copyright: '', comment: '',
};

function makeGmeCore({ tracks = [GME_NO_REGION] } = {}) {
  // A flat address space: the player reads a gme_info_t through getValue().
  const mem = new Map();
  const state = { positionMs: 0, trackEnded: false, fades: [] };
  const core = {
    HEAPU8: { set: () => {} },
    UTF8ToString: () => '',
    getValue: (ptr) => mem.get(ptr) || 0,
    _malloc: (n) => { const p = nextPtr; nextPtr += Math.max(n, 4) * 4 + 64; return p; },
    _free: () => {},
    _gme_open_data: (dataPtr, len, emuPtr) => { mem.set(emuPtr, 1); return 0; },
    _gme_delete: () => {},
    _gme_track_count: () => tracks.length,
    _gme_voice_count: () => 2,
    _gme_voice_name: () => 8,
    _gme_start_track: () => { state.positionMs = 0; state.trackEnded = false; return 0; },
    _gme_set_fade: (ctx, samples) => state.fades.push(samples),
    _gme_set_tempo: () => 0,
    _gme_ignore_silence: () => 0,
    _gme_mute_voices: () => 0,
    _gme_set_stereo_depth: () => 0,
    _gme_disable_echo: () => 0,
    _gme_enable_accuracy: () => 0,
    _gme_tell_scaled: () => Math.round(state.positionMs),
    _gme_seek_scaled: (ctx, ms) => { state.positionMs = ms; },
    _gme_play: () => { state.positionMs += STEP_MS; return 0; },
    _gme_track_ended: () => (state.trackEnded ? 1 : 0),
    _gme_track_info: (ctx, metadataPtr, track) => {
      const info = tracks[track] || tracks[0];
      const ref = nextPtr; nextPtr += 256;
      mem.set(metadataPtr, ref);
      // gme_info_t: length, intro_length, loop_length, play_length, then unused
      // bytes, then the six strings as char pointers.
      mem.set(ref + 0, info.length);
      mem.set(ref + 4, info.intro_length);
      mem.set(ref + 8, info.loop_length);
      mem.set(ref + 12, info.play_length);
      let off = 64;
      for (const s of [info.system, info.game, info.title, info.artist,
        info.copyright, info.comment]) {
        const p = nextPtr; nextPtr += (s ? s.length : 0) + 2;
        for (let i = 0; s && i < s.length; i++) mem.set(p + i, s.charCodeAt(i));
        mem.set(p + (s ? s.length : 0), 0);
        mem.set(ref + off, p);
        off += 4;
      }
      return 0;
    },
  };
  core.state = state;
  return core;
}

async function makeGmePlayer(coreOpts) {
  const core = makeGmeCore(coreOpts);
  const p = new GMEPlayer(core, SAMPLE_RATE, BUFFER_SIZE);
  await p.loadData(new Uint8Array([0x4e, 0x45, 0x53, 0x4d]), 'test.nsf', {});
  return { p, core };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n')}`);
    process.exitCode = 1;
  }
}

async function main() {
  // --- the bare predicate ---------------------------------------------------
  await check('base: an indefinite track parked past its length is a blind loop', async () => {
    assert.strictEqual(bare({ positionMs: 61000 }).isBlindLoop(), true);
  });

  await check('base: pausing keeps the blind loop (still looping, just held)', async () => {
    assert.strictEqual(bare({ positionMs: 61000, paused: true }).isBlindLoop(), true);
  });

  await check('base: a paused song inside its first pass is not blind', async () => {
    assert.strictEqual(bare({ positionMs: 30000, paused: true }).isBlindLoop(), false);
  });

  await check('base: no listed length is never a blind loop', async () => {
    assert.strictEqual(bare({ durationMs: 0, positionMs: 61000, paused: true }).isBlindLoop(), false);
  });

  await check('base: a known loop band is never a blind loop, paused or not', async () => {
    const band = { startMs: 70000, endMs: 120000 };
    assert.strictEqual(bare({ band, positionMs: 130000 }).isBlindLoop(), false);
    assert.strictEqual(bare({ band, positionMs: 130000, paused: true }).isBlindLoop(), false);
  });

  await check('base: repeat off ends the blind loop', async () => {
    assert.strictEqual(bare({ indefinite: false, positionMs: 61000, paused: true }).isBlindLoop(), false);
  });

  await check('base: a player that is not playing and not paused drops it', async () => {
    // The ended/stopped case the isPlaying() term is for. Pausing must not be
    // conflated with it.
    assert.strictEqual(bare({ positionMs: 61000, playing: false }).isBlindLoop(), false);
  });

  await check('base: the boundary (position == length) is blind, paused or not', async () => {
    assert.strictEqual(bare({ positionMs: 60000 }).isBlindLoop(), true);
    assert.strictEqual(bare({ positionMs: 60000, paused: true }).isBlindLoop(), true);
  });

  // --- SID (the reported case) ---------------------------------------------
  await check('sid: parked past the listed length under Repeat One is a blind loop', async () => {
    const { p } = await makeSidPlayer({ positionMs: SID_LENGTH_MS + 1000 });
    p.setLooping(true);
    assert.strictEqual(p.isBlindLoop(), true);
  });

  await check('sid: pausing keeps the blind loop', async () => {
    const { p } = await makeSidPlayer({ positionMs: SID_LENGTH_MS + 1000 });
    p.setLooping(true);
    p.togglePause();
    assert.strictEqual(p.isPaused(), true);
    assert.strictEqual(p.isBlindLoop(), true);
  });

  await check('sid: a parameter change while paused keeps the blind loop', async () => {
    const { p } = await makeSidPlayer({ positionMs: SID_LENGTH_MS + 1000 });
    p.setLooping(true);
    p.togglePause();
    // The footer re-reads the predicate on any prop update while paused, which
    // a settings change triggers. App.js mirrors it into the shown length.
    const shownBefore = p.isBlindLoop() ? Infinity : SID_LENGTH_MS;
    p.setParameter('detectSongEnd', false);
    const shownAfter = p.isBlindLoop() ? Infinity : SID_LENGTH_MS;
    assert.strictEqual(shownBefore, Infinity);
    assert.strictEqual(shownAfter, Infinity);
  });

  await check('sid: resuming keeps the blind loop', async () => {
    const { p } = await makeSidPlayer({ positionMs: SID_LENGTH_MS + 1000 });
    p.setLooping(true);
    p.togglePause();
    p.togglePause();
    assert.strictEqual(p.isPaused(), false);
    assert.strictEqual(p.isBlindLoop(), true);
  });

  await check('sid: repeat off while paused drops the blind loop', async () => {
    const { p } = await makeSidPlayer({ positionMs: SID_LENGTH_MS + 1000 });
    p.setLooping(true);
    p.togglePause();
    p.setLooping(false);
    assert.strictEqual(p.isBlindLoop(), false);
  });

  await check('sid: a seek back into the first pass drops the blind loop', async () => {
    const { p, core } = await makeSidPlayer({ positionMs: SID_LENGTH_MS + 1000 });
    p.setLooping(true);
    p.togglePause();
    core.state.positionMs = 0;
    assert.strictEqual(p.isBlindLoop(), false);
  });

  await check('sid: a tune with a known region is never a blind loop', async () => {
    const { p } = await makeSidPlayer({ positionMs: SID_LENGTH_MS + 1000 });
    p.setLooping(true);
    p.metadata = { intro_length: 5000, loop_length: 30000 };
    assert.strictEqual(p.getLoopBandMs() !== null, true, 'the fake region resolves');
    assert.strictEqual(p.isBlindLoop(), false);
  });

  await check('sid: before the listed length it is not a blind loop', async () => {
    const { p } = await makeSidPlayer({ positionMs: SID_LENGTH_MS - 1000 });
    p.setLooping(true);
    assert.strictEqual(p.isBlindLoop(), false);
  });

  // --- GME (the Indefinite Playback setting, not Repeat One) ----------------
  await check('gme: the indefinite setting past the play length is a blind loop', async () => {
    const { p, core } = await makeGmePlayer();
    p.setParameter('indefinitePlayback', true);
    core.state.positionMs = 61000;
    assert.strictEqual(p.isBlindLoop(), true);
  });

  await check('gme: pausing keeps the blind loop', async () => {
    const { p, core } = await makeGmePlayer();
    p.setParameter('indefinitePlayback', true);
    core.state.positionMs = 61000;
    p.togglePause();
    assert.strictEqual(p.isBlindLoop(), true);
  });

  await check('gme: turning the setting off while paused drops the blind loop', async () => {
    const { p, core } = await makeGmePlayer();
    p.setParameter('indefinitePlayback', true);
    core.state.positionMs = 61000;
    p.togglePause();
    p.setParameter('indefinitePlayback', false);
    assert.strictEqual(p.isBlindLoop(), false);
  });

  await check('gme: a track the engine reports ended drops the blind loop', async () => {
    const { p, core } = await makeGmePlayer();
    p.setParameter('indefinitePlayback', true);
    core.state.positionMs = 61000;
    core.state.trackEnded = true;
    assert.strictEqual(p.isPlaying(), false);
    assert.strictEqual(p.isBlindLoop(), false);
  });

  await check('gme: a reported loop region is never a blind loop', async () => {
    const { p, core } = await makeGmePlayer({ tracks: [GME_WITH_REGION] });
    p.setParameter('indefinitePlayback', true);
    core.state.positionMs = 130000;
    assert.strictEqual(p.getLoopBandMs() !== null, true, 'the fake region resolves');
    assert.strictEqual(p.isBlindLoop(), false);
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}.`);
}

main();
