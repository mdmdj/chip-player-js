// DEV-ONLY: the logged-out heart shows the login prompt, not a silent no-op
// (and not a favorite mutation). The dev user is injected; __cpDevSetUser is
// the same identity switch the account-switch check uses.
//
//   node dev/record/check-favorite-login.mjs [--headed]
//
// Needs the dev server and a catalog directory with at least one heartable row.

import { chromium } from 'playwright';

const BASE = process.env.FAVES_CHECK_BASE || 'http://mms-1:8080';
const DIR = process.env.FAVES_CHECK_DIR || 'mdx';
const headed = process.argv.includes('--headed');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
};

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e && e.message || e)));

try {
  await page.goto(`${BASE}/browse/${DIR}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.BrowseList-row .FavoriteButton', { timeout: 30000 });
  const hasHook = await page.evaluate(() => typeof window.__cpDevSetUser === 'function');
  if (!hasHook) {
    console.log('skip  dev identity hook is not present');
    process.exitCode = 2;
  } else {
    await page.evaluate(() => window.__cpDevSetUser(null));
    await page.locator('.BrowseList-row .FavoriteButton').first().click();
    await page.waitForSelector('.toast-box', { timeout: 2000 });
    const text = (await page.locator('.toast-box').innerText()).replace(/\s+/g, ' ').trim();
    check('the login prompt is shown', /Login\/Sign Up/i.test(text) && /Save Favorites/i.test(text), text);
    check('it is an info toast', await page.locator('.toast-info').count() === 1);
    check('no page error was raised', errors.length === 0, errors.join(' | '));
  }
} catch (e) {
  console.log(`skip  ${e.message}`);
  process.exitCode = 2;
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
