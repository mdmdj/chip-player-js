// DEV-ONLY: does a favorite toggled before the first /user/favorites GET lands
// still end up showing the favorites the server already had?
//
//   node dev/record/check-faves-hydration.mjs [--headed] [--dir mdx]
//
// Both reviewers found this on PR #10 (macroscope `UserProvider.js:208`,
// greptile P1): a toggle invalidates the in-flight initial GET, so the list is
// hydrated by a deferred refresh once the last toggle lands. Stamped with that
// toggle's own token, the refresh was rejected as soon as a *later-started*
// toggle had already finished -- and the favorites the server already had were
// then missing from the page until a reload.
//
// The race is reproduced, not waited for: the first GET and the first POST are
// held, the second POST is allowed to finish, and only then is the first POST
// released, so the older toggle lands last. That ordering is the one that used
// to reject the refresh.
//
// The claim is what a user sees, so the assertion reads the Favorites page --
// scoped to the list, because the footer shows a song title on every page. And
// the scenario itself is asserted (the GET was held, the toggles really did
// overlap, the older one really did land last), so a run that never raced
// cannot pass the page assertion vacuously.
//
// Needs the dev server (npm run dev) and a favorite already saved on the dev
// user -- that saved entry is the witness: it is what the client cannot know on
// its own. Skips (exit 2) when there is none.

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
// reports: favorites are decorated by songId, so when the catalog holds two
// byte-identical copies of a file, the displayed path can be the *other* copy.
// Diffs and cleanup must use the stored path, or a remove targets a path that
// was never stored and silently matches nothing (the row count still makes it
// answer 200).
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

// The witness: a favorite that exists on the server before the browser starts,
// so a client that never hydrates cannot show it.
const before = await serverFaves();
const storedBefore = storedFaves();
if (!before.length) {
  console.error('dev/record/check-faves-hydration.mjs: the dev user has no saved favorites.');
  console.error('That entry is the witness this check needs (a server-only favorite the client cannot');
  console.error('invent). Save one with the app\'s heart button, then re-run.');
  process.exit(2);
}
const witness = before[0];
const witnessName = (witness.subtuneTitle || witness.path.split('/').pop() || '').trim();
console.log(`witness: ${JSON.stringify(witnessName)}  (${witness.path}${witness.subtune ? ` subtune ${witness.subtune}` : ''})`);
console.log(`server favorites before: ${before.length}`);

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();

// Record who asks for the favorites list, across navigations (the page-side
// array would be wiped by the goto below, so report to node instead). The
// client uses XHR via axios here, so this patches open().
const favCalls = [];
await page.exposeFunction('__reportFavCall', rec => favCalls.push(rec));
await page.addInitScript(() => {
  const report = () => window.__reportFavCall({
    at: Math.round(performance.now()),
    stack: (new Error().stack || '').split('\n').slice(1, 6).map(s => s.trim().replace(/\(.*\//, '(')).join(' | '),
  });
  const isList = u => String(u).includes('/user/favorites') && !/\/add|\/remove/.test(String(u));
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isList(url)) report();
    return open.call(this, method, url, ...rest);
  };
  const fetchOrig = window.fetch;
  window.fetch = function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (isList(u)) report();
    return fetchOrig.call(this, input, init);
  };
});

const log = [];
const stamp = what => log.push(`${what}@${Date.now() - t0}`);
const t0 = Date.now();
// Entries carry their timestamp, so match by prefix rather than equality.
const at = prefix => log.findIndex(e => e.startsWith(prefix));

let getCount = 0;
let addCount = 0;
let heldGet = null;
let heldAdd = null;

// Hold the first GET and the first POST; let everything after them through.
await page.route('**/api/user/favorites', route => {
  getCount++;
  stamp(`GET#${getCount}`);
  if (getCount === 1) { heldGet = route; return; }
  return route.continue();
});
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

