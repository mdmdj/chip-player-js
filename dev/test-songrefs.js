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
  songRef, songRefKey, songRefsEqual, songRefListsEqual, getMetadataUrlForFilepath, subtuneLabel,
  listingToContext,
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

check('a sub-tune names itself by index, or by the format label when it has one', () => {
  // The footer shows this for the sub-tunes the catalog has no label for, so
  // "same file title" doesn't stand in for "same tune".
  assert.strictEqual(subtuneLabel(0), 'Tune 1');
  assert.strictEqual(subtuneLabel(5), 'Tune 6');
  assert.strictEqual(subtuneLabel(null), 'Tune 1', 'a missing index is the first tune');
  assert.strictEqual(subtuneLabel(3, 'Stage 3'), 'Stage 3', 'a label wins over the index');
  assert.strictEqual(subtuneLabel(3, null), 'Tune 4');
});

check('a listing becomes one context entry per playable song (song folders expand)', () => {
  // The rows a /browse directory returns, in order: a directory (not playable),
  // a plain file, a song folder of three, then another file. The server gives a
  // playable row the context index it starts at -- a folder owns its `count`
  // slots (server/index.js) -- and that is the index a click hands to
  // playContext. Expansion and indexing have to agree or the click lands on the
  // wrong song.
  const items = [
    { type: 'directory', path: 'dir', idx: null, count: 0 },
    { type: 'file', path: 'a.mid', idx: 0, count: 0 },
    { type: 'songfolder', path: 'b.nsfe', idx: 1, count: 3 },
    { type: 'file', path: 'c.sid', idx: 4, count: 0 },
  ];
  const context = listingToContext(items);
  assert.deepStrictEqual(context, [
    { path: 'a.mid', subtune: 0 },
    { path: 'b.nsfe', subtune: 0 },
    { path: 'b.nsfe', subtune: 1 },
    { path: 'b.nsfe', subtune: 2 },
    { path: 'c.sid', subtune: 0 },
  ]);
  for (const item of items) {
    if (item.type === 'directory') continue;
    assert.strictEqual(context[item.idx].path, item.path, `${item.path} starts at ${item.idx}`);
    assert.strictEqual(context[item.idx].subtune, 0);
  }
});

check('a sub-tune row keeps its index; a folder with no count is one song', () => {
  // Browsing inside a song folder returns one row per sub-tune, each carrying its
  // own index -- those must not be flattened to 0.
  assert.deepStrictEqual(
    listingToContext([
      { type: 'file', path: 'x.gbs', subtune: 0 },
      { type: 'file', path: 'x.gbs', subtune: 7 },
    ]),
    [{ path: 'x.gbs', subtune: 0 }, { path: 'x.gbs', subtune: 7 }],
  );
  // A folder row with a missing or zero count is still one playable song.
  assert.deepStrictEqual(listingToContext([{ type: 'songfolder', path: 'y.nsfe', count: 0 }]),
    [{ path: 'y.nsfe', subtune: 0 }]);
  assert.deepStrictEqual(listingToContext(null), []);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);