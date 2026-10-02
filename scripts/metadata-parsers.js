const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { cleanString, decodeBuffer, readStr } = require('./metadata-utils');
const {
  parseMIDI,
  guessMetadataFromPath,
  parseMidiInternal,
  parseMidiRouted,
  parseMidiWithStrategy,
  extractMidiTitleAndArtist,
  MIDI_STRATEGIES,
  MIDI_STRATEGY_MAP,
} = require('./metadata-midi');
const {
  parseNSF,
  parseNSFe,
  parseGBS,
  parseAY,
  parseSID,
  extractDate,
} = require('./subtune-headers');
const { parsePSF } = require('../src/psf');

/**
 * Extract metadata from a buffer based on the file extension.
 * Returns: { title, artist, game, system, copyright, comment, date, duration }
 */
function parseMetadata(buffer, ext, relPath = null, strategy = null) {
  const extLower = ext.toLowerCase();
  const parser = PARSERS[extLower];
  if (!parser) return {};

  try {
    const meta = (extLower === 'mid' || extLower === 'midi')
      ? parseMidiWithStrategy(buffer, relPath, strategy)
      : parser(buffer);
    // Final cleanup pass
    Object.keys(meta).forEach(k => {
      if (typeof meta[k] === 'string') {
        meta[k] = cleanString(meta[k]);
      }
    });
    return meta;
  } catch (e) {
    console.error(`[${ext.toUpperCase()}] ERROR:`, e.message);
    return {};
  }
}

// --- Parsers ---

const PARSERS = {
  vgm: parseVGM,
  vgz: (buf) => parseVGM(zlib.gunzipSync(buf)),
  nsf: parseNSF,
  nsfe: parseNSFe,
  gbs: parseGBS,
  ay: parseAY,
  spc: parseSPC,
  mod: parseMOD,
  xm: parseXM,
  it: parseIT,
  s3m: parseS3M,
  mid: parseMIDI,
  midi: parseMIDI,
  mdx: parseMIDI, // Fallback: MDX often uses SMF-like structures or no header, but standard MIDI parser won't hurt if format is different.
  gsf: (buf) => parsePSFTags(buf, 'Game Boy Advance'),
  minigsf: (buf) => parsePSFTags(buf, 'Game Boy Advance'),
  miniusf: (buf) => parsePSFTags(buf, 'Nintendo 64'),
  sid: parseSID,
  mus: parseSID, // The single-tune C64 Sidplayer format has no PSID header; parseSID only supplies its C64 label.
};

function parseVGM(buf) {
  // Spec: https://vgmrips.net/wiki/VGM_Specification
  if (buf.length < 64) {
    console.warn('[VGM] File too short (<64 bytes)');
    return {};
  }

  const version = buf.readUInt32LE(0x08);
  let gd3Offset = 0;

  if (version >= 0x100) { // VGM 1.00+
    const relativeOffset = buf.readUInt32LE(0x14);
    if (relativeOffset > 0) gd3Offset = relativeOffset + 0x14;
  }

  const meta = { system: 'VGM' };

  // Parse GD3 Tag if present
  if (gd3Offset && gd3Offset < buf.length) {
    if (buf.toString('ascii', gd3Offset, gd3Offset + 4) === 'Gd3 ') {
      let cursor = gd3Offset + 12; // Skip ID (4), Version (4), Length (4)

      const readString = () => {
        const start = cursor;
        while (cursor < buf.length - 1) {
          if (buf.readUInt16LE(cursor) === 0) {
            const strBuf = buf.subarray(start, cursor);
            cursor += 2; // Skip null terminator
            return strBuf.toString('utf16le');
          }
          cursor += 2;
        }
        return '';
      };

      meta.title = readString();             // Track Name (English)
      readString();                          // Track Name (Japanese)
      meta.game = readString();              // Game Name (English)
      readString();                          // Game Name (Japanese)
      meta.system = readString();            // System Name (English)
      readString();                          // System Name (Japanese)
      meta.artist = readString();            // Author (English)
      readString();                          // Author (Japanese)
      meta.date = extractDate(readString()); // Release Date
      meta.ripper = readString();     // Ripper
      meta.comment = readString();    // Notes
    } else {
      console.warn(`[VGM] GD3 pointer exists (0x${gd3Offset.toString(16)}) but 'Gd3 ' magic missing.`);
    }
  }

  return meta;
}

