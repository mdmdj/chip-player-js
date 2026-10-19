/**
 * Catalog loudness schema.
 *
 * Loudness lives in `catalog.db` rather than a separate database because the
 * deploy already syncs that file (`sqlite3_rsync`), and because a loudness row is
 * catalog data: it is keyed by the same relative path the music table uses.
 *
 * Three tables, because each answers a different question:
 *   loudness_files  one row per file: is it scanned, how many subtunes, and the
 *                   file's aggregate (what album mode uses for a multi-song file)
 *   loudness        one row per (file, subtune): what song mode uses
 *   loudness_albums one row per directory: what album mode uses for a folder
 *
 * Bump LOUDNESS_VERSION whenever the measurement or gain algorithm changes; the
 * scanner then treats every older row as missing.
 */
const LOUDNESS_VERSION = 1;

const STATUS_OK = 'ok';
const STATUS_PARTIAL = 'partial';
const STATUS_ERROR = 'error';
const STATUS_TIMEOUT = 'timeout';

function ensureLoudnessSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loudness_files (
      path TEXT PRIMARY KEY,
      file_size INTEGER,
      mtime TEXT,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      subtune_count INTEGER NOT NULL DEFAULT 1,
      analyzed_subtunes INTEGER NOT NULL DEFAULT 0,
      lufs REAL,
      peak_db REAL,
      duration_sec REAL,
      engine TEXT,
      render_ms INTEGER,
      reason TEXT,
      analyzed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS loudness (
      path TEXT NOT NULL,
      subtune INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      lufs REAL,
      peak_db REAL,
      duration_sec REAL,
      partial INTEGER NOT NULL DEFAULT 0,
      engine TEXT,
      analyzed_at INTEGER,
      PRIMARY KEY (path, subtune)
    );

    CREATE TABLE IF NOT EXISTS loudness_albums (
      directory_path TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      lufs REAL,
      peak_db REAL,
      track_count INTEGER NOT NULL DEFAULT 0,
      duration_sec REAL,
      analyzed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_loudness_path ON loudness(path);
    CREATE INDEX IF NOT EXISTS idx_loudness_status ON loudness_files(status);
  `);

  // Additive migration for a catalog created by an earlier build of this table.
  const columns = db.prepare('PRAGMA table_info(loudness_files)').all().map(c => c.name);
  if (!columns.includes('reason')) {
    db.exec('ALTER TABLE loudness_files ADD COLUMN reason TEXT');
  }
}

module.exports = {
  LOUDNESS_VERSION,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_ERROR,
  STATUS_TIMEOUT,
  ensureLoudnessSchema,
};
