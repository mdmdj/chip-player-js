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

// 900x720 rather than square: the browse list truncates item names at 720 CSS px
// (measured with dev/record/vidgeom.mjs: the list column grows 239px -> 419px
// between 720 and 900, which is the difference between "Castlevania III - Dracula's…"
// and the full name). Width was the short axis. Both numbers are even, so yuv420p
// has no chroma-sampling problem.
const VIEWPORT = { width: 900, height: 720 };
const SCALE = 2;
// recordVideo.size IS set, to exactly the viewport, and that is load-bearing.
//
// Measured (dev/record/vidgeom.mjs for the geometry, dev/record/vidcap.mjs for the
// pixels) rather than read off the docs, which only say the default is "the viewport
// scaled down to fit in 800x800" and not what an explicit larger value does:
//
//   size UNSET     720x720 -> 720x720   1:1, no scale      <- fitted inside the cap
//   size UNSET     800x720 -> 800x720   1:1, no scale      <- exactly the cap
//   size UNSET     900x720 -> 800x640   0.889x RESAMPLED  <- over the cap
//   size EXPLICIT  900x720 -> 900x720   1:1, fills frame  <- what we want
//
// So the default scales the *viewport* down once the frame would exceed 800 on either
// axis, resampling an already-supersampled page and softening the glyph edges dsf=2
// exists to keep. Stating the size bypasses that. The failure this comment used to
// describe was a different mistake: setting size to viewport x deviceScaleFactor
// (1440) pads the frame and leaves the app at ~57% of the picture. So the rule is
// "size == viewport exactly", never the dsf product. vidcap.mjs asserts the app fills
// the frame -- paint a known colour, read the corners back out of the encode -- since
// the padded case still reports the requested dimensions and only pixels give it away.
//
// 900 CSS px is well above the app's 500 px breakpoints (which hide the mtime column,
// the footer art and the shuffle/repeat buttons), so the whole UI stays in frame, and
// the framing assertion below fails loudly if that ever stops being true.

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
// A scenario may ask for a taller frame (see loop-band). The reason is measured, not
// aesthetic: with the Settings panel open, VGM's per-chip toggles push "Show Loop
// Area" down to y=532-551 while the footer starts at y=509, so at 720 the control
// sits *behind* the footer -- elementFromPoint at its centre returns a footer
// transport button. A synthetic click still fires the React handler, which is how a
// DOM assertion can be green over a click no viewer could make. Nothing in the panel
// scrolls, so height is the only lever: 780 gives 18px of clearance, 840 gives 78px,
// chosen as margin for footers that grow with song metadata. Declared here, after
// `scenario`, because it reads it.
const viewport = scenario.viewport || VIEWPORT;

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  await ensureReceiver();

  const shotDir = fs.mkdtempSync(path.join(WORK, 'shot-'));
  const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: SCALE,
    // Exactly the viewport -- see the note above. Unset would resample to 800x640.
    recordVideo: { dir: shotDir, size: { width: viewport.width, height: viewport.height } },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 160)));

  // The video starts at context creation, so the page load is in the file; the
  // flash inside run() is what trims it away.
  await page.goto(`${BASE}${scenario.browse}?r=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.BrowseList-row', { timeout: 30000 });
  await page.waitForFunction(() => !!window.__cpRec, null, { timeout: 30000 });
  await page.evaluate((s) => window.__cpRec.pinDefaults(s), scenario.settings || {});
// Opt-in, and off the settings object so it never reaches the app's settings POST.
// A scenario that demonstrates favouriting needs an empty list to start from -- see
// clearFavorites in the shim for why (virtualized list, and the footer satisfies
// text assertions regardless).
if (scenario.clearFavorites) {
  console.log('cleared favorites: ' + JSON.stringify(await page.evaluate(() => window.__cpRec.clearFavorites())));
}
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
  if (got[0] !== viewport.width || got[1] !== viewport.height) {
    throw new Error(`capture is ${dims}, expected ${viewport.width}x${viewport.height} -- recordVideo scaled or padded the frame (see the note above)`);
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