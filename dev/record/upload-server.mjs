// DEV-ONLY receiver for audio blobs recorded inside the browser by
// dev/shims/recorder.js (window.__cpRec). Browser JS cannot write to the
// workspace, and preview_evaluate returns at most 64 KB while a 12 s opus track
// is ~200 KB, so the page POSTs the blob here instead.
//
// Shape borrowed from ~/dev/mdm-test-playable-0/scripts/record-server.mjs,
// which proves the approach against MediaRecorder output. Kept loopback-only,
// zero-dependency, and gitignored output.
//
//   GET  /health                    -> { ok: true }
//   POST /upload?file=<name>        -> { saved, path }   (body = bytes)
//   GET  /                          -> { ok: true, files: [...] }
//
// RECORD_PORT overrides the default 3999; RECORD_HOST overrides the bind
// address. The default is 0.0.0.0 rather than 127.0.0.1 on purpose: the page
// that records lives in the T3 Code preview tab, whose browser cannot reach the
// host's loopback (a fetch to 127.0.0.1 fails with "Failed to fetch") but does
// reach the host's Tailscale/LAN address. Loopback-only would work from curl
// and never from the recorder -- measured 2026-10-05.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.work');
const PORT = Number(process.env.RECORD_PORT ?? 3999);

/** Keep only safe filename chars; collapse dot runs so '..' can never escape */
const safe = (s) =>
  s
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true, dir: ROOT });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    send(res, 200, { ok: true, files: fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/upload') {
    const file = safe(url.searchParams.get('file') ?? '');
    if (!file) {
      send(res, 400, { error: 'file query param is required' });
      return;
    }
    const target = path.join(ROOT, file);
    if (!target.startsWith(ROOT + path.sep)) {
      send(res, 400, { error: 'resolved path escapes .work/' });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(target, data);
    send(res, 201, { saved: data.length, path: target });
    return;
  }

  send(res, 404, { error: 'not found' });
});

fs.mkdirSync(ROOT, { recursive: true });
const HOST = process.env.RECORD_HOST ?? '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`record receiver on http://${HOST}:${PORT} -> ${ROOT}`);
});