function parseNSF(buf) {
  // Spec: https://wiki.nesdev.org/w/index.php/NSF
  if (buf.length < 128 || buf.toString('ascii', 0, 5) !== 'NESM\x1A') {
    return {};
  }

  // The total number of songs is stored at offset 0x06, and the
  // starting song index (1-based) at 0x07.
  const numSongs = buf[0x06] || 1;
  const startingSong = buf[0x07] || 1;

  // Use latin1 to preserve 8-bit chars like ©
  const copyright = readStr(buf, 0x4E, 0x6E);
  return {
    title: readStr(buf, 0x0E, 0x2E),
    artist: readStr(buf, 0x2E, 0x4E),
    copyright,
    date: extractDate(copyright),
    system: 'NES',
    numSongs,
    startingSong,
  };
}

/**
 * Parse the NSFE `tlbl`/`auth` string chunks into an array of strings.
 * The chunk is a run of null-terminated strings.
 */
function parseNsfeStrings(buf, start, end) {
  const strings = [];
  let cursor = start;
  while (cursor < end) {
    let strEnd = cursor;
    while (strEnd < end && buf[strEnd] !== 0) strEnd++;
    strings.push(readStr(buf, cursor, strEnd));
    cursor = strEnd + 1;
  }
  return strings;
}

function parseNSFe(buf) {
  // Spec: https://wiki.nesdev.org/w/index.php/NSFe
  //
  // NSFE is a chunked ("tagged") format. Each chunk is a little-endian
  // uint32 size followed by a 4-byte ASCII tag (INFO, BANK, time, auth,
  // plst, tlbl, DATA, NEND, ...). See game-music-emu/gme/Nsfe_Emu.cpp.
  if (buf.toString('ascii', 0, 4) !== 'NSFE') {
    return parseNSF(buf);
  }

  const meta = { system: 'NES' };
  let cursor = 4;

  // NSFE does not embed a base NSF header; counts come from the INFO chunk.
  // `trackCount` is the number of tracks physically present in the DATA chunk.
  // The `plst` (playlist) chunk, when present, is the authoritative list of
  // sub-tunes (and their order/remapping), mirroring game-music-emu.
  let trackCount = 1;
  let startingSong = 1;

  let trackLabels = [];   // labels indexed by physical track
  let playlist = null;    // array of physical track indices

  while (cursor + 8 <= buf.length) {
    const chunkSize = buf.readUInt32LE(cursor);
    const chunkType = buf.toString('ascii', cursor + 4, cursor + 8);
    const chunkDataStart = cursor + 8;
    const nextChunk = Math.min(chunkDataStart + chunkSize, buf.length);

    switch (chunkType) {
      case 'INFO': {
        // load_addr(2), init_addr(2), play_addr(2), speed_flags(1),
        // chip_flags(1), track_count(1), first_track(1), unused(6)
        if (chunkSize >= 9) {
          trackCount = buf[chunkDataStart + 8] || 1;
        }
        if (chunkSize >= 10) {
          // NSFE `first_track` is 0-based (unlike the 1-based NSF header).
          startingSong = buf[chunkDataStart + 9] + 1;
        }
        break;
      }
      case 'auth': {
        const strs = parseNsfeStrings(buf, chunkDataStart, nextChunk);
        if (strs[0]) meta.game = strs[0];
        if (strs[1]) meta.artist = strs[1];
        if (strs[2]) meta.copyright = strs[2];
        if (strs[3]) meta.dumper = strs[3];
        if (!meta.title) meta.title = meta.game;
        break;
      }
      case 'tlbl': {
        trackLabels = parseNsfeStrings(buf, chunkDataStart, nextChunk);
        break;
      }
      case 'plst': {
        // A byte array of physical track indices.
        playlist = Array.from(buf.subarray(chunkDataStart, nextChunk));
        break;
      }
      case 'time': // per-track lengths in ms; reserved for future use.
      case 'fade': // per-track fadeout times in ms; reserved for future use.
        break;
      default:
        break;
    }

    if (chunkType === 'NEND') break;
    if (nextChunk <= cursor) break;
    cursor = nextChunk;
  }

  // Mirror game-music-emu's Nsfe_Info:
  //   - with a non-empty playlist, songs are the playlist entries remapped
  //     into the physical track list;
  //   - otherwise, songs are all physical tracks 1:1.
  const usePlaylist = Array.isArray(playlist) && playlist.length > 0;
  const songCount = usePlaylist ? playlist.length : trackCount;

  const subtitles = [];
  for (let i = 0; i < songCount; i++) {
    const physical = usePlaylist ? playlist[i] : i;
    const label = trackLabels[physical];
    // Keep a slot for unlabeled tracks so labels stay aligned to their tune.
    subtitles.push(label != null ? label : null);
  }

  meta.numSongs = songCount;
  meta.startingSong = startingSong;
  if (subtitles.length > 0) {
    meta.trackLabels = subtitles;
  }
  // A single empty label is the spec's "one unnamed track" placeholder.
  if (meta.trackLabels && meta.trackLabels.length === 1 && meta.trackLabels[0] === '') {
    delete meta.trackLabels;
  }
  if (meta.trackLabels && meta.trackLabels[0]) {
    meta.title = meta.trackLabels[0];
  }

  meta.date = extractDate(meta.copyright);

  return meta;
}

