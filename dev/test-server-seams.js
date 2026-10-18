#!/usr/bin/env node
// DEV-ONLY: prove dev/patch-server.js delivers the dev-only server deltas that
// `server/index.js` no longer carries, on BOTH bases a worktree can have --
// upstream's file (what dev/kit gives a new target) and the feature branch's
// (what the overlay is built on) -- and that it is idempotent and reversible.
//
// This is the check behind the 2026-10-18 smoke-test finding: a kit worktree got
// upstream's server/index.js and could not boot (missing auth seam) and ignored
// its port pair, because the kit deliberately does not carry that file.
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PATCHER = path.join(__dirname, 'patch-server.js');

let pass = 0, fail = 0;
const ok = (m) => { console.log('ok   - ' + m); pass++; };
const bad = (m) => { console.log('FAIL - ' + m); fail++; };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m + ' (' + e.message + ')'); } };

const baseOf = (ref) =>
  cp.execFileSync('git', ['show', `${ref}:server/index.js`], { cwd: ROOT, encoding: 'utf8' });

// Run the patcher against a temp copy; returns { status, stdout, text }.
function run(tmp, args = []) {
  const r = cp.spawnSync(process.execPath, [PATCHER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATCH_SERVER_FILE: tmp },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), text: fs.readFileSync(tmp, 'utf8') };
}

const SEAMS = [
  ['auth seam', /process\.env\.DEV_AUTH_MODULE \|\| '\.\/middleware\/auth\.js'/, /require\('\.\/middleware\/auth\.js'\)/],
  ['api port', /process\.env\.API_PORT \?\? process\.env\.PORT/, /const port = process\.env\.PORT \|\| 8080;/],
  ['wds port', /parseInt\(process\.env\.WDS_PORT, 10\) \|\| 3000/, /const WDS_PORT = 3000;/],
  ['mutable html', /let finalHtml = html/, /const finalHtml = html/],
  ['port injection', /window\.__devApiPort=\$\{port\}/, null],
  ['dev no-cache', /if \(isDev\) res\.removeHeader\('Cache-Control'\)/, null],
];

for (const ref of ['master', 'feature/subtunes-as-first-class']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seams-'));
  const tmp = path.join(dir, 'index.js');
  const base = baseOf(ref);
  fs.writeFileSync(tmp, base);

  const first = run(tmp);
  check(`[${ref}] patch exits 0`, () => assert.strictEqual(first.status, 0));
  for (const [name, present, absent] of SEAMS) {
    check(`[${ref}] ${name} applied`, () => assert.match(first.text, present));
    if (absent) check(`[${ref}] ${name} replaced the plain form`, () => assert.doesNotMatch(first.text, absent));
  }
  check(`[${ref}] patched file parses`, () =>
    cp.execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }));

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

// A required anchor that upstream changed must fail loudly, not skip silently.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seams-'));
  const tmp = path.join(dir, 'index.js');
  fs.writeFileSync(tmp, baseOf('master').replace(
    `const { requireAuth, optionalAuth } = require('./middleware/auth.js');`, '// anchor gone'));
  const r = run(tmp);
  check('a changed anchor fails loudly and names the patch', () => {
    assert.strictEqual(r.status, 1);
    assert.match(r.out, /auth-module/);
    assert.match(r.out, /could not apply/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nserver-seams: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
