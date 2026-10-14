#!/usr/bin/env node
// DEV-ONLY, not part of the PR. Stress the app with rapid mixed-format
// switching, hunting the intermittent client-wasm "RuntimeError: null function"
// seen once during the charts-subtunes clip (chart shuffle + Next every ~2 s).
//
// The fault, if it is one, lives in the *page's* wasm core, so a fresh browser
// context per group (not a server restart) is the reset that matters.
//
//   node dev/record/stress.mjs [--groups 10] [--per-group 100] [--dwell 400] [--headed]
//
// Stops at the first repro and prints the recent (format:player) sequence and
// the error stack. Exit 2 on repro, 0 if clean.
import { chromium } from 'playwright';

const BASE = process.env.RECORD_BASE || 'http://mms-1:8080';
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
};
const GROUPS = Number(arg('--groups', 10));
const PER = Number(arg('--per-group', 100));
const DWELL = Number(arg('--dwell', 400));
const HEADED = process.argv.includes('--headed');
const VIEWPORT = { width: 1280, height: 800 };

const ext = (p) => (p ? (String(p).split('.').pop() || '?').toLowerCase() : '?');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot(page) {
  try {
    return await page.evaluate(() => {
      const cp = window.ChipPlayer;
      const player = cp?.sequencer?.getPlayer?.();
      return {
        path: cp?.sequencer?.getCurrSongRef?.()?.path || cp?.sequencer?.getCurrSongPath?.() || null,
        cls: player?.constructor?.name || null,
      };
    });
  } catch {
    return null;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
  let total = 0;
  let repro = null;

  try {
    for (let g = 1; g <= GROUPS && !repro; g++) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      let pageError = null;
      page.on('pageerror', (e) => { if (!pageError) pageError = e; });
      page.on('crash', () => { if (!pageError) pageError = new Error('page crashed (renderer)'); });

      const recent = [];
      let switches = 0;
      const push = (info) => {
        if (info) recent.push(`${ext(info.path)}:${info.cls || '?'}`);
        if (recent.length > 12) recent.shift();
      };

      let started = false;
      try {
        await page.goto(`${BASE}/top`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.BrowseList-row', { timeout: 30000 });
        await page.click('.Browse-topRow button[title^="Shuffle"]', { timeout: 15000 });
        await page.waitForSelector('.AppFooter button[title="Next"]', { timeout: 15000 });
        await sleep(800);
        started = true;
      } catch (e) {
        console.log(`group ${g}: setup failed: ${e.message}`);
      }

      if (started) {
        for (let i = 0; i < PER && !pageError; i++) {
          // Direct DOM click: Playwright's click() waits for actionability and
          // times out on the footer's re-rendered button, which made the run
          // ~8 s per miss. A synthetic click still fires the React handler.
          const clicked = await page.evaluate(() => {
            const b = document.querySelector('.AppFooter button[title="Next"]');
            if (b) { b.click(); return true; }
            return false;
          }).catch(() => false);
          if (clicked) { switches++; total++; }
          await sleep(DWELL);
          push(await snapshot(page));
          if (switches && switches % 25 === 0) console.log(`  g${g} ${switches}/${PER} ...`);
        }
      }

      if (pageError) {
        repro = { group: g, switches, recent: recent.slice(), message: pageError.message, stack: pageError.stack || '' };
        console.log(`\n*** REPRO in group ${g} after ${switches} switches ***`);
        console.log('message:', pageError.message);
        console.log('recent (format:player):', recent.join(' -> '));
        console.log('stack:\n' + (pageError.stack || '(no stack)'));
      } else {
        console.log(`group ${g}: ${switches} switches, clean`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${total} switches total; ${repro ? 'REPRODUCED' : 'no repro'}.`);
  process.exitCode = repro ? 2 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
