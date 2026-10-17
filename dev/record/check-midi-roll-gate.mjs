// DEV-ONLY: the piano roll and the audio must expand the same MIDI loop region,
// on the load where the roll first appears -- including the first load, which is
// where they used to disagree.
//
//   node dev/record/check-midi-roll-gate.mjs [--headed]
//
// Background. The roll's pass count comes from `usesTrackLoops(filepath)`, the
// SoundFont-MIDI gate both consumers share (midi-helpers). The *data* is read
// from the sequencer (the live song buffer); the *gate* used to be read from
// App's `songPath` state, which lags one render behind. On a first load the App
// renders once with the buffer already live and the path still null, so the roll
// parsed a single pass and then latched -- nothing re-parsed it, because
// `midiData` did not change. The roll drew 72062 ms (one pass) of a 144125 ms song
// whose audio played two, and stayed that way until the next load.
//
// It cannot live in the node harnesses: `dev/test-midi-loops.js` pins that the
// *shared* gate is honoured by both consumers (`rollFor`), but the bug was which
// gate the *component* passed on which render -- React wiring, not a function.
// So this drives a real browser, reaches the roll's engine through the component
// tree, and compares what it parsed against what the engine plays.
//
// Fixtures: a SoundFont MIDI (gate on, two passes) and a plain one (gate off,
// one pass). Both must carry a loop region for the check to mean anything -- the
// two-pass assertions are skipped when they do not.

import { chromium } from 'playwright';

const BASE = process.env.MIDI_ROLL_BASE || 'http://mms-1:8080';
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

const browse = async (p) => {
  const res = await fetch(`${BASE}/api/browse?path=${encodeURIComponent(p)}`);
  if (!res.ok) throw new Error(`browse ${p}: ${res.status}`);
  return res.json();
};

const SOUNDFONT_DIR = '/Nintendo 64 (SoundFont MIDI)/Mario Kart 64';

// The roll's engine and the player's clock, in one read: the roll's parsed
// timeline, the duration the audio plays, and the wrap target (the second pass's
// start, so `audio > 1.5 * jump` is a real non-vacuity check rather than an
// equality against a number that could be wrong on both sides).
const PROBE = `(() => {
  const app = window.ChipPlayer;
  const seq = app && app.sequencer;
  const pl = seq && seq.getPlayer();
  const root = app && (app._reactInternalFiber || app._reactInternals);
  const stack = root ? [root] : [];
  const rolls = [];
  let seen = 0;
  while (stack.length && seen < 8000) {
    const f = stack.pop(); seen++;
    const sn = f.stateNode;
    if (sn && sn.engine && typeof sn.engine.durationMs === 'number' &&
        rolls.indexOf(sn.engine) < 0) {
      rolls.push(sn.engine);
    }
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
  }
  return {
    path: seq ? seq.getCurrSongPath() : null,
    audioMs: pl && pl.getDurationMs ? pl.getDurationMs() : null,
    jumpMs: pl && pl.loop ? pl.loop.jumpMs : null,
    player: pl ? pl.constructor.name : null,
    rollMs: rolls.map((e) => e.durationMs),
  };
})()`;

// A client-side load, then wait for the roll to have re-parsed *this* song: the
// audio duration is first read after the load's own async tail, and the roll's
// list is a new object each parse, so compare against the audio once it settles.
const loadAndSettle = async (page, path, timeoutMs = 30000) => {
  await page.evaluate((p) => {
    window.ChipPlayer.sequencer.playContext([{ path: p, subtune: 0 }], 0);
  }, path);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stable = 0;
  let prev = -1;
  while (Date.now() < deadline) {
    last = await page.evaluate(PROBE);
    const settled = last.audioMs > 0 && last.audioMs === prev;
    stable = settled ? stable + 1 : 0;
    prev = last.audioMs;
    if (stable >= 3 && last.rollMs.length > 0) break;
    await page.waitForTimeout(100);
  }
  return last;
};

const agrees = (p) =>
  p.rollMs.length > 0 && p.audioMs > 0 &&
  p.rollMs.every((ms) => Math.abs(ms - p.audioMs) < 1.5);

const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();

try {
  let soundfontUrl = null;
  try {
    const rows = await browse(SOUNDFONT_DIR);
    const row = rows.find((r) => r.type === 'file' && /\.midi?$/i.test(r.path));
    soundfontUrl = row && row.url;
  } catch (e) { /* catalog absent */ }
  const plainRows = await browse('/midi').catch(() => []);
  const plain = (plainRows || []).find((r) => r.type === 'file' && /\.midi?$/i.test(r.path));

  if (!soundfontUrl) {
    console.error(`check-midi-roll-gate: no SoundFont MIDI under ${SOUNDFONT_DIR}; the catalog is required`);
    process.exit(2);
  }
  if (!plain) {
    console.error('check-midi-roll-gate: no plain MIDI under /midi');
    process.exit(2);
  }

  // The first load is the case that used to break: a fresh page, one render with
  // the buffer live and the gate stale.
  await page.goto(`${BASE}${soundfontUrl}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const pl = window.ChipPlayer?.sequencer?.getPlayer?.();
    return !!pl && typeof pl.getDurationMs === 'function' && pl.getDurationMs() > 0;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(1200);

  const first = await page.evaluate(PROBE);
  check('a MIDI player is loaded', /MIDI/.test(first.player || ''), `player=${first.player}`);
  check('the roll is mounted and has parsed a timeline', first.rollMs.length > 0,
    `rolls=${first.rollMs.length}`);
  check('the audio really plays two passes (so the equality below is not vacuous)',
    first.audioMs > first.jumpMs * 1.5, `audio=${Math.round(first.audioMs)} jump=${Math.round(first.jumpMs)}`);
  check('on the first load the roll timed the same two passes the audio plays',
    agrees(first), `roll=${first.rollMs.map(Math.round)} audio=${Math.round(first.audioMs)}`);

  // A song change must not pair one song's buffer with the next one's gate.
  const plainLoaded = await loadAndSettle(page, plain.path);
  check('a plain MIDI (gate off) keeps the roll and the audio on one pass',
    agrees(plainLoaded) && Math.abs(plainLoaded.rollMs[0] - plainLoaded.audioMs) < 1.5,
    `roll=${plainLoaded.rollMs.map(Math.round)} audio=${Math.round(plainLoaded.audioMs)}`);

  const back = await loadAndSettle(page, first.path);
  check('switching back to the SoundFont MIDI expands both again',
    agrees(back) && back.audioMs > back.jumpMs * 1.5,
    `roll=${back.rollMs.map(Math.round)} audio=${Math.round(back.audioMs)}`);

  const plainAgain = await loadAndSettle(page, plain.path);
  check('and the gate flips back off for the plain MIDI',
    agrees(plainAgain), `roll=${plainAgain.rollMs.map(Math.round)} audio=${Math.round(plainAgain.audioMs)}`);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
