// DEV-ONLY synthetic fixtures shared by the dev test harnesses.
//
// These build minimal-but-valid NSF/NSFE/SID buffers so the parsers and the
// catalog builder can be exercised without real files. Not part of the PR.
'use strict';

function buildNSF({ numSongs, startingSong = 1, title = '', artist = '', copyright = '' }) {
  const buf = Buffer.alloc(0x80);
  // The magic is "NESM" + 0x1A at offset 4, with the version byte at 5.
  // parseNSF rejects anything else, so a fixture that writes a plain 0x01 at
  // offset 5 looks like a valid NSF to the length check but fails the magic.
  buf.write('NESM\x1A', 0, 'latin1');
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

function buildGBS({ numSongs, startingSong = 1, title = '', artist = '', copyright = '' }) {
  const buf = Buffer.alloc(0x70);
  buf.write('GBS', 0, 'ascii');
  buf[0x03] = 0x01;
  buf[0x04] = numSongs;
  buf[0x05] = startingSong;
  buf.write(title, 0x10, 'latin1');
  buf.write(artist, 0x30, 'latin1');
  buf.write(copyright, 0x50, 'latin1');
  return buf;
}

function buildAY({ numSongs, firstTrack = 0, author = '', comment = '', labels = [] }) {
  // String/blob area follows the header; all offsets are relative to their
  // own field position (the ZXAYEMUL convention).
  const cstr = (s) => Buffer.from(s + '\0', 'latin1');
  const parts = [Buffer.alloc(0x14)];
  let pos = 0x14;
  const authorPos = pos;
  parts.push(cstr(author)); pos += author.length + 1;
  const commentPos = pos;
  parts.push(cstr(comment)); pos += comment.length + 1;
  const namePos = [];
  for (let i = 0; i < numSongs; i++) {
    namePos.push(pos);
    const nm = labels[i] || '';
    parts.push(cstr(nm)); pos += nm.length + 1;
  }
  const tracksPos = pos;
  const entries = Buffer.alloc(numSongs * 4);
  for (let i = 0; i < numSongs; i++) {
    entries.writeInt16BE(namePos[i] - (tracksPos + i * 4), i * 4);
    // Info offset (bytes 2-3 of each entry) stays 0: absent.
  }
  parts.push(entries);
  const buf = Buffer.concat(parts);
  buf.write('ZXAYEMUL', 0, 'ascii');
  buf[0x10] = numSongs - 1; // max_track (0-based)
  buf[0x11] = firstTrack;
  buf.writeInt16BE(authorPos - 0x0C, 0x0C);
  buf.writeInt16BE(commentPos - 0x0E, 0x0E);
  buf.writeInt16BE(tracksPos - 0x12, 0x12);
  return buf;
}

module.exports = { buildNSF, buildNSFe, buildSID, buildGBS, buildAY };
