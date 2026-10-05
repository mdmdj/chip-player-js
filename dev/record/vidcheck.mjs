// DEV-ONLY: reproduce a <video> playback failure against a served page.
//
//   node dev/record/vidcheck.mjs <url> [clip-id]
//
// Reports the media element's pipeline state (readyState, networkState, error,
// buffered/seekable ranges) and whether currentTime actually advances after
// play(). Used to tell a *file* problem from a *delivery* problem: a clip that
// plays standalone but not on the page points at how the page is served.
//
// Why headless Playwright rather than the preview tab: this needs the real
// media pipeline and a real network stack, and the take must be reproducible.

import { chromium } from 'playwright';

const url = process.argv[2];
const clip = process.argv[3] || null;
if (!url) {
  console.error('usage: vidcheck.mjs <page-url> [clip-id]');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await context.newPage();

// What did the media request actually get back? A 200 with no Accept-Ranges, or a
// 200 where a 206 was asked for, is the whole story in one line.
const media = [];
page.on('response', (r) => {
  const u = r.url();
  if (!/\.mp4(\?|$)/.test(u)) return;
  media.push({
    clip: u.split('/').pop(),
    status: r.status(),
    contentRange: r.headers()['content-range'] || null,
    acceptRanges: r.headers()['accept-ranges'] || null,
    length: r.headers()['content-length'] || null,
  });
});

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('video', { timeout: 30000 });
await page.waitForTimeout(3000);

const probe = async (which) => page.evaluate(async (sel) => {
  const vs = [...document.querySelectorAll('video')];
  const v = sel ? vs.find((x) => x.currentSrc.includes(sel) || x.src.includes(sel)) : vs[0];
  if (!v) return { error: 'no such video' };
  const ranges = (tr) => (tr.length ? tr.start(0).toFixed(2) + '-' + tr.end(0).toFixed(2) : 'empty');
  const before = {
    readyState: v.readyState,
    networkState: v.networkState,
    duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : String(v.duration),
    currentTime: v.currentTime,
    paused: v.paused,
    error: v.error ? `${v.error.code}: ${v.error.message || ''}` : null,
    buffered: ranges(v.buffered),
    seekable: ranges(v.seekable),
    videoWidth: v.videoWidth,
    src: v.currentSrc.split('/').pop(),
  };
  // The question the user asked: does pressing play move the clock?
  let playErr = null;
  try {
    await v.play();
  } catch (e) {
    playErr = `${e.name}: ${e.message}`;
  }
  await new Promise((r) => setTimeout(r, 2500));
  const after = { paused: v.paused, currentTime: Number(v.currentTime.toFixed(2)), readyState: v.readyState };
  return { before, playErr, after, advanced: after.currentTime > before.currentTime };
}, which);

console.log(`first video: ${JSON.stringify(await probe(clip))}`);
if (clip) console.log(`clip ${clip}: ${JSON.stringify(await probe(clip))}`);

console.log('media responses:');
for (const m of media.slice(0, 6)) console.log('  ', JSON.stringify(m));
console.log(`  (${media.length} mp4 request(s) total)`);

await context.close();
await browser.close();