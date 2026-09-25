#!/usr/bin/env node
// DEV-ONLY round-trip test for scripts/build-music.js.
//
// Writes synthetic multi-song files into a temp catalog subdir, runs the
// builder filtered to that subdir (twice, to exercise the reprocess path),
// then asserts the resulting music/subtune rows. Cleans up after itself.
// Run: node dev/test-build.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { buildNSF, buildNSFe, buildSID } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'catalog');
const DB_PATH = path.join(ROOT, 'server', 'catalog.db');
const FILTER = `__devtest_${process.pid}`;
const DIR = path.join(CATALOG, FILTER);
const LIKE = `${FILTER}/%`;

let passed = 0;
let failed = 0;
let db;
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

function runBuilder() {
  execFileSync(process.execPath, ['scripts/build-music.js', '--filter', FILTER, '-n'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function getMusic(suffix) {
  return db.prepare('SELECT id, subtune_count, release_date FROM music WHERE path = ?').get(`${FILTER}/${suffix}`);
}
function getSubtunes(musicId) {
  return db.prepare('SELECT subtune, title FROM subtune WHERE music_id = ? ORDER BY subtune').all(musicId);
}

function cleanup() {
  try {
    if (db) {
      db.prepare('DELETE FROM subtune WHERE music_id IN (SELECT id FROM music WHERE path LIKE ?)').run(LIKE);
      db.prepare('DELETE FROM music WHERE path LIKE ?').run(LIKE);
      db.prepare('DELETE FROM directories WHERE path = ? OR path LIKE ?').run(FILTER, LIKE);
      db.close();
      db = null;
    }
  } catch (e) {
    console.error('cleanup (db):', e.message);
  }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

try {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'multi.nsfe'), buildNSFe({
    numSongs: 3, game: 'Test Game', artist: 'A', copyright: '1989 Test',
    labels: ['Title A', 'Title B', 'Title C'],
  }));
  fs.writeFileSync(path.join(DIR, 'single.nsf'), buildNSF({
    numSongs: 1, title: 'Single', artist: 'A', copyright: '1985 Someone',
  }));
  fs.writeFileSync(path.join(DIR, 'multi.sid'), buildSID({
    numSongs: 10, name: 'Ten Tunes', author: 'A', released: '1987 Someone',
  }));

  console.log('build-music round-trip (synthetic)');
  runBuilder();
  runBuilder(); // reprocess: exercises subtune clearing + INSERT OR REPLACE

  db = new Database(DB_PATH);

  check('multi-song NSFE gets sub-tune rows with labels', () => {
    const m = getMusic('multi.nsfe');
    assert.ok(m, 'music row missing');
    assert.strictEqual(m.subtune_count, 3);
    const subs = getSubtunes(m.id);
    assert.strictEqual(subs.length, 3);
    assert.deepStrictEqual(subs.map(s => s.title), ['Title A', 'Title B', 'Title C']);
  });

  check('single-song NSF has no sub-tune rows', () => {
    const m = getMusic('single.nsf');
    assert.ok(m, 'music row missing');
    assert.strictEqual(m.subtune_count, 1);
    assert.strictEqual(getSubtunes(m.id).length, 0);
    assert.strictEqual(m.release_date, '1985-01-01');
  });

  check('unlabeled SID sub-tunes store NULL titles', () => {
    const m = getMusic('multi.sid');
    assert.ok(m, 'music row missing');
    assert.strictEqual(m.subtune_count, 10);
    const subs = getSubtunes(m.id);
    assert.strictEqual(subs.length, 10);
    assert.ok(subs.every(s => s.title === null), 'expected all titles NULL');
  });

  check('release dates are parsed from metadata', () => {
    assert.strictEqual(getMusic('multi.nsfe').release_date, '1989-01-01');
    assert.strictEqual(getMusic('multi.sid').release_date, '1987-01-01');
  });

  check('reprocessing is idempotent (no duplicate sub-tunes)', () => {
    const m = getMusic('multi.sid');
    const count = db.prepare('SELECT COUNT(*) c FROM subtune WHERE music_id = ?').get(m.id).c;
    assert.strictEqual(count, 10);
  });

  // Removing a multi-subtune file exercises the FK-safe orphan cleanup.
  fs.rmSync(path.join(DIR, 'multi.sid'));
  runBuilder();
  check('removing a multi-subtune file deletes its music + subtune rows', () => {
    const musicCount = db.prepare('SELECT COUNT(*) c FROM music WHERE path LIKE ?').get(LIKE).c;
    const subCount = db.prepare('SELECT COUNT(*) c FROM subtune st JOIN music m ON m.id = st.music_id WHERE m.path LIKE ?').get(LIKE).c;
    assert.strictEqual(musicCount, 2); // multi.nsfe + single.nsf
    assert.strictEqual(subCount, 3);   // multi.nsfe's three tunes
  });
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed.`);
