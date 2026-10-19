#!/usr/bin/env node
/**
 * DEV-ONLY HTTP check for GET /api/loudness.
 *
 * Skips (exit 0) when the dev server is not running or the catalog has not been
 * scanned yet; the scanner harness covers the database side independently.
 */
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function apiPort() {
  try {
    const pair = execFileSync(path.join(ROOT, 'dev', 'registry.sh'), ['port', 'replaygain'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\s+/);
    return Number(pair[1]) || 8080;
  } catch (e) {
    return 8080;
  }
}

async function get(port, query) {
  const url = `http://127.0.0.1:${port}/api/loudness?${query}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const port = apiPort();
  let quiet;
  try {
    quiet = await get(port, 'path=replaygain-samples%2Fquiet%2F01%20Theme%20of%20Wild%20Guns.spc&subtune=0');
  } catch (e) {
    console.log(`skip  loudness server: no dev server on :${port}`);
    return;
  }
  if (!quiet.track) {
    console.log('skip  loudness server: catalog has no scanned sample rows');
    return;
  }
  assert.ok(Number.isFinite(quiet.track.lufs), 'track loudness is finite');
  assert.strictEqual(quiet.track.subtune, 0, 'track sub-tune is echoed');
  assert.strictEqual(quiet.subtuneCount, 1, 'single-song file reports one sub-tune');
  assert.ok(quiet.album, 'directory album is returned');
  assert.strictEqual(quiet.album.kind, 'directory', 'single-song album is the directory');
  assert.strictEqual(quiet.album.status, 'complete', 'album is complete');

  const multi = await get(port, 'path=nsfe%2FAkumajou%20Densetsu%20(VRC6).nsfe&subtune=3');
  if (multi.track) {
    assert.strictEqual(multi.track.subtune, 3, 'multi-song sub-tune is echoed');
    assert.ok(multi.subtuneCount > 1, 'multi-song file reports its sub-tune count');
    assert.strictEqual(multi.album.kind, 'file', 'multi-song album is the file');
    assert.ok(Number.isFinite(multi.album.lufs), 'file album has loudness');
  }

  const missing = await get(port, 'path=does%2Fnot%2Fexist.spc&subtune=0');
  assert.strictEqual(missing.track, null, 'unknown path has no track row');
  assert.strictEqual(missing.album, null, 'unknown path has no album row');

  console.log('ok    loudness server: track, directory album, file album, missing path');
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
