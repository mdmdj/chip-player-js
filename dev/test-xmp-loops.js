#!/usr/bin/env node
// DEV-ONLY XMP loop check: native loop-count lever + learned loop band,
// driven by a fake core with scripted frame streams (no wasm needed).
// Run: node dev/test-xmp-loops.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
// Player.js shims window.requestIdleCallback at module level.
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

const XMPPlayer = require('../src/players/XMPPlayer').default;

// Frame-info field indices (libxmp xmp_frame_info, also asserted in-code).
const FI_POS = 0, FI_TIME = 7, FI_TOTAL = 8, FI_LOOP_COUNT = 14;

function makeCore() {
  const heap = new Map();
  let nextPtr = 4096;
  const core = {
    heap,
    lastLoopArg: null,
    _xmp_create_context: () => 1,
    _malloc: (n) => { const p = nextPtr; nextPtr += n + 16; return p; },
    _free: () => {},
    HEAPU8: { set: () => {} },
    UTF8ToString: () => '',
    getValue: (ptr) => heap.get(ptr) || 0,
    _xmp_load_module_from_memory: () => 0,
    _xmp_start_player: () => 0,
    _xmp_get_module_info: () => 0,
    _xmp_get_frame_info: () => 0,
    _xmp_play_buffer: (ctx, buf, size, loop) => { core.lastLoopArg = loop; return 0; },
    _xmp_stop_module: () => 0,
    _xmp_set_player: () => 0,
    _xmp_set_tempo_factor: () => 0,
    _xmp_get_player: () => 0,
    _xmp_seek_time: () => 0,
  };
  return core;
}

function makePlayer(totalMs) {
  const core = makeCore();
  const p = new XMPPlayer(core, 44100, 64);
  core.heap.set(p.infoPtr + FI_TOTAL * 4, totalMs);
  p.loadData(new Uint8Array([1, 2, 3, 4]), 'test.mod', {});
  return { p, core };
}

// One processAudioInner per {pos, time} frame.
function drive(player, core, frames) {
  const ch = () => new Float32Array(64);
  for (const f of frames) {
    core.heap.set(player.infoPtr + FI_POS * 4, f.pos);
    core.heap.set(player.infoPtr + FI_TIME * 4, f.time);
    if (f.loop != null) core.heap.set(player.infoPtr + FI_LOOP_COUNT * 4, f.loop);
    player.processAudioInner([ch(), ch()]);
  }
}

const orders = (list, msPerOrder) => list.map((pos, i) => ({ pos, time: i * msPerOrder }));

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

check('TECHTRIS-like stream learns [8000, 96000) at the 11->1 jump', () => {
  const { p } = makePlayer(96000);
  assert.strictEqual(p.getLoopBandMs(), null);
  let emits = 0;
  p.on('playerStateUpdate', (s) => { if (!s.isStopped) emits++; });
  drive(p, p.core, orders([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2, 3], 8000));
  assert.strictEqual(p.metadata.intro_length, 8000);
  assert.strictEqual(p.metadata.loop_length, 88000);
  assert.deepStrictEqual(p.getLoopBandMs(), { startMs: 8000, endMs: 96000 });
  assert.strictEqual(emits, 1);
});

check('straight file never learns a band', () => {
  const { p } = makePlayer(96000);
  drive(p, p.core, orders([0, 1, 2, 3, 4, 5], 8000));
  assert.strictEqual(p.metadata.intro_length, undefined);
  assert.strictEqual(p.getLoopBandMs(), null);
});

check('forward order skips do not trigger learning', () => {
  const { p } = makePlayer(291840);
  drive(p, p.core, orders([0, 1, 2, 12, 16, 17, 27, 43], 8000));
  assert.strictEqual(p.metadata.intro_length, undefined);
});

