#!/usr/bin/env node
// DEV-ONLY harness for the Local Files sub-tune cache (src/localFilesSubtunes.js).
//
//   node dev/test-local-subtunes.js
//
// Why it exists: the cache key comes from the Local Files listing, whose `mtime`
// is whole seconds (LocalFilesManager.readAll). A same-name, same-size replacement
// inside one second therefore looked like the same file, and the old header -- tune
// count and labels -- outlived the bytes: new sub-tunes stayed hidden until the
// key changed. The listing now also carries `mtimeMs`, and the key prefers it.
//
// The module is client code (window.localStorage, a dynamic import of the header
// parser), so the harness stubs localStorage and uses real NSF bytes. The parser
// is the same one the build uses, reached through the module's own import.
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');
const babel = require('@babel/core');

const ROOT = path.join(__dirname, '..');

// The client modules are ESM-source; transpile on require like the other
// harnesses do. It also turns the header parser's dynamic import into a require,
// which is what webpack does for the browser and what resolution here needs.
const compile = Module.prototype._compile;
Module.prototype._compile = function (code, filename) {
  if (filename.startsWith(ROOT) && !filename.includes('node_modules') && /\.jsx?$/.test(filename)) {
    code = babel.transformSync(code, {
      filename, configFile: false,
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    }).code;
  }
  return compile.call(this, code, filename);
};

// --- localStorage, in-memory -------------------------------------------------
const store = {};
global.window = {
  localStorage: {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};

const { describeLocalSubtunes } = require(path.join(ROOT, 'src', 'localFilesSubtunes'));

let passed = 0;
let failed = 0;
const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push([name, fn]);
}

// A minimal 128-byte NSF: the song count lives at 0x06, and there are no labels in
// the format, so the parsed list's length is the count.
function nsf(trackCount, title) {
  const b = new Uint8Array(128);
  const magic = 'NESM\x1A';
  for (let i = 0; i < 5; i++) b[i] = magic.charCodeAt(i);
  b[0x05] = 1;                                  // version
  b[0x06] = trackCount;
  b[0x07] = 1;                                  // starting song, 1-based
  b[0x08] = 0x00; b[0x09] = 0x80;               // load address
  b[0x0A] = 0x00; b[0x0B] = 0x80;               // init
  b[0x0C] = 0x00; b[0x0D] = 0x80;               // play
  for (let i = 0; i < title.length && i < 32; i++) b[0x0E + i] = title.charCodeAt(i);
  return b;
}

const A = nsf(3, 'old');
const B = nsf(7, 'new');
const count = (m, p = 'local/rev.nsf') => (m.get(p) || []).length;

checkAsync('a same-size replacement inside one second is re-parsed', async () => {
  // Same path, same size, same whole second -- the listing's `mtime` cannot tell
  // these apart, which is what the bug was. The full timestamp can.
  const base = { path: 'local/rev.nsf', size: 128, mtime: 1700000000 };
  let reads = 0;
  const first = await describeLocalSubtunes([{ ...base, mtimeMs: 1700000000000 }],
    () => { reads++; return A; });
  assert.strictEqual(count(first), 3, 'the 3-track file describes 3 songs');
  assert.strictEqual(reads, 1);
  const second = await describeLocalSubtunes([{ ...base, mtimeMs: 1700000000500 }],
    () => { reads++; return B; });
  assert.strictEqual(count(second), 7,
    'the replacement must be read again, not answered from the old header');
  assert.strictEqual(reads, 2, 'the new file was read');
});

checkAsync('and the cache still short-circuits an unchanged file', async () => {
  const file = { path: 'local/rev.nsf', size: 128, mtime: 1700000000, mtimeMs: 1700000000500 };
  let reads = 0;
  const again = await describeLocalSubtunes([file], () => { reads++; return B; });
  assert.strictEqual(count(again), 7, 'the cached header is reused');
  assert.strictEqual(reads, 0, 'and the bytes are not read at all');
});

// The fallback is deliberate: a caller with only seconds still caches, it just
// cannot see a same-second replacement. Pinned here so the choice is visible.
checkAsync('seconds alone still cache (the documented fallback)', async () => {
  // Fresh buffers, not the ones above: this check is about the key, and reusing a
  // buffer the parser has already walked would measure the harness instead.
  const A2 = nsf(3, 'old2');
  const B2 = nsf(7, 'new2');
  const file = { path: 'local/rev2.nsf', size: 128, mtime: 1700000001 };
  const one = await describeLocalSubtunes([file], () => A2);
  const two = await describeLocalSubtunes([file], () => B2);
  assert.strictEqual(count(one, 'local/rev2.nsf'), 3);
  assert.strictEqual(count(two, 'local/rev2.nsf'), 3, 'seconds alone cannot tell the two apart');
});

(async () => {
  for (const [name, fn] of asyncChecks) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
})();