function parseGBS(buf) {
  // Spec: https://gbdev.gg8.se/wiki/articles/GBS_Music_Format (deleted?)
  //       https://ocremix.org/info/GBS_Format_Specification
  //       https://web.archive.org/web/20250518043814/https://ftp.modland.com/pub/documents/format_documentation/Gameboy%20Sound%20System%20%28.gbs%29.txt
  // Layout mirrors game-music-emu/gme/Gbs_Core.h: track_count at 0x04,
  // first_track (1-based) at 0x05, then three null-padded 32-byte strings.
  if (buf.length < 0x70 || buf.toString('ascii', 0, 3) !== 'GBS') {
    console.warn('[GBS] Missing GBS signature.');
    return {};
  }
  const copyright = readStr(buf, 0x50, 0x70);
  return {
    title: readStr(buf, 0x10, 0x30),
    artist: readStr(buf, 0x30, 0x50),
    copyright,
    date: extractDate(copyright),
    system: 'Game Boy',
    numSongs: buf[0x04] || 1,
    startingSong: buf[0x05] || 1,
  };
}

/**
 * Read a null-terminated string at a big-endian offset field, where the
 * offset is relative to the field's own position (the ZXAYEMUL convention;
 * see game-music-emu/gme/Ay_Emu.cpp:get_data). Returns null when the field
 * is zero or points outside the buffer.
 */
function readAyStringAt(buf, fieldPos) {
  if (fieldPos + 2 > buf.length) return null;
  const offset = buf.readInt16BE(fieldPos);
  if (!offset) return null;
  const start = fieldPos + offset;
  if (start >= buf.length) return null;
  let end = start;
  while (end < buf.length && buf[end] !== 0) end++;
  return decodeBuffer(buf.subarray(start, end));
}

