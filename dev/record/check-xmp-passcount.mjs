// DEV-ONLY: libxmp's completed-loop counter is what the XMP pass-count lever is
// measured against, so pin its contract: a seek never moves it, and a loop that
// completes by playing always does.
//
//   node dev/record/check-xmp-passcount.mjs [--headed]
//
// Background -- macroscope raised `XMPPlayer.js:339` on PR #10: that after Repeat
// One is disabled, seeking makes playback run the old scheduled number of passes
// again. `_loopCount` is a *total* pass target compared against the engine's own
// counter (`player.c:2233`, `fi.loop_count >= loop`), and the only resets of that
// counter are `xmp_restart_module` (`control.c:237`) and the explicit
// `xmp_play_buffer(ctx, NULL, ...)` reset (`player.c:2216`) -- neither seek path
// touches it. This check is that claim, measured instead of argued: the counter
// must not move on a seek, on either seek API, and must move when a loop
// completes.
//
// It cannot live in the fake-core harness (`dev/test-xmp-loops.js`): that drives
// the counter itself, so a check there would only assert its own fake. It needs
// a real engine, hence the dev server and a browser. TECHTRIS.MOD is the fixture
// because its loop start is ~3.9s and its scan end ~79.9s, so seeking near the
// end reaches a wrap in about a second -- a loop can be completed on camera
// rather than after 80s of playback.

import { chromium } from 'playwright';

const BASE = process.env.XMP_CHECK_BASE || 'http://mms-1:8080';
const headed = process.argv.includes('--headed');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
};

const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();

const player = () => page.evaluate(() => {
  const p = window.ChipPlayer.sequencer.player;
  return { name: p.constructor.name, curLoop: p.getCurLoop(), target: p._loopCount, pos: p.getPositionMs(), playing: p.isPlaying() };
});
const seek = async (ms) => { await page.evaluate((t) => window.ChipPlayer.sequencer.player.seekMs(t), ms); return player(); };

try {
  const s = await (await fetch(`${BASE}/api/search?query=techtris&limit=5`)).json();
  const hit = (s.items || []).find(i => /TECHTRIS/i.test(i.file || ''));
  if (!hit) { console.error('check-xmp-passcount: mods/TECHTRIS.MOD is not in the catalog'); process.exit(2); }

  await page.goto(`${BASE}/?play=${hit.song_id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ChipPlayer?.sequencer?.player?.constructor?.name === 'XMPPlayer', null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  // Rendering, asserted first: a stalled engine reads 0 and would make every
  // "the counter did not move" claim below pass for the wrong reason.
  const a = await player();
  await page.waitForTimeout(1200);
  const b = await player();
  check('the engine is really rendering', b.pos - a.pos > 500, `${a.pos} -> ${b.pos} in 1.2s`);

  await page.evaluate(() => window.ChipPlayer.sequencer.player.setLooping(true));  // Repeat One

  // A seek lands on the next rendered buffer, so read after a settle -- but a
  // short one, since the assertions below need the engine to not have played far
  // enough to complete a pass.
  const seekTo = async (ms, settle = 400) => {
    await page.evaluate((t) => window.ChipPlayer.sequencer.player.seekMs(t), ms);
    await page.waitForTimeout(settle);
    return player();
  };

  // Mid-loop: a whole loop of headroom on either side, so a completion cannot
  // intervene. This is the finding's shape -- a seek must not touch the counter.
  const beforeMid = await player();
  const afterMid = await seekTo(68000);
  check('a mid-loop seek does not move the counter', afterMid.curLoop === beforeMid.curLoop,
    `${beforeMid.curLoop} -> ${afterMid.curLoop}`);
  check('and the seek lands where it was asked', Math.abs(afterMid.pos - 68000) < 3000, `landed ${afterMid.pos}`);

  const beforeBack = await player();
  const afterBack = await seekTo(1000);
  check('a backward seek to the intro does not move it either',
    afterBack.curLoop === beforeBack.curLoop, `${beforeBack.curLoop} -> ${afterBack.curLoop}`);
  check('that seek lands where asked too', afterBack.pos < 5000, `landed ${afterBack.pos}`);

  // Toward the scan end, where the wrap is about a second away: the seek itself
  // still must not move the counter...
  const beforeEnd = await player();
  const afterEnd = await seekTo(79000, 300);
  check('a seek past the loop end does not move the counter either',
    afterEnd.curLoop === beforeEnd.curLoop, `${beforeEnd.curLoop} -> ${afterEnd.curLoop}`);

  // ...but playing across the wrap must, and that is the lever's whole premise.
  let wrapped = null;
  for (let i = 0; i < 40 && !wrapped; i++) {
    const now = await player();
    if (now.curLoop > afterEnd.curLoop) wrapped = now;
    else await page.waitForTimeout(250);
  }
  check('completing the loop by playing does move it', !!wrapped, `still ${afterEnd.curLoop} after 10s`);
  check('and the loop is still playing after the wrap', !!wrapped && wrapped.playing === true);
  check('with Repeat One on the target stays 0, however the seeks landed',
    !!wrapped && wrapped.target === 0, `target=${wrapped && wrapped.target}`);

  // Leaving Repeat One arms "one more pass", counted from where the engine is.
  const off = await page.evaluate(() => {
    window.ChipPlayer.sequencer.player.setLooping(false);
    return null;
  }).then(() => player());
  check('leaving repeat arms the pass the engine is in',
    off.target === Math.max(1, off.curLoop + 1), `target=${off.target} curLoop=${off.curLoop}`);

  // With a target armed, a seek must leave that target describing the pass the
  // engine is now in. `xmp_seek_time_frame` zeroes the counter (it forces an
  // xmp_play_buffer refresh), so a target kept from before the seek would be
  // spent counting from zero -- one pass too many. Asserted as a relation rather
  // than a number, so it holds whatever the engine's seek does to the counter.
  const preArmed = await player();
  const postArmed = await seekTo(68000);
  check('an armed target still describes the pass the engine is in after a seek',
    postArmed.target === Math.max(1, postArmed.curLoop + 1),
    `target=${postArmed.target} curLoop=${postArmed.curLoop} (was target=${preArmed.target} curLoop=${preArmed.curLoop})`);

  // The fallback API (the player feature-detects per call, so deleting the export
  // switches it): same contract, different landing point.
  await page.evaluate(() => { delete window.ChipPlayer.chipCore._xmp_seek_time_frame; });
  const preSnap = await player();
  const postSnap = await seekTo(68000);
  check('the snapping fallback does not move the counter either',
    postSnap.curLoop === preSnap.curLoop, `${preSnap.curLoop} -> ${postSnap.curLoop}`);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