check('first backward jump wins (Bgm01-like, skips then 43->10)', () => {
  const { p } = makePlayer(291840);
  drive(p, p.core, orders([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17, 27, 43, 10, 11], 8000));
  // order 10 first seen at frame 10 (t=80000)
  assert.strictEqual(p.metadata.intro_length, 80000);
  assert.strictEqual(p.metadata.loop_length, 291840 - 80000);
  assert.deepStrictEqual(p.getLoopBandMs(), { startMs: 80000, endMs: 291840 });
});

check('seek then natural loop still learns with the pre-seek start time', () => {
  const { p } = makePlayer(96000);
  let emits = 0;
  p.on('playerStateUpdate', (s) => { if (!s.isStopped) emits++; });
  drive(p, p.core, orders([0, 1, 2, 3, 4, 5], 8000));
  p.seekMs(50000);
  drive(p, p.core, orders([6, 7, 8, 9, 10, 11, 1, 2], 8000)
    .map((f, i) => ({ ...f, time: 50000 + i * 8000 })));
  // order 1 was visited pre-seek at t=8000: learning succeeds anyway.
  assert.strictEqual(p.metadata.intro_length, 8000);
  assert.strictEqual(p.metadata.loop_length, 88000);
  assert.strictEqual(emits, 1);
});

check('backward seek landing fakes no band', () => {
  const { p } = makePlayer(200000);
  drive(p, p.core, orders([0, 1, 2, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40], 8000));
  p.seekMs(40000); // lands back on order 5: discontinuity, not a loop
  drive(p, p.core, [{ pos: 5, time: 40000 }, { pos: 5, time: 40800 }, { pos: 6, time: 48000 }]);
  assert.strictEqual(p.metadata.intro_length, undefined);
  assert.strictEqual(p.getLoopBandMs(), null);
});

check('seek-skipped loop start stays unlearned, never corrupt', () => {
  const { p } = makePlayer(200000);
  let emits = 0;
  p.on('playerStateUpdate', (s) => { if (!s.isStopped) emits++; });
  drive(p, p.core, orders([0, 1, 2], 8000));
  p.seekMs(160000); // lands past the loop (target order 8 never visited)
  drive(p, p.core, [{ pos: 20, time: 160000 }, { pos: 21, time: 168000 }, { pos: 22, time: 176000 },
    { pos: 8, time: 184000 }, { pos: 8, time: 184800 }, { pos: 9, time: 192000 }]);
  assert.strictEqual(p.metadata.intro_length, undefined);
  assert.strictEqual(p.getLoopBandMs(), null);
  assert.strictEqual(emits, 0);
});

check('loop from the very start learns nothing (zuma-like, 23->0)', () => {
  const { p } = makePlayer(200000);
  let emits = 0;
  p.on('playerStateUpdate', (s) => { if (!s.isStopped) emits++; });
  drive(p, p.core, orders([0, 1, 2, 3, 23, 0, 1], 8000));
  assert.strictEqual(p.metadata.intro_length, undefined);
  assert.strictEqual(p.getLoopBandMs(), null);
  assert.strictEqual(emits, 0);
});

check('learning runs with repeat off (band ready if repeat engages later)', () => {
  const { p } = makePlayer(96000);
  assert.strictEqual(p.looping, false);
  drive(p, p.core, orders([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1], 8000));
  assert.strictEqual(p.metadata.intro_length, 8000);
});

check('loop count lever: 1 off, 0 on, curLoop+1 leaving deep', () => {
  const { p, core } = makePlayer(96000);
  assert.strictEqual(p._loopCount, 1);
  p.setLooping(true);
  assert.strictEqual(p._loopCount, 0);
  drive(p, core, [{ pos: 0, time: 0 }]);
  assert.strictEqual(core.lastLoopArg, 0);
  core.heap.set(p.infoPtr + FI_LOOP_COUNT * 4, 5);
  p.setLooping(false);
  assert.strictEqual(p._loopCount, 6);
  p.setLooping(false);
  assert.strictEqual(p._loopCount, 1);
  p.setLooping(true);
  assert.strictEqual(p._loopCount, 0);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
