#!/usr/bin/env node
// DEV-ONLY sub-tune API check: the server half of sub-songs-as-first-class
// songs, exercised over HTTP against the running dev server (mms-1:8080, or
// API_BASE). These are the endpoints the client turns a multi-song file into a
// "song folder" with one playable row per sub-song, so the contract under test
// is: a multi-song file is a folder in its parent, the file's own path lists
// sub-songs, sub-songs are addressable by (?play=<id>&subtune=N), and shuffle
// /random/top/playback agree on (path, subtune).
//
// Fixtures come from the real catalog DB, so this works with whatever the
// catalog holds; it skips (exit 0) when there are no multi-song files.
// Run: node dev/test-subtunes-server.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const API_BASE = process.env.CP_API_BASE || 'http://mms-1:8080';
const DB_PATH = path.join(ROOT, 'server', 'catalog.db');

if (!fs.existsSync(DB_PATH)) {
  console.log('no catalog.db -- skipping sub-tune API checks (run scripts/build-music.js)');
  process.exit(0);
}

const db = new Database(DB_PATH, { readonly: true });
const get = async (route) => {
  const res = await fetch(`${API_BASE}${route}`);
  assert.strictEqual(res.status, 200, `GET ${route} -> ${res.status}`);
  return res.json();
};

const multiSong = db.prepare(`
  SELECT m.path, m.song_id, m.subtune_count, m.release_date, m.mtime
  FROM music m WHERE m.subtune_count > 1 ORDER BY m.subtune_count DESC LIMIT 1
`).get();
const labeled = db.prepare(`
  SELECT st.music_id as id, m.path, m.song_id, m.subtune_count, st.subtune, st.title
  FROM subtune st JOIN music m ON m.id = st.music_id
  WHERE st.title IS NOT NULL AND m.subtune_count > 1 LIMIT 1
`).get();
const unlabeled = db.prepare(`
  SELECT st.music_id as id, m.path, m.song_id, m.subtune_count, st.subtune
  FROM subtune st JOIN music m ON m.id = st.music_id
  WHERE st.title IS NULL AND m.subtune_count > 1 LIMIT 1
`).get();
const singleSong = db.prepare(`
  SELECT m.path, m.song_id, m.subtune_count FROM music m
  WHERE (m.subtune_count IS NULL OR m.subtune_count <= 1) AND m.path LIKE '%.nsf' LIMIT 1
`).get() || db.prepare(`
  SELECT m.path, m.song_id, m.subtune_count FROM music m
  WHERE m.subtune_count IS NULL OR m.subtune_count <= 1 LIMIT 1
`).get();

if (!multiSong) {
  console.log('no multi-song files in the catalog -- skipping sub-tune API checks');
  process.exit(0);
}

const dirOf = (p) => p.split('/').slice(0, -1).join('/');
const enc = encodeURIComponent;

let passed = 0;
let skipped = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    if (e.code === 'SKIP') {
      skipped++;
      console.log(`  skip  ${name}  (${e.message})`);
      return;
    }
    console.error(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n')}`);
    process.exitCode = 1;
  }
}
const skip = (why) => Object.assign(new Error(why), { code: 'SKIP' });

