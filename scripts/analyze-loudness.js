#!/usr/bin/env node
/**
 * Fill catalog.db with ReplayGain-style loudness measurements.
 *
 * Run after `scripts/build-music.js` and before deploying the catalog:
 *
 *   node scripts/analyze-loudness.js                 # incremental, resumable
 *   node scripts/analyze-loudness.js --filter spc    # one subtree
 *   node scripts/analyze-loudness.js --limit 100 --verbose
 *   node scripts/analyze-loudness.js --force         # remeasure everything
 *
 * Measurement is deliberately offline and parallel:
 *   * each worker owns a wasm core and reads files from the catalog;
 *   * the parent owns SQLite, so there is one writer;
 *   * a per-file watchdog kills and respawns a worker that hangs inside an
 *     engine call (JavaScript cannot interrupt the C loop);
 *   * progress is committed per file, so a killed run resumes where it stopped.
 *
 * Results are keyed by `(path, subtune)`. A multi-song file gets one row per
 * sub-tune and a file-level aggregate, which is what album mode uses. Folders
 * get a directory aggregate only when every file in them measured successfully.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { Command } = require('commander');
const chalk = require('chalk');
const Database = require('better-sqlite3');

// Installs the Babel hook and browser globals; also gives us the same album
// aggregate the browser uses.
require('./loudness-node-require');
const { albumFromTracks } = require('../src/loudness');
const { startLoudnessServer } = require('./loudness-local-server');
const {
  LOUDNESS_VERSION,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_ERROR,
  STATUS_TIMEOUT,
  ensureLoudnessSchema,
} = require('../server/loudness-schema');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(ROOT, 'server', 'catalog.db');
const CATALOG_ROOT = path.resolve(ROOT, 'catalog');
const SOUNDFONT_ROOT = path.resolve(ROOT, 'public', 'soundfonts');
const CSDB_PATH = path.resolve(ROOT, 'server', 'csdb.db');
const WORKER_PATH = path.resolve(__dirname, 'loudness-scan-worker.js');
const STATUS_SKIPPED = 'skipped';

const program = new Command();
program
  .name('analyze-loudness')
  .description('Measure catalog loudness for ReplayGain-style normalization.')
  .option('--db <path>', 'Catalog database to write', DB_PATH)
  .option('--filter <path>', 'Only paths under this catalog subdirectory', '')
  .option('--limit <number>', 'Maximum files to process', 0)
  .option('--concurrency <number>', 'Worker processes', Math.max(1, Math.min(4, os.cpus().length - 1)))
  .option('--timeout <seconds>', 'Per-file wall-clock limit before the worker is killed', 120)
  .option('--max-size <mb>', 'Skip files larger than this (MB)', 32)
  .option('--max-subtunes <number>', 'Measure at most this many sub-tunes per file', 64)
  .option('--force', 'Re-measure even when the size, mtime and version match', false)
  .option('--missing-only', 'Only files with no loudness row', false)
  .option('--retry-failed', 'Retry files whose last attempt was error/timeout', false)
  .option('--no-albums', 'Skip rebuilding the directory album rows', false)
  .option('--dry-run', 'List what would be measured, without measuring', false)
  .option('--verbose', 'Print one line per file', false)
  .parse(process.argv);

const options = program.opts();
const limit = Number.parseInt(options.limit, 10) || 0;
const concurrency = Math.max(1, Number.parseInt(options.concurrency, 10) || 1);
const timeoutMs = Math.max(1000, (Number.parseFloat(options.timeout) || 120) * 1000);
const maxBytes = Math.max(1, Number.parseFloat(options.maxSize) || 32) * 1024 * 1024;
const maxSubtunes = Math.max(1, Number.parseInt(options.maxSubtunes, 10) || 64);

const db = new Database(path.resolve(options.db || DB_PATH));
db.pragma('journal_mode = WAL');
ensureLoudnessSchema(db);

function selectCandidates() {
  const clauses = [];
  const params = [];
  if (options.force) {
    // everything
  } else if (options.missingOnly) {
    clauses.push('l.path IS NULL');
  } else {
    const retry = options.retryFailed
      ? ` OR l.status IN ('${STATUS_ERROR}', '${STATUS_TIMEOUT}')`
      : '';
    clauses.push(`(
      l.path IS NULL
      OR l.version IS NOT ?
      OR l.file_size IS NOT m.file_size
      OR l.mtime IS NOT m.mtime${retry}
    )`);
    params.push(LOUDNESS_VERSION);
  }
  if (options.filter) {
    clauses.push('m.path LIKE ?');
    params.push(`${options.filter.replace(/^\/+/, '')}%`);
  }

  let sql = `
    SELECT m.path, m.file_size, m.mtime
    FROM music m
    LEFT JOIN loudness_files l ON l.path = m.path
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY m.path
  `;
  if (limit > 0) sql += ` LIMIT ${limit}`;
  return db.prepare(sql).all(...params);
}

const upsertFileStmt = db.prepare(`
  INSERT INTO loudness_files
    (path, file_size, mtime, version, status, subtune_count, analyzed_subtunes,
     lufs, peak_db, duration_sec, engine, render_ms, reason, analyzed_at)
  VALUES
    (@path, @fileSize, @mtime, @version, @status, @subtuneCount, @analyzedSubtunes,
     @lufs, @peakDb, @durationSec, @engine, @renderMs, @reason, @analyzedAt)
  ON CONFLICT(path) DO UPDATE SET
    file_size = excluded.file_size,
    mtime = excluded.mtime,
    version = excluded.version,
    status = excluded.status,
    subtune_count = excluded.subtune_count,
    analyzed_subtunes = excluded.analyzed_subtunes,
    lufs = excluded.lufs,
    peak_db = excluded.peak_db,
    duration_sec = excluded.duration_sec,
    engine = excluded.engine,
    render_ms = excluded.render_ms,
    reason = excluded.reason,
    analyzed_at = excluded.analyzed_at
`);
const deleteTracksStmt = db.prepare('DELETE FROM loudness WHERE path = ?');
const upsertTrackStmt = db.prepare(`
  INSERT INTO loudness
    (path, subtune, version, status, lufs, peak_db, duration_sec, partial, engine, analyzed_at)
  VALUES
    (@path, @subtune, @version, @status, @lufs, @peakDb, @durationSec, @partial, @engine, @analyzedAt)
  ON CONFLICT(path, subtune) DO UPDATE SET
    version = excluded.version,
    status = excluded.status,
    lufs = excluded.lufs,
    peak_db = excluded.peak_db,
    duration_sec = excluded.duration_sec,
    partial = excluded.partial,
    engine = excluded.engine,
    analyzed_at = excluded.analyzed_at
`);

const writeResult = db.transaction((row, result) => {
  const now = Math.floor(Date.now() / 1000);
  if (!result || result.error) {
    const timedOut = result && result.timeout;
    const skipped = result && result.skipped;
    upsertFileStmt.run({
      path: row.path,
      fileSize: row.file_size,
      mtime: row.mtime,
      version: LOUDNESS_VERSION,
      status: skipped ? STATUS_SKIPPED : timedOut ? STATUS_TIMEOUT : STATUS_ERROR,
      subtuneCount: 0,
      analyzedSubtunes: 0,
      lufs: null,
      peakDb: null,
      durationSec: null,
      engine: null,
      renderMs: null,
      reason: result ? result.error : 'unknown error',
      analyzedAt: now,
    });
    deleteTracksStmt.run(row.path);
    return;
  }

  const file = result.file || null;
  const tracks = Array.isArray(result.tracks) ? result.tracks : [];
  const status = result.status === STATUS_PARTIAL ? STATUS_PARTIAL : STATUS_OK;
  upsertFileStmt.run({
    path: row.path,
    fileSize: row.file_size,
    mtime: row.mtime,
    version: LOUDNESS_VERSION,
    status,
    subtuneCount: result.subtuneCount || 1,
    analyzedSubtunes: result.analyzedSubtunes || tracks.length,
    lufs: file && Number.isFinite(file.lufs) ? file.lufs : null,
    peakDb: file && Number.isFinite(file.peakDb) ? file.peakDb : null,
    durationSec: file ? file.durationSec : null,
    engine: result.engine || null,
    renderMs: result.renderMs || null,
    reason: status === STATUS_PARTIAL ? 'some sub-tunes were not measured' : null,
    analyzedAt: now,
  });
  deleteTracksStmt.run(row.path);
  for (const track of tracks) {
    upsertTrackStmt.run({
      path: row.path,
      subtune: track.subtune,
      version: LOUDNESS_VERSION,
      status: track.partial ? STATUS_PARTIAL : STATUS_OK,
      lufs: Number.isFinite(track.lufs) ? track.lufs : null,
      peakDb: Number.isFinite(track.peakDb) ? track.peakDb : null,
      durationSec: track.durationSec,
      partial: track.partial ? 1 : 0,
      engine: track.engine || result.engine || null,
      analyzedAt: now,
    });
  }
});

const rebuildAlbumsStmt = db.prepare('DELETE FROM loudness_albums');
const insertAlbumStmt = db.prepare(`
  INSERT INTO loudness_albums
    (directory_path, version, status, lufs, peak_db, track_count, duration_sec, analyzed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const directoryRowsStmt = db.prepare('SELECT id, path FROM directories ORDER BY path');
const musicForDirectoryStmt = db.prepare(`
  SELECT m.path, m.subtune_count,
         l.status, l.lufs, l.peak_db, l.duration_sec, l.analyzed_subtunes
  FROM music m
  LEFT JOIN loudness_files l ON l.path = m.path
  WHERE m.directory_id = ?
  ORDER BY m.path
`);

function rebuildAlbums() {
  const now = Math.floor(Date.now() / 1000);
  const rebuild = db.transaction(() => {
    rebuildAlbumsStmt.run();
    for (const directory of directoryRowsStmt.all()) {
      const files = musicForDirectoryStmt.all(directory.id);
      if (files.length === 0) continue;
      const tracks = [];
      let complete = true;
      let trackCount = 0;
      for (const file of files) {
        trackCount += file.subtune_count || 1;
        const usable = file.status === STATUS_OK || file.status === STATUS_PARTIAL;
        if (!usable || !Number.isFinite(file.lufs)) {
          complete = false;
          continue;
        }
        if (file.status !== STATUS_OK) complete = false;
        tracks.push({
          lufs: file.lufs,
          peakDb: file.peak_db,
          durationSec: file.duration_sec,
        });
      }
      if (tracks.length === 0) continue;
      const album = albumFromTracks(tracks);
      insertAlbumStmt.run(
        directory.path,
        LOUDNESS_VERSION,
        complete ? STATUS_OK : STATUS_PARTIAL,
        album.lufs,
        album.peakDb,
        trackCount,
        album.durationSec,
        now,
      );
    }
  });
  rebuild();
}

function startWorker(env) {
  const child = fork(WORKER_PATH, [], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let dead = false;
  let nextId = 1;
  let current = null;

  const failCurrent = (error) => {
    if (!current) return;
    clearTimeout(current.timer);
    current.reject(error);
    current = null;
  };

  child.on('message', (message) => {
    if (!current || !message || message.id !== current.id) return;
    clearTimeout(current.timer);
    const job = current;
    current = null;
    if (message.type === 'result') job.resolve(message.result);
    else job.reject(Object.assign(new Error(message.message || 'scan failed'), { path: job.path }));
  });
  child.on('error', (error) => {
    dead = true;
    failCurrent(error);
  });
  child.on('exit', (code, signal) => {
    dead = true;
    failCurrent(new Error(`worker exited (${signal || code})`));
  });

  return {
    get dead() { return dead; },
    run(filepath, taskOptions) {
      return new Promise((resolve, reject) => {
        if (dead) {
          reject(new Error('worker unavailable'));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          dead = true;
          try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
          const error = new Error(`timed out after ${timeoutMs} ms`);
          error.timeout = true;
          failCurrent(error);
        }, timeoutMs);
        current = { id, path: filepath, resolve, reject, timer };
        try {
          child.send({ type: 'analyze', id, filepath, options: taskOptions });
        } catch (e) {
          clearTimeout(timer);
          current = null;
          reject(e);
        }
      });
    },
    kill() {
      dead = true;
      failCurrent(new Error('worker stopped'));
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    },
  };
}

async function main() {
  const candidates = selectCandidates();
  console.log(chalk.cyan(`loudness: ${candidates.length} file(s) to measure`));
  if (options.dryRun) {
    for (const row of candidates.slice(0, 50)) console.log(`  ${row.path}`);
    if (candidates.length > 50) console.log(`  ... and ${candidates.length - 50} more`);
    return;
  }
  if (candidates.length === 0) {
    if (!options.noAlbums) rebuildAlbums();
    return;
  }

  const local = await startLoudnessServer({
    dbPath: path.resolve(options.db || DB_PATH),
    catalogRoot: CATALOG_ROOT,
    soundfontRoot: SOUNDFONT_ROOT,
    csdbPath: CSDB_PATH,
  });
  console.log(chalk.gray(`loudness: local catalog ${local.url}`));

  let next = 0;
  let processed = 0;
  let errors = 0;
  let skipped = 0;
  const started = Date.now();
  const active = new Set();

  function spawn() {
    const worker = startWorker({ CHIP_LOUDNESS_BASE: local.url });
    active.add(worker);
    return worker;
  }

  async function lane() {
    let worker = spawn();
    while (true) {
      const index = next++;
      if (index >= candidates.length) break;
      const row = candidates[index];
      let result;
      if (row.file_size > maxBytes) {
        result = { error: `file too large (${row.file_size} bytes)`, skipped: true };
        skipped++;
      } else {
        if (worker.dead) {
          active.delete(worker);
          worker = spawn();
        }
        try {
          result = await worker.run(row.path, {
            maxSubtunes,
            maxRenderSeconds: 600,
            wallBudgetMs: Math.max(1000, timeoutMs - 1000),
          });
        } catch (e) {
          result = { error: e.message, timeout: !!e.timeout };
          if (worker.dead) {
            active.delete(worker);
            worker = spawn();
          }
        }
      }
      writeResult(row, result);
      processed++;
      if (result && result.error) errors++;
      if (options.verbose || processed % 25 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        const rate = processed / Math.max(elapsed, 0.001);
        const eta = rate > 0 ? Math.round((candidates.length - processed) / rate) : 0;
        console.log(
          chalk.gray(`  ${processed}/${candidates.length}`) +
          ` ${row.path}` +
          (result && result.error ? chalk.red(`  [${result.error}]`) : '') +
          chalk.gray(`  (${rate.toFixed(1)}/s, ~${eta}s left)`),
        );
      }
    }
    active.delete(worker);
    worker.kill();
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => lane()));
  } finally {
    for (const worker of active) worker.kill();
    await local.close();
  }

  if (!options.noAlbums) rebuildAlbums();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(chalk.green(`loudness: ${processed - errors} measured, ${errors} failed, ${skipped} skipped in ${elapsed}s`));
  if (errors > 0) {
    console.log(chalk.yellow('loudness: failed files keep their last status; rerun with --retry-failed to try again.'));
  }
}

main().catch((e) => {
  console.error(chalk.red('loudness:'), e);
  try { db.close(); } catch (err) { /* ignore */ }
  process.exit(1);
});
