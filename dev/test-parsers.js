#!/usr/bin/env node
// DEV-ONLY test harness for the sub-tune metadata parsers.
//
// Uses synthetic buffers for edge cases and (when present) real files under
// catalog/ for integration coverage. Run: node dev/test-parsers.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseMetadata } = require('../scripts/metadata-parsers');

const CATALOG = path.join(__dirname, '..', 'catalog');

const { buildNSF, buildNSFe, buildSID, buildGBS, buildAY } = require('./fixtures');

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

console.log('NSF (synthetic)');
check('single song', () => {
  const m = parseMetadata(buildNSF({ numSongs: 1, title: 'Tetris', artist: 'Nintendo', copyright: '1989' }), 'nsf');
  assert.strictEqual(m.numSongs, 1);
  assert.strictEqual(m.startingSong, 1);
  assert.strictEqual(m.title, 'Tetris');
  assert.strictEqual(m.system, 'NES');
});
check('multiple songs + starting song', () => {
  const m = parseMetadata(buildNSF({ numSongs: 12, startingSong: 3, title: 'Game', artist: 'A', copyright: '' }), 'nsf');
  assert.strictEqual(m.numSongs, 12);
  assert.strictEqual(m.startingSong, 3);
});
check('missing count defaults to 1', () => {
  const m = parseMetadata(buildNSF({ numSongs: 0, title: 'X', artist: '', copyright: '' }), 'nsf');
  assert.strictEqual(m.numSongs, 1);
});

console.log('NSFE (synthetic)');
check('INFO counts + track labels + auth metadata', () => {
  const m = parseMetadata(buildNSFe({
    numSongs: 3,
    startingSong: 2,
    game: 'My Game',
    artist: 'Composer',
    copyright: '1992',
    labels: ['Title Theme', 'Overworld', 'Boss Battle'],
  }), 'nsfe');
  assert.deepStrictEqual(m.trackLabels, ['Title Theme', 'Overworld', 'Boss Battle']);
  assert.strictEqual(m.numSongs, 3);
  assert.strictEqual(m.startingSong, 2);
  assert.strictEqual(m.title, 'Title Theme');
  assert.strictEqual(m.game, 'My Game');
  assert.strictEqual(m.artist, 'Composer');
});
check('single empty label is not a track', () => {
  const m = parseMetadata(buildNSFe({ numSongs: 1, game: 'G', artist: 'A', copyright: 'C', labels: [''] }), 'nsfe');
  assert.strictEqual(m.trackLabels, undefined);
  assert.strictEqual(m.numSongs, 1);
});
check('nsfe falls back to nsf parser on non-NSFE bytes', () => {
  const m = parseMetadata(buildNSF({ numSongs: 5, title: 'T', artist: '', copyright: '' }), 'nsfe');
  assert.strictEqual(m.numSongs, 5);
});
check('playlist remaps and reorders physical tracks', () => {
  // 5 physical tracks, but the playlist exposes only 3, reordered.
  const m = parseMetadata(buildNSFe({
    numSongs: 5,
    game: 'G',
    artist: 'A',
    copyright: 'C',
    labels: ['T0', 'T1', 'T2', 'T3', 'T4'],
    playlist: [4, 2, 0],
  }), 'nsfe');
  assert.strictEqual(m.numSongs, 3);
  assert.deepStrictEqual(m.trackLabels, ['T4', 'T2', 'T0']);
});
check('no playlist exposes all physical tracks', () => {
  const m = parseMetadata(buildNSFe({
    numSongs: 4,
    game: 'G',
    artist: 'A',
    copyright: 'C',
    labels: ['A', 'B', 'C', 'D'],
  }), 'nsfe');
  assert.strictEqual(m.numSongs, 4);
  assert.deepStrictEqual(m.trackLabels, ['A', 'B', 'C', 'D']);
});

check('labels stay aligned when some tracks are unlabeled', () => {
  // One label for three tracks: the label belongs to track 0, not compressed up.
  const m = parseMetadata(buildNSFe({ numSongs: 3, game: 'G', artist: 'A', copyright: 'C', labels: ['Only One'] }), 'nsfe');
  assert.strictEqual(m.numSongs, 3);
  assert.deepStrictEqual(m.trackLabels, ['Only One', null, null]);
});

