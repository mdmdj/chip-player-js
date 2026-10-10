// DEV-ONLY: record clips with Playwright (dev/record/README.md).
//
//   node dev/record/shoot.mjs --clip <id> [--clip <id>...] [--keep] [--headed]
//   node dev/record/shoot.mjs --all
//
// `--clip` is repeatable, so a batch is one invocation and no shell loop. A bare
// positional id still works (`shoot.mjs loop-band`) for muscle memory, but named
// is the documented form: the positional read is `argv[2]` verbatim, so
// `shoot.mjs --keep` used to die with `no scenario: --keep` and a flag-first
// invocation looked like a missing argument. Every flag now parses independently
// of every other one's position.
//
// Naming the clips is also what makes "which ones am I re-recording?" answerable
// from the command line -- the point of a selective re-shoot. With `--clip a --clip
// b` you can see it; with a `for` loop over the registry you cannot.
//
// There is deliberately no default-to-all: no clip ids at all is an error, because
// a bare `shoot.mjs` that quietly recorded all 14 would be a 3.5-minute surprise
// (14 takes x ~15 s). `--all` is the explicit way to ask for that.
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

import { scenarios, byId } from './scenarios.mjs';

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

// Parse flags independently of position. `--clip` collects (it is repeatable);
// `--clip=a` is accepted too, since that is what a muscle-memory `git`-style
// invocation produces and rejecting it would just be pedantry. Anything else that
// is not a flag is a clip id, so the positional form keeps working.
const argv = process.argv.slice(2);
const ids = [];
const unknownFlags = [];
const keep = argv.includes('--keep');
const headed = argv.includes('--headed');
const all = argv.includes('--all');
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--clip') {
    const v = argv[++i];
    if (v === undefined) { console.error('--clip needs a clip id'); process.exit(1); }
    ids.push(v);
  } else if (a.startsWith('--clip=')) {
    ids.push(a.slice('--clip='.length));
  } else if (a === '--keep' || a === '--headed' || a === '--all') {
    // handled above
  } else if (a.startsWith('-')) {
    unknownFlags.push(a);
  } else {
    ids.push(a);
  }
}
if (unknownFlags.length) {
  console.error(`unknown flag: ${unknownFlags.join(', ')}\nusage: node dev/record/shoot.mjs --clip <id> [--clip <id>...] [--keep] [--headed]`);
  process.exit(1);
}

// `--all` and an explicit list together is a contradiction worth naming rather
// than silently resolving: the user asked for two different sets at once.
if (all && ids.length) {
  console.error(`--all cannot be combined with --clip (${ids.join(', ')}). Pick one.`);
  process.exit(1);
}
if (all) {
  for (const s of scenarios) ids.push(s.id);
}
if (!ids.length) {
  console.error(`no clip id given -- nothing recorded.\nusage: node dev/record/shoot.mjs --clip <id> [--clip <id>...] [--keep] [--headed]\n       node dev/record/shoot.mjs --all\nclips: ${Object.keys(byId).join(' ')}`);
  process.exit(1);
}

