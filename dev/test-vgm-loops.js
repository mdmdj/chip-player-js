#!/usr/bin/env node
// DEV-ONLY VGM repeat-one check: the toggle matrix from AGENTS.md, driven by a
// fake core that models libvgm's own loop/fade bookkeeping (no wasm needed).
//
// The fake mirrors src/bindings/libvgm-wrapper.cpp, which is the authority for
// what the JS player can observe:
//   * position_ms is absolute (PLAYTIME_LOOP_INCL), so it climbs through loops
//   * cur_loop counts completed loops: 0 in the intro, 1 at A+B, 2 at A+2B, ...
//   * the wrapper configures loopCount = 2 at load (0 when the global
//     indefinite flag is set), so two passes + fade is the default playback
//   * fade_start_ms is GetTotalPlayTicks(loopCount), i.e. A + count*B -- and for
//     loopCount 0 that is A+B, which is why the player ignores the getter while
//     looping and captures it *before* changing the count
//   * set_loop_count(count) latches FadeOut() immediately when curLoop >= count,
//     which does not survive a later SetLoopCount(0)
// Run: node dev/test-vgm-loops.js
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

const VGMPlayer = require('../src/players/VGMPlayer').default;

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 64;
const STEP_MS = BUFFER_SIZE / SAMPLE_RATE * 1000;
const FADE_MS = 4000;          // libvgm's default fade
const END_SILENCE_MS = 500;    // ... plus its trailing silence

// Reference region: A = 1s intro, B = 5s loop.
const A = 1000, B = 5000;
const BAND_START = A + B;          // 6000: second loop instance
const BAND_END = A + 2 * B;        // 11000
const FADE_START_OFF = BAND_END;   // loopCount 2 -> fade begins here
const DURATION = BAND_END + FADE_MS + END_SILENCE_MS;

function makeCore({ introMs = A, loopMs = B } = {}) {
  const core = {
    introMs, loopMs,
    abs: 0,
    loopCount: 2,           // what the wrapper configures at load
    fadeStartedAtMs: null,  // when the running fade began (null = not fading)
    finished: false,
    silent: false,
    lastLoopArg: null,
    lastIndefiniteArg: null,
    stopped: false,
    _lvgm_init: () => 1,
    _lvgm_set_yrw801_rom_path: () => {},
    _lvgm_load_data: () => 0,
    _lvgm_get_metadata: () => 1024,
    _lvgm_get_voice_count: () => 0,
    _lvgm_get_voice_name: () => 8,
    _lvgm_get_voice_chip_name: () => 8,
    // Bitmask getters are uint64 (the player mixes BigInt shifts).
    _lvgm_get_voice_mask: () => 0n,
    _lvgm_set_voice_mask: () => 0,
    _lvgm_start: () => 0,
    _lvgm_stop: () => { core.stopped = true; return 0; },
    _lvgm_get_playback_speed: () => 1,
    _lvgm_set_playback_speed: () => 0,
    _lvgm_set_enhanced_stereo: () => 0,
    _lvgm_seek_ms: (ctx, ms) => {
      // libvgm cancels a running fade when seeking before its start.
      core.abs = ms;
      core.fadeStartedAtMs = null;
      core.finished = false;
      return 0;
    },
  };

  core.curLoop = () => {
    if (!core.loopMs || core.abs < core.introMs + core.loopMs) return 0;
    return Math.floor((core.abs - (core.introMs + core.loopMs)) / core.loopMs) + 1;
  };
  // GetTotalPlayTicks(loopCount): for count 0 libvgm returns a single pass, which
  // is why the getter is meaningless while looping and captured before the change.
  core.fadeStartMs = () => {
    const n = core.loopCount;
    return core.introMs + (n > 0 ? n * core.loopMs : core.loopMs);
  };
  core.fadeEndMs = () => core.fadeStartedAtMs == null
    ? Infinity
    : core.fadeStartedAtMs + FADE_MS + END_SILENCE_MS;
  core.startFade = () => {
    if (core.fadeStartedAtMs == null) core.fadeStartedAtMs = core.abs;
  };
  // One engine render. Advancing in steps matters: the fade latches when the
  // clock crosses the boundary for a finite loop count, so a test that jumps
  // straight to a position would skip state the engine would have set.
  core.step = () => {
    if (core.fadeStartedAtMs == null && core.loopCount > 0 &&
        core.abs >= core.fadeStartMs()) {
      core.fadeStartedAtMs = core.fadeStartMs();
    }
    if (core.abs >= core.fadeEndMs()) { core.finished = true; return false; }
    core.abs += STEP_MS;
    return true;
  };
  core.advanceTo = (targetMs) => {
    let steps = 0;
    while (core.abs < targetMs && !core.finished && steps++ < 100000) core.step();
  };
  core.setLoopCount = (count) => {
    // The export takes a UINT32: anything wider truncates, so a JS value of
    // 2**32 becomes 0 -- "loop forever" -- which is how a missing null guard in
    // lvgm_get_cur_loop() would silently turn "finish the pass" into "loop".
    const arg = count >>> 0;
    core.lastLoopArg = arg;
    core.loopCount = arg;
    // SetLoopCount() itself never clears a running fade, so a fade latched here
    // outlives a later SetLoopCount(0) -- see the indefinite-playback check.
    if (count !== 0 && core.curLoop() >= count) core.startFade();
  };

  Object.assign(core, {
    _lvgm_set_loop_count: (ctx, count) => core.setLoopCount(count),
    _lvgm_set_indefinite_playback: (ctx, enabled) => {
      core.lastIndefiniteArg = !!enabled;
      core.setLoopCount(enabled ? 0 : 2);
    },
    _lvgm_get_position_ms: () => Math.round(core.abs),
    _lvgm_get_duration_ms: () => DURATION,
    _lvgm_get_cur_loop: () => core.curLoop(),
    _lvgm_get_fade_start_ms: () => core.fadeStartMs(),
    _lvgm_get_loop_start_ms: () => core.introMs,
    _lvgm_get_loop_end_ms: () => core.introMs + core.loopMs,
    _lvgm_render: () => (core.step() ? BUFFER_SIZE : 0),
    _malloc: () => 4096,
    _free: () => {},
    HEAPU8: { set: () => {} },
    UTF8ToString: () => '',
    getValue: () => (core.silent ? 0 : 0x20000000),
    stringToNewUTF8: () => 8,
  });

  return core;
}

