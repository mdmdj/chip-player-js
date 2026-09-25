#!/usr/bin/env node
// DEV-ONLY test harness for the sub-song metadata parsers.
//
// Uses synthetic buffers for edge cases and (when present) real files under
// catalog/ for integration coverage. Run: node dev/test-parsers.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseMetadata } = require('../scripts/metadata-parsers');

const CATALOG = path.join(__dirname, '..', 'catalog');

function buildNSF({ numSongs, startingSong = 1, title, artist, copyright }) {
  const buf = Buffer.alloc(0x80);
  buf.write('NESM', 0, 'ascii');
  buf[0x05] = 0x01;
  buf[0x06] = numSongs;
  buf[0x07] = startingSong;
  buf.write(title, 0x0E, 'latin1');
  buf.write(artist, 0x2E, 'latin1');
  buf.write(copyright, 0x4E, 'latin1');
  return buf;
}

function buildNSFe({ numSongs, startingSong = 1, game, artist, copyright, labels = [], playlist = null }) {
  const chunks = [];
  const pushChunk = (type, data) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length, 0);
    chunks.push(Buffer.concat([size, Buffer.from(type, 'ascii'), data]));
  };
  const cstr = (s) => Buffer.from(s + '\0', 'latin1');

  const info = Buffer.alloc(10);
  info[8] = numSongs;         // track_count (1-based count)
  info[9] = startingSong - 1; // first_track (0-based)
  pushChunk('INFO', info);
  pushChunk('auth', Buffer.concat([cstr(game), cstr(artist), cstr(copyright)]));
  if (labels.length > 0) {
    pushChunk('tlbl', Buffer.concat(labels.map(cstr)));
  }
  if (playlist) {
    pushChunk('plst', Buffer.from(playlist));
  }
  const nend = Buffer.concat([Buffer.alloc(4), Buffer.from('NEND', 'ascii')]);
  return Buffer.concat([Buffer.from('NSFE', 'ascii'), ...chunks, nend]);
}

function buildSID({ version = 2, numSongs, startingSong = 1, name, author, released, speedBits }) {
  const buf = Buffer.alloc(0x7C);
  buf.write('PSID', 0, 'ascii');
  buf.writeUInt16BE(version, 0x04);
  buf.writeUInt16BE(0x7C, 0x06); // data offset
  buf.writeUInt16BE(numSongs, 0x0E);
  buf.writeUInt16BE(startingSong, 0x10);
  buf.write(name, 0x16, 'latin1');
  buf.write(author, 0x36, 'latin1');
  buf.write(released, 0x56, 'latin1');
  if (version >= 2 && speedBits) {
    buf[0x18] = speedBits;
  }
  return buf;
}

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

console.log('SID (synthetic)');
check('single subtune', () => {
  const m = parseMetadata(buildSID({ numSongs: 1, name: 'Commando', author: 'Rob Hubbard', released: '1985' }), 'sid');
  assert.strictEqual(m.numSongs, 1);
  assert.strictEqual(m.title, 'Commando');
  assert.strictEqual(m.artist, 'Rob Hubbard');
  assert.strictEqual(m.system, 'C64');
});
check('multi subtune + packed PAL speed bits', () => {
  // Song 0 and 2 are PAL, song 1 and 3 are NTSC.
  const m = parseMetadata(buildSID({ numSongs: 4, name: 'M', author: 'A', released: 'R', speedBits: 0b0101 }), 'sid');
  assert.strictEqual(m.numSongs, 4);
  assert.deepStrictEqual(m.speeds, ['PAL', 'NTSC', 'PAL', 'NTSC']);
});
check('rejects missing signature', () => {
  const m = parseMetadata(Buffer.alloc(0x100), 'sid');
  assert.strictEqual(m.system, 'C64');
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
  assert.ok(m.artist && m.artist.length > 0, `${f}: artist empty`);
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

console.log(`\n${passed} passed, ${failed} failed.`);
