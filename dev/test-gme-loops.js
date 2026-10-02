#!/usr/bin/env node
// DEV-ONLY GME check: Repeat One for the NSF/NSFE/SPC/GBS/AY family, driven by
// a fake core (no wasm, no real NSF bytes needed).
//
// GME has no loop API, so Repeat One is implemented in the player: skip the JS
// fade, and when the engine reports the track ended, restart the *track* in
// buffer (no refetch, no gap). Tracks whose driver loops internally never
// report "ended", so nothing restarts and the loop stays seamless. That is the
// whole contract, plus the sub-song surface (GME carries multi-song NSF/NSFE).
// Run: node dev/test-gme-loops.js
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
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        ['@babel/preset-react', { runtime: 'classic' }],
      ],
    });
    content = code;
  }
  return originalCompile.call(this, content, filename);
};

const GMEPlayer = require('../src/players/GMEPlayer').default;

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 256;
const STEP_MS = BUFFER_SIZE / SAMPLE_RATE * 1000;
// GMEPlayer's JS fade (fadeDurationMs) runs when a non-repeating track reaches
// its play length; it is GME's own constant, restated here.
const FADE_MS = 5000;

// A one-song track with no loop region (the common case in this catalog: the
// driver loops internally and never reports "ended").
const ONE_SONG = {
  length: 60000, intro_length: 0, loop_length: 0, play_length: 60000,
  system: 'Nintendo Entertainment System', game: 'Test', title: 'One Song',
  artist: 'Someone', copyright: '1989', comment: '',
};
// A one-shot track that really does end, with a loop region.
const ONE_SHOT = {
  length: 120000, intro_length: 20000, loop_length: 50000, play_length: 120000,
  system: 'Sega Genesis', game: 'Test', title: 'One Shot', artist: '',
  copyright: '', comment: '',
};

