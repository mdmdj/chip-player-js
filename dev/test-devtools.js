#!/usr/bin/env node
// DEV-ONLY __cpDev stall-watch check: frozen-while-playing fires once;
// advancing, paused, and song changes never fire. Run: node dev/test-devtools.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = {
  ChipPlayer: { state: { repeat: 0 }, sequencer: { getPlayer: () => null } },
};
global.document = { querySelector: () => null, querySelectorAll: () => [] };
require('./shims/devtools.js');
const dev = global.window.__cpDev;
assert.ok(dev && dev.startStallWatch, 'devtools did not install __cpDev');

// Scripted player behind getPlayer via snapshot override.
let snap = { player: 'VGMPlayer', repeat: 0, paused: false, positionMs: 0, durationMs: 100000, metadata: { title: 'T' } };
let nowMs = 0;
const { performance } = require('perf_hooks');
const realNow = performance.now;
// Drive the watch manually: snapshot() is live, so point the app's clock.
global.window.ChipPlayer.sequencer.getPlayer = () => ({
  constructor: { name: 'VGMPlayer' },
  looping: false, params: {},
  isPaused: () => snap.paused,
  getPositionMs: () => snap.positionMs,
  getDisplayPositionMs: () => snap.positionMs,
  getDurationMs: () => snap.durationMs,
  metadata: snap.metadata,
});
// Patch performance.now for determinism.
performance.now = () => nowMs;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n')}`);
    process.exitCode = 1;
  } finally {
    dev.stopStallWatch();
  }
}

function watchStep() {
  // Run one interval tick synchronously.
  const s = dev._stallCheck(2000, 6000);
  return s;
}

check('advancing position never fires', () => {
  dev.startStallWatch(2000, 6000);
  for (let t = 0; t <= 20000; t += 2000) {
    nowMs = t;
    snap.positionMs = t;
    const s = watchStep();
    assert.strictEqual(s.stall && s.stall.stalled, false);
  }
  dev.stopStallWatch();
});

check('frozen position fires once, then latches', () => {
  dev.startStallWatch(2000, 6000);
  nowMs = 0; snap.positionMs = 5000; snap.paused = false;
  watchStep();
  let fired = null;
  for (let t = 2000; t <= 12000; t += 2000) {
    nowMs = t;
    const s = watchStep();
    if (s.stall && s.stall.stalled) fired = fired || t;
  }
  assert.strictEqual(fired, 6000);
  snap.paused = false;
  dev.stopStallWatch();
});

check('paused never fires', () => {
  dev.startStallWatch(2000, 6000);
  snap.paused = true; snap.positionMs = 5000;
  for (let t = 0; t <= 16000; t += 2000) {
    nowMs = t;
    const s = watchStep();
    assert.strictEqual(s.stall && s.stall.stalled, false);
  }
  snap.paused = false;
  dev.stopStallWatch();
});

check('song change re-arms silently', () => {
  dev.startStallWatch(2000, 6000);
  nowMs = 0; snap.positionMs = 5000; snap.metadata = { title: 'A' };
  watchStep();
  nowMs = 2000; snap.metadata = { title: 'B' }; snap.positionMs = 100;
  const s = watchStep();
  assert.strictEqual(s.stall && s.stall.stalled, false);
  dev.stopStallWatch();
});

performance.now = realNow;
console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
