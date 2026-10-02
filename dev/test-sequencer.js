#!/usr/bin/env node
// DEV-ONLY sequencer test: sub-tune navigation lives in the sequencer, not the
// player. Uses a fake player so it runs without the chip-core wasm build, with
// a small inline Babel require hook (no new dependencies).
// Run: node dev/test-sequencer.js
'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

// Transform client ES modules/JSX on require.
const ROOT = path.join(__dirname, '..');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  if (filename.startsWith(ROOT) && !filename.includes('node_modules') && /\.jsx?$/.test(filename)) {
    const { code } = babel.transformSync(content, {
      filename,
      configFile: false,
      presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'],
    });
    content = code;
  }
  return originalCompile.call(this, content, filename);
};

const Sequencer = require('../src/Sequencer').default;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// A player that loads instantly and ends the song, simulating a one-shot song.
// It records loads so we can assert the sequencer advances exactly once per
// context entry (i.e. a sub-tune is never replayed).
class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.loads = [];
  }
  canPlay() { return true; }
  setLooping() {}
  suspend() {}
  stop() {
    this.stopped = true;
    this.emit('playerStateUpdate', { isStopped: true });
  }
  getMetadata() { return {}; }
  getDurationMs() { return 1000; }
  getPositionMs() { return 0; }
  getTempo() { return 1; }
  getVoiceMask() { return []; }
  getVoiceNames() { return []; }
  getVoiceGroups() { return []; }
  async loadData(data, filepath, persistedSettings, subtune = 0) {
    this.loads.push(`${filepath}#${subtune}`);
    this.stopped = false;
    this.emit('playerStateUpdate', { isStopped: false, numSubtunes: 1, subtune });
    this.stop();
  }
}

// Same, but the song does not end by itself: lets a test end it at a chosen
// moment. `endNow()` is what the player calls when the engine reports the end.
class ManualPlayer extends FakePlayer {
  constructor() {
    super();
    this.ended = false;
  }
  async loadData(data, filepath, persistedSettings, subtune = 0) {
    this.loads.push(`${filepath}#${subtune}`);
    this.stopped = false;
    this.emit('playerStateUpdate', { isStopped: false, numSubtunes: 1, subtune });
  }
  endNow() {
    this.stop();
  }
}

function makeSequencer(players) {
  // `local/` paths are read via localFilesManager.read(), avoiding network.
  return new Sequencer(players, { read: () => new Uint8Array(0) }, () => ({}));
}

console.log('Sequencer sub-tune navigation (fake player)');
check('a multi-subtune context plays each sub-tune once and advances', () => {
  const player = new FakePlayer();
  const seq = makeSequencer([player]);
  seq.playContext([
    { path: 'local/game.nsf', subtune: 0 },
    { path: 'local/game.nsf', subtune: 1 },
    { path: 'local/game.nsf', subtune: 2 },
  ], 0);
  // loadData -> stop -> nextSong chains synchronously, so the whole context
  // drains without replaying any entry.
  assert.deepStrictEqual(player.loads, ['local/game.nsf#0', 'local/game.nsf#1', 'local/game.nsf#2']);
  assert.strictEqual(seq.getCurrSongRef(), null, 'context should be exhausted');
});

check('a mixed context advances one entry at a time', () => {
  const player = new FakePlayer();
  const seq = makeSequencer([player]);
  seq.playContext([
    { path: 'local/a.nsf', subtune: 0 },
    { path: 'local/b.mid', subtune: 0 },
    { path: 'local/a.nsf', subtune: 2 },
  ], 0);
  assert.deepStrictEqual(player.loads, ['local/a.nsf#0', 'local/b.mid#0', 'local/a.nsf#2']);
});

check('playContext subtune override only affects the first song', () => {
  const player = new FakePlayer();
  const seq = makeSequencer([player]);
  seq.playContext([{ path: 'local/game.nsf', subtune: 0 }], 0, 2);
  assert.deepStrictEqual(player.loads, ['local/game.nsf#2']);
});

// Tier-3 engines (V2M today) have no loop API: the engine ends, and the
// sequencer either advances to the next entry or -- under Repeat One, where
// currIdx stays put -- re-loads the same one. That re-load is a full refetch
// and a new player, which is the honest cost of the bottom rung of the ladder.
check('repeat one re-loads the same entry instead of advancing', () => {
  const player = new ManualPlayer();
  const seq = makeSequencer([player]);
  seq.setRepeat(2); // REPEAT_ONE
  seq.playContext([
    { path: 'local/a.v2m', subtune: 0 },
    { path: 'local/b.v2m', subtune: 0 },
  ], 0);
  assert.deepStrictEqual(player.loads, ['local/a.v2m#0']);
  player.endNow();
  assert.deepStrictEqual(player.loads, ['local/a.v2m#0', 'local/a.v2m#0'],
    'the same entry is re-run, not the next one');
  player.endNow();
  assert.deepStrictEqual(player.loads.length, 3, 'and it keeps repeating');
});

check('repeat off advances to the next entry when a song ends', () => {
  const player = new ManualPlayer();
  const seq = makeSequencer([player]);
  seq.playContext([
    { path: 'local/a.v2m', subtune: 0 },
    { path: 'local/b.v2m', subtune: 0 },
  ], 0);
  player.endNow();
  assert.deepStrictEqual(player.loads, ['local/a.v2m#0', 'local/b.v2m#0']);
  player.endNow();
  assert.strictEqual(seq.getCurrSongRef(), null, 'the context drains');
});

console.log(`\n${passed} passed, ${failed} failed.`);