console.log('SID (synthetic)');
check('single subtune', () => {
  const m = parseMetadata(buildSID({ numSongs: 1, name: 'Commando', author: 'Rob Hubbard', released: '1985' }), 'sid');
  assert.strictEqual(m.numSongs, 1);
  assert.strictEqual(m.title, 'Commando');
  assert.strictEqual(m.artist, 'Rob Hubbard');
  assert.strictEqual(m.system, 'C64');
});
check('multi subtune count', () => {
  const m = parseMetadata(buildSID({ numSongs: 4, name: 'M', author: 'A', released: 'R', speedBits: 0b0101 }), 'sid');
  assert.strictEqual(m.numSongs, 4);
  // The per-song PAL/NTSC table (in the 32-bit field at 0x12) is not exposed:
  // nothing consumes it, and the old offset sat inside the title.
  assert.strictEqual(m.speeds, undefined);
});
check('rejects missing signature', () => {
  const m = parseMetadata(Buffer.alloc(0x100), 'sid');
  assert.strictEqual(m.system, 'C64');
  assert.strictEqual(m.numSongs, undefined);
});

console.log('GBS (synthetic)');
check('multi-song counts + strings + date', () => {
  const m = parseMetadata(buildGBS({ numSongs: 35, startingSong: 1, title: 'Metal Gear Solid', artist: 'Konami', copyright: '2000' }), 'gbs');
  assert.strictEqual(m.numSongs, 35);
  assert.strictEqual(m.startingSong, 1);
  assert.strictEqual(m.title, 'Metal Gear Solid');
  assert.strictEqual(m.artist, 'Konami');
  assert.strictEqual(m.system, 'Game Boy');
  assert.strictEqual(m.date, '2000-01-01');
});
check('missing count defaults to 1', () => {
  const m = parseMetadata(buildGBS({ numSongs: 0, title: 'X', artist: '', copyright: '' }), 'gbs');
  assert.strictEqual(m.numSongs, 1);
});
check('rejects short buffer', () => {
  const m = parseMetadata(Buffer.alloc(0x10), 'gbs');
  assert.strictEqual(m.numSongs, undefined);
});
check('rejects a bad signature, not just a short buffer', () => {
  const bad = buildGBS({ numSongs: 2, title: 'X' });
  bad.write('XXX', 0, 'ascii');
  const m = parseMetadata(bad, 'gbs');
  assert.strictEqual(m.numSongs, undefined);
});
check('placeholder-only fields ("?" / "<?>") are stored as absent', () => {
  const m = parseMetadata(buildGBS({ numSongs: 2, title: '<?>', artist: '?', copyright: '???' }), 'gbs');
  assert.strictEqual(m.title, '');
  assert.strictEqual(m.artist, '');
  assert.strictEqual(m.copyright, '');
  assert.strictEqual(m.date, null);
});
check('a value that merely contains "?" is kept', () => {
  const m = parseMetadata(buildGBS({ numSongs: 2, title: 'Continue?', artist: 'Yuzo Koshiro(?)', copyright: '' }), 'gbs');
  assert.strictEqual(m.title, 'Continue?');
  assert.strictEqual(m.artist, 'Yuzo Koshiro(?)');
});

