#!/usr/bin/env node
// DEV-ONLY Songlengths importer for the server csdb database.
//
// SID files carry no durations; prod resolves them at runtime via /hvsc from
// the `hvsc_files` table, which is populated out-of-band from HVSC's
// DOCUMENTS/Songlengths.txt. This script replicates that import locally so
// dev SIDs get real per-subtune lengths (repeat/blind-loop ground truth).
//
// Matching is by the libsidplayfp "fingerprint" (PSID::createMD5), NOT by
// md5(file): md5 over the C64 data + init/play/song-count (LE16) + one speed
// byte per song (0 = VBI, 60 = CIA) + 0x02 when v2+ flags say NTSC. Header
// strings are deliberately excluded, so the hash survives retagging.
//
// Usage:
//   node dev/import-songlengths.js [--file Songlengths.txt] [--dry-run]
//
// Without --file, downloads the canonical HVSC copy to a tmp cache.
// Only rows matching local catalog/*.sid files are imported; names come from
// parsing the local files (same parser the catalog builder uses). Re-runnable.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { parseMetadata } = require('../scripts/metadata-parsers');

const SONGLENGTHS_URL = 'https://hvsc.c64.org/download/C64Music/DOCUMENTS/Songlengths.txt';
const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  if (name === 'dry-run') return true;
  return process.argv[i + 1] || def;
}
const DRY_RUN = process.argv.includes('--dry-run');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`[dev] Downloading ${url} ...`);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => resolve(dest));
      out.on('error', reject);
    }).on('error', reject);
  });
}

// libsidplayfp PSID fingerprint (PSID::createMD5): md5 of C64 data + init,
// play, song count (little-endian u16) + one speed byte per song + 0x02 for
// v2+ NTSC. Returns null for non-PSID/RSID buffers.
function sidFingerprint(buf) {
  if (buf.length < 0x76) return null;
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'PSID' && magic !== 'RSID') return null;
  const version = buf.readUInt16BE(0x04);
  const dataOffset = buf.readUInt16BE(0x06);
  const load = buf.readUInt16BE(0x08);
  const init = buf.readUInt16BE(0x0a);
  const play = buf.readUInt16BE(0x0c);
  const songs = buf.readUInt16BE(0x0e);
  let speed = buf.readUInt32BE(0x12);
  if (dataOffset > buf.length) return null;

  const h = crypto.createHash('md5');
  // loadAddr == 0 means the load address is stored in front of the C64 data
  // (SidTuneBase::resolveAddrs bumps fileOffset by 2); the hash skips it.
  h.update(buf.subarray(load === 0 ? dataOffset + 2 : dataOffset));
  const le = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); h.update(b); };
  le(init); le(play); le(songs);
  const capped = Math.min(songs, 256);
  for (let s = 0; s < capped; s++) {
    h.update(Buffer.from([(speed & 1) ? 60 : 0]));
    if (s < 31) speed >>>= 1;
  }
  if (version >= 2 && buf.length >= 0x78) {
    const flags = buf.readUInt16BE(0x76);
    if ((flags & 0x0c) === 0x08) h.update(Buffer.from([2])); // NTSC only
  }
  return h.digest('hex');
}

function parseSonglengths(text) {
  const entries = new Map(); // md5 -> { fullname, lengths }
  let fullname = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line === '[Database]') continue;
    if (line.startsWith(';')) { fullname = line.slice(1).trim(); continue; }
    const eq = line.indexOf('=');
    if (eq === -1 || !fullname) continue;
    const hash = line.slice(0, eq).trim().toLowerCase();
    const lengths = line.slice(eq + 1).trim();
    if (/^[0-9a-f]{32}$/.test(hash) && lengths) entries.set(hash, { fullname, lengths });
  }
  return entries;
}

function walkSids(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSids(p));
    else if (/\.sid$/i.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  let file = arg('file', null);
  if (!file) {
    file = path.join(os.tmpdir(), 'chip-player-Songlengths.txt');
    if (!fs.existsSync(file)) await download(SONGLENGTHS_URL, file);
    else console.log(`[dev] Reusing cached ${file}`);
  }
  const entries = parseSonglengths(fs.readFileSync(file, 'utf8'));
  console.log(`[dev] Parsed ${entries.size} Songlengths entries from ${file}`);

  const catalogDir = path.join(ROOT, 'catalog');
  const localSids = walkSids(catalogDir);
  console.log(`[dev] Found ${localSids.length} local .sid files`);

  const rows = [];
  const missing = [];
  for (const sidPath of localSids) {
    const buf = fs.readFileSync(sidPath);
    const hash = sidFingerprint(buf);
    if (!hash) { missing.push(`${sidPath} (not PSID/RSID)`); continue; }
    const entry = entries.get(hash);
    if (!entry) { missing.push(`${sidPath} (fingerprint ${hash})`); continue; }
    const meta = parseMetadata(buf, 'sid');
    const tokens = entry.lengths.split(/\s+/);
    if (tokens.length !== (meta.numSongs || 1)) {
      console.log(`[dev] WARN length count != song count: ${sidPath} ` +
        `(${tokens.length} vs ${meta.numSongs})`);
    }
    rows.push({
      hash,
      fullname: entry.fullname,
      name: meta.title || null,
      author: meta.artist || null,
      copyright: meta.copyright || null,
      lengths: entry.lengths,
      songs: meta.numSongs || 1,
      path: sidPath,
    });
  }

  console.log(`[dev] Matched ${rows.length}/${localSids.length} local SIDs`);
  for (const m of missing) console.log(`[dev] MISSING ${m}`);
  if (DRY_RUN) { console.log('[dev] --dry-run: no database changes.'); return; }

  const csdbPath = path.resolve(ROOT, 'server', 'csdb.db');
  if (!fs.existsSync(csdbPath)) {
    console.error(`[dev] ${csdbPath} missing; run ./dev/apply.sh first.`);
    process.exit(2);
  }
  const db = new Database(csdbPath);
  const del = db.prepare('DELETE FROM hvsc_files WHERE hash = ?');
  const ins = db.prepare(
    'INSERT INTO hvsc_files (hash, fullname, name, author, copyright, lengths, songs) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction((list) => {
    for (const r of list) {
      del.run(r.hash);
      ins.run(r.hash, r.fullname, r.name, r.author, r.copyright, r.lengths, r.songs);
    }
  });
  tx(rows);
  db.close();
  console.log(`[dev] Wrote ${rows.length} rows to ${csdbPath} (hvsc_files)`);

  if (missing.length > 0) process.exit(1);
}

main().catch((e) => { console.error(`[dev] FAILED: ${e.message}`); process.exit(2); });
