// DEV-ONLY: validate the clip registry (dev/record/scenarios.mjs).
//
// The repo has no test runner and the browser clips cannot run in CI, so this is
// the cheap guard that keeps the registry from rotting: a clip that points at a
// deleted harness, a missing fixture, a dead snippet or an assertion-free
// scenario would otherwise only be discovered after a recording session.
//
//   node dev/record/scenarios.check.mjs
//
// Exits non-zero on failure, prints a summary otherwise. No deps.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarios } from './scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = path.join(ROOT, 'catalog');
// Must match the group keys build-site.mjs renders; see MAIN_GROUPS / DEEP_GROUPS there.
const MAIN_GROUPS = ['subtunes', 'looping'];
const DEEP_GROUPS = ['native', 'indefinite', 'learned', 'floor'];

const errors = [];
const warnings = [];
const fail = (id, msg) => errors.push(`${id}: ${msg}`);

const ids = new Set();
for (const s of scenarios) {
  if (ids.has(s.id)) fail(s.id, 'duplicate id');
  ids.add(s.id);

  if (!s.title || !s.watch || !Array.isArray(s.watch) || !s.watch.length) fail(s.id, 'no title/watch bullets (the page renders these)');
  // Every per-format clip must name a mechanism group, and the name must be one the
  // page knows. A typo'd group is the quietest possible failure in this file: the
  // clip is recorded, has a passing verdict, and build-site.mjs drops it out of the
  // section without rendering it anywhere. It fails there and only there, so catch
  // it here, where the fix is one word. Same rule for a 'main' clip, where an
  // unknown group would silently leave it out of both top-level sections.
  if (s.section === 'deep' && !DEEP_GROUPS.includes(s.group)) {
    fail(s.id, 'section deep needs a known group, got ' + JSON.stringify(s.group) + ' (expected one of ' + DEEP_GROUPS.join(', ') + ')');
  }
  if (s.section === 'main' && !MAIN_GROUPS.includes(s.group)) {
    fail(s.id, 'section main needs a known group, got ' + JSON.stringify(s.group) + ' (expected one of ' + MAIN_GROUPS.join(', ') + ')');
  }
  if (!s.section || !['main', 'deep'].includes(s.section)) fail(s.id, `bad section: ${s.section}`);
  // A share link is an in-app path too, and it is the one that arrives with the
  // song already loading: App.js reads `?play=<songId>` on mount (via the server's
  // `__chipConfig`), so a scenario pointing at one opens on a playing song. `/top`
  // is accepted for the same reason -- the Top Charts page is a page a clip can be
  // *about*, and shoot.mjs's `waitForSelector('.BrowseList-row')` is satisfied
  // because TopCharts renders that same row class. Both forms are accepted; the
  // check only insists it is a path into this app rather than some absolute URL
  // that would silently record the wrong site.
  const isShareLink = s.browse && /^\/\?play=/.test(s.browse);
  const IN_APP_PAGES = ['/top', '/favorites'];
  if (!s.browse || (!s.browse.startsWith('/browse/') && !isShareLink && !IN_APP_PAGES.includes(s.browse))) {
    fail(s.id, `browse must be an in-app path: ${s.browse}`);
  }
  if (!Array.isArray(s.steps) || !s.steps.length) fail(s.id, 'no steps: nothing would happen on screen');
  if (!Array.isArray(s.assert) || !s.assert.length) fail(s.id, 'no assertions: a clip with no verdict cannot be trusted');

  // The whole point of the registry is that a claim is backed by a number.
  for (const a of s.assert || []) {
    if (!a.name || typeof a.test !== 'string' || !a.test.trim()) fail(s.id, `bad assertion: ${JSON.stringify(a)}`);
  }
  const names = (s.assert || []).map((a) => a.name);
  if (new Set(names).size !== names.length) fail(s.id, 'duplicate assertion names');

  // every()/some() over an empty array are vacuously true, so an assertion
  // whose precondition never happened reports success. Any assertion that
  // filters or slices the trace has to constrain its length too. Not
  // hypothetical: an early loop-band "passed" head-folds-into-band on an empty
  // sample set while the song was in fact being ended by the silence detector.
  for (const a of s.assert || []) {
    const usesTrace = /\btr\b/.test(a.test || '');
    const quantifier = /\.(every|some|filter|slice)\(/.test(a.test || '');
    if (usesTrace && quantifier && !/\.length\s*(>=|>|===|==)/.test(a.test)) {
      warnings.push(`${s.id}/${a.name}: trace quantifier with no length constraint (can pass vacuously)`);
    }
  }

  // Steps must be a forward-only timeline, and a `waitFor` step empties it: the
  // runner re-bases each step's atMs on the moment the wait was met, so the steps
  // after a wait are timed from that event, not from arm time, and their atMs
  // legitimately restarts near zero.
  let last = -1;
  for (const st of s.steps || []) {
    if (st.waitFor) { last = -1; continue; }
    const at = st.atMs || 0;
    if (at < last) fail(s.id, `steps out of order at ${at}ms (previous ${last}ms)`);
    last = at;
  }

  // A long take must stay long enough to show the thing it is about. This was a
  // 9 s cap, written when the host's tab recorder held the take and the scripted
  // span had to survive two flaky round trips; shoot.mjs now drives the whole take
  // in one node process, so the cap protects nothing there. The SID clip is why it
  // moved to 20 s: its restart cannot happen sooner than one quiet detector window
  // (~10 s). It moved again to 30 s for the MIDI clip, which has to show a real
  // loop region twice -- play to the band end, come back, play on.
  //
  // Worth recording what nearly made it 100 s. The MOD/XM clip demonstrates a band
  // *learned* from playback, which cannot exist until libxmp's first backward order
  // jump -- 80 s into TECHTRIS.MOD. A first draft simply sat through it: 92 s, 34 MB,
  // and a 70 MB page. It does not have to. Learning needs the loop start visited
  // linearly and then a backward jump onto it, and a seek supplies the second without
  // losing the first (seekMs forgets only the *last* order; first-visit times are
  // absolute). So the clip plays 5 s, seeks into the last stretch, and comes in at
  // 22 s and 2.5 MB. See the note in scenarios.mjs -- an earlier version of that
  // comment asserted no seek could help, which was wrong and cost a 92 s take.
  //
  // It moved once more to 35 s, for watchability rather than necessity: the MOD/XM
  // clip now plays 10.5 s of music before its seek and holds ~7.7 s of loop after
  // the wrap, which is what the ear needs to follow it, and lands at 31.5 s. A clip
  // that proves the behaviour in 22 s but is hard to follow is not worth much on the
  // page, and the extra 9 s is ~2 MB.
  //
  // Lifted to 120 s, generously, on the grounds that page weight stopped being the
  // constraint: the clips are preload="none" with posters, so a long clip transfers
  // nothing until a reader clicks it, and the earlier stalls were a *preload* problem
  // rather than a size one (FINDINGS.md -- where the first causal story was written
  // after the fix and did not survive its own test). At the measured ~0.35 MB/s a
  // 120 s clip is ~42 MB, which the page budget below absorbs without complaint.
  //
  // What the cap is still for is a span that grew because a scenario was waiting on
  // something that never happens. That failure used to be silent -- a clip that
  // recorded a minute of nothing still published -- so the bound stays, just loose.
  const span = Math.max(...(s.steps || [{ atMs: 0 }]).map((st) => st.atMs || 0));
  if (span > 120000) fail(s.id, `scripted span ${span}ms exceeds the 120s clip budget`);

  if (s.harness && !fs.existsSync(path.join(ROOT, s.harness))) fail(s.id, `harness does not exist: ${s.harness}`);
  if (!s.harness) warnings.push(`${s.id}: no harness reference`);

  // A clip that loops a song has to start from "already playing": the host
  // recorder wraps only the scripted span, so without a pre-roll every take
  // would open with a file load.
  // A share-link browse satisfies this on its own: the song load and, for MIDI, the
  // SoundFont mount happen in App's mount handler, and the scenario's `until` gate
  // then waits for the load to land. Without the exemption a share-link clip is
  // forced into a `preload` that clicks a row it never meant to use.
  const opensSomething = (s.steps || []).some((st) => st.open);
  if (s.fixture && !s.preload && !opensSomething && !isShareLink) fail(s.id, 'has a fixture but no preload and no open step: the take would start mid-load');
  if (s.preload && !s.preload.dir) fail(s.id, 'preload without dir');

  // Fixtures are pinned paths, and the catalog is gitignored + user-supplied, so
  // this is a warning rather than an error -- but a missing one means the clip
  // cannot be shot and should be noticed before a recording session.
  for (const f of [s.fixture, ...(s.fixtures || [])].filter(Boolean)) {
    if (!fs.existsSync(path.join(CATALOG, f))) warnings.push(`${s.id}: fixture not in catalog/: ${f}`);
  }

  if (!s.ready) warnings.push(`${s.id}: not recorded yet (ready: false)`);
}

// The upload directory's total weight, which is the number that actually decides
// whether this page is a reasonable thing to ask someone to host and link from a
// PR. 200 MB, chosen for this pass on the grounds that the clips are
// preload="none" with posters: a reader fetches nothing until they click, so a
// heavy page costs them nothing they did not ask for.
//
// This exists because the duration cap is the wrong tool for the job. It was raised
// from 9 s to 120 s over this session, and every step of that was really a proxy
// for "this clip is getting too heavy" -- which is what this measures directly, and
// measures without having to guess a bitrate. On-demand loading made the per-clip
// duration unimportant; it did not make the total unimportant to whoever uploads it.
//
// Reported as an error only because it is a number someone has to act on (drop a
// clip, or re-encode) and nothing else in this file can tell them. It is a warning
// until site/ exists, because before the first build there is nothing to weigh.
const SITE = path.join(ROOT, 'site');
const MB = 1024 * 1024;
const PAGE_BUDGET_MB = 200;
if (fs.existsSync(SITE)) {
  let total = 0;
  const heaviest = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(mp4|jpg|png|webm)$/i.test(e.name)) {
        const bytes = fs.statSync(full).size;
        total += bytes;
        heaviest.push([path.relative(SITE, full), bytes]);
      }
    }
  };
  walk(SITE);
  const mb = total / MB;
  if (mb > PAGE_BUDGET_MB) {
    heaviest.sort((a, b) => b[1] - a[1]);
    const top = heaviest.slice(0, 5).map(([n, b]) => `${n} ${(b / MB).toFixed(1)}MB`).join(', ');
    errors.push(`upload dir is ${mb.toFixed(0)}MB, over the ${PAGE_BUDGET_MB}MB budget (heaviest: ${top})`);
  } else {
    console.log(`page weight: ${mb.toFixed(0)}MB of ${PAGE_BUDGET_MB}MB budget across ${heaviest.length} media files`);
  }
}

const ready = scenarios.filter((s) => s.ready).length;
const mainCount = scenarios.filter((s) => s.section === 'main').length;

if (errors.length) {
  console.error(`scenarios: ${errors.length} error(s)`);
  for (const e of errors) console.error(`  FAIL ${e}`);
  for (const w of warnings) console.warn(`  warn ${w}`);
  process.exit(1);
}

console.log(`scenarios: ${scenarios.length} clips (${mainCount} main, ${scenarios.length - mainCount} in depth), ${ready} recorded, ${warnings.length} warning(s)`);
for (const w of warnings) console.warn(`  warn ${w}`);