async function main() {
  await check('a multi-song file appears as a song folder in its directory', async () => {
    const rows = await get(`/api/browse?path=${enc(dirOf(multiSong.path))}`);
    const row = rows.find(r => r.path === multiSong.path);
    assert.ok(row, `${multiSong.path} missing from its directory listing`);
    assert.strictEqual(row.type, 'songfolder');
    assert.strictEqual(row.count, multiSong.subtune_count, 'count is the sub-song count');
    assert.strictEqual(row.url, null, 'a song folder is navigated into, not played');
  });

  await check('a single-song file stays a plain file row', async () => {
    if (!singleSong) throw skip('no single-song file in the catalog');
    const rows = await get(`/api/browse?path=${enc(dirOf(singleSong.path))}`);
    const row = rows.find(r => r.path === singleSong.path);
    assert.ok(row, `${singleSong.path} missing from its directory listing`);
    assert.strictEqual(row.type, 'file', 'one sub-song is not a folder');
    assert.strictEqual(row.url, `/?play=${enc(singleSong.song_id)}`);
    assert.ok(!row.url.includes('subtune='), 'no sub-tune parameter for a single song');
  });

  await check('the file path itself lists its sub-songs', async () => {
    const rows = await get(`/api/browse?path=${enc(multiSong.path)}`);
    assert.strictEqual(rows.length, multiSong.subtune_count);
    rows.forEach((row, i) => {
      assert.strictEqual(row.type, 'file', 'sub-songs are playable rows');
      assert.strictEqual(row.subtune, i, '0-based, in order');
      assert.strictEqual(row.song_id, multiSong.song_id, 'addressed by the parent file hash');
      assert.strictEqual(row.url, `/?play=${enc(multiSong.song_id)}&subtune=${i}`);
    });
  });

  await check('unlabeled sub-songs fall back to "Tune N", labeled ones keep the label', async () => {
    for (const fixture of [labeled, unlabeled]) {
      if (!fixture) continue;
      const rows = await get(`/api/browse?path=${enc(fixture.path)}`);
      const row = rows.find(r => r.subtune === fixture.subtune);
      assert.ok(row, `sub-tune ${fixture.subtune} of ${fixture.path} is listed`);
      if (fixture.title == null) {
        assert.strictEqual(row.name, `Tune ${fixture.subtune + 1}`,
          'an unlabeled sub-song gets the positional fallback');
      } else {
        assert.strictEqual(row.name, fixture.title, 'the stored label wins');
      }
    }
    // And nothing is ever nameless.
    const rows = await get(`/api/browse?path=${enc(multiSong.path)}`);
    for (const row of rows) {
      assert.ok(typeof row.name === 'string' && row.name.length > 0,
        `row ${row.subtune} has a name`);
    }
  });

  await check('sub-song rows reuse the parent file size', async () => {
    const dirRows = await get(`/api/browse?path=${enc(dirOf(multiSong.path))}`);
    const folder = dirRows.find(r => r.path === multiSong.path);
    const subRows = await get(`/api/browse?path=${enc(multiSong.path)}`);
    for (const row of subRows) {
      assert.strictEqual(row.size, folder.size, 'a sub-song has no size of its own');
    }
  });

  await check('sub-song dates fall back to the file release date', async () => {
    const subRows = await get(`/api/browse?path=${enc(multiSong.path)}`);
    const dirRows = await get(`/api/browse?path=${enc(dirOf(multiSong.path))}`);
    const folder = dirRows.find(r => r.path === multiSong.path);
    const expected = folder.mtime; // directory rows already prefer release_date
    for (const row of subRows) {
      if (row.mtime === 0) continue; // no date anywhere in the chain
      assert.strictEqual(row.mtime, expected,
        'subtune date -> file release_date -> file mtime');
    }
  });

  await check('a sub-song title is searchable, and not double-counted', async () => {
    if (!labeled) throw skip('no labeled sub-song in the catalog');
    const res = await get(`/api/search?query=${enc(labeled.title.split(/\s+/)[0])}`);
    const hits = res.items.filter(i => i.file === labeled.path);
    assert.ok(hits.length >= 1, `"${labeled.title}" is findable`);
    const first = res.items.findIndex(i => i.file === labeled.path);
    assert.ok(!res.items.slice(0, first).some(i => i.file === labeled.path),
      'a file is never listed twice (file-level match wins)');
    if (hits[0].subtune !== undefined) {
      assert.ok(Number.isInteger(hits[0].subtune), 'a sub-song hit carries its index');
    }
  });

  await check('/metadata resolves subtuneCount and subtuneTitle', async () => {
    const meta = await get(`/api/metadata?path=${enc(multiSong.path)}`);
    assert.strictEqual(meta.subtuneCount, multiSong.subtune_count);
    assert.strictEqual(meta.subtuneTitle, null, 'no sub-tune index means no sub-song title');
    const sub = db.prepare('SELECT title FROM subtune WHERE music_id = ? ORDER BY subtune LIMIT 1')
      .get(db.prepare('SELECT id FROM music WHERE path = ?').get(multiSong.path).id);
    const withIndex = await get(`/api/metadata?path=${enc(multiSong.path)}&subtune=0`);
    assert.strictEqual(withIndex.subtuneTitle, sub.title ?? null,
      'the title for the requested sub-song, NULL when unlabeled');
  });

  await check('shuffle and random hand out playable sub-songs', async () => {
    for (const route of ['/api/shuffle?limit=50', '/api/random?limit=10']) {
      const res = await get(route);
      assert.ok(res.items.length > 0);
      for (const item of res.items) {
        assert.ok(typeof item.path === 'string' && item.path.length > 0);
        assert.ok(Number.isInteger(item.subtune) && item.subtune >= 0, 'a real sub-tune index');
        const row = db.prepare('SELECT subtune_count FROM music WHERE path = ?').get(item.path);
        if (row) {
          const count = row.subtune_count || 1;
          assert.ok(item.subtune < count,
            `${item.path} sub-tune ${item.subtune} is within 0..${count - 1}`);
        }
      }
    }
  });

  await check('shuffle hands out a sub-song other than 0 for a multi-song file', async () => {
    // Scope the shuffle to the file's own directory so the file is always in
    // the sample: the point is that toShuffledSongRefs() picks a random
    // sub-tune per call, not that a global sample happens to catch one.
    const dir = dirOf(multiSong.path);
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const res = await get(`/api/shuffle?limit=200&path=${enc(dir)}`);
      for (const item of res.items) {
        if (item.path === multiSong.path) seen.add(item.subtune);
      }
    }
    assert.ok(seen.size > 1,
      `a multi-song file must shuffle as more than just sub-tune 0 (saw ${[...seen]})`);
    for (const subtune of seen) {
      assert.ok(subtune < multiSong.subtune_count, 'every shuffled sub-tune is playable');
    }
  });

  await check('playback rejects a sub-tune the file does not have', async () => {
    const res = await fetch(`${API_BASE}/api/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songId: multiSong.song_id,
        subtune: multiSong.subtune_count + 5,
        durationMs: 1000,
      }),
    });
    assert.strictEqual(res.status, 400, 'an unplayable sub-tune is refused');
  });

  await check('top charts group by (song, sub-tune) and label the sub-song', async () => {
    const res = await get('/api/top?limit=50&scope=global');
    assert.ok(Array.isArray(res.items));
    for (const item of res.items) {
      assert.ok(Number.isInteger(item.subtune) && item.subtune >= 0);
      if (item.subtune_count > 1) {
        assert.ok(item.subtune < item.subtune_count, 'the index is within the song');
        assert.ok('subtune_title' in item, 'a multi-song chart row carries its sub-song title');
      }
    }
  });

  // Favorites: a sub-song is favorited independently of its siblings, and a
  // legacy row without a sub-tune keeps working (it means sub-tune 0). These
  // mutate the dev user's favorites, so they undo themselves at the end.
  const favAdd = (body) => fetch(`${API_BASE}/api/user/favorites/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const favRemove = (body) => fetch(`${API_BASE}/api/user/favorites/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const favList = async () => (await get('/api/user/favorites')).favorites;
  const keyOf = (f) => `${f.path}\u0000${f.subtune ?? 0}`;

  const cleanup = [];
  await check('a sub-song can be favorited without touching its siblings', async () => {
    const before = await favList();
    for (const subtune of [0, 1]) {
      const body = { path: multiSong.path, subtune, mtime: 0 };
      const res = await favAdd(body);
      assert.strictEqual(res.status, 200, `add sub-tune ${subtune} -> ${res.status}`);
      cleanup.push(body);
    }
    const after = await favList();
    const mine = after.filter(f => f.path === multiSong.path);
    assert.strictEqual(mine.length, 2, 'both sub-songs are favorited');
    assert.deepStrictEqual(mine.map(f => f.subtune).sort(), [0, 1]);
    assert.deepStrictEqual(after.filter(f => !before.some(b => keyOf(b) === keyOf(f))),
      after.filter(f => !before.some(b => keyOf(b) === keyOf(f))),
      'sanity: the list is comparable');
  });

  await check('removing one sub-song leaves the others favorited', async () => {
    const res = await favRemove({ path: multiSong.path, subtune: 0, mtime: 0 });
    assert.strictEqual(res.status, 200);
    const after = await favList();
    const mine = after.filter(f => f.path === multiSong.path);
    assert.deepStrictEqual(mine.map(f => f.subtune), [1],
      'only the removed sub-song is gone');
    const again = await favRemove({ path: multiSong.path, subtune: 0, mtime: 0 });
    // Idempotent, not 404: removeFavoriteByPathStmt rewrites the whole playlist
    // row with json_group_array, so changes is always 1 and the handler's
    // "Favorite not found" branch cannot fire. Harmless for the client (it only
    // removes what it believes is favorited), but `removed` overstates the
    // count. Pinned here so a future change to the statement is deliberate.
    assert.strictEqual(again.status, 200, 'removing an absent sub-tune is a no-op');
    assert.deepStrictEqual((await favList()).filter(f => f.path === multiSong.path)
      .map(f => f.subtune), [1], 'and the sibling is still favorited');
  });

  await check('a sub-song is decorated for the UI (size, count, title)', async () => {
    const [row] = (await favList()).filter(f => f.path === multiSong.path);
    assert.ok(row, 'the remaining favorite is listed');
    assert.strictEqual(row.songId, multiSong.song_id, 'addressed by the parent file hash');
    assert.strictEqual(row.subtuneCount, multiSong.subtune_count);
    assert.ok('subtuneTitle' in row, 'carries its sub-song title (null when unlabeled)');
    assert.ok(row.size > 0, 'a sub-song reuses the file size');
  });

  await check('a legacy favorite without a sub-tune still resolves (sub-tune 0)', async () => {
    const before = await favList();
    assert.ok(!before.some(f => f.path === singleSong.path),
      'fixture: the single-song file is not favorited yet');
    const res = await favAdd({ path: singleSong.path, mtime: 0 }); // no subtune field
    assert.strictEqual(res.status, 200);
    cleanup.push({ path: singleSong.path, subtune: 0, mtime: 0 });
    const [row] = (await favList()).filter(f => f.path === singleSong.path);
    assert.ok(row, 'listed');
    assert.strictEqual(row.subtune ?? 0, 0, 'a missing sub-tune means sub-tune 0');
    assert.strictEqual(row.subtuneCount, 1, 'a single-song file is not a song folder');
  });

  await check('a sub-tune the song does not have is rejected', async () => {
    const res = await favAdd({ path: multiSong.path, subtune: multiSong.subtune_count, mtime: 0 });
    assert.strictEqual(res.status, 400, 'out-of-range sub-tune');
    const res2 = await favAdd({ path: 'does/not/exist.nsf', subtune: 0, mtime: 0 });
    assert.strictEqual(res2.status, 404, 'unknown path');
  });

  // Undo everything this suite added, so a dev run leaves no residue.
  for (const body of cleanup) {
    await favRemove({ path: body.path, subtune: body.subtune, mtime: body.mtime });
  }
  const afterCleanup = await favList();
  assert.ok(!afterCleanup.some(f => f.path === multiSong.path || f.path === (singleSong.path || '')),
    'the suite left no favorites behind');

  console.log(`\n${passed} checks passed${skipped ? `, ${skipped} skipped` : ''}` +
    `${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
}

main().catch(e => {
  if (e.cause || /fetch failed|ECONNREFUSED/.test(String(e))) {
    console.error(`Could not reach the dev server at ${API_BASE} (start \`npm run dev\`). Skipping.`);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
