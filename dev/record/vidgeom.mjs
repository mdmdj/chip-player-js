// DEV-ONLY: measure what recordVideo actually writes for a given viewport.
//
//   node dev/record/vidgeom.mjs
//
// The clip column is too narrow to read the item names in the browse list, so the
// capture wants to be wider. Two things must be checked before changing
// shoot.mjs's VIEWPORT, and both are things the docs get wrong (Playwright's
// recordVideo.size is documented as "defaults to the viewport scaled to fit in
// 800x800", and shoot.mjs's own comment claims an unset size yields the viewport
// 1:1 -- measured, the default caps the *frame*, not the viewport):
//
//   1. Does a wider viewport still capture 1:1, or does the frame get padded /
//      scaled? A 720 CSS px viewport at dsf 2 currently gives a 720x720 frame,
//      so the capture is NOT at device resolution -- dsf buys glyph crispness in
//      the encoded frame, not a 1440px one.
//   2. Does the app's own layout survive the extra width, or does it stretch the
//      two-column shell and shrink the list? shoot.mjs notes the app has 500px
//      breakpoints, so width is not free.
//
// Prints ffprobe dimensions plus a downscaled PNG per config so the frame can be
// eyeballed, and the app's own layout numbers (list width, footer row height) read
// from the live DOM.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { chromium } from 'playwright';

const BASE = process.env.RECORD_BASE || 'http://mms-1:8080';
const OUT = '/tmp/opencode/vidgeom';

// Viewports to compare. 720x720 is the current capture; the rest are the widths
// under consideration. Height stays 720 so only one axis moves.
const CONFIGS = [
  { w: 720, h: 720, dsf: 2 },
  { w: 800, h: 720, dsf: 2 },
  { w: 900, h: 720, dsf: 2 },
  { w: 960, h: 720, dsf: 2 },
  { w: 900, h: 900, dsf: 2 },
];

fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `ERR ${String(e.message).split('\n')[0]}`;
  }
};

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

for (const cfg of CONFIGS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgeom-'));
  const context = await browser.newContext({
    viewport: { width: cfg.w, height: cfg.h },
    deviceScaleFactor: cfg.dsf,
    recordVideo: { dir },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/browse/nsfe?r=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // What the app actually did with the extra width.
  const layout = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null);
    const row = q('.BrowseList-row');
    const list = q('.BrowseList') || row?.parentElement;
    return {
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      list: box(list),
      row: box(row),
      // The footer is the thing that breaks first at narrow widths.
      footer: box(q('footer')) || box(q('.footer')),
      mtimeVisible: !!q('.BrowseList-mtime') && getComputedStyle(q('.BrowseList-mtime')).display !== 'none',
      rowText: row ? row.textContent.trim().slice(0, 60) : null,
    };
  });

  const video = page.video();
  await context.close();
  const vp = await video.path();
  const dims = sh('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
    'stream=width,height,nb_frames,r_frame_rate', '-of', 'csv=p=0', vp]);
  const png = path.join(OUT, `vp-${cfg.w}x${cfg.h}.png`);
  sh('ffmpeg', ['-v', 'error', '-y', '-i', vp, '-frames:v', '1', '-vf', 'scale=480:-1', png]);

  const ratio = (() => {
    const m = /^(\d+),(\d+)/.exec(dims);
    if (!m) return '?';
    const [, w, h] = m.map(Number);
    return w === cfg.w && h === cfg.h ? '1:1 as requested' : `SCALED from ${cfg.w}x${cfg.h}`;
  })();

  console.log(`viewport ${cfg.w}x${cfg.h} dsf${cfg.dsf} -> frame ${dims}  [${ratio}]`);
  console.log(`   app layout: ${JSON.stringify(layout)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

await browser.close();
console.log(`\nframes: ${OUT}/vp-*.png`);