function makeCore({ tracks = [ONE_SONG] } = {}) {
  // A flat address space: the player reads a gme_info_t through getValue().
  const mem = new Map();
  let nextPtr = 1024;
  const state = {
    positionMs: 0,
    trackEnded: false,       // the engine's "this track is done" flag
    loopsInternally: true,   // driver loops: never reports ended
    startTracks: [],         // every _gme_start_track call
    fades: [],
    plays: 0,
    muted: [],
    seeks: [],
    tempo: 1,
  };
  const core = {
    state,
    HEAPU8: { set: () => {} },
    UTF8ToString: () => '',
    _malloc: (n) => { const p = nextPtr; nextPtr += Math.max(n, 4) * 4 + 64; return p; },
    _free: () => {},
    getValue: (ptr) => mem.get(ptr) || 0,
    _gme_open_data: (dataPtr, len, emuPtr) => { mem.set(emuPtr, 1); return 0; },
    _gme_delete: () => {},
    _gme_track_count: () => tracks.length,
    _gme_voice_count: () => 2,
    _gme_voice_name: () => 8,
    _gme_start_track: (ctx, track) => {
      state.startTracks.push(track);
      state.positionMs = 0;
      state.trackEnded = false;
      return 0;
    },
    _gme_set_fade: (ctx, samples) => state.fades.push(samples),
    _gme_set_tempo: (ctx, tempo) => { state.tempo = tempo; return 0; },
    _gme_ignore_silence: () => 0,
    _gme_mute_voices: (ctx, bitmask) => { state.muted.push(bitmask); return 0; },
    _gme_set_stereo_depth: () => 0,
    _gme_disable_echo: () => 0,
    _gme_enable_accuracy: () => 0,
    _gme_tell_scaled: () => Math.round(state.positionMs),
    _gme_seek_scaled: (ctx, ms) => { state.seeks.push(ms); state.positionMs = ms; },
    _gme_play: () => { state.positionMs += STEP_MS; state.plays++; return 0; },
    _gme_track_ended: () => (state.loopsInternally ? 0 : (state.trackEnded ? 1 : 0)),
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
  return core;
}

async function makePlayer(coreOpts) {
  const core = makeCore(coreOpts);
  const p = new GMEPlayer(core, SAMPLE_RATE, BUFFER_SIZE);
  await p.loadData(new Uint8Array([0x4e, 0x45, 0x53, 0x4d]), 'test.nsf', {});
  return { p, core };
}

// Render until the engine's position reaches `targetMs`, or the song ends.
function drive(p, core, targetMs) {
  const ch = () => new Float32Array(BUFFER_SIZE);
  let frames = 0;
  while (core.state.positionMs < targetMs && !p.stopped && frames++ < 200000) {
    p.processAudio([ch(), ch()]);
  }
}

function setEndsAt(core, ms) {
  // The engine reports "ended" once the track has played past its content.
  core.state.loopsInternally = false;
  const originalPlay = core._gme_play;
  core._gme_play = () => {
    originalPlay();
    if (core.state.positionMs >= ms) core.state.trackEnded = true;
  };
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
  await check('a track that loops internally is never restarted', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    drive(p, core, 200000);
    assert.strictEqual(core.state.startTracks.length, 1, 'only the load-time start');
    assert.strictEqual(p.stopped, false);
    assert.ok(core.state.positionMs > 200000, 'the position keeps climbing');
  });

  await check('a one-shot track restarts in buffer when it ends under repeat one', async () => {
    const { p, core } = await makePlayer({ tracks: [ONE_SHOT] });
    setEndsAt(core, 1000);
    p.setLooping(true);
    drive(p, core, 3000);
    assert.ok(core.state.startTracks.length >= 2,
      `the track is re-run (starts: ${core.state.startTracks.length})`);
    assert.deepStrictEqual([...new Set(core.state.startTracks)], [0],
      'the same sub-song is re-run');
    assert.strictEqual(p.stopped, false, 'the song never ends under repeat one');
    // The restart must not leave a fade behind that would cut the next pass.
    assert.ok(core.state.fades.every(f => f === 200000000),
      'gme_set_fade is pushed far out again after every start');
  });

  await check('the restart is in buffer: no refetch, no position jump backwards', async () => {
    const { p, core } = await makePlayer({ tracks: [ONE_SHOT] });
    setEndsAt(core, 1000);
    p.setLooping(true);
    drive(p, core, 2000);
    const before = core.state.positionMs;
    // The engine reset to 0 when it re-ran the track; that is the restart
    // itself, not a seek issued by the player.
    assert.deepStrictEqual(core.state.seeks, [], 'the player never seeks to restart');
    assert.ok(before < 3000, 'the clock restarted with the track');
  });

  await check('repeat off: the JS fade runs and the song ends', async () => {
    const { p, core } = await makePlayer({ tracks: [ONE_SHOT] });
    p.setLooping(false);
    drive(p, core, ONE_SHOT.play_length + FADE_MS + STEP_MS * 8);
    assert.strictEqual(p.stopped, true, 'the track ended through the JS fade');
    assert.ok(core.state.startTracks.length === 1, 'no restart without repeat one');
  });

  await check('toggling repeat mid-song clears a fade in progress', async () => {
    const { p, core } = await makePlayer({ tracks: [ONE_SHOT] });
    p.setLooping(false);
    drive(p, core, ONE_SHOT.play_length + 50);
    assert.strictEqual(p.fadingOut, true, 'the fade started at the track length');
    p.setLooping(true);
    assert.strictEqual(p.fadingOut, false, 'the fade is abandoned');
    assert.strictEqual(p.fadeFinished, false);
    assert.strictEqual(p.isPlayingIndefinitely(), true);
  });

  await check('a track with a loop region folds the head into the band', async () => {
    const { p, core } = await makePlayer({ tracks: [ONE_SHOT] });
    setEndsAt(core, 100000);
    p.setLooping(true);
    const band = p.getLoopBandMs();
    assert.deepStrictEqual(band, { startMs: 70000, endMs: 120000 },
      'intro + two passes, clamped to the track length');
    core.state.positionMs = band.startMs + 1000;
    assert.strictEqual(p.getDisplayPositionMs(), band.startMs + 1000, 'inside the band');
    const loopLength = band.endMs - band.startMs;
    core.state.positionMs = band.endMs + 1000;
    assert.strictEqual(p.getDisplayPositionMs(), band.startMs + (1000 % loopLength),
      'wraps at the band end');
  });

  await check('a track with no loop region shows the real position (blind loop)', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    assert.strictEqual(p.getLoopBandMs(), null, 'no region to show');
    core.state.positionMs = 12345;
    assert.strictEqual(p.getDisplayPositionMs(), 12345, 'the head runs on');
  });

  await check('sub-songs are selectable and each has its own metadata', async () => {
    const tracks = [ONE_SONG, { ...ONE_SONG, title: 'Second Sub-Song', play_length: 30000 }];
    const { p, core } = await makePlayer({ tracks });
    assert.strictEqual(p.getNumSubtunes(), 2);
    assert.strictEqual(p.getSubtune(), 0);
    p.playSubtune(1);
    assert.strictEqual(p.getSubtune(), 1);
    assert.strictEqual(p.metadata.title, 'Second Sub-Song');
    assert.strictEqual(p.getDurationMs(), 30000, 'duration follows the sub-song');
    assert.deepStrictEqual(core.state.startTracks, [0, 1], 'each selection starts that track');
  });

  await check('playSubtune resets fade state from a faded-out song', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(false);
    drive(p, core, ONE_SONG.play_length + 50);
    assert.strictEqual(p.fadingOut, true);
    p.playSubtune(0);
    assert.strictEqual(p.fadingOut, false, 'the new sub-song is not born fading');
    assert.strictEqual(p.fadeStartMs, null);
    assert.strictEqual(p.fadeFinished, false);
  });

  await check('a partial voice mask reaches the engine (GME keeps no silence state)', async () => {
    // Deliberate asymmetry with SIDPlayer, which resets its tail detector on a
    // partial mask: GME's end is the JS fade, and under repeat one there is no
    // fade at all, so muting changes nothing about song end. Asserted so the
    // difference is recorded rather than rediscovered.
    const { p, core } = await makePlayer();
    p.setLooping(false);
    p.setVoiceMask([true, false]);
    assert.ok(core.state.muted.length > 0, 'the mask reaches the engine');
    assert.deepStrictEqual(p.getVoiceMask(), [true, false]);
    p.setLooping(true);
    drive(p, core, ONE_SONG.play_length + 1000);
    assert.strictEqual(p.stopped, false, 'a muted voice cannot end a repeating song');
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
}

main();
