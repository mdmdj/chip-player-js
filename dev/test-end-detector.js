#!/usr/bin/env node
// DEV-ONLY SID/N64 tail-end detector check: the Repeat One tail restart that
// stands in for a native loop API on engines that have none, driven by fake
// cores with scripted audio levels (no wasm, no HVSC fetch).
//
// What is being pinned:
//   * the position gate: the per-buffer tap only runs once the trip window
//     opens one window before the listed length, so quiet intros and mid-song
//     breakdowns can never trip it
//   * the level+stillness rule: a full window of per-second means, all below
//     END_QUIET_MEAN and within END_STATIC_RANGE of each other
//   * the documented gap: with no listed length (no HVSC entry, no time/fade
//     tag) the trip gate collapses to 0 and the detector runs from frame 0
// Run: node dev/test-end-detector.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
// N64Player seeks in idle callbacks (the incremental-seek fix) and Player
// probes requestIdleCallback at module level; Node has neither.
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
// leaves the default lengths in place (which is the case under test anyway).
const redaxios = require('redaxios');
redaxios.get = () => Promise.resolve({ status: 404, data: {} });

const SIDPlayer = require('../src/players/SIDPlayer').default;
const N64Player = require('../src/players/N64Player').default;

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 1024;
const STEP_MS = BUFFER_SIZE / SAMPLE_RATE * 1000;
// Tuned constants, restated here so a change in the player shows up as a
// failing test rather than silently retuning the detector.
const WINDOW_SEC = 6;
const QUIET_MEAN = 0.004;
const STATIC_RANGE = 0.001;
// Probed levels (AGENTS.md): music bodies sit far above the gate; ending tails
// are orders of magnitude below it.
const MUSIC_LEVEL = 0.05;
const TAIL_LEVEL = 0.00005;
// A quiet-but-alive passage: quiet enough to pass the level gate, but not
// still (its per-second means move), so it must never trip the detector.
const BREATHING_LEVEL = 0.0005;

let nextPtr = 4096;
function makeCore({ positionMs = 0, numSongs = 1 } = {}) {
  const heap = new ArrayBuffer(1 << 20);
  const state = {
    core: null,
    positionMs,
    numSongs,
    renders: 0,
    level: MUSIC_LEVEL,
    levelPattern: null,  // [level, frames] pairs, cycled
    subTunesSet: [],
    currentSubtune: 0,
    finished: false,
  };
  void positionMs;
  const core = {
    HEAPU8: new Uint8Array(heap),
    HEAPF32: new Float32Array(heap),
    UTF8ToString: () => 8,
    _malloc: (n) => { const p = nextPtr; nextPtr += n * 4 + 64; return p; },
    _free: () => {},
    copyToHeap: () => 4096 + 64,
    getValue: () => 0,
    _sid_init: () => 0,
    _sid_load_data: () => 0,
    _sid_get_song_md5: () => 8,
    _sid_set_voice_mask: () => 0,
    _sid_get_num_subtunes: () => numSongs,
    _sid_get_subtune: () => state.currentSubtune,
    _sid_set_speed: () => 0,
    _sid_get_speed: () => 1,
    _sid_set_voice_group_mask: () => 0,
    _sid_stop: () => { state.stopped = true; return 0; },
    // sidGetVoiceGroups returns an embind std::vector; vectorToArray wants it.
    sidGetVoiceGroups: () => ({ size: () => 0, get: () => 0 }),
    _sid_get_position_ms: () => Math.round(state.positionMs),
    _sid_set_subtune: (n) => {
      state.subTunesSet.push(n);
      state.currentSubtune = n;
      state.positionMs = 0;
    },
    _sid_render: (bufL, bufR, count) => {
      const level = state.level;
      const viewL = new Float32Array(heap, bufL, count);
      const viewR = new Float32Array(heap, bufR, count);
      viewL.fill(level);
      viewR.fill(level);
      state.positionMs += STEP_MS;
      state.renders++;
      if (state.finished) return 0;
      return count;
    },
  };
  core.state = state;
  return core;
}

// One second of audio at a given mean-abs level. run() reads the second entry
// as seconds and converts with STEP_MS.
const second = (level) => [level, 1];

async function makePlayer(coreOpts, durationMs = 0) {
  const core = makeCore(coreOpts);
  const p = new SIDPlayer(core, SAMPLE_RATE, BUFFER_SIZE);
  await p.loadData(new Uint8Array([1, 2, 3, 4]), 'test.sid', {});
  // 0 leaves the default HVSC length; a number overrides the listed length.
  if (durationMs > 0) p.subtuneDurations = [durationMs];
  return { p, core };
}

// Same script shape for N64 (its detector taps the float channels the player
// writes, so the level has to come through getValue).
function runN64(p, core, script) {
  const ch = () => new Float32Array(BUFFER_SIZE);
  for (const [level, seconds] of script) {
    core.state.level = level;
    const frames = Math.round(seconds * 1000 / STEP_MS);
    for (let i = 0; i < frames; i++) p.processAudio([ch(), ch()]);
  }
}

