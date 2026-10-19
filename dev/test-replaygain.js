#!/usr/bin/env node
/**
 * DEV-ONLY harness for the replaygain feature.
 *
 * It drives the exact analyzer the worker uses, on the real engine core, and
 * asserts the numbers that matter: the measured spread across the ear-labelled
 * samples, the peak-safe gain that closes most of it, and album aggregation.
 *
 * The sample files live under catalog/replaygain-samples; without a real
 * chip-core (a fresh tree may still have the silent stub) the harness reports
 * itself skipped instead of failing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CORE_JS = path.join(SRC, 'chip-core.js');
const CORE_WASM = path.join(SRC, 'chip-core.wasm');
const SAMPLE_ROOT = path.join(ROOT, 'catalog', 'replaygain-samples');

// Same inline require hook the other client-code harnesses use: the client is
// ESM/JSX and the repo has no test runner.
const originalJs = require.extensions['.js'];
require.extensions['.js'] = function (mod, filename) {
  if (!filename.startsWith(SRC + path.sep)) return originalJs(mod, filename);
  const source = fs.readFileSync(filename, 'utf8');
  const out = babel.transformSync(source, {
    filename,
    presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]],
    sourceMaps: false,
  });
  return mod._compile(out.code, filename);
};
require.extensions['.png'] = (mod) => { mod.exports = 'image'; };

global.window = global;
global.self = global;
global.window.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
global.window.cancelIdleCallback = (id) => clearTimeout(id);

const {
  LoudnessMeter,
  gainFromMeasurement,
  albumFromTracks,
  PEAK_CEILING_DB,
} = require('../src/loudness');
const { createLoudnessAnalyzer } = require('../src/loudness-analysis');

const SAMPLE_RATE = 48000;
const TARGET_LUFS = -18;

function listSamples(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSamples(full));
    else if (/\.(spc|nsf|nsfe|vgm|vgz|mod|xm|it|s3m|mdx|v2m|sid|mid|midi|gsf|minigsf|miniusf|gbs|ay)$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

async function loadCore() {
  if (!fs.existsSync(CORE_JS) || !fs.existsSync(CORE_WASM)) return null;
  if (fs.statSync(CORE_WASM).size < 100000) return null; // the dev stub has no wasm
  const { pathToFileURL } = require('url');
  const { default: ChipCore } = await import(pathToFileURL(CORE_JS).href);
  const wasm = fs.readFileSync(CORE_WASM);
  return ChipCore({
    instantiateWasm(imports, success) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports);
      success(instance);
      return instance.exports;
    },
  });
}

function sine(amplitude, seconds = 2) {
  const meter = new LoudnessMeter(SAMPLE_RATE);
  const frames = SAMPLE_RATE * seconds;
  for (let i = 0; i < frames; i++) {
    const v = amplitude * Math.sin(2 * Math.PI * 1000 * i / SAMPLE_RATE);
    meter.processFrame(v, v);
  }
  return meter.result();
}

async function main() {
  // 1. Meter sanity: doubling the amplitude is +6.02 dB, and a short buffer is
  // still measurable (the 400 ms gating block is longer than many jingles).
  const quietSine = sine(0.05);
  const loudSine = sine(0.1);
  assert.ok(Number.isFinite(quietSine.lufs), 'a sine has a finite loudness');
  assert.ok(
    Math.abs((loudSine.lufs - quietSine.lufs) - 6.0206) < 0.1,
    `doubling amplitude should add 6.02 dB (got ${(loudSine.lufs - quietSine.lufs).toFixed(2)})`,
  );
  assert.ok(quietSine.peakDb > -27 && quietSine.peakDb < -25.9, 'peak reflects the sample amplitude');

  // 2. Gain math is testable without an engine core.
  const hot = { lufs: -10, peakDb: -0.5 };
  const hotGain = gainFromMeasurement(hot, TARGET_LUFS);
  assert.ok(hotGain.gainDb < 0, 'a loud track is turned down');
  assert.ok(hot.peakDb + hotGain.gainDb <= PEAK_CEILING_DB + 0.01, 'peak ceiling');
  const quiet = { lufs: -30, peakDb: -12 };
  const quietGain = gainFromMeasurement(quiet, TARGET_LUFS);
  assert.strictEqual(quietGain.limitedBy, 'peak');
  assert.ok(Math.abs(quiet.peakDb + quietGain.gainDb - PEAK_CEILING_DB) < 0.01, 'boost stops at the ceiling');

  const core = await loadCore();
  const samples = listSamples(SAMPLE_ROOT);
  if (!core || samples.length === 0) {
    console.log('skip  engine measurements: no real chip-core or no sample folder in this tree');
    return;
  }

  // 3. Real measurements through the real engines.
  const analyze = createLoudnessAnalyzer(core, SAMPLE_RATE);
  const oldDebug = console.debug;
  console.debug = () => {};
  const measurements = [];
  try {
    for (const file of samples) {
      const relpath = path.relative(path.join(ROOT, 'catalog'), file);
      const measurement = await analyze(fs.readFileSync(file), relpath);
      measurements.push({ file, relpath, measurement });
      console.log(
        `${relpath}: ${measurement.lufs.toFixed(1)} LUFS, peak ${measurement.peakDb.toFixed(1)} dBFS, ` +
        `${measurement.durationSec.toFixed(0)} s`,
      );
    }
  } finally {
    console.debug = oldDebug;
  }
  assert.ok(measurements.length >= 8, `expected the labelled samples (got ${measurements.length})`);

  const lufs = measurements.map(m => m.measurement.lufs);
  const rawSpread = Math.max(...lufs) - Math.min(...lufs);
  console.log(`raw spread: ${rawSpread.toFixed(1)} dB`);
  assert.ok(rawSpread > 7, `the samples should span a wide range (got ${rawSpread.toFixed(1)} dB)`);

  const gains = measurements.map(({ relpath, measurement }) => {
    const gain = gainFromMeasurement(measurement, TARGET_LUFS);
    return { relpath, measurement, gain };
  });

  for (const { relpath, measurement, gain } of gains) {
    const outputPeak = measurement.peakDb + gain.gainDb;
    assert.ok(
      outputPeak <= PEAK_CEILING_DB + 0.01,
      `${relpath}: gain must leave the peak at or below ${PEAK_CEILING_DB} dBFS (got ${outputPeak.toFixed(2)})`,
    );
    assert.ok(gain.gainDb >= -24 && gain.gainDb <= 24, `${relpath}: gain stays bounded`);
  }
  const normalized = gains.map(({ measurement, gain }) => measurement.lufs + gain.gainDb);
  const normalizedSpread = Math.max(...normalized) - Math.min(...normalized);
  console.log(`peak-safe spread after -18 LUFS normalization: ${normalizedSpread.toFixed(1)} dB`);
  assert.ok(
    normalizedSpread < rawSpread - 5,
    `normalization should close most of the loudness gap (${rawSpread.toFixed(1)} -> ${normalizedSpread.toFixed(1)})`,
  );
  assert.ok(normalizedSpread < 4.0, `peak-safe normalized spread should be under 4 dB (got ${normalizedSpread.toFixed(1)})`);

  // 3. Album gain: duration-weighted, and its gain is peak-safe too.
  const folders = new Map();
  for (const item of measurements) {
    const dir = path.dirname(item.relpath);
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir).push(item.measurement);
  }
  for (const [dir, tracks] of folders) {
    const album = albumFromTracks(tracks);
    assert.ok(album, `${dir}: album measurement`);
    assert.ok(album.trackCount === tracks.length, `${dir}: every track contributes`);
    const gain = gainFromMeasurement(album, TARGET_LUFS);
    assert.ok(
      album.peakDb + gain.gainDb <= PEAK_CEILING_DB + 0.01,
      `${dir}: album gain is peak-safe`,
    );
    console.log(
      `${dir}: album ${album.lufs.toFixed(1)} LUFS over ${album.trackCount} tracks, ` +
      `gain ${gain.gainDb >= 0 ? '+' : ''}${gain.gainDb.toFixed(1)} dB`,
    );
  }

  // 4. A silent measurement must not invent a huge boost.
  const silence = new LoudnessMeter(SAMPLE_RATE).result();
  assert.ok(silence.lufs < -100, 'silence measures as silence');
  const silenceGain = gainFromMeasurement(silence, TARGET_LUFS);
  assert.ok(silenceGain.gainDb === 24, 'bounded gain for an empty measurement');
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
