#!/usr/bin/env node
// DEV-ONLY MDX repeat-one check: native loop with an exact band, driven by a
// fake core (no wasm, no Emscripten FS needed beyond a stub).
//
// The fake models mdxmini's loop bookkeeping as MDXPlayer uses it:
//   * the song has its own infinite loop, so length(k) = intro + k*loop + fade
//     -- which is why _readLoopRegion() measures the region from two recorded
//     passes instead of guessing a fade
//   * mdx_set_max_loop(n) caps joint sections (0 = forever), and the engine's own
//     fade runs out after the capped section, then calc_sample returns 0
//   * mdx_get_length measures before that region is resolved, so its fade gate
//     counts per-track loops while playback counts joint sections, and it reports
//     whole seconds -- the two disagree when loops_per_section > 1
//   * the built-in loop jumps are seamless: no fade, no reload, no jump in the
//     absolute clock
// Run: node dev/test-mdx-loops.js
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
// Players import chip images for their voice groups; Node cannot parse those.
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

const MDXPlayer = require('../src/players/MDXPlayer').default;

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 64;
const STEP_MS = BUFFER_SIZE / SAMPLE_RATE * 1000;
const FADE_MS = 4000;   // nominal; mdxmini fades over the tail of the last pass

// Reference region: the song loops from its first frame (A = 0), like the
// catalog's G2MST6.MDX, where A == B.
const A = 0, B = 20000;
const BAND_START = A + B;
const BAND_END = A + 2 * B;
const DURATION = BAND_END + FADE_MS;

// Minimal Emscripten FS stub: MDXPlayer loads through the filesystem.
function makeFS() {
  const files = new Map();
  return {
    filesystems: { IDBFS: {} },
    mkdirTree: () => {},
    mount: () => {},
    analyzePath: (p) => ({ exists: files.has(p) }),
    writeFile: (p, data) => files.set(p, data),
    readFile: (p) => files.get(p),
    syncfs: (_populate, cb) => cb(null),
  };
}

function makeCore({ introMs = A, loopMs = B, withLoopGetters = true, perSection = 0, lengthMs = null } = {}) {
  const per = perSection > 0 ? perSection : 1;   // per-track repeats in one section
  const core = {
    introMs, loopMs, per, lengthMs,
    maxLoop: 0,
    abs: 0,
    fadeStartedAtMs: null, // mdxmini latches fade_out; only reinit (a seek) clears it
    silent: false,
    lastMaxLoopArg: null,
    stopped: false,
    FS: makeFS(),
  };

  // Where the fade for a given section count begins: the end of that section.
  // The playback end is that plus FADE_MS (see core.step).
  core.fadeStartMs = (passes) => core.introMs + passes * core.loopMs;

  Object.assign(core, {
    _mdx_create_context: () => 1,
    _mdx_set_rate: () => {},
    _mdx_set_dir: () => {},
    _mdx_set_speed: () => 0,
    _mdx_close: () => 0,
    _mdx_get_title: (ctx, ptr) => core.HEAPU8.fill(0, ptr, ptr + 256),
    ccall: (name) => (name === 'mdx_open' ? 0 : 0),
    // Note: lowering the pass count to 0 does NOT clear a fade already in
    // progress (mdxmini only reinit clears it), which is why enabling Repeat One
    // during the fade ends the song rather than looping it.
    _mdx_set_max_loop: (ctx, n) => { core.lastMaxLoopArg = n; core.maxLoop = n; },
    _mdx_set_position_ms: (ctx, ms) => { core.abs = ms; core.fadeStartedAtMs = null; },
    _mdx_get_position_ms: () => Math.round(core.abs),
    _mdx_get_tracks: () => 0,
    _mdx_get_track_name: () => 8,
    _mdx_get_track_mask: () => 0,
    _mdx_set_track_mask: () => {},
    _mdx_calc_sample: () => (core.step() ? BUFFER_SIZE : 0),
    _malloc: () => 4096,
    _free: () => {},
    HEAPU8: new Uint8Array(8192),
    UTF8ToString: () => '',
    getValue: () => (core.silent ? 0 : 0x2000),
  });

  // _mdx_get_length is upstream and _readLoopRegion() calls it unconditionally;
  // only the two region getters are feature-detected.
  //
  // It is not the section-gated playback length: mdx_get_length's parse runs the
  // fade gate before loops_per_section is resolved, so the gate counts raw
  // per-track loops (one section is `per` of them) and the return is whole
  // seconds. per == 1 leaves only the truncation.
  core._mdx_get_length = () => Math.floor(
    (core.lengthMs != null
      ? core.lengthMs                     // a file whose tracks stop looping early
      : core.introMs + (core.maxLoop / core.per) * core.loopMs + FADE_MS) / 1000);
  if (withLoopGetters) {
    core._mdx_get_loop_start_ms = () => core.introMs;
    core._mdx_get_loop_length_ms = () => core.loopMs;
  }
  // per > 1: the tracks have different periods (4 s and 6 s make a 12 s
  // section), so the engine's per-track counter is not the section count. The
  // player must hand the engine the limit in the engine's unit and keep its
  // two-pass floor expressed in sections.

  // Advance in whole steps: the fade latches when the clock crosses the boundary
  // for the current pass count, so a test that jumped to a position would skip
  // state the engine would have set.
  core.step = () => {
    if (core.fadeStartedAtMs == null && core.maxLoop > 0 &&
        core.abs >= core.fadeStartMs(core.maxLoop)) {
      core.fadeStartedAtMs = core.fadeStartMs(core.maxLoop);
    }
    if (core.fadeStartedAtMs != null && core.abs >= core.fadeStartedAtMs + FADE_MS) return false;
    core.abs += STEP_MS;
    return true;
  };
  core.advanceTo = (targetMs) => {
    let steps = 0;
    while (core.abs < targetMs && steps++ < 100000) {
      if (!core.step()) return false; // engine ended the song
    }
    return true;
  };
  return core;
}