// Resolve every id before recording anything, so a typo in the last one does not
// cost the 15 s take that preceded it.
const missing = ids.filter((id) => !byId[id]);
if (missing.length) {
  console.error(`no scenario: ${missing.join(', ')}\nclips: ${Object.keys(byId).join(' ')}`);
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

// A scenario may ask for a taller frame (see loop-band). The reason is measured, not
// aesthetic: with the Settings panel open, VGM's per-chip toggles push "Show Loop
// Area" down to y=532-551 while the footer starts at y=509, so at 720 the control
// sits *behind* the footer -- elementFromPoint at its centre returns a footer
// transport button. A synthetic click still fires the React handler, which is how a
// DOM assertion can be green over a click no viewer could make. Nothing in the panel
// scrolls, so height is the only lever: 780 gives 18px of clearance, 840 gives 78px,
// chosen as margin for footers that grow with song metadata. Read per scenario, so
// it is a function rather than a constant.
const viewportFor = (scenario) => scenario.viewport || VIEWPORT;

// One take, start to finish. Returns { pass } and never exits, so a batch can keep
// going after a failed clip -- a red verdict on clip 3 should not cost the other 11
// takes, and the independence that buys this is the fresh browser context created
// per clip here.
async function shootOne(scenario) {
  const viewport = viewportFor(scenario);
  const span = Math.max(...scenario.steps.map((s) => s.atMs || 0), 0);
  // A `waitFor` step holds the take past its own `atMs`, so budget each one's timeout
  // into the poll deadline below -- otherwise a clip whose waits dominate its span
  // (xmp-learned-band waits ~24 s after a 10.5 s seek) is declared "never finished"
  // while it is still running.
  const waitBudget = scenario.steps.reduce((a, s) => a + (s.waitFor ? (s.waitForTimeoutMs ?? 15000) : 0), 0);
  const shotDir = fs.mkdtempSync(path.join(WORK, 'shot-'));
  const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
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
    //
    // The URL is assembled with the URL API rather than string-concatenating
    // `?r=`, because a scenario may legitimately open on a share link
    // (`browse: '/?play=<songId>'`) and appending a second `?` to that folds the
    // cache-buster into the song id. `r=` still defeats the bundle cache.
    const target = new URL(scenario.browse, BASE);
    target.searchParams.set('r', String(Date.now()));
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
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
      // Seeked before the recording starts; see preRoll in the shim. Kept out of the
      // steps array so it can never be scheduled inside the recorded window.
      preRoll: scenario.preRoll || null,
      // Re-zero immediately before the flash so the clip starts at 0; defaults to
      // true for a preload clip, false for a preRoll one. See run() in the shim.
      startAtZero: scenario.startAtZero,
      steps: scenario.steps,
      until: scenario.until || null,
      intervalMs: 100,
      // Default is 600ms in the shim; a clip whose song ends mid-take sets this so the
      // recording stops inside the silence rather than catching the sequencer's
      // restart (see repeat-leave-fade).
      finishAfterMs: scenario.finishAfterMs,
      assert: scenario.assert || [],
    });
    console.log(`armed ${scenario.id}: ${JSON.stringify(armed)}`);

    // run() finishes on a page-side timer; poll for its verdict.
    let result = null;
    const deadline = Date.now() + span + waitBudget + 30000;
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

    console.log(`done: site/clips/${scenario.id}.mp4`);
    return { pass: !!result.pass };
  } finally {
    // Close on the failure path too, or one bad take leaves a Chromium process (and
    // its shot dir) behind for the rest of the batch to trip over.
    await browser.close().catch(() => {});
    if (!keep) fs.rmSync(shotDir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  // One receiver for the whole batch: starting it is cheap but it is not free, and
  // the per-clip independence that matters is the browser (fresh context per take),
  // which is what keeps one clip's state out of the next one's take.
  await ensureReceiver();

  // Duplicates are a typo, not an intent: re-recording a clip twice costs 15 s and
  // makes the summary lie about how many takes ran.
  const seen = new Set();
  const todo = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));

  const failed = [];
  for (const id of todo) {
    const scenario = byId[id];
    console.log(`\n=== ${id} (${todo.indexOf(id) + 1}/${todo.length}) ===`);
    try {
      const { pass } = await shootOne(scenario);
      if (!pass) failed.push(id);
    } catch (e) {
      // Keep going. The clip that failed is reported in the summary with the rest,
      // and the stack is still printed so a page-side failure can be diagnosed.
      console.error(`FAILED ${id}: ${e.message}`);
      if (process.env.SHOOT_TRACE) console.error(e.stack);
      failed.push(id);
    }
  }

  console.log(`\nshoot: ${todo.length - failed.length}/${todo.length} passed`);
  if (failed.length) console.log(`failed: ${failed.join(', ')}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  // The stack matters: a bare message once hid that a page-side failure had no
  // `verdict` at all, and cost a take to diagnose.
  console.error('FAILED:', e.message);
  if (process.env.SHOOT_TRACE) console.error(e.stack);
  process.exit(1);
});