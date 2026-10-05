// DEV-ONLY: play every clip on the page, one at a time, and report per-clip.
//
//   node dev/record/vidall.mjs [page-url]
//
// vidcheck.mjs probes the first video and one named clip, which is enough to answer
// "does this page serve media correctly" but not "why does clicking play work on some
// clips and not others". The report is inconsistent, so every clip needs testing, and
// the per-clip numbers are where the pattern shows: a codec the browser will not
// decode, a media error code, a clip that never reaches readyState 4, one that starts
// and then stalls.
//
// For each clip: the element's state before play(), whether play() rejects, and
// whether currentTime actually advances over a fixed window. Plus the browser's own
// canPlayType answers, because "the file is valid" and "this browser can decode it"
// are different claims -- H.264 High and AAC are both licensed codec families, and a
// build without them reports empty strings here while ffprobe calls the file fine.

import { chromium } from 'playwright';

const URL_ = process.argv[2] || 'http://mms-1:8099/';
const PLAY_MS = 2000;

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 120)}`); });

await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('video', { timeout: 30000 });
await page.waitForTimeout(4000);

const codecs = await page.evaluate(() => {
  const v = document.createElement('video');
  return {
    h264High: v.canPlayType('video/mp4; codecs="avc1.640028"'),
    h264Baseline: v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
    aacLc: v.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    mp4: v.canPlayType('video/mp4'),
    ua: navigator.userAgent.slice(0, 110),
  };
});
console.log('browser canPlayType:', JSON.stringify(codecs, null, 1));

const count = await page.evaluate(() => document.querySelectorAll('video').length);
console.log(`\n${count} clips on the page\n`);

const rows = [];
for (let i = 0; i < count; i++) {
  const r = await page.evaluate(async ({ i, ms }) => {
    const v = document.querySelectorAll('video')[i];
    v.pause();
    v.currentTime = 0;
    await new Promise((res) => setTimeout(res, 150));
    const ranges = (tr) => (tr.length ? `${tr.start(0).toFixed(1)}-${tr.end(0).toFixed(1)}` : 'empty');
    const before = {
      readyState: v.readyState,
      networkState: v.networkState,
      duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),
      error: v.error ? `${v.error.code}` : null,
      buffered: ranges(v.buffered),
      seekable: ranges(v.seekable),
      w: v.videoWidth,
    };
    let playErr = null;
    try { await v.play(); } catch (e) { playErr = `${e.name}`; }
    const t0 = v.currentTime;
    await new Promise((res) => setTimeout(res, ms));
    const t1 = v.currentTime;
    const advanced = +(t1 - t0).toFixed(2);
    v.pause();
    return { name: v.currentSrc.split('/').pop(), before, playErr, advanced, afterReady: v.readyState, afterError: v.error ? `${v.error.code}` : null };
  }, { i, ms: PLAY_MS });
  rows.push(r);
  const ok = r.advanced > 0.5 && !r.playErr && !r.afterError;
  console.log(`${ok ? 'PLAYS ' : 'STALLS'} ${r.name.padEnd(24)} rs=${r.before.readyState} ns=${r.before.networkState} dur=${r.before.duration} buf=${r.before.buffered.padEnd(10)} seek=${r.before.seekable.padEnd(10)} err=${r.before.error || '-'}/${r.afterError || '-'} play=${r.playErr || 'ok'} advanced=${r.advanced}s`);
}

const bad = rows.filter((r) => !(r.advanced > 0.5 && !r.playErr && !r.afterError));
console.log(`\n${rows.length - bad.length}/${rows.length} played; ${bad.length} stalled`);
if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].slice(0, 8).join('\n  '));

await ctx.close();
await browser.close();