async function makePlayer(coreOpts) {
  const core = makeCore(coreOpts);
  const p = new MDXPlayer(core, SAMPLE_RATE, BUFFER_SIZE);
  // Player.audioNode is only touched to mute around the (blocking) open call.
  p.audioNode = { context: { state: 'suspended' } };
  await p.loadData(new Uint8Array([1, 2, 3, 4]), 'G2MST6.MDX', {});
  core.lastMaxLoopArg = null; // cleared so a check can assert "nothing re-derived"
  return { p, core };
}

async function drive(p, core, positions) {
  const ch = () => new Float32Array(BUFFER_SIZE);
  for (const abs of positions) {
    core.advanceTo(abs);
    p.processAudio([ch(), ch()]);
  }
}

async function driveToEnd(p, core, fromMs, limit = 6000) {
  core.advanceTo(fromMs);
  const ch = () => new Float32Array(BUFFER_SIZE);
  let frames = 0;
  while (!p.stopped && frames++ < limit) {
    p.processAudio([ch(), ch()]);
  }
  return frames;
}

function assertDisplay(p, expected, label) {
  const actual = p.getDisplayPositionMs();
  assert.ok(Math.abs(actual - expected) <= 2 * STEP_MS + 1,
    `${label}: display ${actual}, expected ${expected} (+/- two ${STEP_MS.toFixed(2)}ms steps)`);
}