async function makePlayer(coreOpts) {
  const core = makeCore(coreOpts);
  const p = new VGMPlayer(core, SAMPLE_RATE, BUFFER_SIZE);
  await p.loadData(new Uint8Array([1, 2, 3, 4]), 'test.vgm', {});
  // loadData resolves the params, which sets the engine's own two-pass default;
  // clear the recorded call so a check can assert "nothing re-derived since".
  core.lastLoopArg = null;
  core.lastIndefiniteArg = null;
  return { p, core };
}

// Place the engine at `abs` before a toggle, so a running fade has latched.
async function seek(p, core, abs) {
  core.advanceTo(abs);
  return abs;
}

// Render one buffer at each of the given absolute positions.
async function drive(p, core, positions) {
  const ch = () => new Float32Array(BUFFER_SIZE);
  for (const abs of positions) {
    core.advanceTo(abs);
    p.processAudio([ch(), ch()]);
  }
}

// Render from `fromMs` until the engine reports the song finished.
async function driveToEnd(p, core, fromMs, limit = 4000) {
  core.advanceTo(fromMs);
  const ch = () => new Float32Array(BUFFER_SIZE);
  let frames = 0;
  while (!core.finished && !p.stopped && frames++ < limit) {
    p.processAudio([ch(), ch()]);
  }
  return frames;
}

// The head must not jump across a toggle: same song position, same display.
function assertNoJump(p, label, before, after) {
  assert.ok(Math.abs(after - before) <= STEP_MS + 1,
    `${label}: head jumped ${before} -> ${after} (step ${STEP_MS.toFixed(2)}ms)`);
}