console.log('AY (synthetic)');
check('multi-track counts + per-track labels', () => {
  const m = parseMetadata(buildAY({ numSongs: 3, firstTrack: 0, author: 'Tim Follin', comment: 'Game', labels: ['Menu', 'Level 1', 'Boss'] }), 'ay');
  assert.strictEqual(m.numSongs, 3);
  assert.strictEqual(m.startingSong, 1);
  assert.deepStrictEqual(m.trackLabels, ['Menu', 'Level 1', 'Boss']);
  assert.strictEqual(m.title, 'Menu');
  assert.strictEqual(m.artist, 'Tim Follin');
  assert.strictEqual(m.system, 'ZX Spectrum');
});
check('single track still yields its label as title', () => {
  const m = parseMetadata(buildAY({ numSongs: 1, labels: ['Only'] }), 'ay');
  assert.strictEqual(m.numSongs, 1);
  assert.strictEqual(m.title, 'Only');
});
check('an offset pointing before the buffer is treated as absent', () => {
  const bytes = buildAY({ numSongs: 2, author: 'Tim Follin', comment: 'Game', labels: ['Menu', 'Level 1'] });
  // The author field (0x0C) and each track entry's name offset are signed and
  // relative to their own position. -0x400 points before byte 0; subarray() used
  // to resolve that from the buffer's end and return trailing bytes as the
  // string, so the tail's text could surface as the author or a sub-tune label.
  bytes.writeInt16BE(-0x400, 0x0C);
  const tracksPos = 0x12 + bytes.readInt16BE(0x12);
  bytes.writeInt16BE(-0x400, tracksPos);
  const m = parseMetadata(bytes, 'ay');
  assert.strictEqual(m.artist, undefined, `author came from the tail: ${JSON.stringify(m.artist)}`);
  assert.strictEqual(m.trackLabels[0], null, 'the invalid label is absent, not the tail');
  assert.strictEqual(m.title, undefined, 'no title is taken from an invalid label');
});
check('rejects missing signature', () => {
  const m = parseMetadata(Buffer.alloc(0x40), 'ay');
  assert.strictEqual(m.system, 'ZX Spectrum');
  assert.strictEqual(m.numSongs, undefined);
});

console.log('Date extraction (synthetic)');
check('NSF year from copyright', () => {
  const m = parseMetadata(buildNSF({ numSongs: 1, title: 'T', artist: '', copyright: '1988 Konami' }), 'nsf');
  assert.strictEqual(m.date, '1988-01-01');
});
check('NSFE full date from copyright', () => {
  const m = parseMetadata(buildNSFe({ numSongs: 1, game: 'G', artist: 'A', copyright: '1988-12-16' }), 'nsfe');
  assert.strictEqual(m.date, '1988-12-16');
});
check('range takes the first year', () => {
  const m = parseMetadata(buildNSFe({ numSongs: 1, game: 'G', artist: 'A', copyright: '2008-2009' }), 'nsfe');
  assert.strictEqual(m.date, '2008-01-01');
});
check('SID year from released', () => {
  const m = parseMetadata(buildSID({ numSongs: 1, name: 'N', author: 'A', released: '2001 SHAPE/Blues Muz\'' }), 'sid');
  assert.strictEqual(m.date, '2001-01-01');
});
check('no year means no date', () => {
  const m = parseMetadata(buildNSF({ numSongs: 1, title: 'T', artist: '', copyright: 'Nintendo' }), 'nsf');
  assert.strictEqual(m.date, null);
});
check('impossible dates fall back to a valid part', () => {
  const m = parseMetadata(buildNSF({ numSongs: 1, title: 'T', artist: '', copyright: '2023-02-31' }), 'nsf');
  assert.strictEqual(m.date, '2023-02-01');
});

console.log('Real files under catalog/ (skipped if absent)');
function realTest(label, globDir, ext, assertions) {
  const dir = path.join(CATALOG, globDir);
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.' + ext));
  if (files.length === 0) return;
  check(label, () => {
    for (const f of files) {
      const m = parseMetadata(fs.readFileSync(path.join(dir, f)), ext);
      assertions(m, f);
    }
  });
}

realTest('SID files have plausible metadata', 'sid', 'sid', (m, f) => {
  assert.ok(m.numSongs >= 1, `${f}: numSongs`);
  assert.ok(m.title && m.title.length > 0, `${f}: title empty`);
  // artist may be unknown; a bare "<?>"/"?" is normalized to absent by cleanString.
});

realTest('RSID files parse like PSID (counts)', 'sid', 'sid', (m, f) => {
  if (!f.startsWith('RSID_')) return;
  assert.ok(m.numSongs > 1, `${f}: expected multi-song RSID, got ${m.numSongs}`);
});

