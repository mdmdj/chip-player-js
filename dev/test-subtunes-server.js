#!/usr/bin/env node
// DEV-ONLY sub-tune API check: the server half of the sub-tunes-as-first-class
// work, exercised over HTTP against the running dev server (mms-1:8080, or
// API_BASE). These are the endpoints the client turns a multi-song file into a
// "song folder" with one playable row per sub-tune, so the contract under test
// is: a multi-song file is a folder in its parent, the file's own path lists
// sub-tunes, sub-tunes are addressable by (?play=<id>&subtune=N), and shuffle
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
    assert.strictEqual(row.count, multiSong.subtune_count, 'count is the sub-tune count');
    assert.strictEqual(row.url, null, 'a song folder is navigated into, not played');
  });

  await check('a single-song file stays a plain file row', async () => {
    if (!singleSong) throw skip('no single-song file in the catalog');
    const rows = await get(`/api/browse?path=${enc(dirOf(singleSong.path))}`);
    const row = rows.find(r => r.path === singleSong.path);
    assert.ok(row, `${singleSong.path} missing from its directory listing`);
    assert.strictEqual(row.type, 'file', 'one sub-tune is not a folder');
    assert.strictEqual(row.url, `/?play=${enc(singleSong.song_id)}`);
    assert.ok(!row.url.includes('subtune='), 'no sub-tune parameter for a single song');
  });

  await check('the file path itself lists its sub-tunes', async () => {
    const rows = await get(`/api/browse?path=${enc(multiSong.path)}`);
    assert.strictEqual(rows.length, multiSong.subtune_count);
    rows.forEach((row, i) => {
      assert.strictEqual(row.type, 'file', 'sub-tunes are playable rows');
      assert.strictEqual(row.subtune, i, '0-based, in order');
      assert.strictEqual(row.song_id, multiSong.song_id, 'addressed by the parent file hash');
      assert.strictEqual(row.url, `/?play=${enc(multiSong.song_id)}&subtune=${i}`);
    });
  });

  await check('unlabeled sub-tunes fall back to "Tune N", labeled ones keep the label', async () => {
    for (const fixture of [labeled, unlabeled]) {
      if (!fixture) continue;
      const rows = await get(`/api/browse?path=${enc(fixture.path)}`);
      const row = rows.find(r => r.subtune === fixture.subtune);
      assert.ok(row, `sub-tune ${fixture.subtune} of ${fixture.path} is listed`);
      if (fixture.title == null) {
        assert.strictEqual(row.name, `Tune ${fixture.subtune + 1}`,
          'an unlabeled sub-tune gets the positional fallback');
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

  await check('sub-tune rows reuse the parent file size', async () => {
    const dirRows = await get(`/api/browse?path=${enc(dirOf(multiSong.path))}`);
    const folder = dirRows.find(r => r.path === multiSong.path);
    const subRows = await get(`/api/browse?path=${enc(multiSong.path)}`);
    for (const row of subRows) {
      assert.strictEqual(row.size, folder.size, 'a sub-tune has no size of its own');
    }
  });

  await check('sub-tune dates fall back to the file release date', async () => {
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

  await check('a sub-tune title is searchable, and not double-counted', async () => {
    if (!labeled) throw skip('no labeled sub-tune in the catalog');
    const res = await get(`/api/search?query=${enc(labeled.title.split(/\s+/)[0])}`);
    const hits = res.items.filter(i => i.file === labeled.path);
    assert.ok(hits.length >= 1, `"${labeled.title}" is findable`);
    const first = res.items.findIndex(i => i.file === labeled.path);
    assert.ok(!res.items.slice(0, first).some(i => i.file === labeled.path),
      'a file is never listed twice (file-level match wins)');
    if (hits[0].subtune !== undefined) {
      assert.ok(Number.isInteger(hits[0].subtune), 'a sub-tune hit carries its index');
    }
  });

  await check('/metadata resolves subtuneCount and subtuneTitle', async () => {
    const meta = await get(`/api/metadata?path=${enc(multiSong.path)}`);
    assert.strictEqual(meta.subtuneCount, multiSong.subtune_count);
    assert.strictEqual(meta.subtuneTitle, null, 'no sub-tune index means no sub-tune title');
    const sub = db.prepare('SELECT title FROM subtune WHERE music_id = ? ORDER BY subtune LIMIT 1')
      .get(db.prepare('SELECT id FROM music WHERE path = ?').get(multiSong.path).id);
    const withIndex = await get(`/api/metadata?path=${enc(multiSong.path)}&subtune=0`);
    assert.strictEqual(withIndex.subtuneTitle, sub.title ?? null,
      'the title for the requested sub-tune, NULL when unlabeled');
  });

  await check('every song states its song count, plain files included', async () => {
    // isSongFolder() in the client is the only thing that reads this, so the
    // field must never be absent: an omitted count used to mean "one song".
    const plain = await get(`/api/metadata?path=${enc(singleSong.path)}`);
    assert.strictEqual(plain.subtuneCount, singleSong.subtune_count || 1,
      '/metadata counts a plain file as one song');

    for (const song of [multiSong, singleSong]) {
      const res = await fetch(`${API_BASE}/?play=${encodeURIComponent(song.song_id)}`);
      assert.strictEqual(res.status, 200, `GET /?play=${song.song_id}`);
      const html = await res.text();
      const match = html.match(/__chipConfig = (\{.*?\});/);
      assert.ok(match, 'the page states its song in __chipConfig');
      const config = JSON.parse(match[1]);
      assert.strictEqual(config.subtuneCount, song.subtune_count || 1,
        `a share link into ${song.path} counts its songs`);
    }
  });

  await check('shuffle and random hand out playable sub-tunes', async () => {
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

  await check('a directory shuffle hands out every sub-tune, not one per file', async () => {
    // A sub-tune is a song in its own right, so shuffling a directory hands out
    // all of a multi-song file's sub-tunes instead of one arbitrary sub-tune.
    const dir = dirOf(multiSong.path);
    const res = await get(`/api/shuffle?limit=100000&path=${enc(dir)}`);
    const keys = res.items.map(item => `${item.path}\u0000${item.subtune}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'no song is shuffled twice');

    const subs = res.items.filter(item => item.path === multiSong.path).map(item => item.subtune);
    assert.deepStrictEqual([...subs].sort((a, b) => a - b), [...Array(multiSong.subtune_count).keys()],
      `all ${multiSong.subtune_count} sub-tunes of ${multiSong.path} are in the shuffle`);

    const rows = db.prepare(`
      SELECT path, subtune_count FROM music
      WHERE directory_id = (SELECT id FROM directories WHERE path = ?)
    `).all(dir);
    assert.ok(rows.length > 1, 'the directory has more than one file to check');
    for (const row of rows) {
      const songs = row.subtune_count > 1 ? row.subtune_count : 1;
      assert.strictEqual(res.items.filter(item => item.path === row.path).length, songs,
        `${row.path} contributes ${songs} song(s)`);
    }
  });

  await check('shuffle on a song folder shuffles its sub-tunes', async () => {
    // A multi-song file browses as a "song folder" of sub-tunes, and a file has
    // no children to prefix-match, so shuffle play enumerates its sub-tunes
    // rather than returning nothing.
    const limit = multiSong.subtune_count;
    const res = await get(`/api/shuffle?limit=${limit}&path=${enc(multiSong.path)}`);
    assert.strictEqual(res.items.length, limit, 'every sub-tune of the folder is shuffled');
    for (const item of res.items) {
      assert.strictEqual(item.path, multiSong.path);
      assert.ok(Number.isInteger(item.subtune) && item.subtune >= 0, 'a real sub-tune index');
      assert.ok(item.subtune < limit, `${item.path} sub-tune ${item.subtune} is within 0..${limit - 1}`);
    }
    const orders = new Set();
    for (let i = 0; i < 5; i++) {
      const again = await get(`/api/shuffle?limit=${limit}&path=${enc(multiSong.path)}`);
      orders.add(again.items.map(item => item.subtune).join(','));
    }
    assert.ok(orders.size > 1, `the sub-tunes come back in random order (saw ${orders.size} orders)`);
  });

  await check('shuffle on a file path returns that file', async () => {
    // Browsing a single-song file shows an empty listing, but shuffle play
    // should still play the file it names.
    const single = db.prepare('SELECT path FROM music WHERE subtune_count = 1 LIMIT 1').get();
    const res = await get(`/api/shuffle?path=${enc(single.path)}`);
    assert.deepStrictEqual(res.items, [{ path: single.path, subtune: 0 }]);
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

  await check('top charts group by (song, sub-tune) and label the sub-tune', async () => {
    const res = await get('/api/top?limit=50&scope=global');
    assert.ok(Array.isArray(res.items));
    for (const item of res.items) {
      assert.ok(Number.isInteger(item.subtune) && item.subtune >= 0);
      assert.ok(Number.isInteger(item.subtuneCount) && item.subtuneCount >= 1,
        'every chart row reports how many songs the file holds');
      if (item.subtuneCount > 1) {
        assert.ok(item.subtune < item.subtuneCount, 'the index is within the song');
        assert.ok('subtune_title' in item, 'a multi-song chart row carries its sub-tune title');
      }
    }
  });

  // Favorites: a sub-tune is favorited independently of its siblings, and a
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
  await check('a sub-tune can be favorited without touching its siblings', async () => {
    const before = await favList();
    for (const subtune of [0, 1]) {
      const body = { path: multiSong.path, subtune, mtime: 0 };
      const res = await favAdd(body);
      assert.strictEqual(res.status, 200, `add sub-tune ${subtune} -> ${res.status}`);
      cleanup.push(body);
    }
    const after = await favList();
    const mine = after.filter(f => f.path === multiSong.path);
    assert.strictEqual(mine.length, 2, 'both sub-tunes are favorited');
    assert.deepStrictEqual(mine.map(f => f.subtune).sort(), [0, 1]);
    assert.deepStrictEqual(after.filter(f => !before.some(b => keyOf(b) === keyOf(f))),
      after.filter(f => !before.some(b => keyOf(b) === keyOf(f))),
      'sanity: the list is comparable');
  });

  await check('removing one sub-tune leaves the others favorited', async () => {
    const res = await favRemove({ path: multiSong.path, subtune: 0, mtime: 0 });
    assert.strictEqual(res.status, 200);
    const after = await favList();
    const mine = after.filter(f => f.path === multiSong.path);
    assert.deepStrictEqual(mine.map(f => f.subtune), [1],
      'only the removed sub-tune is gone');
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

  await check('a sub-tune is decorated for the UI (size, count, title)', async () => {
    const [row] = (await favList()).filter(f => f.path === multiSong.path);
    assert.ok(row, 'the remaining favorite is listed');
    assert.strictEqual(row.songId, multiSong.song_id, 'addressed by the parent file hash');
    assert.strictEqual(row.subtuneCount, multiSong.subtune_count);
    assert.ok('subtuneTitle' in row, 'carries its sub-tune title (null when unlabeled)');
    assert.ok(row.size > 0, 'a sub-tune reuses the file size');
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
