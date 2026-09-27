// DEV-ONLY synthetic fixtures shared by the dev test harnesses.
//
// These build minimal-but-valid NSF/NSFE/SID buffers so the parsers and the
// catalog builder can be exercised without real files. Not part of the PR.
'use strict';

function buildNSF({ numSongs, startingSong = 1, title = '', artist = '', copyright = '' }) {
  const buf = Buffer.alloc(0x80);
  buf.write('NESM', 0, 'ascii');
  buf[0x05] = 0x01;
  buf[0x06] = numSongs;
  buf[0x07] = startingSong;
  buf.write(title, 0x0E, 'latin1');
  buf.write(artist, 0x2E, 'latin1');
  buf.write(copyright, 0x4E, 'latin1');
  return buf;
}

function buildNSFe({ numSongs, startingSong = 1, game = '', artist = '', copyright = '', labels = [], playlist = null }) {
  const chunks = [];
  const pushChunk = (type, data) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length, 0);
    chunks.push(Buffer.concat([size, Buffer.from(type, 'ascii'), data]));
  };
  const cstr = (s) => Buffer.from(s + '\0', 'latin1');

  const info = Buffer.alloc(10);
  info[8] = numSongs;         // track_count
  info[9] = startingSong - 1; // first_track (0-based)
  pushChunk('INFO', info);
  pushChunk('auth', Buffer.concat([cstr(game), cstr(artist), cstr(copyright)]));
  if (labels.length > 0) {
    pushChunk('tlbl', Buffer.concat(labels.map(cstr)));
  }
  if (playlist) {
    pushChunk('plst', Buffer.from(playlist));
  }
  const nend = Buffer.concat([Buffer.alloc(4), Buffer.from('NEND', 'ascii')]);
  return Buffer.concat([Buffer.from('NSFE', 'ascii'), ...chunks, nend]);
}

function buildSID({ version = 2, numSongs, startingSong = 1, name = '', author = '', released = '', speedBits }) {
  const buf = Buffer.alloc(0x7C);
  buf.write('PSID', 0, 'ascii');
  buf.writeUInt16BE(version, 0x04);
  buf.writeUInt16BE(0x7C, 0x06); // data offset
  buf.writeUInt16BE(numSongs, 0x0E);
  buf.writeUInt16BE(startingSong, 0x10);
  buf.write(name, 0x16, 'latin1');
  buf.write(author, 0x36, 'latin1');
  buf.write(released, 0x56, 'latin1');
  if (version >= 2 && speedBits) {
    buf[0x18] = speedBits;
  }
  return buf;
}

module.exports = { buildNSF, buildNSFe, buildSID };
