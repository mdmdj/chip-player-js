#!/usr/bin/env node
// DEV-ONLY V2M check: the one engine still on the tier-3 ladder rung -- its own
// end, then stop and reload (no loop points in the format, no loop API in the
// wrapper). Driven by a fake core, since the contract is about *what the player
// does at the end*, not about how V2M renders.
//
// The point of pinning tier 3 is that it is honest and predictable: the song
// ends when the engine says so, the head never lies about a band that does not
// exist, and nothing about Repeat One pretends to be seamless.
// Run: node dev/test-v2m-loops.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
Module._extensions['.png'] = (module) => { module.exports = ''; };
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

const V2MPlayer = require('../src/players/V2MPlayer').default;

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 256;
const STEP_MS = BUFFER_SIZE / SAMPLE_RATE * 1000;
const DURATION_MS = 30000;

function makeCore({ durationMs = DURATION_MS } = {}) {
  const heap = new ArrayBuffer(1 << 18);
  const state = { positionMs: 0, endsAtMs: durationMs, speeds: [], seeks: [], closed: false };
  const core = {
    state,
    HEAPU8: new Uint8Array(heap),
    getValue: () => 0.25,
    _malloc: () => 4096,
    _free: () => {},
    _v2m_open: () => 0,
    _v2m_close: () => { state.closed = true; },
    _v2m_set_speed: (val) => { state.speeds.push(val); return 0; },
    _v2m_get_position_ms: () => Math.round(state.positionMs),
    _v2m_get_duration_ms: () => durationMs,
    _v2m_seek_ms: (ms) => { state.seeks.push(ms); state.positionMs = ms; },
    // The engine reports the end by writing nothing.
    _v2m_write_audio: () => {
      if (state.positionMs >= state.endsAtMs) return 0;
      state.positionMs += STEP_MS;
      return BUFFER_SIZE;
    },
  };
  return core;
}

async function makePlayer(coreOpts) {
  const core = makeCore(coreOpts);
  const p = new V2MPlayer(core, SAMPLE_RATE, BUFFER_SIZE);
  await p.loadData(new Uint8Array([0x56, 0x32, 0x4d, 0x31]), 'test.v2m', {});
  return { p, core };
}

function drive(p, core, targetMs) {
  const ch = () => new Float32Array(BUFFER_SIZE);
  let frames = 0;
  while (core.state.positionMs < targetMs && !p.stopped && frames++ < 200000) {
    p.processAudio([ch(), ch()]);
  }
}

let passed = 0;
// Async on purpose: the checks load a player, and a sync wrapper would let a
// rejection escape and surface *after* the summary (a false pass with a nonzero
// exit).
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
  await check('a V2M file has no loop region, so no band and no late restart', async () => {
    const { p } = await makePlayer();
    assert.strictEqual(p.getLoopBandMs(), null, 'nothing to highlight');
    assert.strictEqual(p.metadata.intro_length, undefined);
    assert.strictEqual(p.metadata.loop_length, undefined);
    p.setLooping(true);
    assert.strictEqual(p.getDisplayPositionMs(), p.getPositionMs(),
      'the head is the real position, never folded');
  });

  await check('the engine end stops the song, repeat one or not', async () => {
    for (const looping of [false, true]) {
      const { p, core } = await makePlayer();
      p.setLooping(looping);
      drive(p, core, DURATION_MS + STEP_MS * 4);
      assert.strictEqual(p.stopped, true, `looping=${looping}: the song ends`);
      assert.strictEqual(core.state.closed, true, 'and the engine is closed');
    }
  });

  await check('Repeat One does not pretend: the base detector stands down, the engine ends it', async () => {
    // Under looping the base end detector is disabled, so what ends the song is
    // the engine reporting zero samples -- not a duration check or a restart.
    const { p, core } = await makePlayer();
    p.setLooping(true);
    assert.strictEqual(p.isPlayingIndefinitely(), true);
    drive(p, core, DURATION_MS - 1000);
    assert.strictEqual(p.stopped, false, 'still playing just before the end');
    assert.strictEqual(p.isPlayingIndefinitely(), true, 'the base detector stays down');
    assert.strictEqual(core.state.seeks.length, 0, 'and nothing was seeked');
  });

  await check('position and duration come from the engine', async () => {
    const { p, core } = await makePlayer({ durationMs: 12345 });
    assert.strictEqual(p.getDurationMs(), 12345);
    drive(p, core, 1000);
    assert.ok(Math.abs(p.getPositionMs() - 1000) < STEP_MS * 3,
      `position tracks the engine (${p.getPositionMs()})`);
  });

  await check('seek goes to the engine and re-arms a stopped song', async () => {
    const { p, core } = await makePlayer();
    drive(p, core, DURATION_MS + STEP_MS * 4);
    assert.strictEqual(p.stopped, true);
    p.seekMs(500);
    assert.deepStrictEqual(core.state.seeks, [500], 'the engine was told');
  });

  await check('tempo reaches the engine', async () => {
    const { p, core } = await makePlayer();
    p.setTempo(1.5);
    assert.strictEqual(p.getTempo(), 1.5);
    assert.ok(core.state.speeds.includes(1.5), '_v2m_set_speed was called');
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
}

main();