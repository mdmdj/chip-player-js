// DEV-ONLY: does an explicit recordVideo.size stay 1:1 above the 800 cap?
//
//   node dev/record/vidcap.mjs
//
// Measured (dev/record/vidgeom.mjs): with recordVideo.size UNSET, Playwright fits
// the frame inside 800x800 by scaling the viewport down. 720x720 -> a 720x720
// frame (fits, no scale) and 800x720 -> 800x720 (fits exactly), but 900x720 ->
// 800x640: the app is resampled 0.889x. That is exactly the failure shoot.mjs's
// size comment exists to avoid, so a wider capture is not free unless an explicit
// size bypasses the cap.
//
// Dimensions alone cannot answer the rest: the padded case is the one that
// silently shrinks the app to ~57% of the picture and breaks full-viewport flash
// detection, while the frame still reports the requested size. So paint the page
// a known colour and read actual pixels out of the encode:
//   - corners red  -> the app fills the frame (1:1, no padding)
//   - corners other -> padded or letterboxed
// Sampling is done on a late frame via a raw rgb24 pipe decoded here, because a
// filter-based corner crop silently yields nothing when it fails -- an earlier
// version of this probe read those empty bytes as "padded", which was the probe
// lying, not the frame.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { chromium } from 'playwright';

const BASE = process.env.RECORD_BASE || 'http://mms-1:8080';
const OUT = '/tmp/opencode/vidcap';

const CANDIDATES = [
  { w: 720, h: 720, explicit: false },  // current: unset size, fits the cap
  { w: 800, h: 720, explicit: false },  // largest that fits the cap
  { w: 900, h: 720, explicit: false },  // wanted width, size unset
  { w: 900, h: 720, explicit: true },   // wanted width, size stated
  { w: 900, h: 900, explicit: true },
];

fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    return null;
  }
};

const label = (c) => `${c.w}x${c.h} size:${c.explicit ? 'explicit' : 'unset'}`;

// Decode one late frame to rgb24 and report the corner/centre colours.
function framePixels(file, w, h) {
  const raw = sh('ffmpeg', ['-v', 'error', '-sseof', '-0.5', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  if (!raw || raw.length < w * h * 3) return null;
  const at = (x, y) => {
    const o = (y * w + x) * 3;
    return [raw[o], raw[o + 1], raw[o + 2]];
  };
  return { tl: at(2, 2), tr: at(w - 3, 2), bl: at(2, h - 3), br: at(w - 3, h - 3), mid: at(w >> 1, h >> 1) };
}

const isRed = ([r, g, b]) => r > 190 && g < 70 && b < 70;

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

for (const c of CANDIDATES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidcap-'));
  const recordVideo = c.explicit ? { dir, size: { width: c.w, height: c.h } } : { dir };
  const context = await browser.newContext({
    viewport: { width: c.w, height: c.h },
    deviceScaleFactor: 2,
    recordVideo,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/browse/nsfe?r=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row', { timeout: 30000 }).catch(() => {});
  // Known colour so padding is unmistakable, and the list is populated so the
  // width under test is actually exercised.
  await page.evaluate(() => {
    document.documentElement.style.background = '#ff0000';
    document.body.style.background = '#ff0000';
  });
  await page.waitForTimeout(1500);

  const video = page.video();
  await context.close();
  const vp = await video.path();

  const dims = sh('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', vp], { encoding: 'utf8' })?.trim() || '?';
  const [fw, fh] = dims.split(',').map(Number);
  const px = Number.isFinite(fw) ? framePixels(vp, fw, fh) : null;

  const verdict = !px
    ? 'could not decode a frame'
    : isRed(px.tl) && isRed(px.br) && isRed(px.tr) && isRed(px.bl)
      ? 'app fills the frame (1:1, no padding)'
      : `PADDED/letterboxed (corners tl=${px.tl} tr=${px.tr} bl=${px.bl} br=${px.br})`;

  const scaled = fw && fh ? `${(fw / c.w).toFixed(3)}x` : '?';
  console.log(`${label(c).padEnd(26)} -> frame ${String(dims).padEnd(10)} scale ${scaled.padEnd(7)} ${verdict}`);

  const png = path.join(OUT, `cap-${c.w}x${c.h}-${c.explicit ? 'explicit' : 'unset'}.png`);
  sh('ffmpeg', ['-v', 'error', '-y', '-sseof', '-0.5', '-i', vp, '-frames:v', '1', '-vf', 'scale=520:-1', png]);
  fs.rmSync(dir, { recursive: true, force: true });
}

await browser.close();
console.log(`\nframes: ${OUT}/cap-*.png`);