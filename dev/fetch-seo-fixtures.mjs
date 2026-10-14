#!/usr/bin/env node
// DEV-ONLY (dev/**, never promoted). Fetch the catalog directories that
// scripts/test-seo.js references from the production catalog into
// ./catalog/<path>, so a local `build-music` run can index them and
// `npm run test:seo` has the rows it asserts on.
//
// The seed list is parsed out of scripts/test-seo.js, so it cannot drift from
// the test it exists to satisfy. Scope is fixed to those directories: it lists
// each one via the public browse API and downloads the files beneath it, with
// a courteous delay between every request. Nothing else is crawled.
//
// Idempotent: a file already present at the expected size is skipped, so a
// re-run costs only the directory listings. Pass --force to re-fetch.
//
//   node dev/fetch-seo-fixtures.mjs [--delay 400] [--dry-run] [--force] [--base URL]
//   node dev/fetch-seo-fixtures.mjs --check [--db server/catalog.db]
//
// `--check` writes nothing: it reports whether the catalog already has a row
// for every seed directory (exit 1 with the fix if not), so dev/run-tests.sh
// can gate test-seo on it.
//
// Then index the new files and check the test:
//   node scripts/build-music.js -n && npm run test:seo

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const TEST_FILE = join(REPO, 'scripts', 'test-seo.js');
const UA = 'chip-player-js-dev-catalog-fixture/1.0 (+https://github.com/mdmdj/chip-player-js; local test fixture)';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
};
const DELAY = Number(opt('--delay', 400)); // ms between network requests
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const CHECK = args.includes('--check');
const DB_PATH = String(opt('--db', join(REPO, 'server', 'catalog.db')));
const BASE = String(opt('--base', 'https://chiptune.app')).replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The seed paths are the `path: '...'` literals in test-seo.js; dedupe and keep
// source order so the log reads like the test suite.
async function seedPaths() {
  const src = await readFile(TEST_FILE, 'utf8');
  const found = [...src.matchAll(/path:\s*'((?:[^'\\]|\\.)+)'/g)].map((m) => m[1]);
  const seen = new Set();
  return found.filter((p) => !seen.has(p) && seen.add(p));
}

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

async function collect(dirPath, files, counters) {
  const rows = await getJson(`${BASE}/api/browse?path=${encodeURIComponent(dirPath)}`);
  counters.listings++;
  await sleep(DELAY);
  for (const x of Array.isArray(rows) ? rows : []) {
    if (x.type === 'directory') await collect(x.path, files, counters);
    else if (x.type === 'file') files.set(x.path, x.size || 0);
  }
}

async function download(path, size, counters) {
  const dest = join(REPO, 'catalog', path);
  if (!FORCE) {
    try {
      const s = await stat(dest);
      if (s.size === size && s.size > 0) {
        counters.skipped++;
        return true;
      }
    } catch {}
  }
  const url = `${BASE}/catalog/${path.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      counters.downloaded++;
      counters.bytes += buf.length;
      await sleep(DELAY);
      return true;
    } catch (e) {
      if (attempt === 3) {
        console.error(`  FAIL ${path}: ${e.message}`);
        counters.failed++;
        return false;
      }
      await sleep(750 * attempt);
    }
  }
}

const main = async () => {
  const seeds = await seedPaths();
  if (!seeds.length) throw new Error(`no seed paths parsed from ${TEST_FILE}`);

  if (CHECK) {
    let missing;
    try {
      const Database = require('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      const stmt = db.prepare('SELECT 1 FROM directories WHERE path = ?');
      missing = seeds.filter((s) => !stmt.get(s));
      db.close();
    } catch (e) {
      console.error(`fetch-seo-fixtures: cannot read ${DB_PATH} (${e.message})`);
      missing = seeds;
    }
    if (missing.length) {
      console.error(`test-seo needs ${seeds.length} catalog directories; the dev catalog is missing ${missing.length}:`);
      for (const m of missing.slice(0, 6)) console.error('  - ' + m);
      if (missing.length > 6) console.error(`  ... and ${missing.length - 6} more`);
      console.error('Fix: node dev/fetch-seo-fixtures.mjs && node scripts/build-music.js -n');
      process.exit(1);
    }
    console.log(`test-seo fixtures present: ${seeds.length}/${seeds.length} directories (${DB_PATH})`);
    return;
  }

  console.log(`seeds from test-seo.js: ${seeds.length} directories; delay ${DELAY}ms/request`

    + (DRY_RUN ? '; DRY RUN' : '') + (FORCE ? '; force' : ''));

  const files = new Map();
  const counters = { listings: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
  for (const s of seeds) await collect(s, files, counters);
  const totalBytes = [...files.values()].reduce((a, b) => a + b, 0);
  console.log(`${files.size} files across ${seeds.length} directories (${(totalBytes / 1048576).toFixed(1)} MB)`);

  if (DRY_RUN) {
    console.log('dry run: no files written');
    return;
  }

  // Serial on purpose: one request at a time, DELAY between each, so the crawl
  // stays gentle on the maintainer's host.
  let n = 0;
  for (const [path, size] of files) {
    await download(path, size, counters);
    if (++n % 50 === 0) console.log(`  ${n}/${files.size} ...`);
  }

  await writeFile(join(REPO, 'dev', '.seo-fixtures.manifest'), [...files.keys()].sort().join('\n') + '\n');
  console.log(`done: downloaded=${counters.downloaded} skipped=${counters.skipped} failed=${counters.failed}`
    + ` (${(counters.bytes / 1048576).toFixed(2)} MB), listings=${counters.listings}`);
  console.log('next: node scripts/build-music.js -n && npm run test:seo');
  if (counters.failed) process.exitCode = 1;
};

main().catch((e) => {
  console.error('fetch-seo-fixtures: ' + e.message);
  process.exit(1);
});
