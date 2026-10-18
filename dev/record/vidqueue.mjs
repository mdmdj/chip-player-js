// DEV-ONLY: was it really the queue? Test the old page against the new one.
//
//   node dev/record/vidqueue.mjs
//
// The user pushed back on the diagnosis, and rightly: on a LAN 34 MB is about a
// second, and clicking play should make the browser fetch the video rather than sit
// at 0:00. So the claim "35 MB was the problem" does not survive its own arithmetic.
//
// The claim worth testing is narrower: it was never total bytes, it was that 14
// elements each opened a *speculative* download at once, a browser runs ~6 at a
// time, and a click has to queue behind 13 requests nobody asked for. That predicts
// something specific and testable -- an early click stalls, a late click works -- and
// it is the opposite of "the network is too slow", because by the late click the
// bytes are already local.
//
// So: serve the old page (preload="metadata") and the new one (preload="none") side
// by side, and for each, click play on the LAST clip on the page both early and
// after the load settles. The last clip is the one furthest down the queue.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from './express.mjs';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');
const CLIPS = ['songfolder.mp4', 'favorite-subtune.mp4', 'loop-band.mp4', 'repeat-toggle-smooth.mp4',
  'repeat-leave-fade.mp4', 'blind-loop.mp4', 'vgm-native.mp4', 'gme-looping-driver.mp4',
  'mdx-native.mp4', 'midi-cc102.mp4', 'xmp-learned-band.mp4', 'sid-tail-restart.mp4',
  'n64-indefinite.mp4', 'v2m-tier3.mp4'];
const LAST = 'v2m-tier3.mp4';   // index 13: the deepest in any queue

// Build the "old" page: same HTML, preload="metadata", no poster/w/h left off.
const OLD = fs.mkdtempSync(path.join(os.tmpdir(), 'vidqueue-'));
fs.cpSync(SITE, OLD, { recursive: true });
const html = fs.readFileSync(path.join(OLD, 'index.html'), 'utf8')
  .replace(/preload="none"/g, 'preload="metadata"')
  .replace(/ poster="[^"]*"/g, '')
  .replace(/ width="\d+" height="\d+"/g, '');
fs.writeFileSync(path.join(OLD, 'index.html'), html);

const server = express().use(express.static(OLD, { etag: true, lastModified: true }))
  .listen(8091, '127.0.0.1', () => console.log('old page (preload=metadata) on 8091'));
// The new page, same static options, so the only variable is the HTML.
const server2 = express().use(express.static(SITE, { etag: true, lastModified: true }))
  .listen(8090, '127.0.0.1', () => console.log('new page (preload=none) on 8090'));

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

// One trial: load `url`, wait `settleMs`, then click play on the last clip and see
// whether the clock actually moves within `windowMs`.
async function trial(label, url, settleMs) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  let offered = 0;
  page.on('response', (r) => {
    if (/\.mp4(\?|$)/.test(r.url())) offered += Number(r.headers()['content-length'] || 0);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('video', { timeout: 30000 });
  await page.waitForTimeout(settleMs);

  const before = await page.evaluate((clip) => {
    const v = [...document.querySelectorAll('video')].find((x) => x.currentSrc.includes(clip));
    return { rs: v.readyState, buffered: v.buffered.length ? +v.buffered.end(0).toFixed(2) : 0 };
  }, LAST);

  const res = await page.evaluate(async (clip) => {
    const v = [...document.querySelectorAll('video')].find((x) => x.currentSrc.includes(clip));
    let err = null;
    const t0 = v.currentTime;
    try { await v.play(); } catch (e) { err = e.name; }
    // Poll, because the failure mode is "never starts", not "starts wrong".
    let moved = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      moved = +(v.currentTime - t0).toFixed(2);
      if (moved > 0.4) break;
    }
    v.pause();
    return { err, moved, rs: v.readyState };
  }, LAST);

  await ctx.close();
  const verdict = res.moved > 0.4 ? 'PLAYED' : 'STALLED';
  console.log(`${label.padEnd(42)} settled=${String(settleMs).padStart(5)}ms  readyState=${before.rs} buffered=${String(before.buffered).padStart(5)}s  ->  ${verdict} (moved ${res.moved}s in 5s${res.err ? `, play() ${res.err}` : ''})`);
  return res.moved > 0.4;
}

console.log(`\nclicking the last clip on the page (${LAST}, 14th of 14)\n`);
const rows = [];
rows.push(['old, click 0.5s after load', await trial('old  preload=metadata  early click', 'http://127.0.0.1:8091/', 500)]);
rows.push(['old, click after 8s settle', await trial('old  preload=metadata  late click', 'http://127.0.0.1:8091/', 8000)]);
rows.push(['new, click 0.5s after load', await trial('new  preload=none      early click', `http://127.0.0.1:${8090}/`, 500)]);
rows.push(['new, click after 8s settle', await trial('new  preload=none      late click', `http://127.0.0.1:${8090}/`, 8000)]);

console.log('\nsummary:');
for (const [k, ok] of rows) console.log(`  ${ok ? 'played ' : 'STALLED'}  ${k}`);

await browser.close();
server.close();
server2.close();
fs.rmSync(OLD, { recursive: true, force: true });
