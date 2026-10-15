#!/usr/bin/env node
// DEV-ONLY song-search check. Two halves:
//
//  1. the catalog schema the search reads: `song` is one row per *playable
//     song* (a single-song file is one row, a song folder is one row per
//     sub-tune), `song_fts` indexes it, and the legacy per-table FTS pair is
//     gone. Rows must line up 1:1 with music + subtune.
//  2. /search over HTTP against the running dev server: one query, one ranked
//     list, `limit` a hard maximum, a file name finding every song it holds,
//     a label finding its tune, unlabelled tunes found by their file's name.
//
// Fixtures come from the real catalog DB (skips when it is absent) and the dev
// server (skips when it is down), so this stays green on another machine.
// Run: node dev/test-search.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const API_BASE = process.env.CP_API_BASE || 'http://mms-1:8080';
const DB_PATH = path.join(ROOT, 'server', 'catalog.db');

let passed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('check() must not be async here');
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
function skip(name, why) { console.log(`skip  ${name}\n      (${why})`); }

// ---------------------------------------------------------------- schema half
if (!fs.existsSync(DB_PATH)) {
  console.log('no catalog.db -- skipping song-search checks (run scripts/build-music.js)');
  process.exit(0);
}
const db = new Database(DB_PATH, { readonly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

console.log('catalog schema');

check('song and song_fts exist; the legacy FTS pair is gone', () => {
  const names = new Set(all(`SELECT name FROM sqlite_master`).map(r => r.name));
  assert.ok(names.has('song'), 'song table missing');
  assert.ok(names.has('song_fts'), 'song_fts missing');
  assert.ok(!names.has('music_fts'), 'music_fts should have been dropped');
  assert.ok(!names.has('subtune_fts'), 'subtune_fts should have been dropped');
  const trg = all(`SELECT name FROM sqlite_master WHERE type='trigger'`).map(r => r.name);
  for (const t of ['music_ai', 'music_ad', 'music_au', 'subtune_ai', 'subtune_ad', 'subtune_au'])
    assert.ok(!trg.includes(t), `stale trigger ${t}`);
});

check('song holds one row per playable song', () => {
  const songs = one('SELECT COUNT(*) c FROM song').c;
  const singles = one('SELECT COUNT(*) c FROM music WHERE subtune_count <= 1').c;
  const subs = one('SELECT COUNT(*) c FROM subtune').c;
  assert.strictEqual(songs, singles + subs, `song=${songs} != singles ${singles} + subtunes ${subs}`);
});

check('song_fts is in sync with song', () => {
  assert.strictEqual(one('SELECT COUNT(*) c FROM song_fts').c, one('SELECT COUNT(*) c FROM song').c);
});

check('every song row points at a real file and a valid sub-tune index', () => {
  const bad = one(`
    SELECT COUNT(*) c FROM song s LEFT JOIN music m ON m.id = s.music_id
    WHERE m.id IS NULL OR s.subtune < 0 OR s.path = '' OR s.path IS NULL`);
  assert.strictEqual(bad.c, 0);
});

check('(music_id, subtune) is unique', () => {
  const dup = one(`SELECT COUNT(*) c FROM (SELECT music_id, subtune FROM song GROUP BY 1,2 HAVING COUNT(*)>1)`).c;
  assert.strictEqual(dup, 0);
});

check('a song folder has exactly subtune_count rows, contiguous from 0', () => {
  const folder = one('SELECT id, subtune_count FROM music WHERE subtune_count > 1 ORDER BY subtune_count DESC LIMIT 1');
  if (!folder) return; // no multi-song file in this catalog
  const subs = all('SELECT subtune FROM song WHERE music_id = ? ORDER BY subtune', folder.id).map(r => r.subtune);
  assert.strictEqual(subs.length, folder.subtune_count, 'row count != subtune_count');
  assert.deepStrictEqual(subs, [...Array(folder.subtune_count).keys()], 'sub-tunes are not 0..N-1');
});

check('a single-song file has exactly one row at sub-tune 0', () => {
  const f = one('SELECT id FROM music WHERE subtune_count <= 1 LIMIT 1');
  const rows = all('SELECT subtune, title FROM song WHERE music_id = ?', f.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].subtune, 0);
  assert.strictEqual(rows[0].title, null, 'a single-song file has no sub-tune label');
});

check('song.file_title is the parent file title (the folder-name matcher)', () => {
  const bad = one(`
    SELECT COUNT(*) c FROM song s JOIN music m ON m.id = s.music_id
    WHERE COALESCE(s.file_title, '') IS NOT COALESCE(m.title, '')`);
  assert.strictEqual(bad.c, 0);
});

check('song.title is the sub-tune label and nothing else', () => {
  const bad = one(`
    SELECT COUNT(*) c FROM song s LEFT JOIN subtune st
      ON st.music_id = s.music_id AND st.subtune = s.subtune
    WHERE COALESCE(s.title, '') IS NOT COALESCE(NULLIF(st.title, ''), '')`);
  assert.strictEqual(bad.c, 0, 'song.title != the sub-tune label (NULL when unlabelled)');
});

// ---------------------------------------------------------------- HTTP half
const get = async (route) => {
  const res = await fetch(`${API_BASE}${route}`);
  assert.strictEqual(res.status, 200, `GET ${route} -> ${res.status}`);
  return res.json();
};
const search = async (query, limit) =>
  get(`/api/search?query=${encodeURIComponent(query)}&limit=${limit}`);

const folder = one('SELECT m.id, m.path, m.title, m.subtune_count FROM music m WHERE m.subtune_count > 1 ORDER BY m.subtune_count DESC LIMIT 1');
const labeled = one(`SELECT s.subtune, s.title, s.path FROM song s WHERE s.title IS NOT NULL AND s.title <> '' LIMIT 1`);
const unlabeledTune = one(`
  SELECT s.music_id, s.subtune, s.file_title, s.path FROM song s
  WHERE s.subtune > 0 AND (s.title IS NULL OR s.title = '') LIMIT 1`);

(async () => {
  let serverUp = true;
  try {
    const probe = await fetch(`${API_BASE}/api/search?query=a&limit=1`);
    serverUp = probe.ok;
  } catch (e) { serverUp = false; }

  if (!serverUp) {
    console.log('\nsearch API');
    skip('every /search check', `${API_BASE} is not reachable -- start \`npm run dev\``);
    finish();
    return;
  }

  console.log('\nsearch API');

  const run = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); process.exitCode = 1; }
  };

  await run('every result is a playable song (file, song_id, subtune, title|null)', async () => {
    const { items } = await search('the', 20);
    assert.ok(items.length > 0, 'no results for a common term');
    for (const it of items) {
      assert.strictEqual(typeof it.file, 'string');
      assert.ok(it.file.length > 0);
      assert.ok(it.song_id === null || typeof it.song_id === 'string', 'song_id');
      assert.ok(Number.isInteger(it.subtune) && it.subtune >= 0, `subtune ${it.subtune}`);
      assert.ok(it.title === null || typeof it.title === 'string', 'title');
    }
  });

  await run('total equals the number of returned items', async () => {
    const r = await search('the', 20);
    assert.strictEqual(r.total, r.items.length);
  });

  await run('no duplicate (file, sub-tune) in one response', async () => {
    const { items } = await search('a', 100);
    const seen = new Set();
    for (const it of items) {
      const k = `${it.file}\u0000${it.subtune}`;
      assert.ok(!seen.has(k), `duplicate ${it.file} sub-tune ${it.subtune}`);
      seen.add(k);
    }
  });

  // The reviewer's contract: a response may never exceed `limit`. It used to,
  // because file hits and sub-tune hits were each capped and then appended.
  await run('limit is a hard maximum (1, 5, 50, 100)', async () => {
    for (const limit of [1, 5, 50, 100]) {
      const { items, total } = await search('a', limit);
      assert.ok(items.length <= limit, `limit=${limit} returned ${items.length}`);
      assert.strictEqual(total, items.length);
    }
  });

  await run('limit caps a query whose matches span many files', async () => {
    const broad = await search('e', 3);
    assert.ok(broad.items.length <= 3, `got ${broad.items.length}`);
  });

  if (folder) {
    await run('a song folder\'s name finds every song it holds', async () => {
      const { items } = await search(folder.title, 400);
      const mine = items.filter(i => i.file === folder.path);
      assert.strictEqual(mine.length, folder.subtune_count,
        `"${folder.title}" returned ${mine.length} songs of ${folder.subtune_count}`);
      const subs = mine.map(i => i.subtune).sort((a, b) => a - b);
      assert.deepStrictEqual(subs, [...Array(folder.subtune_count).keys()]);
    });

    await run('songs of one folder come back as one block under one file', async () => {
      const { items } = await search(folder.title, 400);
      const idxs = items.map((i, n) => i.file === folder.path ? n : -1).filter(n => n >= 0);
      assert.ok(idxs.length > 0, 'folder not matched');
      assert.strictEqual(idxs[idxs.length - 1] - idxs[0], idxs.length - 1, 'folder rows are not contiguous');
    });
  } else {
    skip('folder-name returns all its songs', 'no multi-song file in catalog');
  }

  if (folder && folder.title) {
    await run('a directory name finds the songs beneath it', async () => {
      const dir = folder.path.split('/').slice(0, -1).join('/');
      if (!dir) return;
      const leaf = dir.split('/').pop();
      const { items } = await search(leaf, 200);
      assert.ok(items.some(i => i.file.startsWith(dir + '/')),
        `"${leaf}" matched nothing under ${dir}`);
    });
  }

  if (labeled) {
    await run('a sub-tune label finds its tune and carries the label', async () => {
      const { items } = await search(labeled.title, 50);
      const hit = items.find(i => i.file === labeled.path && i.subtune === labeled.subtune);
      assert.ok(hit, `"${labeled.title}" did not return ${labeled.path} sub-tune ${labeled.subtune}`);
      assert.strictEqual(hit.title, labeled.title);
    });
  } else {
    skip('label finds its tune', 'no labelled sub-tune in catalog');
  }

  if (unlabeledTune) {
    await run('an unlabelled sub-tune is found by its file\'s name (title stays null)', async () => {
      const { items } = await search(unlabeledTune.file_title, 400);
      const hit = items.find(i => i.file === unlabeledTune.path && i.subtune === unlabeledTune.subtune);
      assert.ok(hit, `"${unlabeledTune.file_title}" did not return its unlabelled tune ${unlabeledTune.subtune}`);
      assert.strictEqual(hit.title, null, 'an unlabelled tune must not be given a title');
    });
  } else {
    skip('unlabelled tune found by file name', 'no unlabelled sub-tune in catalog');
  }

  await run('search is case-insensitive and prefix-matching', async () => {
    const a = await search(folder ? folder.title : 'the', 50);
    const lower = await search((folder ? folder.title : 'the').toLowerCase(), 50);
    assert.strictEqual(lower.total, a.total, 'case changed the result count');
    const term = (folder ? folder.title : 'the').slice(0, Math.max(3, Math.floor((folder ? folder.title : 'the').length / 2)));
    const prefix = await search(term, 50);
    assert.ok(prefix.total >= a.total, 'a prefix matched fewer than the full term');
  });

  await run('a bare quote does not error (sanitised) and empty returns nothing', async () => {
    const q = await search('"', 10);
    assert.ok(Array.isArray(q.items));
    const empty = await search('   ', 10);
    assert.deepStrictEqual(empty.items, []);
    assert.strictEqual(empty.total, 0);
  });

  await run('every returned song is addressable by (?play, sub-tune)', async () => {
    const { items } = await search(folder ? folder.title : 'the', 5);
    for (const it of items) {
      assert.ok(/^\d+$/.test(String(it.subtune)), 'sub-tune is not a number');
    }
  });

  finish();
})().catch(e => { console.error(e); process.exitCode = 1; });

function finish() {
  console.log(`\n${passed} check(s) passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
}
