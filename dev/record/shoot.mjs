// DEV-ONLY: record one clip with Playwright (dev/record/README.md).
//
//   node dev/record/shoot.mjs <clip-id> [--keep] [--headed]
//
// Why Playwright and not the host's tab recorder (`preview_recording_start`):
//
//   * Sharpness. Measured 1:1 against a native Chromium render, the host
//     recorder captures at **1x CSS pixels and upscales 1.5x** -- its output is
//     1350x1350 for a 900x900 viewport, and the glyph edges are visibly smeared
//     (it matches a 1x render blown up, not a DPR-1.5 render). Playwright with an
//     explicit `deviceScaleFactor` renders at the device resolution, so there is
//     no upscale anywhere. The host recorder exposes no quality, scale or codec
//     option, so this cannot be fixed from its side.
//   * No transfer cap. Recordings come back through a 50 MiB attachment limit,
//     which takes fails outright (measured: a 56 s take was lost).
//   * No tool-call latency. Everything below happens inside one node process, so
//     the take is not at the mercy of preview_evaluate's intermittent
//     transport failures or a multi-second round trip per step.
//   * Predictable frame rate: a constant ~25 fps, versus the host's variable-rate
//     stream that declares 1/1 and needs `-fps_mode passthrough` to survive.
//
// The audio half is unchanged and still comes from the page: the host recorder
// never had an audio track, so nothing is lost by not using it. `__cpRec` mirrors
// the app's gain node into a MediaStreamDestination, uploads the opus blob to
// dev/record/upload-server.mjs, and paints the white flash that find-flash.sh
// uses to trim both streams to a common origin.
//
// Framing: 720 CSS px at deviceScaleFactor 2 -> a 1440x1440 video. The glyphs are
// 25% larger than a 900 px viewport would give and are pixel-exact at 2x, so the
// footer and slider text is readable without any post sharpening.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { byId } from './scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, 'dev/record/.work');
const SITE = path.join(ROOT, 'site');
const BASE = process.env.RECORD_BASE || 'http://mms-1:8080';

const VIEWPORT = { width: 720, height: 720 };
const SCALE = 2;
// Playwright's recordVideo.size is deliberately NOT set. Unset, it defaults to
// the viewport size (capped at 800), so a 720 px viewport yields a 720x720 frame
// captured 1:1 -- no upscale, no padding. Setting it to viewport x deviceScaleFactor
// (1440) *pads* the screencast frame instead: the app ends up occupying ~57% of the
// picture, the rest is page backdrop, and a full-viewport white flash stops being
// detectable because it only lights a third of the frame -- which is exactly how
// find-flash.sh first reported "no flash". 720 CSS px also sits above the app's
// 500 px breakpoints (which hide the mtime column, the footer art and the
// shuffle/repeat buttons), so the whole UI stays in frame.

const id = process.argv[2];
const keep = process.argv.includes('--keep');
const headed = process.argv.includes('--headed');
const scenario = byId[id];
if (!scenario) {
  console.error(`no scenario: ${id}`);
  process.exit(1);
}

const sh = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, ...opts });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });

// The page uploads its audio and proof JSON here; make sure it is listening.
async function ensureReceiver() {
  const port = 3999;
  const host = new URL(BASE).hostname;
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return true;
  } catch { /* not up yet */ }
  const p = spawn(process.execPath, [path.join(ROOT, 'dev/record/upload-server.mjs')], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  p.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { /* keep waiting */ }
  }
  throw new Error(`upload receiver did not come up on ${host}:${port}`);
}

const span = Math.max(...scenario.steps.map((s) => s.atMs || 0), 0);

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  await ensureReceiver();

  const shotDir = fs.mkdtempSync(path.join(WORK, 'shot-'));
  const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    recordVideo: { dir: shotDir },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 160)));

  // The video starts at context creation, so the page load is in the file; the
  // flash inside run() is what trims it away.
  await page.goto(`${BASE}${scenario.browse}?r=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row', { timeout: 30000 });
  await page.waitForFunction(() => !!window.__cpRec, null, { timeout: 30000 });
  await page.evaluate((s) => window.__cpRec.pinDefaults(s), scenario.settings || {});
  // Wait for the listing to settle: clicking during the first paint races the
  // fetch and the row is not in the DOM yet.
  await page.waitForTimeout(800);

  const armed = await page.evaluate((spec) => window.__cpRec.run(spec), {
    name: scenario.id,
    preload: scenario.preload || null,
    steps: scenario.steps,
    until: scenario.until || null,
    intervalMs: 100,
    assert: scenario.assert || [],
  });
  console.log(`armed ${scenario.id}: ${JSON.stringify(armed)}`);

  // run() finishes on a page-side timer; poll for its verdict.
  let result = null;
  const deadline = Date.now() + span + 30000;
  while (Date.now() < deadline) {
    result = await page.evaluate(() => window.__cpRec.result());
    if (result && !result.pending) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!result || result.pending) throw new Error('take never finished');
  // A page-side failure lands here as { error }, with no `verdict`. Reading
  // result.verdict first turned that into "Cannot convert undefined or null to
  // object", which hid the actual message -- the opposite of the point of
  // surfacing failures loudly.
  if (result.error) throw new Error(`page-side failure: ${result.error}`);

  const video = page.video();
  await context.close();          // finalises the video file
  const videoPath = await video.path();
  await browser.close();

  const failed = Object.entries(result.verdict).filter(([, v]) => !v.pass);
  console.log(`verdict: ${result.pass ? 'PASS' : 'FAIL'}${failed.length ? ` -- ${failed.map(([k, v]) => `${k}${v.detail ? ` (${v.detail})` : ''}`).join('; ')}` : ''}`);
  console.log(`marks: ${(result.marks || []).map((m) => `${m.t}:${m.label}`).join(', ')}`);

  const audioPath = path.join(WORK, `${scenario.id}.webm`);
  if (!fs.existsSync(audioPath)) throw new Error(`page did not upload audio: ${audioPath} missing`);

  // Framing assertion, because the padded-frame failure is silent apart from a
  // missing flash: if the capture is not exactly the viewport, Playwright scaled
  // or padded the screencast and the clip is not what we think it is.
  const dims = (await sh('bash', ['-c',
    `ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 ${JSON.stringify(videoPath)}`])).out.trim();
  const got = dims.split(',').map((n) => Number(n));
  if (got[0] !== VIEWPORT.width || got[1] !== VIEWPORT.height) {
    throw new Error(`capture is ${dims}, expected ${VIEWPORT.width}x${VIEWPORT.height} -- recordVideo scaled or padded the frame (see the note above)`);
  }

  const flash = (await sh('bash', ['dev/record/find-flash.sh', videoPath])).out.trim().split('\n')[0];
  const mux = await sh('bash', ['dev/record/mux.sh', videoPath, audioPath,
    path.join(SITE, 'clips', `${scenario.id}.mp4`), flash, String(result.audio.audioStartToFlashMs)]);
  process.stdout.write(mux.out);
  if (mux.code !== 0) throw new Error(`mux failed (${mux.code})`);

  if (!keep) fs.rmSync(shotDir, { recursive: true, force: true });
  console.log(`done: site/clips/${scenario.id}.mp4`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((e) => {
  // The stack matters: a bare message once hid that a page-side failure had no
  // `verdict` at all, and cost a take to diagnose.
  console.error('FAILED:', e.message);
  if (process.env.SHOOT_TRACE) console.error(e.stack);
  process.exit(1);
});