function parseAY(buf) {
  // Layout mirrors game-music-emu/gme/Ay_Emu.h:header_t. The header holds
  // offsets (not inline strings); per-track names live in the tracks table.
  if (buf.length < 0x14) return {};
  if (buf.toString('ascii', 0, 8) !== 'ZXAYEMUL') {
    console.warn('[AY] Missing ZXAYEMUL signature.');
    return { system: 'ZX Spectrum' };
  }
  const maxTrack = buf[0x10];
  const numSongs = (maxTrack || 0) + 1;

  const meta = {
    system: 'ZX Spectrum',
    numSongs,
    startingSong: (buf[0x11] || 0) + 1,
  };
  const author = readAyStringAt(buf, 0x0C);
  if (author) meta.artist = author;
  const comment = readAyStringAt(buf, 0x0E);
  if (comment) meta.comment = comment;

  // Tracks table: one 4-byte entry per song; the first word of each entry
  // points at that song's null-terminated name.
  const tracksOff = buf.readInt16BE(0x12);
  const tracksPos = 0x12 + tracksOff;
  if (tracksOff && tracksPos >= 0x14 && tracksPos + numSongs * 4 <= buf.length) {
    const labels = [];
    for (let i = 0; i < numSongs; i++) {
      labels.push(readAyStringAt(buf, tracksPos + i * 4));
    }
    if (labels.some((l) => l != null && l !== '')) {
      meta.trackLabels = labels.map((l) => (l ? l : null));
      if (meta.trackLabels[0]) meta.title = meta.trackLabels[0];
    }
  }

  return meta;
}

function parseSPC(buf) {
  // Spec: https://wiki.superfamicom.org/spc700-reference#spc-file-format-header
  if (buf.length < 0x100 || buf.toString('ascii', 0, 27) !== 'SNES-SPC700 Sound File Data') {
    console.warn('[SPC] Missing SPC700 signature.');
    return {};
  }

  // Check ID666 format: Text vs Binary
  // Standard ID666 uses text at 0x2E
  const isBinaryId666 = buf[0x23] === 0x1A; // Spec deviation sometimes used

  let title = readStr(buf, 0x2E, 0x4E);
  let game = readStr(buf, 0x4E, 0x6E);
  let dumper = readStr(buf, 0x6E, 0x7E);
  let comment = readStr(buf, 0x7E, 0x9E);
  let artist = readStr(buf, 0xB1, 0xD1);

  // Parse Length (seconds)
  let duration = 0;
  if (!isBinaryId666) {
    const secondsStr = buf.toString('ascii', 0xA9, 0xAC).trim();
    const parsed = parseInt(secondsStr, 10);
    if (!isNaN(parsed)) duration = parsed;
  } else {
    duration = buf.readUInt16LE(0xA9);
  }

  return {
    title,
    game,
    artist,
    comment,
    dumper,
    duration,
    system: 'SNES'
  };
}

function parseMOD(buf) {
  // MOD titles are the first 20 bytes
  if (buf.length < 20) return {};
  return {
    title: readStr(buf, 0x00, 0x14),
    system: 'Amiga'
  };
}

function parseS3M(buf) {
  return {
    title: readStr(buf, 0x00, 0x1C),
    system: 'PC'
  };
}

function parseXM(buf) {
  return {
    title: readStr(buf, 0x11, 0x25),
    system: 'PC'
  };
}

function parseIT(buf) {
  return {
    title: readStr(buf, 0x04, 0x1E),
    system: 'PC'
  };
}

function parsePSFTags(buf, defaultSystem = 'Game Boy Advance') {
  return parsePSF(buf, { defaultSystem });
}


module.exports = {
  parseMetadata,
  guessMetadataFromPath,
  parseMidiInternal,
  parseMidiRouted,
  parseMidiWithStrategy,
  parseMIDI,
  extractMidiTitleAndArtist,
  MIDI_STRATEGIES,
  MIDI_STRATEGY_MAP,
  cleanString,
  decodeBuffer,
  readStr,
  parsePSFTags,
};