function run(p, core, script) {
  // Script: [level, seconds] pairs, consumed in order.
  const ch = () => new Float32Array(BUFFER_SIZE);
  for (const [level, seconds] of script) {
    core.state.level = level;
    const frames = Math.round(seconds * 1000 / STEP_MS); // STEP_MS is ms per frame
    for (let i = 0; i < frames; i++) p.processAudio([ch(), ch()]);
  }
}

// N64 shares the detector but taps the converted float channels, and its
// duration comes straight from the length tag -- 0 when the file is untagged,
// which is the case the trip gate gets wrong.
function makeN64Core({ durationMs = 0, level = MUSIC_LEVEL } = {}) {
  const heap = new ArrayBuffer(1 << 20);
  const state = { positionMs: 0, durationMs, level, seeks: [], zeroSeeks: 0, indefinite: null };
  const core = {
    // Every path already "exists": a .miniusf pulls its shared .usflib over
    // HTTP, and the test must stay offline.
    FS: {
      filesystems: { IDBFS: {} },
      mkdirTree: () => {},
      mount: () => {},
      analyzePath: () => ({ exists: true }),
      writeFile: () => {},
      syncfs: (_populate, cb) => cb(null),
    },
    HEAPU8: new Uint8Array(heap),
    HEAPF32: new Float32Array(heap),
    UTF8ToString: () => 8,
    ccall: (name) => (name === 'n64_load_file' ? 0 : 0),
    _malloc: (n) => { const p = nextPtr; nextPtr += n * 4 + 64; return p; },
    _free: () => {},
    getValue: () => Math.round(state.level * 32767),
    _n64_render_audio: () => { state.positionMs += STEP_MS; return BUFFER_SIZE; },
    _n64_get_position_ms: () => Math.round(state.positionMs),
    _n64_get_duration_ms: () => state.durationMs,
    _n64_set_indefinite_playback: (v) => { state.indefinite = !!v; },
    // restartTrack() restarts in-buffer by seeking to zero, so a zero-seek is
    // how a restart shows up on the engine side.
    _n64_seek_ms: (ms) => { state.seeks.push(ms); if (ms === 0) state.zeroSeeks++; state.positionMs = ms; },
    _n64_shutdown: () => {},
  };
  core.state = state;
  return core;
}

async function makeN64Player(coreOpts) {
  const core = makeN64Core(coreOpts);
  const p = new N64Player(core, SAMPLE_RATE, BUFFER_SIZE);
  p.audioNode = { context: { state: 'suspended' } };
  // A .miniusf is metadata + a _lib= reference to its shared .usflib.
  const data = new TextEncoder().encode('name\n\n_lib=game.usflib\n');
  await p.loadData(data, 'test.miniusf', {});
  return { p, core };
}

let passed = 0;
let xfailed = 0;
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

