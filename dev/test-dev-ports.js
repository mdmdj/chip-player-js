#!/usr/bin/env node
// DEV-ONLY: the dev server's ports come from the environment, so two dev trees
// can run at once (dev/overlay.sh <target> dev). This pins the three reads that
// make that work:
//   * src/config/index.js  -- the client's API/catalog/soundfont port follows
//                             window.__devApiPort, falling back to 8080;
//   * server/index.js      -- API port from API_PORT (PORT fallback), webpack
//                             dev server port from WDS_PORT;
//   * scripts/start.js     -- WDS port from WDS_PORT (PORT fallback).
// The first is behaviour (loaded fresh per case with a fake window); the two
// source files are read, since requiring them boots a server.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (m) => { console.log('ok   - ' + m); pass++; };
const bad = (m) => { console.log('FAIL - ' + m); fail++; };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m + ' (' + e.message + ')'); } };

// Load src/config/index.js in a fresh process with a fake window on `port`.
function apiBase(port) {
  const win = JSON.stringify({ location: { hostname: 'h' }, __devApiPort: port });
  const code = `
    global.window = ${win};
    process.env.NODE_ENV = 'development';
    const c = require(${JSON.stringify(path.join(ROOT, 'src/config/index.js'))});
    process.stdout.write(String(c.API_BASE));
  `;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').pop());
  return r.stdout;
}

check('client: API port follows window.__devApiPort', () => {
  assert.strictEqual(apiBase(8180), 'http://h:8180/api');
});
check('client: API port falls back to 8080', () => {
  assert.strictEqual(apiBase(undefined), 'http://h:8080/api');
});

const serverSrc = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
check('server: API port from API_PORT (PORT fallback)', () => {
  assert.ok(/parseInt\(process\.env\.API_PORT \?\? process\.env\.PORT, 10\) \|\| 8080/.test(serverSrc),
    'API_PORT/PORT read not found');
});
check('server: WDS port from WDS_PORT (default 3000)', () => {
  assert.ok(/parseInt\(process\.env\.WDS_PORT, 10\) \|\| 3000/.test(serverSrc),
    'WDS_PORT read not found');
});

const startSrc = fs.readFileSync(path.join(ROOT, 'scripts/start.js'), 'utf8');
check('start: WDS port from WDS_PORT (PORT fallback)', () => {
  assert.ok(/parseInt\(process\.env\.WDS_PORT \?\? process\.env\.PORT, 10\) \|\| 3000/.test(startSrc),
    'WDS_PORT/PORT read not found');
});

console.log(`\ndev-ports: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
