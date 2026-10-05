// DEV-ONLY: how much does the page fetch before you press play, and how long do the
// media requests take?
//
//   node dev/record/vidleak.mjs [page-url]
//
// Every clip plays in headless Chromium (vidall.mjs), so the symptom the user sees --
// inconsistent, some clips never start -- is not in the files or the codec. What
// differs between headless and a real browser is connection scheduling: HTTP/1.1
// allows 6 concurrent connections per host, and the page asks for 14 media streams
// at once with preload="metadata". Elements beyond the limit queue, and a queued
// element that is asked to play may be waiting on a free connection.
//
// This measures the thing that decides it: total bytes pulled during load, per
// request, and whether the requests finished. If the page pulls ~30 MB before a
// click, preload is fetching whole files and the contention is real; if it pulls a
// few hundred KB (moov only), the connection-limit theory is weaker and the cause is
// elsewhere.

import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://mms-1:8099/';
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();

const reqs = [];
page.on('response', async (r) => {
  const u = r.url();
  if (!/\.mp4(\?|$)/.test(u)) return;
  let len = Number(r.headers()['content-length'] || 0);
  let range = r.headers()['content-range'] || null;
  if (!len) {
    try { len = (await r.body()).length; } catch { len = -1; }
  }
  reqs.push({ clip: u.split('/').pop(), status: r.status(), len, range, t: Date.now() });
});

const t0 = Date.now();
await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('video', { timeout: 30000 });
await page.waitForTimeout(6000);
const elapsed = Date.now() - t0;

// Per-element view of how much each clip actually holds.
const perEl = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => {
  const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
  return { clip: v.currentSrc.split('/').pop(), heldSec: +end.toFixed(2), dur: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null, rs: v.readyState };
}));

const total = reqs.reduce((a, r) => a + (r.len > 0 ? r.len : 0), 0);
const onDisk = [...perEl].reduce((a, e) => a + (e.dur || 0), 0);
console.log(`load finished in ${elapsed} ms, ${reqs.length} mp4 responses, ${(total / 1e6).toFixed(2)} MB transferred`);
console.log(`sum of clip durations: ${onDisk.toFixed(1)} s (a full download would be ~30 MB)\n`);
console.log('per response:');
for (const r of reqs.sort((a, b) => b.len - a.len)) {
  console.log(`  ${r.clip.padEnd(24)} ${String(r.status).padEnd(4)} ${String(r.len).padStart(9)} B  ${r.range || '-'}`);
}
console.log('\nper element (how much the browser is holding):');
for (const e of perEl) console.log(`  ${e.clip.padEnd(24)} holds ${String(e.heldSec).padStart(6)}s of ${String(e.dur).padStart(6)}s  readyState=${e.rs}`);

await ctx.close();
await browser.close();