async function xcheck(name, why, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}  <- expected to fail: FIXED, unwrap the xcheck`);
  } catch (e) {
    xfailed++;
    console.log(`  xfail  ${name}\n          ${why}`);
  }
}

async function main() {
  await check('listed length: the trip window opens one window before the end', async () => {
    const { p } = await makePlayer({}, 120000);
    assert.strictEqual(p.getEndDetectTripAtMs(), 120000 - WINDOW_SEC * 1000);
  });

  await check('music never trips the detector, however long it plays', async () => {
    const { p, core } = await makePlayer({}, 30000);
    p.setLooping(true);
    run(p, core, Array(20).fill(second(MUSIC_LEVEL)));
    assert.strictEqual(core.state.subTunesSet.length, 1, 'only the load-time sub-tune');
    assert.strictEqual(p.stopped, false);
  });

  await check('a quiet but alive passage never trips the detector', async () => {
    const { p, core } = await makePlayer({}, 30000);
    p.setLooping(true);
    const script = [];
    for (let i = 0; i < 12; i++) {
      script.push(second(BREATHING_LEVEL * (i % 2 === 0 ? 1 : 0.4)));
    }
    run(p, core, script);
    assert.strictEqual(core.state.subTunesSet.length, 1,
      'the stillness gate must reject a moving-but-quiet passage');
  });

  await check('a quiet static tail inside the trip window restarts the sub-tune', async () => {
    const { p, core } = await makePlayer({ positionMs: 0 }, 20000);
    p.setLooping(true);
    run(p, core, [[MUSIC_LEVEL, 15], ...Array(7).fill(second(TAIL_LEVEL))]);
    assert.strictEqual(core.state.subTunesSet.length, 2, 'one restart');
    assert.deepStrictEqual(core.state.subTunesSet, [0, 0], 'same sub-tune re-run');
  });

  await check('the same tail before the trip window is ignored', async () => {
    const { p, core } = await makePlayer({ positionMs: 0 }, 600000);
    p.setLooping(true);
    run(p, core, [[MUSIC_LEVEL, 2], ...Array(9).fill(second(TAIL_LEVEL))]);
    assert.strictEqual(core.state.subTunesSet.length, 1,
      'a quiet intro far from the listed end must stay gated');
    assert.ok(p.getEndDetectTripAtMs() > 10000, 'gate is still ahead of the position');
  });

  await check('repeat off: no restart, the listed length ends the sub-tune', async () => {
    const { p, core } = await makePlayer({ positionMs: 0 }, 3000);
    p.setLooping(false);
    run(p, core, [[MUSIC_LEVEL, 1], ...Array(8).fill(second(TAIL_LEVEL))]);
    assert.strictEqual(core.state.subTunesSet.length, 1, 'detector is Repeat One only');
    assert.strictEqual(p.stopped, true, 'the listed length ends it instead');
  });

  await check('the detectSongEnd toggle keeps the detector out of the way', async () => {
    const { p, core } = await makePlayer({ positionMs: 0 }, 20000);
    p.setLooping(true);
    p.setParameter('detectSongEnd', false);
    run(p, core, [[MUSIC_LEVEL, 15], ...Array(8).fill(second(TAIL_LEVEL))]);
    assert.strictEqual(core.state.subTunesSet.length, 1, 'toggle off means no tail restart');
    assert.strictEqual(p.stopped, false, 'repeat one keeps it playing');
  });

  await check('a muted voice disables the detector (it cannot hear anything)', async () => {
    const { p, core } = await makePlayer({ positionMs: 0 }, 20000);
    p.setLooping(true);
    p.mask = Array(18).fill(true);
    p.mask[0] = false;
    run(p, core, [[MUSIC_LEVEL, 15], ...Array(8).fill(second(TAIL_LEVEL))]);
    assert.strictEqual(core.state.subTunesSet.length, 1,
      'a muted voice makes any buffer look quiet and static');
  });

  await check('restarting the sub-tune re-arms the detector', async () => {
    const { p, core } = await makePlayer({ positionMs: 0 }, 20000);
    p.setLooping(true);
    run(p, core, [[MUSIC_LEVEL, 15], ...Array(7).fill(second(TAIL_LEVEL))]);
    assert.strictEqual(core.state.subTunesSet.length, 2);
    // playSubtune() resets the window, so the following quiet stretch needs a
    // fresh full window before it can trip again.
    run(p, core, Array(5).fill(second(TAIL_LEVEL)));
    assert.strictEqual(core.state.subTunesSet.length, 2, 'window was reset by the restart');
  });

  await check('untagged N64: the engine substitutes a default length, so the gate stays shut', async () => {
    // The feared case is a trip gate that collapses to 0, which needs
    // durationMs == 0. It cannot happen once a track is loaded:
    // lazyusf2-wrapper.cpp replaces a missing time/length tag with
    // cfg_deflength/cfg_deffade, so an untagged .miniusf still reports a
    // length (verified in-app: sparse00-03 all report 171000, trip gate
    // 165000). n64_get_duration_ms() only returns 0 before initialization.
    const { p, core } = await makeN64Player({ durationMs: 0 });
    // What the wrapper would report with no tag at all:
    const DEFAULT_LENGTH_MS = 180000 - 9000;
    assert.strictEqual(DEFAULT_LENGTH_MS, 171000, 'the observed fallback length');
    core.state.durationMs = DEFAULT_LENGTH_MS;
    p.resetEndDetector();
    assert.strictEqual(p.getEndDetectTripAtMs(), DEFAULT_LENGTH_MS - WINDOW_SEC * 1000,
      'the gate is a full window before the fallback length, not 0');
    p.setLooping(true);
    runN64(p, core, [[MUSIC_LEVEL, 2], ...Array(8).fill(second(TAIL_LEVEL))]);
    assert.strictEqual(core.state.zeroSeeks, 0, 'a mid-song break is not an ending');
    assert.strictEqual(p.stopped, false);
  });

  await check('untagged N64: a quiet static tail still restarts under repeat one', async () => {
    // The gate must not be a blanket off switch: a one-shot whose content has
    // ended still needs its tail restart, since the engine free-runs forever.
    const { p, core } = await makeN64Player({ durationMs: 0 });
    p.setLooping(true);
    runN64(p, core, Array(14).fill(second(TAIL_LEVEL)));
    assert.ok(core.state.zeroSeeks >= 1, 'the tail is detected and the tune re-run');
    assert.ok(core.state.seeks.includes(0), 'restartTrack() seeks back to zero');
  });

  await check('repeat one reaches the N64 engine as indefinite playback', async () => {
    const { p, core } = await makeN64Player({ durationMs: 60000 });
    p.setLooping(false);
    assert.strictEqual(core.state.indefinite, false);
    p.setLooping(true);
    assert.strictEqual(core.state.indefinite, true,
      'OR-ed from repeat one, so looping tracks free-run instead of fading');
    assert.strictEqual(p.isPlayingIndefinitely(), true);
  });

  console.log(`\n${passed} checks passed${xfailed ? `, ${xfailed} known failure(s)` : ''}${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
}

main();