function assertNoJump(p, label, before, after) {
  assert.ok(Math.abs(after - before) <= STEP_MS + 1,
    `${label}: head jumped ${before} -> ${after} (step ${STEP_MS.toFixed(2)}ms)`);
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
  await check('measured region maps onto the shared band vocabulary', async () => {
    const { p } = await makePlayer();
    assert.strictEqual(p.metadata.intro_length, A);
    assert.strictEqual(p.metadata.loop_length, B);
    assert.deepStrictEqual(p.getLoopBandMs(), { startMs: BAND_START, endMs: BAND_END });
    assert.strictEqual(p.getDurationMs(), DURATION, 'intro + two passes + fade');
  });

  await check('a band the song cannot reach is not drawn', async () => {
    // Measured on FACE04: the engine's length is 242s while intro + 2*loop is
    // 273.7s, so the highlighted band hung off the end of the slider and the
    // clamp left a sliver the song never plays, drawn while it was already
    // fading out. No band is the honest answer.
    const short = await makePlayer({ lengthMs: A + 2 * B - 1500 });
    assert.strictEqual(short.p.getLoopBandMs(), null, 'no band past the song');
    assert.strictEqual(short.p.metadata.loop_length, B,
      'the region itself is still recorded -- the transport derives from it');
    const fits = await makePlayer({ lengthMs: A + 2 * B + 2000 });
    assert.ok(fits.p.getLoopBandMs(), 'a band the song reaches is still drawn');
    assert.strictEqual(fits.p.getLoopBandMs().startMs, BAND_START);
  });

  await check('load leaves the engine at two passes (libvgm parity)', async () => {
    const { p, core } = await makePlayer();
    assert.strictEqual(p._maxLoopCount, 2);
    assert.strictEqual(core.maxLoop, 2);
  });

  await check('repeat one: native infinite loop, no seek, no jump in the clock', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    assert.strictEqual(core.lastMaxLoopArg, 0, '0 = forever');
    await drive(p, core, [BAND_START + 1000, BAND_END + 1000, BAND_END + B + 1000]);
    assert.strictEqual(core.abs > DURATION + FADE_MS, true, 'position keeps climbing past the fade');
    assert.strictEqual(p.stopped, false, 'a capped-out engine would have ended by now');
  });

  await check('head folds into the band once the loop repeats', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    await drive(p, core, [BAND_END - 1000]);
    assertDisplay(p, BAND_END - 1000, 'first pass plays through live');
    await drive(p, core, [BAND_END + 1000]);
    assertDisplay(p, BAND_START + 1000, 'band boundary');
    await drive(p, core, [BAND_END + B + 1000]);
    assertDisplay(p, BAND_START + 1000, 'second pass folds back');
  });

  await check('leaving shallow restores two passes, head continuous', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    core.advanceTo(BAND_START + 1000);
    const before = p.getDisplayPositionMs();
    p.setLooping(false);
    assertNoJump(p, 'disable inside the band', before, p.getDisplayPositionMs());
    assert.strictEqual(core.lastMaxLoopArg, 2, 'max(2, curLoop+1) with curLoop 1');
    // Every leave hands the end to the engine, not only a deep one: the reported
    // duration is measured under a different gate (and truncated to whole
    // seconds), so the engine's fade can run past it and the base detector must
    // stand down here too.
    assert.strictEqual(p.durationExtended, true, 'the engine owns the end on any leave');
  });

  await check('a sub-second gap alone still lets the engine finish (per=1)', async () => {
    // With the periods equal the two gates agree apart from mdx_get_length's
    // whole-second return: 2 x 20123ms + fade = 44246ms reads as 44s, 246ms
    // short. Small, but the detector would still clamp the engine's fade to it.
    const loop = 20123;
    const { p, core } = await makePlayer({ introMs: 0, loopMs: loop });
    assert.strictEqual(p.getDurationMs(), 44000, 'whole-second truncated length');
    p.setSilenceDuration(0);
    p.setLooping(true);
    core.advanceTo(loop + 1000);
    p.setLooping(false);
    await driveToEnd(p, core, loop + 1000, 60000);
    assert.strictEqual(p.stopped, true, 'the engine ends the song itself');
    assert.ok(p.getPositionMs() > 44100,
      `engine end ${p.getPositionMs()}ms truncated to the reported 44s`);
    assert.strictEqual(p.durationExtended, true);
  });

  await check('leaving shallow still outruns a short reported duration (mixed periods)', async () => {
    // Where the two gates disagree: mdx_get_length reports the per-track figure
    // (2 x 10s loops + fade = 24s) while playback fades at the joint section end
    // (2 x 20s + fade = 44s). Leaving at curLoop 1 schedules a fade past the
    // reported duration, so a detector that trusted 24s would cut 20s of music.
    const { p, core } = await makePlayer({ perSection: 2 });
    assert.strictEqual(p.getDurationMs(), 24000, 'per-track-gated reported length');
    p.setSilenceDuration(0);   // arm the base detector so the truncation is observable
    p.setLooping(true);
    core.advanceTo(BAND_START + 1000);
    p.setLooping(false);
    assert.strictEqual(core.lastMaxLoopArg, 2, 'max(2, curLoop+1) with curLoop 1');
    await driveToEnd(p, core, BAND_START + 1000, 60000);
    assert.strictEqual(p.stopped, true, 'the engine ends the song itself');
    assert.ok(p.getPositionMs() >= BAND_END,
      `ran past the reported 24s to ${p.getPositionMs()}ms`);
    assert.strictEqual(p.durationExtended, true, 'the engine owns the end');
  });

  await check('leaving deep extends the fade and the engine ends the song', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    core.advanceTo(BAND_END + 1000); // curLoop 2
    const before = p.getDisplayPositionMs();
    p.setLooping(false);
    assertNoJump(p, 'disable deep', before, p.getDisplayPositionMs());
    assert.strictEqual(p.getCurLoop(), 2);
    assert.strictEqual(core.lastMaxLoopArg, 3, 'curLoop + 1 finishes this pass');
    assert.strictEqual(p.durationExtended, true);
    assert.strictEqual(p.isPlayingIndefinitely(), true, 'engine owns the end');
    await driveToEnd(p, core, BAND_END + 1000, 30000);
    assert.strictEqual(p.stopped, true, 'the engine ends the song itself');
    assertDisplay(p, DURATION, 'display lands at the duration');
  });

  await check('no-op toggle keeps the two-pass default and never moves the head', async () => {
    // Unlike VGM (which leaves the count alone), MDXPlayer re-pushes the default
    // on every toggle. That is harmless -- mdx_set_max_loop only caps passes --
    // so assert the outcome rather than that no call happened.
    const { p, core } = await makePlayer();
    core.advanceTo(BAND_END + 2000);
    const before = p.getDisplayPositionMs();
    p.setLooping(false);
    p.setLooping(false);
    assert.strictEqual(p._maxLoopCount, 2);
    assert.strictEqual(core.maxLoop, 2);
    assert.strictEqual(p.getDisplayPositionMs(), before);
  });

  await check('head is continuous at every toggle point (pre / band / tail)', async () => {
    for (const at of [BAND_START - 1000, BAND_START + 1000, BAND_END + 2000]) {
      const { p, core } = await makePlayer();
      p.setLooping(true);
      core.advanceTo(at);
      let before = p.getDisplayPositionMs();
      p.setLooping(false);
      assertNoJump(p, `on->off at ${at}`, before, p.getDisplayPositionMs());
      before = p.getDisplayPositionMs();
      p.setLooping(true);
      assertNoJump(p, `off->on at ${at}`, before, p.getDisplayPositionMs());
    }
  });

  await check('base end detector stands down while looping', async () => {
    for (const silence of [0, -1]) {
      const { p, core } = await makePlayer();
      p.setSilenceDuration(silence);
      p.setLooping(true);
      await drive(p, core, [DURATION + FADE_MS + 10000]);
      assert.strictEqual(p.stopped, false, `silenceDuration ${silence}`);
    }
  });

  await check('curLoop is derived from the position, not an engine counter', async () => {
    const { p, core } = await makePlayer();
    core.advanceTo(A + B / 2);
    assert.strictEqual(p.getCurLoop(), 0, 'inside the first pass');
    core.advanceTo(BAND_START + 1);
    assert.strictEqual(p.getCurLoop(), 1);
    core.advanceTo(BAND_END + 1);
    assert.strictEqual(p.getCurLoop(), 2);
  });

  await check('song with no built-in loop: two passes, no band, blind head', async () => {
    const { p, core } = await makePlayer({ introMs: 0, loopMs: 0 });
    assert.strictEqual(p.metadata.loop_length, undefined);
    assert.strictEqual(p.getLoopBandMs(), null);
    assert.strictEqual(p.getCurLoop(), 0);
    p.setLooping(true);
    assert.strictEqual(core.lastMaxLoopArg, 0, 'still loops natively forever');
    await drive(p, core, [5000]);
    assertDisplay(p, 5000, 'no region to fold into');
  });

  await check('engine without the region getters still loops natively, no band', async () => {
    // An older chip-core has _mdx_set_max_loop and _mdx_get_length but not the
    // loop-point getters, so there is no exact region to show.
    const { p, core } = await makePlayer({ withLoopGetters: false });
    assert.strictEqual(typeof core._mdx_set_max_loop, 'function', '_mdx_set_max_loop is upstream');
    assert.strictEqual(p.metadata.loop_length, undefined, 'no region measured');
    assert.strictEqual(p.getLoopBandMs(), null);
    assert.strictEqual(p.getDurationMs(), DURATION, 'length(2) still gives a duration');
    p.setLooping(true);
    assert.strictEqual(core.lastMaxLoopArg, 0, 'loops natively with no band');
    await drive(p, core, [3000]);
    assertDisplay(p, 3000, 'blind head runs on');
  });

  await check('repeat one past the region: native loop, no late restart seek', async () => {
    const { p, core } = await makePlayer();
    // loopEnd..fadeStart, i.e. past the loop but before mdxmini has latched its
    // two-pass fade (the next check covers enabling once the fade is running).
    core.advanceTo(BAND_START + 2000);
    p.setLooping(true);
    assert.strictEqual(core.lastMaxLoopArg, 0);
    // Native looping owns this case, so the transport must not be rewound.
    await drive(p, core, [BAND_END + B]);
    assert.ok(p.getPositionMs() > BAND_END,
      'position keeps climbing instead of being rewound');
    assert.strictEqual(p.stopped, false, 'and the song is still playing');
  });

  await check('enabling repeat one during the fade tail keeps the head on the tail', async () => {
      const { p, core } = await makePlayer();
      core.advanceTo(BAND_END + 2000); // fade already running at 2 passes
      const before = p.getDisplayPositionMs();
      p.setLooping(true);
      assertNoJump(p, 'enable mid-fade', before, p.getDisplayPositionMs());
      await drive(p, core, [BAND_END + 4000]);
      assertDisplay(p, BAND_END + 4000, 'tail keeps running out');
      await driveToEnd(p, core, BAND_END + 4000, 30000);
      assert.strictEqual(p.stopped, true, 'the running fade still ends the song');
    });

  await check('a seek drops the captured tail, and the head folds again', async () => {
    const { p, core } = await makePlayer();
    core.advanceTo(BAND_END + 2000);
    p.setLooping(true); // captures the running fade
    assert.strictEqual(p.fadeTailStartMs, BAND_END);
    p.seekMs(BAND_START + 1000);
    assert.strictEqual(p.fadeTailStartMs, null, 'the capture belonged to the old position');
    await drive(p, core, [BAND_START + B]);
    assertDisplay(p, BAND_START, 'folds into the band again');
  });

  // The engine's fade limit is the joint-section count the band is drawn from,
  // even when one section is several repeats of the longest track. MDXPlayer
  // hands it that count directly (mdxmml_ym2151.c's loop_gate_value does the
  // projection per track), so the old per-track projection must not reappear.
  await check('leaving repeat hands the engine the joint section count', async () => {
    const { p, core } = await makePlayer({ perSection: 2 });
    p.setLooping(true);
    await drive(p, core, [BAND_END + 1000]);
    p.setLooping(false);
    // The joint sections completed here are 2, so the two-pass floor makes it 3.
    assert.strictEqual(core.lastMaxLoopArg, 3,
      `expected the joint section count 3, got ${core.lastMaxLoopArg}`);
  });

  await check('the two-pass floor is the same number with mixed periods', async () => {
    // The engine reads sections, so the floor is two sections and the pass in
    // progress makes three.
    const { p, core } = await makePlayer({ perSection: 3 });
    p.setLooping(true);
    await drive(p, core, [BAND_END + 1000]);
    p.setLooping(false);
    assert.strictEqual(core.lastMaxLoopArg, 3,
      `expected the section floor 3, got ${core.lastMaxLoopArg}`);
  });

  await check('the player derives the joint count with no core-side section limit', async () => {
    const { p, core } = await makePlayer();
    p.setLooping(true);
    await drive(p, core, [BAND_END + 1000]);
    p.setLooping(false);
    // DEFAULT_LOOP_COUNT is 2; curLoop is the joint count the player derives.
    const curLoop = Math.max(0, Math.floor((core.abs - A) / B));
    assert.strictEqual(core.lastMaxLoopArg, Math.max(2, curLoop + 1),
      `expected the joint fallback, got ${core.lastMaxLoopArg}`);
  });

  // The engine's limit and the slider's pass count are the same unit now, so the
  // display cannot fold the band through the audible fade (greptile P2,
  // macroscope MDXPlayer.js:193).
  await check('the display and the engine agree on the joint section count', async () => {
    const { p, core } = await makePlayer({ perSection: 2 });
    p.setLooping(true);
    await drive(p, core, [BAND_END + 1000]);
    p.setLooping(false);
    const curLoop = Math.max(0, Math.floor((core.abs - A) / B));
    const sections = Math.max(2, curLoop + 1);
    assert.strictEqual(core.lastMaxLoopArg, sections, `engine limit=${core.lastMaxLoopArg}`);
    assert.strictEqual(p._maxLoopCount, sections, `display passes=${p._maxLoopCount}`);
    assert.strictEqual(p._fadeStartMs(), A + sections * B, `fadeStartMs=${p._fadeStartMs()}`);
  });

  console.log(`\n${passed} checks passed${xfailed ? `, ${xfailed} known failure(s)` : ''}${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
}

main();