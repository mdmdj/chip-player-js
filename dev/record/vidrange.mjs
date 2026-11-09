// DEV-ONLY: does the cache policy change the answer to a *range* request?
//
//   node dev/record/vidrange.mjs
//
// The queue explanation for the intermittent stalls is refuted (vidqueue.mjs: the
// old preload="metadata" page plays fine, even clicked 0.5 s after load on the
// deepest clip). So the other change from the same commit is the remaining suspect:
// Cache-Control went from express.static's default `max-age=0` to
// `public, max-age=3600`.
//
// It matters for media specifically, because `max-age=0` makes the browser
// *revalidate*, and a revalidating range request carries `If-Range: <etag>`. If the
// server answers that with 200 (full body) instead of 206 (partial), the media
// element has to start over from byte 0 -- and a browser mid-setup restarting its
// download looks exactly like "I clicked play and nothing happened". Nothing in
// vidall/vidcheck ever sent If-Range, because a cold profile does not revalidate.
//
// This asks the server directly, for both policies, and prints what came back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from './express.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');
const CLIP = 'clips/vgm-native.mp4';

const POLICIES = [
  { name: 'max-age=0 (what we had)', maxAge: 0 },
  { name: 'max-age=3600 (now)', maxAge: 3600 },
];

const servers = [];
for (const [i, p] of POLICIES.entries()) {
  const app = express();
  app.use(express.static(SITE, {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', `public, max-age=${p.maxAge}`);
    },
  }));
  const port = 8093 + i;
  await new Promise((r) => app.listen(port, '127.0.0.1', r));
  servers.push(app);
  p.port = port;
  p.url = `http://127.0.0.1:${port}/${CLIP}`;
}

const get = (url, headers) => fetch(url, { headers }).then(async (r) => ({
  status: r.status,
  etag: r.headers.get('etag'),
  cache: r.headers.get('cache-control'),
  range: r.headers.get('content-range'),
  len: r.headers.get('content-length'),
  body: (await r.arrayBuffer()).byteLength,
}));

for (const p of POLICIES) {
  console.log(`\n=== Cache-Control: ${p.name}`);
  const plain = await get(p.url, { Range: 'bytes=0-1023' });
  console.log(`  plain Range: bytes=0-1023      -> ${plain.status}  content-range=${plain.range}  bytes=${plain.body}`);

  const etag = plain.etag;
  const withIfRange = await get(p.url, { Range: 'bytes=0-1023', 'If-Range': etag });
  console.log(`  Range + If-Range: <etag>       -> ${withIfRange.status}  content-range=${withIfRange.range}  bytes=${withIfRange.body}`);

  const ifNoneMatch = await get(p.url, { 'If-None-Match': etag });
  console.log(`  If-None-Match: <etag>          -> ${ifNoneMatch.status}  bytes=${ifNoneMatch.body}   ${ifNoneMatch.status === 304 ? '(revalidate, no body -- cheap)' : ''}`);

  const second = await get(p.url, { Range: 'bytes=0-1023' });
  console.log(`  repeat Range                  -> ${second.status}  content-range=${second.range}`);
}

process.exit(0);
console.log('\nThe line that matters: a 200 where a 206 was asked for means the media');
console.log('element must restart from byte 0 instead of continuing.');