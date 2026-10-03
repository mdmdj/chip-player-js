#!/usr/bin/env node
// DEV-ONLY SongRef check: the client identity model sub-tunes rest on. A
// playable thing is { path, subtune }; everything else (highlights, favorites,
// React keys, the share link, the sequencer context) compares those, so a
// mistake here shows up as the wrong song playing rather than as an error.
// Run: node dev/test-songrefs.js
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

const {
  songRef, songRefKey, songRefsEqual, songRefListsEqual, getMetadataUrlForFilepath,
} = require('../src/util');

const NSFE = 'famicompo/Castlevania III - The Dracula X Chronicles/09 Big Bat Man.nsf';
const SONG = 'arcade/Ghosts\'N_Goblins (Arcade)/16 Hurry Up!.vgz';

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

check('a bare path becomes sub-tune 0', () => {
  assert.deepStrictEqual(songRef(SONG), { path: SONG, subtune: 0 });
  assert.deepStrictEqual(songRef(NSFE, 5), { path: NSFE, subtune: 5 });
});

check('an explicit sub-tune overrides the default', () => {
  assert.strictEqual(songRef(NSFE, 7).subtune, 7);
  assert.strictEqual(songRef(NSFE, 0).subtune, 0);
});

check('an existing ref or a browse row passes through unchanged', () => {
  const ref = { path: NSFE, subtune: 3 };
  assert.deepStrictEqual(songRef(ref), ref);
  assert.deepStrictEqual(songRef(ref, 9), ref, 'an object carries its own sub-tune');
  // A /browse sub-tune row: same shape as a ref.
  const row = { path: NSFE, name: 'Tune 4', subtune: 3, song_id: 'abc', type: 'file' };
  assert.deepStrictEqual(songRef(row), { path: NSFE, subtune: 3 });
});

check('a row without a sub-tune is sub-tune 0 (single-song files)', () => {
  const row = { path: SONG, type: 'file', song_id: 'xyz' };
  assert.strictEqual(songRef(row).subtune, 0);
  assert.strictEqual(songRef({ path: SONG, subtune: undefined }).subtune, 0);
  assert.strictEqual(songRef({ path: SONG, subtune: null }).subtune, 0);
});

check('null stays null, so callers can test for "no song"', () => {
  assert.strictEqual(songRef(null), null);
  assert.strictEqual(songRef(undefined), null);
  assert.strictEqual(songRefKey(null), null);
});

check('the key distinguishes sub-tunes of the same file', () => {
  assert.notStrictEqual(songRefKey(NSFE, 1), songRefKey(NSFE, 2));
  assert.notStrictEqual(songRefKey(NSFE, 0), songRefKey(SONG, 0));
  assert.strictEqual(songRefKey(NSFE, 3), songRefKey({ path: NSFE, subtune: 3 }));
});

check('the key cannot be faked by a crafted path (NUL separator)', () => {
  // Two different sub-tunes must never collide, whatever their names.
  const a = { path: 'x\u00001', subtune: 0 };
  const b = { path: 'x', subtune: 1 };
  assert.notStrictEqual(songRefKey(a), songRefKey(b));
  assert.notStrictEqual(songRefKey({ path: 'a/b', subtune: 0 }), songRefKey({ path: 'a', subtune: 0 }));
});

check('equality ignores ref identity but not content', () => {
  assert.ok(songRefsEqual({ path: NSFE, subtune: 2 }, { path: NSFE, subtune: 2 }));
  assert.ok(songRefsEqual(NSFE, { path: NSFE, subtune: 0 }));
  assert.ok(!songRefsEqual({ path: NSFE, subtune: 2 }, { path: NSFE, subtune: 3 }));
});

check('list equality is by content and order (the sequencer copies its context)', () => {
  const a = [songRef(NSFE, 0), songRef(NSFE, 1), songRef(SONG, 0)];
  const copy = [songRef(NSFE, 0), songRef(NSFE, 1), songRef(SONG, 0)];
  assert.notStrictEqual(a, copy, 'sanity: a different array object');
  assert.ok(songRefListsEqual(a, copy), 'same songs in the same order');

  const reordered = [copy[1], copy[0], copy[2]];
  assert.ok(!songRefListsEqual(a, reordered), 'order is part of the context');

  const swappedSubtune = [copy[0], songRef(NSFE, 2), copy[2]];
  assert.ok(!songRefListsEqual(a, swappedSubtune), 'a different sub-tune is a different song');

  assert.ok(!songRefListsEqual(a, copy.slice(0, 2)), 'different lengths differ');
  assert.ok(songRefListsEqual([], []));
  assert.ok(!songRefListsEqual(null, []), 'null is not an empty list');
});

check('the metadata URL carries the sub-tune only when asked', () => {
  const plain = getMetadataUrlForFilepath(SONG);
  assert.ok(!plain.includes('subtune='), `single song: ${plain}`);
  const withSub = getMetadataUrlForFilepath(NSFE, 4);
  assert.ok(withSub.endsWith('&subtune=4'), withSub);
  // Sub-tune 0 is still a sub-tune: an explicit 0 must be sent.
  assert.ok(getMetadataUrlForFilepath(NSFE, 0).endsWith('&subtune=0'));
  // A path with a space/#/% must still round-trip through the encoder.
  const tricky = getMetadataUrlForFilepath('midi/100% Pure Love.mid', 0);
  assert.ok(tricky.includes('path=midi%2F100%25%20Pure%20Love.mid'), tricky);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
