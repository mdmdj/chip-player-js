// DEV-ONLY: deleting the file you are playing moves to the song that *followed*
// it, not to a later one.
//
//   node dev/record/check-local-delete.mjs [--headed] [--subtune=7] [--single] [--shuffle]
//
// Reported by macroscope on PR #10 (App.js:886). Deleting a playing multi-song
// file rebuilds the local context and, the playing song being gone, moves the
// transport to "the survivor now at that position". A multi-song file is several
// rows, so removing them shifts every later row left by the number removed: the
// old clamp (min(playingIdx, len-1)) landed on a later song whenever the playing
// sub-tune was not the file's first row. The default fixture is a 28-row file
// played at its 8th row with two songs after it -- the follower is index 1, the
// clamp gave 2.
//
// The flags cover the neighbours, because the fix must not disturb what the
// clamp already got right, and because it feeds the shuffle rebuild:
//
//   default      folder's 8th of 28 rows -> next file      (the clamp went past it)
//   --subtune=0  folder's first row      -> next file      (the clamp agreed)
//   --single     the single file before the folder -> the folder's first row
//   --shuffle    the default, with Shuffle on (currIdx indexes the order)
//
// Asserts on the transport's own current song. Where the two rules disagree it
// asserts the *setup* is one that tells them apart, so a run that does not
// reproduce the shape cannot pass. Local files live in the browser, so a fresh
// context starts empty and a run leaves nothing behind. Needs the dev server.

import { chromium } from 'playwright';

const BASE = process.env.LOCAL_CHECK_BASE || 'http://mms-1:8080';
const headed = process.argv.includes('--headed');

// The display name is the basename and the context is the listing sorted by
// path, so these names decide the order.
const FILES = [
  { path: 'spc/11 The Cage.spc', name: 'aa-before.spc' },
  { path: 'nsfe/Akumajou Densetsu (VRC6).nsfe', name: 'bb-folder.nsfe' },
  { path: 'spc/109 Underground.spc', name: 'cc-next.spc' },
  { path: 'spc/105 Battle Theme.spc', name: 'dd-later.spc' },
];
const FOLDER = 'local/bb-folder.nsfe';
const FIRST = 'local/aa-before.spc';

const argVal = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const PLAY_SUBTUNE = Number(argVal('subtune', 7));
const SINGLE = process.argv.includes('--single');
const SHUFFLE = process.argv.includes('--shuffle');
const COMMA = '\u0000';
const key = r => `${r.path}${COMMA}${r.subtune || 0}`;
const label = r => `${r.path}${r.subtune ? `#${r.subtune}` : ''}`;

// What is playing when the delete happens, and what should take over.
const PLAYING = SINGLE ? { path: FIRST, subtune: 0 } : { path: FOLDER, subtune: PLAY_SUBTUNE };
const FOLLOWER = SINGLE ? { path: FOLDER, subtune: 0 } : { path: 'local/cc-next.spc', subtune: 0 };

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

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();

