// DEV-ONLY: the Local Files panel says it is loading instead of claiming the
// library is empty while it is still being read.
//
//   node dev/record/check-local-loading.mjs [--headed]
//
// Reported by macroscope on PR #10 (App.js:826): the syncfs callback cleared
// `loadingLocalFiles` and then called the async updateLocalFiles(), so for the
// whole sub-tune parse the panel rendered "You don't have any Local Files yet."
// to someone who had files. The loading state has to be cleared together with
// the listing it was covering, in one state update.
//
// The parse is short, so the window is opened deliberately: the parser is a lazy
// webpack chunk (`subtune-headers`), and the harness holds that request while it
// looks at the panel. Three cases:
//
//   files + held chunk   loading text, NOT the empty message; then the listing
//   no files             through loading to the empty message, never stuck
//   files + failed chunk  a parse failure still leaves the panel usable
//
// Needs the dev server. Local files live in the browser, so a fresh context
// starts empty and a run leaves nothing behind.

import { chromium } from 'playwright';

const BASE = process.env.LOCAL_CHECK_BASE || 'http://mms-1:8080';
const headed = process.argv.includes('--headed');
const CHUNK = '**/subtune-headers*';
const FILE = { path: 'nsfe/Akumajou Densetsu (VRC6).nsfe', name: 'zz-folder.nsfe' };
const CACHE_KEY = 'cp.localSubtunes.v1';

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

const browser = await chromium.launch({ headless: !headed });

// The panel's own text and geometry, scoped to the Local Files view: its heading
// is unique, and the whole panel is its parent. Never a body-wide search.
const panel = (page) => page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].find(el => el.textContent.startsWith('Local Files'));
  const root = h && h.parentElement;
  if (!root) return { found: false };
  const msg = root.querySelector('.LocalFiles-message');
  const box = root.getBoundingClientRect();
  const mb = msg && msg.getBoundingClientRect();
  return {
    found: true,
    text: root.textContent,
    loading: /Loading local files/.test(root.textContent),
    empty: /You don't have any Local Files yet/.test(root.textContent),
    rows: root.querySelectorAll('.BrowseList-row').length,
    subtunes: root.querySelectorAll('.LocalFiles-subtune').length,
    align: msg ? getComputedStyle(msg).textAlign : null,
    msgHeight: mb ? Math.round(mb.height) : null,
    centred: mb ? Math.abs((mb.left + mb.width / 2) - (box.left + box.width / 2)) < 4 : null,
  };
});

const addFile = (page, spec) => page.evaluate(async ({ path, name }) => {
  const input = document.querySelector('input[type=file]');
  const enc = path.split('/').map(encodeURIComponent).join('/');
  const blob = await (await fetch(`/catalog/${enc}`)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], name));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, spec);

// IDBFS writes land in IndexedDB asynchronously, and a reload before that flush
// would start from an empty library. Ask for the flush and wait for it, rather
// than sleeping and hoping.
const flushLocalFiles = (page) => page.evaluate(() => new Promise((resolve) => {
  window.ChipPlayer.chipCore.FS.syncfs(false, resolve);
}));

const openPanel = async (page) => {
  await page.goto(`${BASE}/local`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type=file]', { state: 'attached', timeout: 30000 });
};

// ---------------------------------------------------------------- case 1
// Files to read, with the parse held open: the panel must not say "empty".
{
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  let held = null;
  let chunkRequests = 0;

  await openPanel(page);
  await addFile(page, FILE);
  await page.waitForFunction(() => !!document.querySelector('.LocalFiles-folder'), null, { timeout: 20000 });
  await flushLocalFiles(page);
  check('[files] the fixture was read and listed before the reload', (await panel(page)).rows > 0);

  // Cold cache, so the reload really re-parses; then hold the parser chunk.
  await page.evaluate((k) => window.localStorage.removeItem(k), CACHE_KEY);
  await page.route(CHUNK, (route) => { chunkRequests++; held = route; });
  await page.goto(`${BASE}/local`, { waitUntil: 'domcontentloaded' });

  // The request has to be in hand before the panel is judged: the loading state
  // is also what the constructor renders, which would pass for the wrong reason.
  const holding = await (async () => {
    for (let i = 0; i < 100 && chunkRequests === 0; i++) await page.waitForTimeout(100);
    return chunkRequests > 0 && held !== null;
  })();
  const during = await panel(page);
  check('[files] the parser chunk was requested and is held', holding, `requests=${chunkRequests}`);
  check('[files] the panel says it is loading while the parse runs', during.loading, JSON.stringify(during));
  check('[files] it does NOT claim the library is empty', !during.empty, JSON.stringify(during));
  check('[files] the loading text is centred in the panel', during.align === 'center' && during.centred === true,
    `align=${during.align} centred=${during.centred} height=${during.msgHeight}`);

  if (held) { await held.continue(); held = null; }
  const settled = await page.waitForFunction(() =>
    !document.body.textContent.includes('Loading local files') && !!document.querySelector('.LocalFiles-folder'),
    null, { timeout: 20000 }).then(() => true, () => false);
  const after = await panel(page);
  check('[files] the listing appears once the parse finishes', settled && after.subtunes > 1,
    `folders=${after.rows} subtunes=${after.subtunes}`);
  check('[files] the loading text is gone afterwards', !after.loading, JSON.stringify(after));
  await context.close();
}

// ---------------------------------------------------------------- case 2
// Nothing to read: through loading, to the empty message.
{
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  await openPanel(page);
  const settled = await page.waitForFunction(() =>
    !document.body.textContent.includes('Loading local files') &&
    /You don't have any Local Files yet/.test(document.body.textContent),
    null, { timeout: 10000 }).then(() => true, () => false);
  const state = await panel(page);
  check('[none] an empty library ends on the empty message', settled && state.empty, JSON.stringify(state));
  check('[none] it does not stay on the loading text', !state.loading, JSON.stringify(state));
  await context.close();
}

// ---------------------------------------------------------------- case 3
// The parse fails: the panel must still leave the loading state.
{
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  await openPanel(page);
  await addFile(page, FILE);
  await page.waitForFunction(() => !!document.querySelector('.LocalFiles-folder'), null, { timeout: 20000 });
  await flushLocalFiles(page);
  await page.evaluate((k) => window.localStorage.removeItem(k), CACHE_KEY);
  let aborted = 0;
  await page.route(CHUNK, (route) => { aborted++; return route.abort(); });
  await page.goto(`${BASE}/local`, { waitUntil: 'domcontentloaded' });

  const settled = await page.waitForFunction(() =>
    !document.body.textContent.includes('Loading local files'), null, { timeout: 20000 })
    .then(() => true, () => false);
  const state = await panel(page);
  check('[failed parse] the chunk really was requested and refused', aborted > 0, `aborted=${aborted}`);
  check('[failed parse] the panel leaves the loading state', settled && !state.loading, JSON.stringify(state));
  check('[failed parse] the file is still listed, one row per file', state.rows > 0 && state.subtunes === 0,
    `rows=${state.rows} subtunes=${state.subtunes}`);
  await context.close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
