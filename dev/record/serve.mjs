// DEV-ONLY: serve site/ for local preview (dev/record/README.md).
//
//   node dev/record/serve.mjs [port]
//
// Replaces serve.sh's `python3 -m http.server`, which cannot serve the page
// correctly: it has no Range support, so every media request gets a full-file
// 200 with no Accept-Ranges. Measured consequence (dev/record/vidcheck.mjs): the
// video element's `seekable` range comes back EMPTY (0.00-0.00), so the first
// frame appears but pressing play has nothing to stream, while the same file
// opened standalone plays fine because by then it is fully downloaded. A serving
// bug, not a clip bug.
//
// Express is already a dependency of this repo (server/package.json), and its
// `express.static` does Range/206, ETag and Content-Type properly -- which is
// also what nginx/Apache/a static host do for the uploaded page. Node itself has
// no static file server, so there is nothing built in to reach for; using the
// dependency we already ship beats hand-rolling the header parsing. It is
// resolved from server/node_modules by ./express.mjs, since this file sits in
// dev/record/ and a bare `import 'express'` would not see it there.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from './express.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'site');
const PORT = Number(process.argv[2]) || 8099;

// `max-age=0` is express.static's default, which means "revalidate before every
// use": every page load re-requests all 14 clips and, because a browser's metadata
// probe is an open-ended `Range: bytes=0-` with the moov at the front, each of those
// answers streams the whole file before the browser cancels. So let the media and
// stylesheets be cached for an hour and revalidate only the HTML, so a rebuild shows
// up immediately without re-pulling 35 MB over the Tailscale link on every visit.
const staticOpts = {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  },
};

express()
  .use(express.static(OUT, staticOpts))
  .get('/', (req, res) => res.sendFile(path.join(OUT, 'index.html')))
  .listen(PORT, '0.0.0.0', () => {
    console.log(`serving ${OUT} on http://0.0.0.0:${PORT}/ (ctrl-c to stop)`);
  });