const poll = async (fn, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
const localCtx = () => page.evaluate(() =>
  (window.ChipPlayer.playContexts['local'] || []).map(r => ({ path: r.path, subtune: r.subtune })));
const playingRef = () => page.evaluate(() => {
  const r = window.ChipPlayer.sequencer.getCurrSongRef();
  return r && { path: r.path, subtune: r.subtune };
});
const mode = [SINGLE ? 'single' : `subtune=${PLAY_SUBTUNE}`, SHUFFLE ? 'shuffle' : 'no-shuffle'].join(' ');

try {
  await page.goto(`${BASE}/local`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type=file]', { state: 'attached', timeout: 30000 });

  // Add through the real input, the way a drop does.
  const added = await page.evaluate(async (specs) => {
    const input = document.querySelector('input[type=file]');
    const files = await Promise.all(specs.map(async ({ path, name }) => {
      const enc = path.split('/').map(encodeURIComponent).join('/');
      const blob = await (await fetch(`/catalog/${enc}`)).blob();
      return new File([blob], name);
    }));
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return files.map(f => f.name);
  }, FILES);
  check('every fixture was added', added.length === FILES.length, added.join(', '));

  // The sub-tune parse is async, so wait for the expanded context.
  await poll(async () => (await localCtx()).length >= FILES.length);
  const pre = await localCtx();
  const folderRows = pre.map((r, i) => (r.path === FOLDER ? i : -1)).filter(i => i >= 0);
  const folderEnd = folderRows.length ? folderRows[folderRows.length - 1] : -1;

  check('the multi-song file was added', folderRows.length > 1, `expanded to ${folderRows.length} rows`);
  check('it sits after the first file', folderRows[0] === 1, `first folder row at ${folderRows[0]}`);
  check('a song follows the folder', pre[folderEnd + 1] && pre[folderEnd + 1].path === 'local/cc-next.spc',
    `row after the folder: ${pre[folderEnd + 1] && pre[folderEnd + 1].path}`);
  check('the playing row is inside the file', PLAY_SUBTUNE >= 0 && PLAY_SUBTUNE < folderRows.length,
    `sub-tune ${PLAY_SUBTUNE} of ${folderRows.length}`);

  // Where the two rules part company: the old clamp (min(playingIdx, newLen-1))
  // against the identity follower. They differ exactly when the deleted file is
  // several rows and the playing one is not its first -- so the setup asserts
  // whichever relation this mode is supposed to have, or a mode where the rules
  // agree could pass without exercising anything.
  const playingIdx = SINGLE ? 0 : folderRows[0] + PLAY_SUBTUNE;
  const deletedRows = SINGLE ? [0] : folderRows;
  const after = pre.filter((r, i) => !deletedRows.includes(i));
  const followerIdx = after.findIndex(r => key(r) === key(FOLLOWER));
  const clampPick = Math.min(playingIdx, after.length - 1);
  const shouldDiffer = !SINGLE && PLAY_SUBTUNE > 0;
  if (!SHUFFLE) {
    check(`the setup ${shouldDiffer ? 'tells the two rules apart' : 'has both rules agreeing'}`,
      shouldDiffer ? clampPick !== followerIdx : clampPick === followerIdx,
      `clamp index ${clampPick} (${label(after[clampPick] || {})}), follower index ${followerIdx} (${label(FOLLOWER)})`);
  }

  // Play the target, through its row.
  if (SINGLE) {
    await page.evaluate((text) => {
      const a = [...document.querySelectorAll('a')].find(el =>
        (el.getAttribute('href') || '').startsWith('local/') && el.textContent === text);
      if (!a) throw new Error(`no local row labelled ${text}`);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, FIRST.split('/').pop());
  } else {
    const childName = await page.evaluate(({ folder, i }) => {
      const item = (window.ChipPlayer.state.localFiles || []).find(x => x.path === folder);
      return item && item.children && item.children[i] ? item.children[i].name : null;
    }, { folder: FOLDER, i: PLAY_SUBTUNE });
    check('found the sub-tune row to click', !!childName, `name=${childName}`);
    await page.evaluate((name) => {
      const a = [...document.querySelectorAll('.LocalFiles-subtune a')].find(el => el.textContent === name);
      if (!a) throw new Error(`no sub-tune row labelled ${name}`);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, childName);
  }
  let now = await playingRef();
  check(`[${mode}] the target song is playing`, now && key(now) === key(PLAYING), label(now || {}));

  if (SHUFFLE) {
    // The app's own path (the transport's shuffle control calls this), and note
    // it must pass the mode number: setShuffle builds the order only when
    // shuffle === SHUFFLE_ON (1), so a boolean would leave the sequencer with no
    // order at all -- a state the delete path is not written for.
    await page.evaluate(() => window.ChipPlayer.handleCycleShuffle());
    await page.waitForTimeout(300);
    const shuffled = await page.evaluate(() => ({
      mode: window.ChipPlayer.sequencer.shuffle,
      orderLen: (window.ChipPlayer.sequencer.shuffleOrder || []).length,
    }));
    check(`[${mode}] shuffle is on with an order built`, shuffled.mode === 1 && shuffled.orderLen > 0,
      JSON.stringify(shuffled));
    now = await playingRef();
    check(`[${mode}] enabling shuffle does not change the playing song`, now && key(now) === key(PLAYING), label(now || {}));
  }

  // Delete the file being played: shift-click its header button (no confirm).
  const deleting = SINGLE ? FIRST : FOLDER;
  await page.evaluate((target) => {
    const btn = document.querySelector(`button[data-href="${target}"]`);
    if (!btn) throw new Error(`no delete button for ${target}`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, shiftKey: true }));
  }, deleting);
  const shrank = await poll(async () => (await localCtx()).length === after.length);
  check(`[${mode}] the file was deleted (context shrank by its rows)`, shrank,
    `${pre.length} -> ${(await localCtx()).length}, expected ${after.length}`);
  check(`[${mode}] the following song was not deleted too`, (await localCtx()).some(r => key(r) === key(FOLLOWER)));

  const landed = await poll(async () => {
    const r = await playingRef();
    return !!r && key(r) !== key(PLAYING);
  }, 10000);
  const got = await playingRef();
  check(`[${mode}] the transport moved off the deleted file`, landed, label(got || {}));
  check(`[${mode}] it moved to the song that followed it`, got && key(got) === key(FOLLOWER),
    `landed on ${label(got || {})}, expected ${label(FOLLOWER)}`);
  if (!SHUFFLE && !SINGLE) {
    console.log(`  (the old clamp would have landed on index ${clampPick}: ${label(after[clampPick] || {})})`);
  }
} finally {
  await browser.close();
}

console.log(`\n${mode}: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