realTest('NSF files have plausible metadata', 'nsf', 'nsf', (m, f) => {
  assert.ok(m.numSongs >= 1, `${f}: numSongs`);
  assert.ok(m.title && m.title.length > 0, `${f}: title empty`);
});

realTest('NSFE files expose track labels', 'nsfe', 'nsfe', (m, f) => {
  assert.ok(m.numSongs >= 1, `${f}: numSongs`);
  assert.ok(m.title && m.title.length > 0, `${f}: title empty`);
  if (m.numSongs > 1) {
    assert.ok(Array.isArray(m.trackLabels), `${f}: missing trackLabels for ${m.numSongs} songs`);
    assert.ok(m.trackLabels.length >= 1, `${f}: empty trackLabels`);
  }
});

realTest('GBS files have plausible counts', 'gbs', 'gbs', (m, f) => {
  assert.ok(m.numSongs >= 1, `${f}: numSongs`);
  assert.ok(m.title && m.title.length > 0, `${f}: title empty`);
});

realTest('AY files expose track counts and labels', 'ay', 'ay', (m, f) => {
  assert.ok(m.numSongs >= 1, `${f}: numSongs`);
  if (m.numSongs > 1) {
    assert.ok(Array.isArray(m.trackLabels), `${f}: missing trackLabels for ${m.numSongs} tracks`);
    assert.strictEqual(m.trackLabels.length, m.numSongs, `${f}: label/track mismatch`);
  }
});

// The client imports scripts/subtune-headers.js directly (a lazy chunk) and
// passes a Uint8Array, not a Node Buffer. These checks reuse the catalog files
// on disk to prove that path: the module is buffer-agnostic, and its sub-tune
// output matches the build's own parseMetadata path.
console.log('Shared sub-tune module (the client path: Uint8Array, no Buffer)');
const { describeSubtunes, describeSubtunesInBuffer } = require('../scripts/subtune-headers');
const SAMPLE_DIRS = [['nsf', 'nsf'], ['nsfe', 'nsfe'], ['sid', 'sid'], ['gbs', 'gbs'], ['ay', 'ay']];
const samples = [];
for (const [dir, ext] of SAMPLE_DIRS) {
  const d = path.join(CATALOG, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (f.toLowerCase().endsWith('.' + ext)) samples.push([ext, path.join(d, f), f]);
  }
}
if (samples.length === 0) {
  console.log('  (skipped: no catalog files)');
} else {
  check('a Uint8Array gives the same sub-tunes as a Buffer', () => {
    for (const [ext, p, f] of samples) {
      const buf = fs.readFileSync(p);
      const u8 = Uint8Array.from(buf); // the browser's byte view, not a Buffer
      assert.deepStrictEqual(
        describeSubtunesInBuffer(ext, u8),
        describeSubtunesInBuffer(ext, buf),
        `${f}: Uint8Array vs Buffer`);
    }
  });
  check('the shared module agrees with the build path (parseMetadata)', () => {
    for (const [ext, p, f] of samples) {
      const buf = fs.readFileSync(p);
      assert.deepStrictEqual(
        describeSubtunesInBuffer(ext, Uint8Array.from(buf)),
        describeSubtunes(ext, parseMetadata(buf, ext)),
        `${f}: shared module vs build path`);
    }
  });
  check('a real multi-song file lists its sub-tunes with 0-based indices', () => {
    const multi = samples.find(([ext, p]) =>
      describeSubtunesInBuffer(ext, Uint8Array.from(fs.readFileSync(p))).length > 1);
    assert.ok(multi, 'no multi-song catalog file found');
    const [ext, p, f] = multi;
    const subs = describeSubtunesInBuffer(ext, Uint8Array.from(fs.readFileSync(p)));
    assert.ok(subs.length > 1, `${f}: expected >1 sub-tunes`);
    subs.forEach((s, i) => assert.strictEqual(s.subtune, i, `${f}: index ${i}`));
  });
}

console.log(`\n${passed} passed, ${failed} failed.`);