try {
  await page.goto(`${BASE}/browse/${DIR}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row .FavoriteButton', { timeout: 30000 });
  check('the initial GET was issued', await poll(() => getCount >= 1));

  const hearts = await page.locator('.BrowseList-row .FavoriteButton').count();
  check('the listing has at least two heartable rows', hearts >= 2, `hearts=${hearts}`);

  // Toggle rows that are NOT already favorites: the run's additions are then
  // exactly what cleanup has to undo, and a leftover from an earlier run cannot
  // masquerade as one of them.
  const favNames = before.map(f => (f.path || '').split('/').pop());
  const picks = await page.$$eval('.BrowseList-row', (rows, names) => {
    const buttons = [...document.querySelectorAll('.BrowseList-row .FavoriteButton')];
    const seenIds = new Set();
    const out = [];
    for (const r of rows) {
      const a = r.querySelector('.BrowseList-colName a');
      const b = r.querySelector('.FavoriteButton');
      if (!a || !b) continue;
      const name = (a.textContent || '').trim();
      // Distinct songs only. Two catalog copies of one file share a songId and
      // resolve to a single server entry, which would collapse both toggles into
      // one favorite -- and then the diff-based cleanup would under-count.
      const songId = ((a.getAttribute('href') || '').match(/play=([^&]+)/) || [])[1] || name;
      if (names.includes(name) || seenIds.has(songId)) continue;
      seenIds.add(songId);
      out.push({ index: buttons.indexOf(b), name });
    }
    return out;
  }, favNames);
  check('two un-favorited rows are available to toggle', picks.length >= 2, `picks=${picks.length}`);
  console.log(`toggling: ${picks[0] && picks[0].name} then ${picks[1] && picks[1].name}`);

  // Two toggles, deliberately overlapping: the first POST is still held when
  // the second one completes. The gap lets React re-render between them, so
  // this cannot be confused with two clicks sharing one render's closure.
  await page.locator('.BrowseList-row .FavoriteButton').nth(picks[0].index).click();
  await page.waitForTimeout(80);
  await page.locator('.BrowseList-row .FavoriteButton').nth(picks[1].index).click();
  check('both toggles were issued while the first was held',
    await poll(() => addCount >= 2 && heldAdd !== null), `adds=${addCount}`);

  // Wait for the *second* toggle to have actually reached the server: exactly
  // one new favorite, because the first is still held.
  await poll(async () => (await serverFaves()).length === before.length + 1);
  const midCount = (await serverFaves()).length;
  check('the newer toggle landed while the older was held', midCount === before.length + 1, `server=${midCount}`);

  // Release the older toggle, so it lands last.
  await heldAdd.continue();
  heldAdd = null;
  stamp('ADD#1-released');
  await poll(async () => (await serverFaves()).length === before.length + 2);
  const addedCount = (await serverFaves()).length;
  check('the older toggle landed after the newer one', addedCount === before.length + 2, `server=${addedCount}`);

  // The older toggle's completion is what issues the deferred refresh.
  const sawRefresh = await poll(() => getCount >= 2);
  check('the deferred hydration request was issued', sawRefresh, `GETs=${getCount}`);
  check('it was issued by the older toggle, not before it', at('GET#2') > at('ADD#1-released'), log.join(' '));

  // Release the very first GET last: it is the stale one, and must be dropped.
  await heldGet.continue();
  heldGet = null;
  stamp('GET#1-released');

  // Navigate client-side. A page.goto() here would RELOAD the app, which
  // re-runs the initial GET and hydrates the list anyway -- masking the very
  // bug under test ("missing until another toggle or reload").
  await page.locator('a[href^="/favorites"]').first().click();
  let rows = [];
  const shown = await poll(async () => {
    rows = (await page.locator('.BrowseList-colName a').allTextContents()).map(s => s.trim());
    return rows.some(t => witnessName && t.includes(witnessName));
  }, 10000);
  check('the server-only favorite is on the Favorites page after the race', shown, `rows=${JSON.stringify(rows.slice(0, 6))}`);

  check('the race really happened (GET held past both toggles)',
    at('GET#1') === 0 && at('ADD#1') < at('ADD#2') &&
    at('GET#1-released') > at('ADD#1-released'),
    log.join(' '));

  console.log('favorites-list requests made by the page:');
  for (const c of favCalls) console.log(`  t+${c.at}ms  ${c.stack}`);
} finally {
  if (heldGet) await heldGet.abort().catch(() => {});
  if (heldAdd) await heldAdd.abort().catch(() => {});
  await browser.close();

  // Undo this run's toggles; the stored set is left exactly as it was.
  const beforeStored = storedBefore;
  const afterStored = storedFaves();
  const added = [];
  const seen = new Set();
  for (const a of afterStored) {
    const key = faveKey(a);
    if (beforeStored.some(b => faveKey(b) === key) || seen.has(key)) continue;
    seen.add(key);
    added.push(a);
  }
  console.log(`cleanup: stored ${afterStored.length} (${added.length} added by this run: ${added.map(a => a.path).join(', ')})`);
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
    console.log(`cleanup: WARNING stored favorites now ${restored.length}, expected ${beforeStored.length}: ` +
      restored.map(f => f.path).join(', '));
  } else {
    console.log(`cleanup: stored favorites back to ${restored.length}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