// Display reads after a drive() land within two buffer steps of the position we
// asked for: advanceTo() walks in whole steps (so it overshoots by up to one) and
// the rendered buffer adds another.
function assertDisplay(p, expected, label) {
  const actual = p.getDisplayPositionMs();
  assert.ok(Math.abs(actual - expected) <= 2 * STEP_MS + 1,
    `${label}: display ${actual}, expected ${expected} (+/- two ${STEP_MS.toFixed(2)}ms steps)`);
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

// A defect that is confirmed but not fixed yet: reported so it stays visible,
// without failing the run. Unwrap it when it is fixed -- `check` then guards it.
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
  await check('loop region maps onto the shared intro/loop band vocabulary', async () => {
    const { p } = await makePlayer();
    assert.strictEqual(p.metadata.intro_length, A);
    assert.strictEqual(p.metadata.loop_length, B);
    assert.deepStrictEqual(p.getLoopBandMs(), { startMs: BAND_START, endMs: BAND_END });
  });

  await check('#3 Off->One before the band: no jump, native loop, head folds later', async () => {
    const { p, core } = await makePlayer();
    await seek(p, core, 2000);
    const before = p.getDisplayPositionMs();
    p.setLooping(true);
    const after = p.getDisplayPositionMs();
    assertNoJump(p, 'enable in the lead-in', before, after);
    assert.strictEqual(core.lastLoopArg, 0, 'loop count 0 = forever');
    // First pass plays through live, then the head cycles inside the band.
    await drive(p, core, [BAND_START + 1000]);
    assertDisplay(p, BAND_START + 1000, 'first pass in the band');
    await drive(p, core, [BAND_END + 1000]);
    assertDisplay(p, BAND_START + 1000, 'band boundary');
    await drive(p, core, [BAND_END + B + 1000]);
    assertDisplay(p, BAND_START + 1000, 'second loop');
  });

  await check('#6 One->Off shallow: count re-derived, head continuous', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    await seek(p, core, BAND_START + 1000); // curLoop 1, still inside the band
    const before = p.getDisplayPositionMs();
    p.setLooping(false);
    assertNoJump(p, 'disable inside the band', before, p.getDisplayPositionMs());
    assert.strictEqual(core.lastLoopArg, 2, 'finish the current pass, fade at the boundary');
    assert.strictEqual(p.durationExtended, false);
    assert.strictEqual(p.isPlayingIndefinitely(), false);
  });

  await check('#7 One->Off deep: count = curLoop+1, durationExtended, fade to the end', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    await seek(p, core, A + 9 * B); // curLoop 9, deep
    const before = p.getDisplayPositionMs();
    p.setLooping(false);
    assertNoJump(p, 'disable deep', before, p.getDisplayPositionMs());
    assert.strictEqual(core.lastLoopArg, 10);
    assert.strictEqual(p.durationExtended, true);
    assert.strictEqual(p.isPlayingIndefinitely(), true, 'engine owns the end, not the base detector');
    // The tail runs from the band end and lands at 100% when the song ends.
    const fadeStart = core.fadeStartMs();
    assert.strictEqual(fadeStart, A + 10 * B);
    await drive(p, core, [fadeStart]);
    assertDisplay(p, BAND_END, 'fade tail starts at the band end');
    await driveToEnd(p, core, fadeStart);
    assert.strictEqual(p.stopped, true, 'the engine ends the song itself');
    assertDisplay(p, DURATION, 'display lands at the two-pass duration');
  });

  await check('#4 Off->One during the fade: fade captured, head rides the tail, song ends', async () => {
    const { p, core } = await makePlayer();
    await seek(p, core, FADE_START_OFF + 500); // fade already running (loopCount 2)
    const before = p.getDisplayPositionMs();
    p.setLooping(true);
    assertNoJump(p, 'enable mid-fade', before, p.getDisplayPositionMs());
    assert.strictEqual(p.fadeTailStartMs, FADE_START_OFF, 'captured before the count changed');
    assert.strictEqual(core.lastLoopArg, 0);
    // No fold back into the band: the tail keeps running out, and the fade
    // already in progress survives the loop-count change to 0.
    await drive(p, core, [FADE_START_OFF + 1000]);
    assertDisplay(p, BAND_END + 1000, 'mid tail');
    await driveToEnd(p, core, FADE_START_OFF + 1000);
    assert.strictEqual(p.stopped, true, 'the fade finishes and the song ends');
  });

  await check('repeat one enabled past the loop end: no seek back, engine takes over', async () => {
    // The base class used to carry a "late repeat" flag for this case, but every
    // player cleared it, so the branch was unreachable. Pin what actually
    // governs it instead: libvgm loops natively, so the transport must not be
    // rewound and the position must keep climbing.
    //
    // The window is loopEnd..fadeStart (BAND_START..BAND_END). Later than that
    // and libvgm has already latched its two-pass fade, which SetLoopCount(0)
    // does not clear -- the song ends, per the indefinite-playback xfail below.
    const { p, core } = await makePlayer();
    await seek(p, core, BAND_START + 2000); // past the loop, fade not yet running
    assert.strictEqual(core.fadeStartedAtMs, null, 'precondition: no fade running');
    const beforeDisplay = p.getDisplayPositionMs();
    p.setLooping(true);
    assertNoJump(p, 'enable past the loop end', beforeDisplay, p.getDisplayPositionMs());
    assert.strictEqual(core.lastLoopArg, 0, 'the engine takes the repeat, not a seek');
    await drive(p, core, [BAND_END + 1000, BAND_END + B + 1000]);
    assert.ok(p.getPositionMs() > BAND_END + B,
      'position keeps climbing forward instead of being rewound');
    assert.strictEqual(p.stopped, false, 'and the song is still playing');
  });

  await check('#8 repeat one from the start: head cycles in the band, abs climbs', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    for (let pass = 1; pass <= 4; pass++) {
      const abs = A + pass * B + 1000;
      await drive(p, core, [abs]);
      const disp = p.getDisplayPositionMs();
      assert.ok(disp >= BAND_START && disp < BAND_END, `pass ${pass} display ${disp} inside the band`);
      assert.ok(core.abs >= abs, `absolute position keeps climbing (${core.abs} >= ${abs})`);
    }
  });

  await check('#9 repeat off from the start: lead-in, two passes, then the fade tail', async () => {
    const { p, core } = await makePlayer();
    // Live through the intro and both passes.
    await drive(p, core, [500]);
    assertDisplay(p, 500, 'intro');
    await drive(p, core, [BAND_START - 500]);
    assertDisplay(p, BAND_START - 500, 'lead-in plus first pass');
    await drive(p, core, [BAND_END - 500]);
    assertDisplay(p, BAND_END - 500, 'second pass');
    await drive(p, core, [FADE_START_OFF + 2000]);
    assertDisplay(p, BAND_END + 2000, 'fade tail');
    await driveToEnd(p, core, FADE_START_OFF + 2000);
    assert.strictEqual(p.stopped, true);
  });

  await check('no-op repeat toggle never moves the count or the head', async () => {
    // The regression from 96683ba3e: re-deriving the count when already not
    // looping pushed the fade start past a running fade and folded the head.
    const { p, core } = await makePlayer();
    await seek(p, core, FADE_START_OFF + 1000);
    const before = p.getDisplayPositionMs();
    p.setLooping(false);
    p.setLooping(false);
    assert.strictEqual(core.lastLoopArg, null, 'nothing re-derived');
    assert.strictEqual(p.getDisplayPositionMs(), before);
  });

  await check('head is continuous at every toggle point (pre / band / tail)', async () => {
    for (const at of [500, BAND_START + 500, FADE_START_OFF + 500]) {
      const { p, core } = await makePlayer();
      p.setLooping(true);
      await seek(p, core, at);
      let before = p.getDisplayPositionMs();
      p.setLooping(false);
      assertNoJump(p, `on->off at ${at}`, before, p.getDisplayPositionMs());
      before = p.getDisplayPositionMs();
      p.setLooping(true);
      assertNoJump(p, `off->on at ${at}`, before, p.getDisplayPositionMs());
    }
  });

  await check('base end detector stands down while looping (skip silence 0 and none)', async () => {
    for (const silence of [0, -1]) {
      const { p, core } = await makePlayer();
      p.setSilenceDuration(silence);
      p.setLooping(true);
      await drive(p, core, [DURATION + 5000]);
      assert.strictEqual(p.stopped, false, `silenceDuration ${silence}: must not end while looping`);
      assert.strictEqual(p.isPlayingIndefinitely(), true);
    }
  });

  await check('skip silence ends a non-looping song before the engine does', async () => {
    // The base detector needs the arming conditions: silenceDuration >= 0, not
    // looping, and 0.4s of silence inside the final five seconds.
    for (const silence of [0, 2]) {
      const { p, core } = await makePlayer();
      p.setSilenceDuration(silence);
      core.silent = true;
      await driveToEnd(p, core, DURATION - 2000);
      assert.strictEqual(p.stopped, true, `silenceDuration ${silence}`);
      assert.strictEqual(core.finished, false, 'ended by the base detector, not the engine');
    }
  });

  await check('seek drops the captured fade tail and the head folds again', async () => {
    const { p, core } = await makePlayer();
    core.abs = FADE_START_OFF + 500;
    p.setLooping(true); // captures fadeTailStartMs
    assert.strictEqual(p.fadeTailStartMs, FADE_START_OFF);
    p.seekMs(A + B);
    assert.strictEqual(p.fadeTailStartMs, null, 'seek drops the capture');
    await drive(p, core, [A + 4 * B]);
    assertDisplay(p, BAND_START, 'folds into the band again');
  });

  await check('file with no loop region: repeat one loops, no band, head runs on', async () => {
    const { p, core } = await makePlayer({ introMs: 0, loopMs: 0 });
    assert.strictEqual(p.getLoopBandMs(), null);
    assert.strictEqual(p.metadata.intro_length, undefined);
    p.setLooping(true);
    assert.strictEqual(core.lastLoopArg, 0);
    await seek(p, core, 4000);
    assertDisplay(p, 4000, 'no region to fold into');
    assert.strictEqual(p.isPlayingIndefinitely(), true);
  });

  await check('indefinite playback setting mirrors repeat one through setParam', async () => {
    const { p, core } = await makePlayer();
    p.setParameter('indefinitePlayback', true);
    assert.strictEqual(core.lastLoopArg, 0, 'setting on loops forever');
    assert.strictEqual(p.isPlayingIndefinitely(), true);
    await seek(p, core, BAND_START + 500);
    const before = p.getDisplayPositionMs();
    p.setParameter('indefinitePlayback', false);
    assert.strictEqual(core.lastLoopArg, 2);
    assertNoJump(p, 'setting off', before, p.getDisplayPositionMs());
  });

  await xcheck('a sentinel loop count from an unloaded engine never means "loop forever"',
    'lvgm_get_cur_loop() is the one getter without the `GetPlayer() == nullptr` guard its siblings have, and PlayerA::GetCurLoop() returns (UINT32)-1 when no file is loaded. JS then computes Math.max(2, 4294967295 + 1) = 2**32, which the export truncates to 0 = loop forever, so a toggle in that state arms "repeat" instead of "finish the pass and fade". Narrow (it needs a toggle before a successful load), and masked in practice by load order, but a one-line guard in the wrapper would close it.', async () => {
    const { p, core } = await makePlayer();
    // What the engine reports with nothing loaded.
    core._lvgm_get_cur_loop = () => 4294967295;
    p.setLooping(true);
    p.setLooping(false);
    assert.ok(core.lastLoopArg >= 2,
      `the engine must get a finite pass count, got ${core.lastLoopArg}`);
  });

  await xcheck('setting off while repeat one is on does not latch a fade',
    'confirmed in-app on "19 1st Place Name Registration.vgz": with repeat one on at curLoop 2, the song fades out ~3.5s later and ends. PlayerA::SetLoopCount() never clears _fadeSmplStart, and _lvgm_set_indefinite_playback(false) latches FadeOut() before applyLoopCount restores 0.', async () => {
    // Repeat one is the user's intent, so the "Indefinite Playback" setting
    // turning off must not end the song: set_indefinite_playback(false)
    // latches PlayerA::FadeOut(), and a later SetLoopCount(0) does not clear it.
    const { p, core } = await makePlayer();
    p.setLooping(true);
    // Three loops in, so the setting's own "curLoop >= 2" fade latch fires.
    await seek(p, core, A + 3 * B + 500);
    p.setParameter('indefinitePlayback', false);
    assert.strictEqual(p.looping, true, 'repeat one is still on');
    assert.strictEqual(core.fadeStartedAtMs, null, 'no fade latched behind the loop count');
    await driveToEnd(p, core, A + 3 * B + 2500);
    assert.strictEqual(p.stopped, false, 'still playing');
  });

  console.log(`\n${passed} checks passed${xfailed ? `, ${xfailed} known failure(s)` : ''}${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
}

main();