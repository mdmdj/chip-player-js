#!/usr/bin/env node
// DEV-ONLY SID load/seek check. A ?t= share link seeks ~100ms after the song is
// started, but SIDPlayer.loadData waits up to METADATA_TIMEOUT_MS for HVSC
// metadata and then re-selects the sub-tune, which reloads the tune and resets
// the engine's position. A seek landing in that window must not go to the core
// early -- the fork's seek blocks until its own clock advances, and there is no
// render yet -- and must still be applied once the song is playing.
// Fake core, no wasm. Run: node dev/test-sid-load.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (filename.startsWith(ROOT) && !filename.includes('node_modules') && /\.jsx?$/.test(filename)) {
    const { code } = babel.transformSync(content, {
      filename,
      configFile: false,
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        // SIDPlayer's param defs carry JSX (the detectSongEnd label).
        ['@babel/preset-react', { runtime: 'automatic' }],
      ],
    });
    content = code;
  }
  return originalCompile.call(this, content, filename);
};

const SIDPlayer = require('../src/players/SIDPlayer').default;

let passed = 0;
function check(name, fn) {
  return fn().then(
    () => { passed++; console.log(`  ok  ${name}`); },
    (e) => {
      console.error(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n')}`);
      process.exitCode = 1;
    });
}

// Records every call in order, so the *sequence* is what the checks read.
function makeCore(calls) {
  return {
    HEAPU8: new Uint8Array(1 << 16),
    HEAPF32: new Float32Array(1 << 12),
    _malloc: () => 1024,
    _free: () => {},
    UTF8ToString: () => '0123456789abcdef0123456789abcdef',
    _sid_init: () => calls.push('init'),
    _sid_load_data: () => { calls.push('load-data'); return 0; },
    _sid_get_song_md5: () => 16,
    _sid_get_num_subtunes: () => 3,
    _sid_set_voice_mask: () => calls.push('voice-mask'),
    _sid_set_subtune: (n) => calls.push(`subtune:${n}`),
    _sid_set_position_ms: (ms) => calls.push(`seek:${ms}`),
    _sid_get_position_ms: () => 0,
    _sid_get_subtune: () => 0,
    _sid_set_speed: () => {},
    _sid_render: () => 0,
  };
}

check('a seek during the metadata wait is applied after the load, not lost', async () => {  const calls = [];
  const p = new SIDPlayer(makeCore(calls), 44100, 64);
  p.audioNode = { context: { state: 'suspended' } }; // muteAudioDuringCall runs fn synchronously
  p.processAudioInner = () => {};                    // the contract is the call order, not the render
  p.getVoiceGroups = () => [];                       // no core vector to walk in a fake
  let deliverMetadata;
  p.getSidMetadata = () => new Promise((resolve) => { deliverMetadata = resolve; });

  const loading = p.loadData(new Uint8Array([1, 2, 3, 4]), 'test.sid', {}, 0);
  await Promise.resolve();                           // let loadData reach the metadata await
  p.seekMs(30000);                                   // what App's ?t= timer does at +100ms
  assert.strictEqual(calls.filter(c => c.startsWith('seek:')).length, 0,
    'no seek reaches the core before the first render');
  deliverMetadata();
  await loading;
  p.processAudio([new Float32Array(64), new Float32Array(64)]); // first rendered block
  const seeks = calls.filter(c => c.startsWith('seek:'));
  assert.deepStrictEqual(seeks, ['seek:30000'],
    `the seek is applied once, after the load (calls: ${calls.join(' ')})`);
  assert.ok(calls.indexOf('seek:30000') > calls.lastIndexOf('subtune:0'),
    `and after the sub-tune re-select that would otherwise reset it (calls: ${calls.join(' ')})`);
}).then(() => {
  console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
});
