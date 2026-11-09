#!/usr/bin/env node
// DEV-ONLY: prove dev/patch-client.js delivers the fake dev user that
// `src/components/UserProvider.js` no longer carries.
//
// UserProvider.js is a feature file, so the kit cannot carry its dev delta and a
// kit worktree runs upstream's copy -- which is why a preview showed no favorites
// and no signed-in user. The patch has to work on BOTH bases a worktree can have
// (upstream's file, and the feature branch's) without touching feature-only
// symbols, and it must be idempotent and reversible like dev/patch-server.js.
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PATCHER = path.join(__dirname, 'patch-client.js');
const REL = 'src/components/UserProvider.js';

let pass = 0, fail = 0;
const ok = (m) => { console.log('ok   - ' + m); pass++; };
const bad = (m) => { console.log('FAIL - ' + m); fail++; };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m + ' (' + e.message + ')'); } };

const baseOf = (ref) => cp.execFileSync('git', ['show', `${ref}:${REL}`], { cwd: ROOT, encoding: 'utf8' });

function run(tmp, args = []) {
  const r = cp.spawnSync(process.execPath, [PATCHER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATCH_CLIENT_FILE: tmp },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), text: fs.readFileSync(tmp, 'utf8') };
}

// UserProvider.js is JSX, so `node --check` cannot parse it.
function parses(tmp) {
  require('@babel/core').parseSync(fs.readFileSync(tmp, 'utf8'), {
    filename: tmp, configFile: false, babelrc: false, parserOpts: { plugins: ['jsx'] },
  });
}

for (const ref of ['master', 'feature/subtunes-as-first-class']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cseams-'));
  const tmp = path.join(dir, 'UserProvider.js');
  const base = baseOf(ref);
  fs.writeFileSync(tmp, base);

  const first = run(tmp);
  check(`[${ref}] patch exits 0`, () => assert.strictEqual(first.status, 0));
  check(`[${ref}] the dev user is injected`, () => assert.match(first.text, /setUser\(\{ \.\.\.devUser, getIdToken/));
  check(`[${ref}] the dev user is read from REACT_APP_DEV_USER`, () =>
    assert.match(first.text, /if \(!process\.env\.REACT_APP_DEV_USER\) return;/));
  check(`[${ref}] Firebase is skipped when the dev user is present`, () =>
    assert.match(first.text, /if \(process\.env\.REACT_APP_DEV_USER\) return;\n    \/\/ Initialize Firebase/));
  // The patch must not depend on a feature-only symbol: it adds no `lastUid`
  // reference of its own (the feature base already has some, upstream has none).
  check(`[${ref}] the patch adds no lastUid reference`, () => {
    const count = (s) => (s.match(/lastUid/g) || []).length;
    assert.strictEqual(count(first.text), count(base));
  });
  check(`[${ref}] the patched component still parses`, () => parses(tmp));

  const second = run(tmp);
  check(`[${ref}] re-apply is idempotent`, () => assert.strictEqual(second.text, first.text));

  const rev = run(tmp, ['--revert']);
  check(`[${ref}] revert exits 0`, () => assert.strictEqual(rev.status, 0));
  check(`[${ref}] revert restores the base byte-for-byte`, () => assert.strictEqual(rev.text, base));

  const third = run(tmp);
  check(`[${ref}] apply after revert reproduces the patched form`, () =>
    assert.strictEqual(third.text, first.text));

  fs.rmSync(dir, { recursive: true, force: true });
}

// A file that already delivers the dev user (an overlay's own DEV regions) must be
// left completely alone -- apply.sh has to succeed there too.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cseams-'));
  const tmp = path.join(dir, 'UserProvider.js');
  // The overlay branch must be reachable: the local ref, else the remote-tracking
  // one. A clone that has neither skips this case rather than failing it.
  let overlayCopy = null;
  for (const ref of ['dev/overlay-subtunes', 'origin/dev/overlay-subtunes']) {
    try { overlayCopy = cp.execFileSync('git', ['show', `${ref}:${REL}`], { cwd: ROOT, encoding: 'utf8' }); break; } catch (e) { /* try the next ref */ }
  }
  if (!overlayCopy) {
    console.log('skip  a file that already has a dev user is left alone\n      (no dev/overlay-subtunes ref here)');
  } else {
    fs.writeFileSync(tmp, overlayCopy);
    const r = run(tmp);
    check('a file that already has a dev user is left alone', () => {
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.text, overlayCopy);
      assert.match(r.out, /already delivers a dev user/);
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// A changed anchor must fail loudly: upstream renaming the effect would otherwise
// silently ship a worktree with no dev user.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cseams-'));
  const tmp = path.join(dir, 'UserProvider.js');
  fs.writeFileSync(tmp, baseOf('master').replace('// Initialize Firebase', '// Firebase init'));
  const r = run(tmp);
  check('a changed anchor fails loudly and names the patch', () => {
    assert.strictEqual(r.status, 1);
    assert.match(r.out, /dev-user/);
    assert.match(r.out, /could not apply/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nclient-seams: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
