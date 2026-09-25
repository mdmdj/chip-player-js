// DEV-ONLY seed for the server sqlite databases.
//
// Creates the `user_db` and `csdb_db` schemas that `server/database.js` expects
// and populates a dev user. Run automatically by `dev/apply.sh`.
//
// Usage:
//   node dev/seed-dbs.js [serverDir]
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const serverDir = process.argv[2] || path.join(__dirname, '..', 'server');
const userDbPath = path.resolve(serverDir, 'users.db');
const csdbDbPath = path.resolve(serverDir, 'csdb.db');

if (fs.existsSync(userDbPath) && !process.env.DEV_SEED_FORCE) {
  console.log(`[dev] ${userDbPath} already exists (set DEV_SEED_FORCE=1 to reseed).`);
}

{
  const db = new Database(userDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      photo_url TEXT,
      created_at INTEGER,
      last_login INTEGER,
      settings TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT,
      created_at INTEGER,
      modified_at INTEGER,
      type TEXT DEFAULT 'favorites',
      items TEXT DEFAULT '[]'
    );

    -- database.js relies on ON CONFLICT(user_id) WHERE type = 'favorites'
    -- for both add-favorite statements.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_user_favorites
      ON playlists(user_id) WHERE type = 'favorites';

    CREATE TABLE IF NOT EXISTS playbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      ip_address TEXT,
      song_id TEXT,
      played_at INTEGER,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_playbacks_played_at ON playbacks(played_at);
  `);

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO users (id, email, display_name, photo_url, created_at, last_login, settings)
    VALUES ('dev-user', 'dev@example.com', 'Dev User', NULL, ?, ?, '{}')
    ON CONFLICT(id) DO NOTHING
  `).run(now, now);
  db.close();
  console.log(`[dev] Seeded ${userDbPath}`);
}

{
  const db = new Database(csdbDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sids (
      csdbid TEXT PRIMARY KEY,
      xml TEXT,
      fetched_at INTEGER
    );

    -- HVSC metadata, keyed by SID md5 hash and by path. The original schema
    -- is not tracked in this repo; columns are inferred from server/index.js
    -- (name, author, copyright, lengths, image_url, csdbid) and the queries
    -- in server/database.js (hash, fullname).
    CREATE TABLE IF NOT EXISTS hvsc_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT,
      fullname TEXT,
      name TEXT,
      author TEXT,
      copyright TEXT,
      lengths TEXT,
      csdbid TEXT,
      songs INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hvsc_files_hash ON hvsc_files(hash);
    CREATE INDEX IF NOT EXISTS idx_hvsc_files_fullname ON hvsc_files(fullname);
  `);
  db.close();
  console.log(`[dev] Seeded ${csdbDbPath}`);
}
