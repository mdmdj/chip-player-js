#!/usr/bin/env node
/**
 * DEV-ONLY harness for the client-side ReplayGain manager.
 *
 * The important safety property is the local-file watchdog: a worker that never
 * answers (the wasm equivalent of a file hanging inside one C call) must be
 * terminated, the file must be cached as failed, and the gain must fall back to
 * unity. The catalog path must never create a worker at all.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const originalJs = require.extensions['.js'];
require.extensions['.js'] = function (mod, filename) {
  if (!filename.startsWith(SRC + path.sep)) return originalJs(mod, filename);
  // Node treats `import.meta` as ESM even after Babel's CJS transform, so
  // rewrite it for this Node-only harness.
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/import\.meta\.url/g, 'require("url").pathToFileURL(__filename).href');
  const out = babel.transformSync(source, {
    filename,
    presets: [
      ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
      '@babel/preset-react',
    ],
    sourceMaps: false,
    babelrc: false,
    configFile: false,
  });
  return mod._compile(out.code, filename);
};
require.extensions['.png'] = (mod) => { mod.exports = 'image'; };

global.window = global;
global.self = global;

const instances = [];
let mode = 'hang';
class FakeWorker {
  constructor() {
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    instances.push(this);
  }
  postMessage(message) {
    if (message.type !== 'analyze') return;
    if (mode === 'hang') return;
    const measurement = {
      lufs: -24,
      peakDb: -6,
      durationSec: 120,
      subtuneCount: 2,
      analyzedSubtunes: 2,
      status: 'ok',
      engine: 'fake',
      tracks: [
        { subtune: 0, lufs: -24, peakDb: -6, durationSec: 60, partial: false },
        { subtune: 1, lufs: -20, peakDb: -5, durationSec: 60, partial: false },
      ],
      file: { lufs: -22, peakDb: -5, durationSec: 120, trackCount: 2 },
    };
    setTimeout(() => {
      if (this.onmessage) this.onmessage({ data: { type: 'result', id: message.id, measurement } });
    }, 0);
  }
  terminate() { this.terminated = true; }
}
global.Worker = FakeWorker;

const ReplayGainModule = require('../src/ReplayGain');
const ReplayGain = ReplayGainModule.default;
const { resolveAutoMode } = ReplayGainModule;

function manager(settings, fetchServer = async () => null) {
  const changes = [];
  const rg = new ReplayGain({
    sampleRate: 48000,
    getSettings: () => settings,
    onChange: (change) => changes.push(change),
    fetchServer,
    analysisTimeoutMs: 40,
  });
  return { rg, changes };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // 1. A catalog lookup never starts the worker, and a complete row applies.
  {
    const { rg, changes } = manager(
      { volumeNormalization: 'song', normalizationTarget: -18 },
      async () => ({ track: { lufs: -30, peakDb: -12, status: 'ok' }, album: null, subtuneCount: 1 }),
    );
    const workersBefore = instances.length;
    rg.setSong({ filepath: 'spc/track.spc', subtune: 0, buffer: new Uint8Array(100) });
    await sleep(20);
    assert.strictEqual(instances.length, workersBefore, 'catalog lookup must not create a worker');
    const applied = changes.filter(c => c.source === 'song').pop();
    assert.ok(applied, 'catalog track gain applied');
    assert.ok(Math.abs(applied.gainDb - 11) < 0.2, `expected roughly +11 dB, got ${applied.gainDb}`);
  }

  // 2. A missing catalog row plays at unity and does not create a worker.
  {
    const { rg, changes } = manager(
      { volumeNormalization: 'song', normalizationTarget: -18 },
      async () => null,
    );
    const workersBefore = instances.length;
    rg.setSong({ filepath: 'spc/missing.spc', subtune: 0, buffer: new Uint8Array(100) });
    await sleep(20);
    assert.strictEqual(instances.length, workersBefore, 'missing catalog row must not create a worker');
    const applied = changes[changes.length - 1];
    assert.strictEqual(applied.source, 'off', 'missing row stays neutral');
    assert.strictEqual(applied.linear, 1, 'missing row has unity gain');
  }

  // 3. Album mode uses the complete album row; an incomplete album falls back
  //    to the track.
  {
    const response = {
      track: { lufs: -30, peakDb: -12, status: 'ok' },
      album: { kind: 'directory', status: 'complete', lufs: -22, peakDb: -5 },
      subtuneCount: 1,
    };
    const { rg, changes } = manager(
      { volumeNormalization: 'album', normalizationTarget: -18 },
      async () => response,
    );
    rg.setSong({ filepath: 'spc/track.spc', subtune: 0, buffer: new Uint8Array(100) });
    await sleep(20);
    const album = changes.filter(c => c.source === 'album').pop();
    assert.ok(album, 'album gain applied');
    assert.ok(Math.abs(album.gainDb - 4) < 0.2, `expected +4 dB album gain, got ${album.gainDb}`);
  }

  // 4. The watchdog terminates a hung local worker and caches a timeout.
  {
    mode = 'hang';
    const { rg, changes } = manager({ volumeNormalization: 'song', normalizationTarget: -18 });
    const before = instances.length;
    rg.setSong({
      filepath: 'local/hang.nsf',
      subtune: 0,
      buffer: new Uint8Array(1000),
      isLocal: true,
    });
    await sleep(120);
    assert.strictEqual(instances.length, before + 1, 'one local worker created');
    assert.strictEqual(instances[before].terminated, true, 'hung worker terminated');
    assert.strictEqual(rg.local.status, 'timeout', 'timeout cached');
    assert.ok(rg.local.retryAfter > Date.now(), 'timeout has a retry window');
    const last = changes[changes.length - 1];
    assert.strictEqual(last.linear, 1, 'timeout leaves the output at unity');
  }

  // 5. Local album mode measures all sub-tunes and uses the file aggregate.
  {
    mode = 'respond';
    const { rg, changes } = manager({ volumeNormalization: 'album', normalizationTarget: -18 });
    rg.setSong({
      filepath: 'local/multi.nsf',
      subtune: 1,
      buffer: new Uint8Array(1000),
      isLocal: true,
    });
    await sleep(60);
    const album = changes.filter(c => c.source === 'album').pop();
    assert.ok(album, 'local multi-song album gain applied');
    assert.ok(Math.abs(album.gainDb - 4) < 0.2, `expected file aggregate +4 dB, got ${album.gainDb}`);
    assert.strictEqual(rg.local.subtuneCount, 2, 'both sub-tunes recorded');
    assert.strictEqual(rg.local.allSubtunes, true, 'album scan records all sub-tunes');
  }

  // 6. Auto mode: one album in the context -> album, mixed -> song. A song
  // folder (one path, several sub-tunes) is one album; a directory of several
  // song folders is several albums.
  {
    assert.strictEqual(resolveAutoMode([{ path: 'spc/A/01.spc', subtune: 0 }]), 'song', 'one song -> song');
    assert.strictEqual(resolveAutoMode([
      { path: 'spc/Album/01.spc', subtune: 0 },
      { path: 'spc/Album/02.spc', subtune: 0 },
    ]), 'album', 'one directory -> album');
    assert.strictEqual(resolveAutoMode([
      { path: 'nsfe/a.nsfe', subtune: 0 },
      { path: 'nsfe/a.nsfe', subtune: 1 },
    ]), 'album', 'one song folder -> album');
    assert.strictEqual(resolveAutoMode([
      { path: 'spc/A/01.spc', subtune: 0 },
      { path: 'spc/B/01.spc', subtune: 0 },
    ]), 'song', 'two directories -> song');
    assert.strictEqual(resolveAutoMode([
      { path: 'nsfe/a.nsfe', subtune: 0 },
      { path: 'nsfe/a.nsfe', subtune: 1 },
      { path: 'nsfe/b.nsfe', subtune: 0 },
      { path: 'nsfe/b.nsfe', subtune: 1 },
    ]), 'song', 'two song folders -> song');

    const response = {
      track: { lufs: -30, peakDb: -12, status: 'ok' },
      album: { kind: 'directory', status: 'complete', lufs: -22, peakDb: -5 },
      subtuneCount: 1,
    };
    const settings = { volumeNormalization: 'auto', normalizationTarget: -18 };
    const oneAlbum = manager(settings, async () => response);
    oneAlbum.rg.setSong({
      filepath: 'spc/Album/01.spc',
      subtune: 0,
      buffer: new Uint8Array(100),
      context: [
        { path: 'spc/Album/01.spc', subtune: 0 },
        { path: 'spc/Album/02.spc', subtune: 0 },
      ],
    });
    await sleep(20);
    const autoAlbum = oneAlbum.changes.filter(c => c.source === 'album').pop();
    assert.ok(autoAlbum, 'auto chose album for one album context');

    const mixed = manager(settings, async () => response);
    mixed.rg.setSong({
      filepath: 'spc/A/01.spc',
      subtune: 0,
      buffer: new Uint8Array(100),
      context: [
        { path: 'spc/A/01.spc', subtune: 0 },
        { path: 'spc/B/01.spc', subtune: 0 },
      ],
    });
    await sleep(20);
    const autoSong = mixed.changes.filter(c => c.source === 'song').pop();
    assert.ok(autoSong, 'auto chose song for a mixed context');
  }

  console.log('ok    loudness client: catalog lookup, missing row, album, auto, watchdog, local album');
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
