# replaygain — design and measurements

Feature branch: `feature/replaygain` (overlay `dev/overlay-replaygain`).

## The problem

Volume varies by engine, game and song by more than the volume slider can
compensate for. The slider tops out at 150% (+3.5 dB); the ear-labelled samples
below span about 10.6 dB of integrated loudness. Some engines are also very loud:
the V2M fixture measures about -9 LUFS with a peak above 0 dBFS, so it is already
clipping before the user touches anything.

## What was measured

`dev/test-replaygain.js` renders the samples through the same player classes and
the same wasm core the app uses, at 48 kHz, and measures BS.1770 integrated
loudness plus sample peak. These are the eight files that could be downloaded
from the links (four returned Cloudflare 403s from this network; retry later or
add them by hand):

| Label | File | LUFS | Peak dBFS | Gain at -18 (peak-safe) |
| --- | --- | ---: | ---: | ---: |
| quiet | Wild Guns / Theme of Wild Guns | -31.7 | -12.7 | +11.7 |
| quiet | Rise of the Robots / End of Match | -22.8 | -8.3 | +4.8 |
| medium | Zelda ALttP / Staff Roll | -30.6 | -12.1 | +11.1 |
| medium | Shougi Saikyou / Which Scenario | -30.4 | -14.3 | +13.3 |
| medium | BattleClash / Garam | -27.9 | -8.8 | +7.8 |
| medium | Earthworm Jim / Andy Asteroids | -29.8 | -10.7 | +9.7 |
| kinda loud | Lufia / Battle of the Island in the Void | -21.1 | -6.6 | +5.6 |
| kinda loud | Mega Man X3 / Doppler Stage | -22.5 | -7.2 | +6.2 |

The order matches the ear labels except End of Match (labelled quiet, measures
like Doppler), which is why the feature uses measured loudness rather than a
curated list.

Raw spread: 10.6 dB. After peak-safe normalization to -18 LUFS: 2.1 dB. The
quietest track is limited by its peak (it would need +13.8 dB to reach -18), so
it lands at about -20 LUFS. That is the honest limit of a static replay gain
without a limiter; see "Next steps".

The album measurement is duration-weighted: an album is all of its tracks played
back to back, so its mean square is the time-weighted mean of the tracks'. For
the samples, the `quiet` folder becomes -27.8 LUFS (+7.3 dB, peak-limited), the
`medium` folder -29.7 LUFS (+7.8 dB), and `kinda-loud` -21.5 LUFS (+3.5 dB).

## How it works

1. **Measurement** (`src/loudness.js`): K-weighting (high shelf + 38 Hz RLB high
   pass) at the actual sample rate, 400 ms gating blocks with a 100 ms hop,
   absolute -70 LUFS and relative -10 dB gates. Peak is sample peak. This is
   BS.1770-4 / EBU R128, not ReplayGain 1.0's 95th-percentile filter; the result
   is directly comparable to the LUFS numbers streaming services quote.
2. **Rendering** (`src/loudness-analysis.js`, in `src/loudness-worker.js`): a
   second wasm core in a worker loads the song through the real player classes
   and runs `processAudio` in a tight loop. No audio context, so it runs as fast
   as the CPU allows (roughly 60-90x real time for GME, 300x for libxmp, 16x for
   V2M). It is the same code path the audio callback uses, including duration
   fades and subtune handling.
3. **Gain**: `gainDb = target - measuredLufs`, then clamped so
   `peakDb + gainDb <= -1 dBFS`, and bounded to [-24, +24] dB. This prevents
   clipping without a limiter and turns already-hot engines (V2M) down.
4. **Cache** (`src/loudness-cache.js`): IndexedDB keyed by filepath; the value
   includes the byte length, so a changed file is rescanned. A cached track is
   applied on the first frame of the next play, including after a reload.
5. **Modes** (`src/ReplayGain.js`): `off`, `per song`, and `per folder (album)`.
   Album mode scans the folder's siblings in the worker and applies one gain to
   all of them, preserving the album's internal dynamics. Folders over 40 files
   are treated as collections, not albums, and use song gain. In album mode the
   current track's gain is applied while the rest of the folder is measured, then
   the album gain takes over.
6. **UI** (`Settings`): Off / Per song / Per folder, target Quiet (-23), Balanced
   (-18) or Loud (-14), plus the current gain. Defaults: Per song, Balanced.

The app's existing gain node multiplies the user's volume by the normalization
linear factor, so the slider still works and still tops out at 150%.

## Known limits and next steps

- **Peak-limited tracks stop short of the target.** A static gain cannot raise a
  track whose peak is already close to full scale. A look-ahead limiter (or a
  soft clipper) after the gain node would allow the Loud target to actually
  reach -14 on those tracks. Not done here because it changes the sound, not just
  the level, and needs a listening test to choose the threshold/attack.
- **First play is at unity gain for a second or two** while the worker scans.
  Subsequent plays are instant from cache. A partial live estimate could remove
  the gap, but would be a second measurement path.
- **MIDI's first scan downloads the SoundFont** into the worker's filesystem
  (the main player has its own filesystem), so the first MIDI scan can take
  much longer than the track. Later MIDI scans reuse the worker's copy.
- **Long/slow engines are capped** at 20 seconds of wall time and marked
  `partial`; the part that was rendered is still measured. The N64 and SID
  fixtures hit this, so their numbers are approximate.
- **Album scans fetch every sibling.** A cold 4-track folder took about 12 s in
  this tree; the progress is visible in Settings and the worker is cancellable
  when the user changes song.
- **No server precompute.** A catalog-wide scan would take hours (9.5k files at
  roughly 1-3 s each), so measurement is on demand and cached per browser.
- **The four missing sample links** were 403 from this network
  (`9AR51lDC`, `NWA8rHky`, `xqUWlAHK`, `MCRZHzfs`). Add the files under
  `catalog/replaygain-samples/loud/` and the harness picks them up.

## Verify

```sh
./dev/run-tests.sh                 # dev/test-replaygain.js asserts the numbers above
./dev/overlay.sh replaygain dev    # then play a sample with normalization on/off
```

The harness skips the engine measurements when the tree has only the silent stub
core or no sample folder; the gain/meter maths still run.
