#!/usr/bin/env node
// DEV-ONLY play-page SEO check: the server-rendered metadata for a ?play= page,
// exercised over HTTP against the running dev server (mms-1:8080, or CP_API_BASE).
//
// A sub-tune is a song of its own, so it gets its own page: `?play=<id>&subtune=N`
// is self-canonical, carries the sub-tune's title and its own MusicRecording
// structured data. Sub-tune 0 is the file page (`?play=<id>`, no &subtune=), and
// an out-of-range/!numeric subtune falls back to it. This pins that contract so
// the server and the sitemap generator (which submits the same URLs) stay aligned.
//
// Fixtures come from the real catalog DB; it skips when the catalog or server is
// absent. Run: node dev/test-play-seo.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const API_BASE = process.env.CP_API_BASE || 'http://mms-1:8080';
const BASE_URL = 'https://chiptune.app';
const DB_PATH = path.join(ROOT, 'server', 'catalog.db');

if (!fs.existsSync(DB_PATH)) {
  console.log('no catalog.db -- skipping play-page SEO checks (run scripts/build-music.js)');
  process.exit(0);
}

const db = new Database(DB_PATH, { readonly: true });

const skip = (why) => Object.assign(new Error(why), { code: 'SKIP' });

async function fetchHtml(route) {
  const res = await fetch(`${API_BASE}${route}`);
  assert.strictEqual(res.status, 200, `GET ${route} -> ${res.status}`);
  return res.text();
}

// Pull the tags the SEO work is responsible for out of the served HTML.
function parse(html) {
  const grab = (re) => (html.match(re) || [])[1];
  const cfg = grab(/window\.__chipConfig = (\{[\s\S]*?\});<\/script>/);
  const ld = grab(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return {
    title: grab(/<title>([^<]*)<\/title>/),
    canonical: grab(/<link rel="canonical" href="([^"]*)"/),
    ogUrl: grab(/<meta property="og:url" content="([^"]*)"/),
    chipConfig: cfg ? JSON.parse(cfg) : null,
    schema: ld ? JSON.parse(ld) : null,
  };
}

let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

async function main() {
  const multi = db.prepare(`
    SELECT m.path, m.song_id, m.subtune_count FROM music m
    WHERE m.subtune_count > 1 ORDER BY m.subtune_count DESC LIMIT 1
  `).get();
  if (!multi) throw skip('no multi-song file in the catalog');

  const labeled = db.prepare(`
    SELECT m.path, m.song_id, m.subtune_count, st.subtune, st.title
    FROM subtune st JOIN music m ON m.id = st.music_id
    WHERE st.title IS NOT NULL AND m.subtune_count > 1 AND st.subtune > 0
    LIMIT 1
  `).get();
  const single = db.prepare(`
    SELECT m.path, m.song_id FROM music m WHERE m.subtune_count = 1 LIMIT 1
  `).get();

  // 1. A multi-song file's bare ?play= is the sub-tune-0 page.
  const bare = parse(await fetchHtml(`/?play=${multi.song_id}`));
  assert.strictEqual(bare.canonical, `${BASE_URL}/?play=${multi.song_id}`,
    'a multi-song file\'s canonical should be bare (no &subtune=)');
  assert.strictEqual(bare.ogUrl, bare.canonical, 'og:url should match canonical');
  assert.strictEqual(bare.chipConfig.subtune, 0, 'bare page is sub-tune 0');
  assert.strictEqual(bare.chipConfig.subtuneCount, multi.subtune_count, 'chipConfig carries the song count');
  assert.ok(bare.title && bare.title.length > 0, 'bare page should have a title');
  ok('a multi-song file\'s bare ?play= is the sub-tune-0 page');

  // 2. A labeled sub-tune is its own page: self canonical, its title, its data.
  if (!labeled) {
    console.log('  skip  a labeled sub-tune (none in this catalog)');
  } else {
    const n = labeled.subtune;
    const selfUrl = `${BASE_URL}/?play=${labeled.song_id}&subtune=${n}`;
    const st = parse(await fetchHtml(`/?play=${labeled.song_id}&subtune=${n}`));
    assert.strictEqual(st.canonical, selfUrl, 'a sub-tune canonical should include &subtune=');
    assert.strictEqual(st.ogUrl, selfUrl, 'og:url should be the sub-tune URL');
    assert.strictEqual(st.chipConfig.subtune, n, 'chipConfig should carry the sub-tune index');
    assert.strictEqual(st.chipConfig.subtuneCount, labeled.subtune_count, 'chipConfig should carry the count');
    assert.ok(st.title.startsWith(labeled.title),
      `title "${st.title}" should start with the sub-tune label "${labeled.title}"`);
    assert.strictEqual(st.schema['@type'], 'MusicRecording', 'structured data should be a MusicRecording');
    assert.strictEqual(st.schema.name, labeled.title, 'structured-data name should be the sub-tune label');
    assert.strictEqual(st.schema.url, selfUrl, 'structured-data url should be the sub-tune URL');
    ok('a labeled sub-tune is its own page (self canonical, title, structured data)');
  }

  // 3. Sub-tune 0, and an out-of-range index, both fall back to the bare page.
  const zero = parse(await fetchHtml(`/?play=${multi.song_id}&subtune=0`));
  assert.strictEqual(zero.canonical, `${BASE_URL}/?play=${multi.song_id}`, 'subtune=0 is the file page');
  const oob = parse(await fetchHtml(`/?play=${multi.song_id}&subtune=${multi.subtune_count}`));
  assert.strictEqual(oob.canonical, `${BASE_URL}/?play=${multi.song_id}`, 'an out-of-range subtune is the file page');
  assert.strictEqual(oob.chipConfig.subtune, 0, 'an out-of-range subtune reports 0');
  ok('subtune 0 and an out-of-range subtune both fall back to the file page');

  // 4. A single-song file ignores subtune and keeps the bare canonical.
  if (!single) {
    console.log('  skip  a single-song file (none in this catalog)');
  } else {
    const s = parse(await fetchHtml(`/?play=${single.song_id}&subtune=3`));
    assert.strictEqual(s.canonical, `${BASE_URL}/?play=${single.song_id}`, 'a single-song file keeps the bare canonical');
    assert.strictEqual(s.chipConfig.subtune, 0, 'a single-song file is sub-tune 0');
    assert.strictEqual(s.chipConfig.subtuneCount, 1, 'a single-song file reports a count of 1');
    ok('a single-song file ignores subtune and keeps the bare canonical');
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((e) => {
  if (e.code === 'SKIP') {
    console.log('play-page SEO: ' + e.message + ' -- skipping.');
    process.exit(0);
  }
  if (e.cause || /fetch failed|ECONNREFUSED/.test(String(e))) {
    console.error(`Could not reach the dev server at ${API_BASE} (start \`npm run dev\`). Skipping.`);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
