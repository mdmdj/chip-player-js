// DEV-ONLY: does a favorite toggle that is still in flight when the account
// goes away stay out of the new session -- the list *and* its localStorage copy?
//
//   node dev/record/check-faves-account-switch.mjs [--headed] [--dir mdx]
//
// macroscope found this on PR #10 (`UserProvider.js:225`), same family as the
// hydration race next door: the sign-out bumps `favesRefreshToken`, but the
// post-toggle hydration claims a *new* token when it is issued, so that earlier
// invalidation no longer covers it -- and the GET it issues still runs with the
// `user` the toggle's closure captured. The response then lands on the cleared
// (or the new account's) list. The guard is `lastUid.current === user.uid`.
//
// The check performs the sign-out form of the switch. A switch to another
// account goes through the same guard, but dev has one account and the auth
// bypass answers every token as it, so the new account's own (legitimate) GET
// would bring the same list -- indistinguishable from the leak, and not
// assertable here.
//
// The race is reproduced, not waited for: the initial favorites GET is held, so
// the list stays cold and the post-toggle hydration branch is reachable at all;
// the toggle's POST is held; the identity then changes; only then is the POST
// released. The success path is the dangerous one, so the run asserts the
// mutation really did reach the server afterwards.
//
// The claim is about what persists, so the assertion reads localStorage -- the
// browser context is fresh, so it starts empty and any witness path appearing
// in it can only have come from the leaked refresh. It is checked together with
// its mechanism (no second list GET may be issued) and the scenario itself (the
// GET really was held, the switch really preceded the release), so a run that
// never raced cannot pass vacuously.
//
// Needs the dev server (npm run dev) and a favorite already saved on the dev
// user -- that saved entry is the witness: it is what the client cannot know on
// its own (the GET never landed). Skips (exit 2) when there is none.

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

// The JSON the server actually stored, which is not always what the API
// reports (favorites are decorated by songId, so a byte-identical catalog copy
// can take the displayed path). Cleanup must target the stored path.
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
// so a client whose initial GET is held cannot show it -- and a leaked refresh
// cannot help but bring it.
const before = await serverFaves();
const storedBefore = storedFaves();
if (!before.length) {
  console.error('dev/record/check-faves-account-switch.mjs: the dev user has no saved favorites.');
  console.error('That entry is the witness this check needs (a server-only favorite the client cannot');
  console.error('invent). Save one with the app\'s heart button, then re-run.');
  process.exit(2);
}
const witnessPaths = new Set(before.map(f => f.path));
console.log(`witness: ${before.length} server favorite(s), e.g. ${JSON.stringify((before[0].path || '').split('/').pop())}`);

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));

const log = [];
const stamp = what => log.push(`${what}@${Date.now() - t0}`);
const t0 = Date.now();
const at = prefix => log.findIndex(e => e.startsWith(prefix));

let getCount = 0;
let addCount = 0;
let heldGet = null;
let heldAdd = null;

// Hold the first list GET (so the list stays cold) and the first toggle POST.
// Separate patterns: the list route must not swallow /add.
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
const seed = () => page.evaluate(() => {
  try { return JSON.parse(window.localStorage.getItem('faves') || '[]'); } catch (e) { return null; }
});

try {
  await page.goto(`${BASE}/browse/${DIR}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row .FavoriteButton', { timeout: 30000 });
  check('the initial GET was issued', await poll(() => getCount >= 1));

  const switchable = await page.evaluate(() => typeof window.__cpDevSetUser === 'function');
  check('the dev identity hook is available (dev shim staged)', switchable);
  if (!switchable) throw new Error('window.__cpDevSetUser is missing -- run ./dev/apply.sh and restart npm run dev');

  // Toggle a row that is NOT already a favorite, so the run's addition is
  // identifiable for cleanup.
  const favNames = before.map(f => (f.path || '').split('/').pop());
  const pick = await page.$$eval('.BrowseList-row', (rows, names) => {
    const buttons = [...document.querySelectorAll('.BrowseList-row .FavoriteButton')];
    for (const r of rows) {
      const a = r.querySelector('.BrowseList-colName a');
      const b = r.querySelector('.FavoriteButton');
      if (!a || !b) continue;
      const name = (a.textContent || '').trim();
      if (names.includes(name)) continue;
      return { index: buttons.indexOf(b), name };
    }
    return null;
  }, favNames);
  check('an un-favorited row is available to toggle', !!pick, `pick=${pick && pick.name}`);

  await page.locator('.BrowseList-row .FavoriteButton').nth(pick.index).click();
  check('the toggle was issued while the list GET was held',
    await poll(() => addCount >= 1 && heldGet !== null && heldAdd !== null), `adds=${addCount}`);

  // The identity goes away while the toggle is still in flight -- the whole
  // point of the check. (Prod does this through onAuthStateChanged; dev skips
  // Firebase, so the hook performs the same step.)
  await page.evaluate(() => window.__cpDevSetUser(null));
  stamp('SWITCH');
  check('the switch cleared the list', await poll(async () => (await seed()).length === 0),
    `seed=${JSON.stringify(await seed())}`);

  // Release it: the mutation succeeds for the account that issued it, which is
  // exactly when the unguarded code re-reads and paints.
  await heldAdd.continue();
  heldAdd = null;
  stamp('ADD#1-released');
  const landed = await poll(async () => (await serverFaves()).length === before.length + 1);
  check('the toggle really landed after the switch (the success path)', landed,
    `server=${(await serverFaves()).length} expected=${before.length + 1}`);

  // (1) The mechanism: no second list GET may be issued for the dead session.
  const secondGet = await poll(() => getCount >= 2, 3000);
  check('no favorites GET was issued for the account that went away', !secondGet, `GETs=${getCount}`);

  // (2) The artefact: the leaked list would be persisted here, and a reload
  // trusts this seed before any GET answers.
  const leaked = (await seed()).filter(f => witnessPaths.has(f.path));
  check('the old account\'s favorites were not written to localStorage', leaked.length === 0,
    `leaked=${JSON.stringify(leaked.map(f => f.path))}`);

  // (3) The scenario: it really raced, in the order the bug needs.
  check('the race really happened (switch before the release, GET still held)',
    at('GET#1') === 0 && at('SWITCH') < at('ADD#1-released') && at('ADD#1') < at('SWITCH'),
    log.join(' '));

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} finally {
  if (heldGet) await heldGet.abort().catch(() => {});
  if (heldAdd) await heldAdd.abort().catch(() => {});
  await browser.close();

  // Undo this run's toggle; the stored set is left exactly as it was.
  const afterStored = storedFaves();
  const added = [];
  const seen = new Set();
  for (const a of afterStored) {
    const key = faveKey(a);
    if (storedBefore.some(b => faveKey(b) === key) || seen.has(key)) continue;
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
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
