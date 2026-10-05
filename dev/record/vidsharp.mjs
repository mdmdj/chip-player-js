// DEV-ONLY: is an explicit >800 recordVideo.size as sharp as the current capture?
//
//   node dev/record/vidsharp.mjs
//
// The corner test (vidcap.mjs) proves an explicit size is not padded, and that it
// records at 1:1 CSS pixels rather than the 800-capped resample. It cannot prove
// *sharpness*, and that is the thing shoot.mjs's whole size comment is defending:
// with size unset at 900x720 the frame is 800x640, i.e. the already-supersampled
// page downscaled 0.889x, which softens text. So compare both against ground
// truth -- a direct Playwright screenshot of the same page at the same size.
//
// SSIM is the measure the repo already uses for this judgement (see shoot.mjs's
// quality note). 1.0 means the encode is indistinguishable from the native render;
// the padded/resampled cases score visibly lower.
//
// Note on dsf: measured frame sizes show the encode is at CSS resolution, not
// device resolution (720 CSS px at dsf 2 yields a 720x720 frame, not 1440x1440),
// so dsf=2 is buying supersampled antialiasing rather than a bigger frame. That is
// why scale must be held constant across this comparison.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { chromium } from 'playwright';

const BASE = process.env.RECORD_BASE || 'http://mms-1:8080';
const OUT = '/tmp/opencode/vidsharp';

const CONFIGS = [
  { w: 720, h: 720, explicit: false }, // today's capture
  { w: 900, h: 720, explicit: false }, // wanted width, size unset -> capped resample
  { w: 900, h: 720, explicit: true },  // wanted width, size stated -> 1:1
];

fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `ERR ${String(e.message).split('\n')[0]}`;
  }
};

// Ground truth: the live page, screenshotted at the frame size the encode uses.
async function reference(page, w, h, file) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
  await page.screenshot({ path: file });
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

for (const c of CONFIGS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidsharp-'));
  const recordVideo = c.explicit ? { dir, size: { width: c.w, height: c.h } } : { dir };
  const context = await browser.newContext({
    viewport: { width: c.w, height: c.h },
    deviceScaleFactor: 2,
    recordVideo,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/browse/nsfe?r=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const video = page.video();
  const dims = sh('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', await video.path().catch(() => '/dev/null')]);
  await context.close();
  const vp = await video.path();

  const [fw, fh] = sh('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', vp]).split(',').map(Number);

  // The last frame of the take, and a native render at exactly the frame size.
  const frame = path.join(OUT, `frame-${c.w}-${c.explicit ? 'explicit' : 'unset'}.png`);
  sh('ffmpeg', ['-v', 'error', '-y', '-sseof', '-0.5', '-i', vp, '-frames:v', '1', frame]);

  // Reference needs the same pixel dimensions; reuse a second page for it.
  const ctx2 = await browser.newContext({ viewport: { width: fw, height: fh }, deviceScaleFactor: 1 });
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/browse/nsfe?r=${Date.now() + 1}`, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.BrowseList-row', { timeout: 30000 }).catch(() => {});
  await p2.waitForTimeout(1000);
  const ref = path.join(OUT, `ref-${c.w}x${fh}.png`);
  await reference(p2, fw, fh, ref);
  await ctx2.close();

  const ssim = sh('ffmpeg', ['-v', 'info', '-i', frame, '-i', ref, '-lavfi',
    '[0:v][1:v]ssim', '-f', 'null', '-']);
  const m = /All:([0-9.]+)/.exec(ssim);

  console.log(`viewport ${c.w}x${c.h} size:${c.explicit ? 'explicit' : 'unset'}` +
    ` -> frame ${fw}x${fh}  SSIM vs native render: ${m ? m[1] : '?'}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

await browser.close();
console.log(`\nimages: ${OUT}/`);