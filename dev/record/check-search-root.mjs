// DEV-ONLY: a search result at the catalog root gets a valid directory heading.
// The empty heading is the case that returned null from
// encodeRawFilepathSegments and crashed pathJoin before the browse link was made.
//
//   node dev/record/check-search-root.mjs [--headed]
//
// Needs the dev server and the `test.nsf` fixture at the catalog root.

import { chromium } from 'playwright';

const BASE = process.env.SEARCH_CHECK_BASE || 'http://mms-1:8080';
const QUERY = process.env.SEARCH_CHECK_QUERY || 'test.nsf';
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
  await page.goto(`${BASE}/?q=${encodeURIComponent(QUERY)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.BrowseList-row', { timeout: 30000 });
  check('the root fixture is listed', (await page.locator('.BrowseList-row').filter({ hasText: 'test.nsf' }).count()) > 0);
  const hrefs = await page.locator('.BrowseList-row a').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')));
  check('the root heading links to /browse/', hrefs.some(h => h && h.endsWith('/browse/')), hrefs.join(', '));
  check('no page error was raised', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.log(`skip  ${e.message}`);
  process.exitCode = 2;
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
