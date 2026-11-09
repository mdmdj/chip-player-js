#!/usr/bin/env node
// Copy a small, representative sample of MDX files into the catalog, from a
// scan-tracks.tsv (path, looping_tracks, one_shots, stubs) produced by
// ./scan-tracks over dev/mdx-corpus. Flattens into <dest>, one file per
// basename, and copies each file's PDX companion under the UPPERCASE name the
// app fetches (MDXPlayer uppercases the PDX name before requesting it).
//
//   find dev/mdx-corpus -iname '*.mdx' | dev/mdx-native/scan-tracks > /tmp/scan.tsv
//   node dev/mdx-native/curate-sample.js /tmp/scan.tsv catalog/mdx --limit 40
//
// Deterministic: candidates whose path contains /eidis/ win (clean names), then
// the shortest path; files are taken in scan order.

const fs = require('fs');
const path = require('path');

const [scanPath, dest, ...flags] = process.argv.slice(2);
if (!scanPath || !dest) {
  console.error('usage: curate-sample.js <scan.tsv> <dest-dir> [--limit N]');
  process.exit(2);
}
const limitIdx = flags.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(flags[limitIdx + 1], 10) : 40;

const rows = fs.readFileSync(scanPath, 'utf8').trim().split('\n')
  .filter(Boolean).map(l => l.split('\t')[0]);

// prefer eidis/ paths (clean names), then the shortest
const score = (p) => (p.includes('/eidis/') ? 0 : 1) * 1e9 + p.length;
const byBase = new Map();
for (const p of rows) {
  const b = path.basename(p).toLowerCase();
  if (!byBase.has(b) || score(p) < score(byBase.get(b))) byBase.set(b, p);
}
const picks = [...byBase.values()].slice(0, limit);

function pdxName(buf) {
  let i = 0;
  for (; i < buf.length - 2; i++) if (buf[i] === 0x0d && buf[i+1] === 0x0a && buf[i+2] === 0x1a) break;
  if (i >= buf.length - 2) return null;
  let p = i + 3, s = p;
  while (p < buf.length && buf[p] !== 0x00) p++;
  return buf.toString('latin1', s, p);
}

fs.mkdirSync(dest, { recursive: true });
let mdx = 0, pdx = 0;
for (const src of picks) {
  const base = path.basename(src);
  fs.copyFileSync(src, path.join(dest, base));
  mdx++;
  const name = pdxName(fs.readFileSync(src));
  if (!name) continue;
  const dir = path.dirname(src);
  const hit = fs.readdirSync(dir).find(f => f.toLowerCase() === name.toLowerCase());
  if (hit) { fs.copyFileSync(path.join(dir, hit), path.join(dest, name.toUpperCase())); pdx++; }
}
console.log(`copied ${mdx} mdx, ${pdx} pdx into ${dest}`);
