// DEV-ONLY: favorites still paint from the cache before the server answers.
//
//   node dev/record/check-faves-cache.mjs [--headed]
//
// The companion to check-faves-hydration.mjs. That fix keys the hydration latch
// by account so a user change re-opens it, and clears the list when the
// identity changes underneath it -- neither of which may touch the *first*
// resolution: seeding `faves` from localStorage is deliberate (master's), and
// it is what makes favorites appear without waiting for the GET.
//
// So: seed the cache, hold the server's answer forever, and require the seeded
// favorite to be on the page anyway. The hold is the whole test -- if the list
// painted from the response, the response had to arrive.

import { chromium } from 'playwright';

const BASE = process.env.FAVES_CHECK_BASE || 'http://mms-1:8080';
const headed = process.argv.includes('--headed');
const TOKEN = 'dev-token';

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

const listRes = await fetch(`${BASE}/api/user/favorites`, { headers: { Authorization: `Bearer ${TOKEN}` } });
const faves = listRes.ok ? (await listRes.json()).favorites || [] : [];
if (!faves.length) {
  console.error('dev/record/check-faves-cache.mjs: the dev user has no saved favorites to seed the cache with.');
  process.exit(2);
}
const seeded = faves[0];
const seededName = (seeded.subtuneTitle || seeded.path.split('/').pop() || '').trim();
console.log(`seeding the cache with ${JSON.stringify(seededName)}`);

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });

// The cache the app reads on mount, plus the entry that must never be dropped.
await context.addInitScript(entry => {
  window.localStorage.setItem('faves', JSON.stringify([entry]));
}, seeded);

const page = await context.newPage();
let gets = 0;
let held = null;
let released = false;
await page.route('**/api/user/favorites', route => {
  gets++;
  if (!released) { held = route; return; }   // held for the whole check
  return route.continue();
});

try {
  await page.goto(`${BASE}/browse/mdx`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row', { timeout: 30000 });
  check('the app asked the server for favorites', await (async () => {
    for (let i = 0; i < 60 && gets === 0; i++) await page.waitForTimeout(100);
    return gets > 0;
  })());

  // Client-side, as in the companion check: a page load would restart the app.
  await page.locator('a[href^="/favorites"]').first().click();
  let rows = [];
  let shown = false;
  for (let i = 0; i < 40 && !shown; i++) {
    rows = (await page.locator('.BrowseList-colName a').allTextContents()).map(s => s.trim());
    shown = rows.some(t => seededName && t.includes(seededName));
    if (!shown) await page.waitForTimeout(100);
  }

  check('the cached favorite is on the page', shown, `rows=${JSON.stringify(rows.slice(0, 6))}`);
  check('and the server was never allowed to answer (so the cache painted it)', held !== null, `gets=${gets}`);
} finally {
  if (held) await held.abort().catch(() => {});
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
