#!/usr/bin/env node
// DEV-ONLY generator for catalog/midi/loop-pedal-seam.mid -- the fixture for the
// seam's sustain-pedal lift. A note released while the pedal is down keeps
// sounding, so at a loop boundary the expanded two-pass list has to lift the
// pedal (as loopJump does on the live wrap) or those notes bleed into the second
// pass and overlap its notes. Loop 2..4s (2s long), pedal down throughout, one
// note released exactly on the seam while the pedal holds it.
// Run: node dev/make-loop-pedal-midi.js [out.mid]
'use strict';

const fs = require('fs');
const path = require('path');

// Same builder as dev/test-midi-loops.js: tpq 120, tempo 500000us => a beat is
// 500ms and a tick is 4.1667ms.
const TPQ = 120;

function varlen(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

function buildMidi(events, { format = 1, division = TPQ } = {}) {
  const trackLists = Array.isArray(events[0]) ? events : [events];
  const chunks = trackLists.map((list) => {
    const track = [];
    for (const ev of list) track.push(...varlen(ev.delta), ...ev.bytes);
    track.push(...varlen(0), 0xff, 0x2f, 0x00); // end of track
    return [0x4d, 0x54, 0x72, 0x6b,
      (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
      (track.length >> 8) & 0xff, track.length & 0xff, ...track];
  });
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    (format >> 8) & 0xff, format & 0xff,
    (chunks.length >> 8) & 0xff, chunks.length & 0xff,
    (division >> 8) & 0xff, division & 0xff];
  return new Uint8Array([...header, ...chunks.flat()]);
}

const tempo = (usPerQuarter = 500000) => ({ delta: 0, bytes: [0xff, 0x51, 0x03,
  (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] });
const cc = (controller, value = 0) => ({ delta: 0, bytes: [0xb0, controller, value] });
const ccAt = (delta, controller, value = 0) => ({ delta, bytes: [0xb0, controller, value] });
const noteOnAt = (delta, channel = 0, pitch = 60, velocity = 100) =>
  ({ delta, bytes: [0x90 | channel, pitch, velocity] });
const noteOffAt = (delta, channel = 0, pitch = 60) =>
  ({ delta, bytes: [0x80 | channel, pitch, 0] });

// Pedal down at 0 and never lifted by the file itself: the seam's lift is the
// only one there is, which is exactly the point.
const bytes = buildMidi([
  tempo(),
  cc(64, 127),                                    // tick 0: pedal down
  noteOnAt(0, 0, 48), noteOffAt(TPQ * 3, 0, 48),  // 0..360: released under the pedal -> rings on
  ccAt(TPQ, 110),                                 // 480 (2000ms): loop start
  noteOnAt(0, 0, 72), noteOffAt(TPQ, 0, 72),      // the loop's own figure, 480..600
  noteOnAt(TPQ, 0, 76), noteOffAt(TPQ * 2, 0, 76),// 720 -> released at 960, i.e. on the seam
  cc(111),                                        // 960 (4000ms): loop end = the seam
  noteOnAt(TPQ, 0, 84), noteOffAt(TPQ * 2, 0, 84),// composed ending, 1080..1320
]);

const out = process.argv[2]
  || path.join(__dirname, '..', 'catalog', 'midi', 'loop-pedal-seam.mid');
fs.writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes): loop 2000..4000ms, pedal down throughout,`
  + ' a note released on the seam while it is held');
