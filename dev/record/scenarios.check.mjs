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

const errors = [];
const warnings = [];
const fail = (id, msg) => errors.push(`${id}: ${msg}`);

const ids = new Set();
for (const s of scenarios) {
  if (ids.has(s.id)) fail(s.id, 'duplicate id');
  ids.add(s.id);

  if (!s.title || !s.watch || !Array.isArray(s.watch) || !s.watch.length) fail(s.id, 'no title/watch bullets (the page renders these)');
  if (!s.section || !['main', 'deep'].includes(s.section)) fail(s.id, `bad section: ${s.section}`);
  if (!s.browse || !s.browse.startsWith('/browse/')) fail(s.id, `browse must be an in-app path: ${s.browse}`);
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

  // Steps must be a forward-only timeline: the runner arms them with plain
  // setTimeout, so an out-of-order atMs silently reorders the clip.
  let last = -1;
  for (const st of s.steps || []) {
    const at = st.atMs || 0;
    if (at < last) fail(s.id, `steps out of order at ${at}ms (previous ${last}ms)`);
    last = at;
  }

  // The clip has to fit the measured evaluate budget (FINDINGS.md): the take
  // is started and finished in two calls with the host recorder in between, so
  // the scripted span is what has to stay short.
  const span = Math.max(...(s.steps || [{ atMs: 0 }]).map((st) => st.atMs || 0));
  if (span > 9000) fail(s.id, `scripted span ${span}ms exceeds the 9s clip budget`);

  if (s.harness && !fs.existsSync(path.join(ROOT, s.harness))) fail(s.id, `harness does not exist: ${s.harness}`);
  if (!s.harness) warnings.push(`${s.id}: no harness reference`);

  // A clip that loops a song has to start from "already playing": the host
  // recorder wraps only the scripted span, so without a pre-roll every take
  // would open with a file load.
  const opensSomething = (s.steps || []).some((st) => st.open);
  if (s.fixture && !s.preload && !opensSomething) fail(s.id, 'has a fixture but no preload and no open step: the take would start mid-load');
  if (s.preload && !s.preload.dir) fail(s.id, 'preload without dir');

  // Fixtures are pinned paths, and the catalog is gitignored + user-supplied, so
  // this is a warning rather than an error -- but a missing one means the clip
  // cannot be shot and should be noticed before a recording session.
  for (const f of [s.fixture, ...(s.fixtures || [])].filter(Boolean)) {
    if (!fs.existsSync(path.join(CATALOG, f))) warnings.push(`${s.id}: fixture not in catalog/: ${f}`);
  }

  if (!s.ready) warnings.push(`${s.id}: not recorded yet (ready: false)`);
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