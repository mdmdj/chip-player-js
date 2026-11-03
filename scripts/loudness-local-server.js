/**
 * The catalog scanner runs the player classes under Node, and those classes
 * fetch metadata, soundfonts and companion files through the same URLs the
 * browser uses. This tiny server gives them a local equivalent backed by
 * `catalog.db` and the on-disk catalog, so a scan is offline and reproducible.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const MIME = {
  '.sf2': 'application/octet-stream',
  '.usflib': 'application/octet-stream',
  '.gsflib': 'application/octet-stream',
  '.pdx': 'application/octet-stream',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(root, decoded);
  const rootWithSep = path.resolve(root) + path.sep;
  if (full !== path.resolve(root) && !full.startsWith(rootWithSep)) return null;
  return full;
}

function startLoudnessServer({ dbPath, catalogRoot, soundfontRoot, csdbPath }) {
  const db = new Database(dbPath, { readonly: true });
  if (csdbPath && fs.existsSync(csdbPath)) {
    try {
      db.exec(`ATTACH DATABASE '${csdbPath.replace(/'/g, "''")}' AS csdb_db`);
    } catch (e) {
      // SID lengths are optional; the player falls back to its default length.
    }
  }

  const metadataStmt = db.prepare(`
    SELECT song_id, soundfont, contributor, md5, subtune_count
    FROM music WHERE path = ? LIMIT 1
  `);
  const subtuneStmt = db.prepare(`
    SELECT st.title
    FROM subtune st JOIN music m ON m.id = st.music_id
    WHERE m.path = ? AND st.subtune = ? LIMIT 1
  `);
  let hvscStmt = null;
  try {
    hvscStmt = db.prepare('SELECT * FROM csdb_db.hvsc_files WHERE hash = ? LIMIT 1');
  } catch (e) {
    // No csdb.db: SIDPlayer falls back to its default track length.
  }

  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/api/metadata') {
      const filepath = (url.searchParams.get('path') || '').replace(/^\/+/, '');
      const subtune = Number.parseInt(url.searchParams.get('subtune'), 10);
      const meta = filepath ? metadataStmt.get(filepath) : null;
      if (!meta) return sendJson(res, 200, {});
      let subtuneTitle = null;
      if (Number.isInteger(subtune)) {
        const row = subtuneStmt.get(filepath, subtune);
        subtuneTitle = row ? row.title : null;
      }
      return sendJson(res, 200, {
        songId: meta.song_id,
        soundfont: meta.soundfont,
        contributor: meta.contributor,
        md5: meta.md5,
        subtuneCount: meta.subtune_count || 1,
        subtuneTitle,
      });
    }

    if (url.pathname === '/api/hvsc') {
      const hash = url.searchParams.get('sidHash');
      if (!hash) return sendJson(res, 400, { error: 'missing sidHash' });
      const row = hvscStmt ? hvscStmt.get(hash) : null;
      if (!row) return sendJson(res, 404, { error: 'SID not found' });
      row.image_url = null;
      return sendJson(res, 200, row);
    }

    let root = null;
    let rest = null;
    if (url.pathname.startsWith('/catalog/')) {
      root = catalogRoot;
      rest = url.pathname.slice('/catalog/'.length);
    } else if (url.pathname.startsWith('/soundfonts/')) {
      root = soundfontRoot;
      rest = url.pathname.slice('/soundfonts/'.length);
    }
    if (!root) return sendJson(res, 404, { error: 'not found' });

    let file;
    try {
      file = safeJoin(root, rest);
    } catch (e) {
      return sendJson(res, 400, { error: 'bad path' });
    }
    if (!file) return sendJson(res, 403, { error: 'forbidden' });
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      return sendJson(res, 404, { error: 'not found' });
    }
    if (!stat.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
    });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close() {
          return new Promise((done) => {
            server.close(() => {
              try { db.close(); } catch (e) { /* already closed */ }
              done();
            });
          });
        },
      });
    });
  });
}

module.exports = { startLoudnessServer };
