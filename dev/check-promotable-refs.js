#!/usr/bin/env node
// DEV-ONLY gate: nothing that can reach the PR may point at this repo's
// overlay-only material. A promoted file has to stand on its own -- AGENTS.md and
// dev/ do not exist in the PR, our dev-catalog file names mean nothing to a reader,
// and the two files we hand-carry feature work in can leak such a reference by hand
// even though the file itself never promotes.
//
// Checked: every tracked file that promote.sh would not skip (it skips
// dev/promote-paths.txt entries), plus the hand-carried pair. Lines inside
// DEV-BEGIN..DEV-END blocks are ignored -- the promote strips those, so they cannot
// leak (the two regions in server/index.js are the reason that matters).
//
// Run: node dev/check-promotable-refs.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HAND_CARRIED = ['server/index.js', 'scripts/build-chip-core.js'];

// Never legitimate in a promoted file. Kept narrow on purpose: `catalog/` alone is
// upstream's own directory and `dev` alone is an ordinary word.
const FORBIDDEN = [
  [/\bAGENTS\.md\b/, 'the overlay-only notes'],
  [/promote-paths/, 'the promotion tooling'],
  [/dev\/(record|shims|mdx-native|mdx-corpus|apply\.sh|remove\.sh|rebase\.sh|promote|push-overlay|run-tests|test-[a-z-]+\.js)/,
    'a dev tool'],
  [/catalog\/nes-audio-tests/, 'a dev fixture'],
  [/\b(EXES04|FACE04|popm2[15]|DAR2_4|G2MST6|MTS2_32|DTWNB18|SIDE11C|CTTY|SPD35|KNA14_EX|utabi46b|SEIYA_N|WBALL0_EX)\b/,
    'a dev-catalog file name'],
  [/\bcorpus\b/, 'the dev corpus'],
];

// promote.sh skips these, so they never promote.
function loadSkipList() {
  const file = path.join(__dirname, 'promote-paths.txt');
  const entries = fs.readFileSync(file, 'utf8').split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  return (rel) => entries.some((entry) => {
    const bare = entry.replace(/\/+$/, '').replace(/\/\*\*$/, '');
    let isDir = /\/\*\*$/.test(entry) || /\/$/.test(entry);
    try { isDir = isDir || fs.statSync(path.join(ROOT, bare)).isDirectory(); } catch (e) { /* gone */ }
    if (rel === bare) return true;
    return isDir && rel.startsWith(bare + '/');
  });
}

// A DEV region strips away, so what is inside it can never leak.
function outsideDevRegions(text) {
  let inRegion = false;
  return text.split('\n').map((line) => {
    const opens = /\bDEV-BEGIN\b/.test(line);
    const closes = /\bDEV-END\b/.test(line);
    const visible = inRegion ? '' : line;
    if (opens && !closes) inRegion = true;
    else if (closes) inRegion = false;
    return visible;
  });
}

const skipped = loadSkipList();
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const candidates = tracked.filter((rel) => !skipped(rel) || HAND_CARRIED.includes(rel));

const hits = [];
for (const rel of candidates) {
  let text;
  const full = path.join(ROOT, rel);
  try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; } // binary or gone
  if (text.includes('\0')) continue;
  outsideDevRegions(text).forEach((line, i) => {
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(line)) {
        hits.push(`${rel}:${i + 1}: ${what} -- ${line.trim().slice(0, 100)}`);
        return;
      }
    }
  });
}

console.log(`checked ${candidates.length} of ${tracked.length} tracked files ` +
  `(${tracked.length - candidates.length} skipped as overlay-only, ` +
  `${HAND_CARRIED.length} hand-carried files included)`);
if (hits.length) {
  console.error(`FAIL  ${hits.length} overlay-only reference(s) in files that can reach the PR:`);
  for (const hit of hits) console.error(`      ${hit}`);
  process.exit(1);
}
console.log('ok    no overlay-only references in anything that can promote');
