#!/usr/bin/env node
/**
 * DEV-ONLY harness for the catalog loudness scanner.
 *
 * It runs the scanner against a snapshot of the real catalog, so it needs a real
 * chip-core (the stub measures silence) and the sample catalog. The snapshot is
 * important: the scanner writes rows, and this harness must never mutate the
 * catalog the app is using.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'server', 'catalog.db');
const CORE_WASM = path.join(ROOT, 'src', 'chip-core.wasm');
const SCANNER = path.join(ROOT, 'scripts', 'analyze-loudness.js');

if (!fs.existsSync(CORE_WASM) || fs.statSync(CORE_WASM).size < 100000) {
  console.log('skip  loudness catalog: no real chip-core in this tree');
  process.exit(0);
}
if (!fs.existsSync(DB)) {
  console.log('skip  loudness catalog: no server/catalog.db');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chip-loudness-'));
const snapshot = path.join(tmp, 'catalog.db');
try {
  const source = new Database(DB, { readonly: true });
  source.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  source.close();
} catch (e) {
  console.log(`skip  loudness catalog: could not snapshot catalog (${e.message})`);
  process.exit(0);
}

function run(args) {
  return execFileSync(process.execPath, [SCANNER, '--db', snapshot, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

function open() {
  return new Database(snapshot, { readonly: true });
}

try {
  // 1. A filtered scan writes file rows and the folder album.
  const first = run(['--filter', 'replaygain-samples', '--force', '--concurrency', '2', '--verbose']);
  assert.ok(/measured/.test(first), 'scanner reports a summary');
  let db = open();
  const files = db.prepare(`
    SELECT path, status, subtune_count, analyzed_subtunes, lufs
    FROM loudness_files WHERE path LIKE 'replaygain-samples/%'
  `).all();
  db.close();
  assert.strictEqual(files.length, 8, `all eight labelled samples measured (got ${files.length})`);
  for (const file of files) {
    assert.strictEqual(file.status, 'ok', `${file.path}: status ok`);
    assert.ok(Number.isFinite(file.lufs), `${file.path}: finite loudness`);
    assert.ok(file.analyzed_subtunes >= 1, `${file.path}: at least one sub-tune`);
  }

  db = open();
  const albums = db.prepare(`
    SELECT directory_path, status, track_count, lufs
    FROM loudness_albums WHERE directory_path LIKE 'replaygain-samples/%'
  `).all();
  const quiet = albums.find(a => a.directory_path === 'replaygain-samples/quiet');
  db.close();
  assert.ok(quiet, 'quiet folder album exists');
  assert.strictEqual(quiet.status, 'ok', 'quiet folder album is complete');
  assert.strictEqual(quiet.track_count, 2, 'quiet folder counts both songs');
  assert.ok(Number.isFinite(quiet.lufs), 'quiet folder has a finite album loudness');

  // 2. The second run is incremental: nothing to do.
  const second = run(['--filter', 'replaygain-samples']);
  assert.ok(/0 file\(s\) to measure/.test(second), `second run is incremental:\n${second}`);

  // 3. A too-short watchdog is recorded as timeout, not a hang, and the rest
  //    of the run still exits 0.
  const timed = run([
    '--filter', 'replaygain-samples/medium/31 Staff Roll.spc',
    '--force', '--concurrency', '1', '--timeout', '1',
  ]);
  assert.ok(/failed/.test(timed), 'timeout run reports a failure');
  db = open();
  const timedOut = db.prepare(`
    SELECT status, reason FROM loudness_files
    WHERE path = 'replaygain-samples/medium/31 Staff Roll.spc'
  `).get();
  db.close();
  assert.strictEqual(timedOut.status, 'timeout', `watchdog records timeout (got ${timedOut.status})`);
  assert.ok(/timed out/.test(timedOut.reason || ''), 'timeout row says why');

  // 4. A multi-song file measures every sub-tune and gets a file aggregate.
  db = open();
  const multi = db.prepare(`
    SELECT path, status, subtune_count, analyzed_subtunes, lufs
    FROM loudness_files WHERE subtune_count > 1 LIMIT 1
  `).get();
  const rows = multi ? db.prepare('SELECT COUNT(*) c FROM loudness WHERE path = ?').get(multi.path).c : 0;
  db.close();
  if (multi) {
    assert.strictEqual(multi.analyzed_subtunes, multi.subtune_count, `${multi.path}: every sub-tune measured`);
    assert.strictEqual(rows, multi.subtune_count, `${multi.path}: one loudness row per sub-tune`);
    assert.ok(Number.isFinite(multi.lufs), `${multi.path}: file aggregate exists`);
  }

  console.log('ok    loudness catalog: scan, album, incremental, watchdog, sub-tunes');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
