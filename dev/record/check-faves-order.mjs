// DEV-ONLY: does a favorite added while an earlier one is still in flight stay
// where the user put it?
//
//   node dev/record/check-faves-order.mjs [--headed] [--dir mdx]
//
// Greptile on PR #16 (`UserProvider.js:234`): the successful add response removed
// the entry from its optimistic position and appended it again, so adding A and
// then B while A's request is still pending turned [A, B] into [B, A]. The
// Favorites list preserves that order within a directory, so the rows -- and the
// order the list plays in -- moved as responses arrived.
//
// The race is reproduced, not waited for: the first POST is held, the second is
// allowed to finish, and only then is the first released, so the older toggle
// lands last. The assertion reads the Favorites page, scoped to the list rows,
// and the scenario itself is asserted (both toggles overlapped, the newer one
// really did land first), so a run that never raced cannot pass vacuously.
//
// Navigate client-side on purpose: a page.goto() reloads the app, whose hydration
// GET re-reads the server's own (arrival) order and hides the client one.
//
// Needs the dev server (npm run dev). Adds two favorites to the dev user and
// removes them again; a leftover from an earlier run cannot masquerade as one of
// them, because the picks skip anything already favorited.

import { chromium } from 'playwright';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const BASE = process.env.FAVES_CHECK_BASE || 'http://mms-1:8080';
const DIR = process.env.FAVES_CHECK_DIR || 'mdx';
const headed = process.argv.includes('--headed');

const TOKEN = 'dev-token';
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};
const serverFaves = () => api('/user/favorites').then(d => d.favorites || []);
const faveKey = f => `${f.path}\u0000${f.subtune || 0}`;

// The JSON the server has actually stored, which is not always what the API
// reports: entries are decorated by songId, so a file whose stored path differs
// in case from the catalog name comes back rewritten -- and a remove aimed at the
// decorated path silently matches nothing (the row count still answers 200).
const storedFaves = () => {
  const db = new Database(fileURLToPath(new URL('../../server/users.db', import.meta.url)), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("select items from playlists where type = 'favorites'").get();
    return row ? JSON.parse(row.items) : [];
  } finally {
    db.close();
  }
};

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
};

const before = await serverFaves();
const beforeStored = storedFaves();
const beforeKeys = new Set(beforeStored.map(faveKey));
console.log(`server favorites before: ${before.length}`);

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();

const log = [];
const t0 = Date.now();
const stamp = what => log.push(`${what}@${Date.now() - t0}`);
const at = prefix => log.findIndex(e => e.startsWith(prefix));

let addCount = 0;
let heldAdd = null;
await page.route('**/api/user/favorites/add', route => {
  addCount++;
  stamp(`ADD#${addCount}`);
  if (addCount === 1) { heldAdd = route; return; }
  return route.continue();
});

const poll = async (fn, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await page.waitForTimeout(60);
  }
  return false;
};

const added = [];
try {
  await page.goto(`${BASE}/browse/${DIR}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row .FavoriteButton', { timeout: 30000 });

  // A row's link text is the song's title, not its file name, so identify picks by
  // songId: a favorite that is already saved must not be picked again (the server
  // appends a second copy rather than deduplicating).
  const favIds = new Set(before.map(f => f.songId).filter(Boolean));
  const picks = await page.$$eval('.BrowseList-row', (rows, ids) => {
    const names = new Set(ids);
    const buttons = [...document.querySelectorAll('.BrowseList-row .FavoriteButton')];
    const seenIds = new Set();
    const out = [];
    for (const r of rows) {
      const a = r.querySelector('.BrowseList-colName a');
      const b = r.querySelector('.FavoriteButton');
      if (!a || !b) continue;
      const name = (a.textContent || '').trim();
      // Distinct songs only: two byte-identical catalog copies share a songId and
      // resolve to one server entry, which would collapse both toggles into one.
      const songId = ((a.getAttribute('href') || '').match(/play=([^&]+)/) || [])[1] || name;
      if (names.has(songId) || seenIds.has(songId)) continue;
      seenIds.add(songId);
      out.push({ index: buttons.indexOf(b), name, songId });
    }
    return out;
  }, [...favIds]);
  check('two un-favorited rows are available to toggle', picks.length >= 2, `picks=${picks.length}`);
  console.log(`toggling: ${picks[0] && picks[0].name} then ${picks[1] && picks[1].name}`);

  // A is clicked first and held; B is clicked while A is still in flight and lands
  // first. The 80 ms gap lets React re-render between them, so this cannot be two
  // clicks sharing one render's closure.
  await page.locator('.BrowseList-row .FavoriteButton').nth(picks[0].index).click();
  await page.waitForTimeout(80);
  await page.locator('.BrowseList-row .FavoriteButton').nth(picks[1].index).click();
  check('both toggles were issued while the first was held',
    await poll(() => addCount >= 2 && heldAdd !== null), `adds=${addCount}`);

  await poll(async () => (await serverFaves()).length === before.length + 1);
  const midCount = (await serverFaves()).length;
  check('the newer toggle landed while the older was held',
    midCount === before.length + 1, `server=${midCount}`);

  await heldAdd.continue();
  heldAdd = null;
  stamp('ADD#1-released');
  await poll(async () => (await serverFaves()).length === before.length + 2);
  check('the older toggle landed after the newer one',
    (await serverFaves()).length === before.length + 2, `server=${(await serverFaves()).length}`);
  for (const f of storedFaves()) if (!beforeKeys.has(faveKey(f))) added.push(f);

  // The artefact: the list the page renders, in the order the user built it.
  await page.locator('a[href^="/favorites"]').first().click();
  let rows = [];
  await poll(async () => {
    rows = (await page.locator('.BrowseList-colName a').allTextContents()).map(s => s.trim());
    return rows.length >= 2;
  }, 10000);
  const ia = rows.findIndex(t => picks[0] && t.includes(picks[0].name));
  const ib = rows.findIndex(t => picks[1] && t.includes(picks[1].name));
  check('both picks are on the Favorites page', ia >= 0 && ib >= 0,
    `A=${ia} B=${ib} rows=${JSON.stringify(rows.slice(0, 6))}`);
  check('the earlier click is still ahead of the later one', ia >= 0 && ib >= 0 && ia < ib,
    `A=${ia} B=${ib} (the older add must not move to the end)`);

  check('the race really happened (the first POST was held past the second)',
    at('ADD#1') < at('ADD#2') && at('ADD#1-released') > at('ADD#2'), log.join(' '));
} finally {
  for (const f of added) {
    try {
      await api('/user/favorites/remove', { method: 'POST', body: JSON.stringify(f) });
      console.log(`cleanup: removed ${f.path}`);
    } catch (e) {
      console.log(`cleanup: FAILED to remove ${f.path}: ${e.message}`);
    }
  }
  const restored = storedFaves();
  if (restored.length !== beforeStored.length) {
    failed++;
    console.log(`FAIL  cleanup could not restore the dev user's favorites: now ${restored.length}, expected ${beforeStored.length}`);
  } else {
    console.log(`cleanup: favorites back to ${restored.length}`);
  }
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
