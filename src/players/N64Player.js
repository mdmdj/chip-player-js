import Player from "./Player.js";
import EndDetector, { DETECT_SONG_END_HINT } from './EndDetector.js';
import { ensureEmscFileWithData, ensureEmscFileWithUrl, pathJoin } from '../util';
import { CATALOG_PREFIX } from '../config';
import pathe from 'pathe';
import autoBind from 'auto-bind';
import React from 'react'; // For the icon in the detectSongEnd label

const fileExtensions = [
  'miniusf',
];
const MOUNTPOINT = '/n64';
const INT16_MAX = 32767; // 2^15 - 1
// N64 seek renders every sample up to the target on the main thread, so do it
// in idle-time chunks (like GMEPlayer) instead of one long freeze.
const SEEK_INCREMENT_MS = 1000;

// Tail-end detector tuning, mirroring SIDPlayer: music bodies run 0.03-0.16
// (mean-abs per second) while ended tails sit at or below ~0.001, so the
// level gate separates them by 6x or more and the stillness gate (frozen
// second-means) suppresses quiet-but-alive passages. N64 output is normalized
// the same way (int16 full-scale), but the levels have not been verified on
// USF content -- quiet game mixes are the case to watch. Window mirrors GME's
// 6s silence rule.
const END_QUIET_MEAN = 0.004;
const END_STATIC_RANGE = 0.001;
const END_WINDOW_SEC = 6;
const END_TAP_STEP = 7;

export default class N64Player extends Player {
  paramDefs = [
    {
      id: 'indefinitePlayback',
      label: 'Indefinite Playback',
      type: 'toggle',
      hint: 'Ignore track length metadata for looping tracks and loop indefinitely.',
      defaultValue: false,
    },
    {
      id: 'detectSongEnd',
      label: (<span>Detect Song End While <span className='inline-icon icon-repeat'/>One</span>),
      type: 'toggle',
      hint: DETECT_SONG_END_HINT,
      defaultValue: true,
    },
  ];

  constructor(...args) {
    super(...args);
    autoBind(this);

    // Initialize N64 filesystem
    this.core.FS.mkdirTree(MOUNTPOINT);
    this.core.FS.mount(this.core.FS.filesystems.IDBFS, {}, MOUNTPOINT);

    this.playerKey = 'n64';
    this.name = 'N64 Player';
    this.fileExtensions = fileExtensions;
    this.buffer = this.core._malloc(this.bufferSize * 4); // 2 ch, 16-bit
    this.seekRequestId = null;
    this.seekTargetMs = null;
    this.resetEndDetector();
    // DEV-BEGIN (stripped for promotion; route the end detector through the
    // live dev tuning store; production calls the methods directly)
    this.endTuning = null;
    const baseUpdateEndDetector = this.updateEndDetector;
    const baseEndDetectTripAtMs = this.getEndDetectTripAtMs;
    this.updateEndDetector = (channels) => baseUpdateEndDetector(channels, this.endTuning);
    this.getEndDetectTripAtMs = () => baseEndDetectTripAtMs(this.endTuning);
    // DEV-END
  }

  resetEndDetector() {
    this.endSecMeans = [];
    this.endSecSum = 0;
    this.endSecFrames = 0;
    this.endDetectTripAtMs = null;
  }

  // Start of the end-detection trip window, cached per track: durations only
  // change on load, which resets the detector, so there is no per-callback
  // lookup.
  getEndDetectTripAtMs(tuning = null) {
    const windowSec = tuning?.windowSec ?? END_WINDOW_SEC;
    if (this.endDetectTripAtMs == null) {
      this.endDetectTripAtMs = Math.max(0, (this.getDurationMs() || 0) - windowSec * 1000);
    }
    return this.endDetectTripAtMs;
  }

  loadData(data, filename, persistedSettings) {
    // N64Player reads song data from the Emscripten filesystem,
    // rather than loading bytes from memory like other players.
    cancelIdleCallback(this.seekRequestId);
    this.seekTargetMs = null;
    this.resetEndDetector();
    let err;
    this.filepathMeta = Player.metadataFromFilepath(filename);

    const decoder = new TextDecoder('latin1');
    const miniusfStr = decoder.decode(data);
    const usflibs = miniusfStr.match(/_lib=([^\n]+)/).slice(1);
    if (usflibs.length === 0) {
      throw new Error(`No .usflib references found`);
    }

    const dir = pathe.dirname(filename);
    const fsFilename = pathJoin(MOUNTPOINT, filename);
    const filePromises = [
      ensureEmscFileWithData(this.core, fsFilename, data),
      ...usflibs.map(usflib => {
        const fsUsflibFilename = pathJoin(MOUNTPOINT, dir, usflib);
        const url = pathJoin(CATALOG_PREFIX, dir, usflib);
        return ensureEmscFileWithUrl(this.core, fsUsflibFilename, url);
      }),
    ];

    return Promise.all(filePromises)
      .then(() => {
        err = this.core.ccall(
          'n64_load_file', 'number',
          ['string', 'number', 'number', 'number'],
          [fsFilename, this.buffer, this.bufferSize, this.sampleRate],
        );

        if (err !== 0) {
          console.error('n64_load_file failed. error code: %d', err);
          throw Error('n64_load_file failed');
        }

        this.resolveParamValues(persistedSettings);
        this.metadata = { title: pathe.basename(filename) };

        this.resume();
        this.emit('playerStateUpdate', {
          ...this.getBasePlayerState(),
          isStopped: false,
        });
      });
  }

  processAudioInner(channels) {
    if (this.paused) {
      for (let ch = 0; ch < channels.length; ch++) {
        channels[ch].fill(0);
      }
      this.resetEndDetector();
      return;
    }

    let samplesWritten = this.core._n64_render_audio(this.buffer, this.bufferSize);
    if (samplesWritten <= 0) {
      this.handleSongEnd();
      return;
    }
    this.writeChannels(channels);

    // Tail-end restart, Repeat One only (mirrors SIDPlayer): with indefinite
    // playback the engine free-runs past durationMs -- looping game code keeps
    // rendering, so the detector never trips -- but a one-shot whose content
    // has ended sits in silence forever. A tail that goes quiet AND static
    // for a full window is an ending, so re-run the tune from the top
    // in-buffer (no refetch, no gap). The position gate comes first, so the
    // per-buffer tap only runs once the trip window opens one window before
    // the expected end -- the length tag is approximate -- and anything
    // earlier stays gated, keeping quiet intros and breakdowns mid-song from
    // ever tripping it. Repeat-off keeps the engine fade-and-end behavior
    // above, unchanged.
    if (this.params.detectSongEnd && this.isPlayingIndefinitely() &&
        this.getPositionMs() >= this.getEndDetectTripAtMs() && this.updateEndDetector(channels)) {
      this.restartTrack();
      samplesWritten = this.core._n64_render_audio(this.buffer, this.bufferSize);
      if (samplesWritten <= 0) {
        this.handleSongEnd();
        return;
      }
      this.writeChannels(channels);
    }
  }

  writeChannels(channels) {
    for (let ch = 0; ch < channels.length; ch++) {
      for (let i = 0; i < this.bufferSize; i++) {
        channels[ch][i] = this.core.getValue(
          this.buffer +           // Interleaved channel format
          i * 2 * 2 +             // frame offset   * bytes per sample * num channels +
          ch * 2,                 // channel offset * bytes per sample
          'i16'                   // the sample values are signed 16-bit integers
        ) / INT16_MAX;
      }
    }
  }

  // Fold one rendered buffer into the tail detector. It taps the converted
  // float channels (the int16 buffer holds no float views, unlike SID). N64
  // exposes no voice mask, so there is nothing to gate on -- every voice the
  // emulator renders counts.
  updateEndDetector(channels) {
    return this.endDetector.fold(channels[0], channels[1] || channels[0]);
  }

  // DEV-BEGIN (stripped for promotion; live end-detector tuning for the
  // dev-only Settings section, its only caller. The constructor routes the
  // detector through the live store; production keeps the tuned constants.)
  setEndTuning(patch) {
    this.endTuning = patch ? { ...(this.endTuning || {}), ...patch } : null;
    this.resetEndDetector();
  }

  getEndTuning() {
    return {
      quietMean: this.endTuning?.quietMean ?? END_QUIET_MEAN,
      staticRange: this.endTuning?.staticRange ?? END_STATIC_RANGE,
      windowSec: this.endTuning?.windowSec ?? END_WINDOW_SEC,
      tapStep: this.endTuning?.tapStep ?? END_TAP_STEP,
    };
  }

  getEndDetectorState() {
    return {
      ...this.getEndTuning(),
      positionMs: this.getPositionMs(),
      tripAtMs: this.getEndDetectTripAtMs(),
      windowMeans: [...this.endSecMeans],
    };
  }
  // DEV-END

  // In-buffer restart for the Repeat One tail detector (like GME's
  // restartTrack): seek-to-0 re-runs the emulator from the top without
  // refetching the miniusf/usflib. Synchronous -- an in-flight idle-callback
  // seek is cancelled first so it cannot yank the position afterward.
  restartTrack() {
    cancelIdleCallback(this.seekRequestId);
    this.seekTargetMs = null;
    this.silenceSamplesRemaining = 0;
    this.onSilenceEnd = null;
    this.resetEndDetector();
    this.core._n64_seek_ms(0);
  }

  getPositionMs() {
    return this.core._n64_get_position_ms();
  }

  getDurationMs() {
    return this.core._n64_get_duration_ms();
  }

  getMetadata() {
    return this.metadata;
  }

  isPlaying() {
    return !this.isPaused();
  }

  seekMs(positionMs) {
    cancelIdleCallback(this.seekRequestId);
    this.seekTargetMs = positionMs;
    this.resetEndDetector();
    if (positionMs < this.getPositionMs()) {
      // Seeking backward restarts the tune; do that once up front.
      this.core._n64_seek_ms(0);
    }
    this.doIncrementalSeek(SEEK_INCREMENT_MS);
  }

  doIncrementalSeek(incrementMs) {
    this.seekRequestId = requestIdleCallback(() => {
      const intermediateMs = Math.min(this.getPositionMs() + incrementMs, this.seekTargetMs);
      this.core._n64_seek_ms(intermediateMs);
      if (intermediateMs < this.seekTargetMs) {
        this.doIncrementalSeek(incrementMs);
      } else {
        this.seekTargetMs = null;
        this.seekRequestId = null;
      }
    });
  }

  setParameter(id, value) {
    switch (id) {
      case 'indefinitePlayback':
        value = !!value;
        this.params[id] = value;
        this.syncIndefinitePlayback();
        break;
      case 'detectSongEnd':
        this.params[id] = !!value;
        this.resetEndDetector();
        break;
      default:
    }
  }

  setLooping(looping) {
    super.setLooping(looping);
    this.syncIndefinitePlayback();
  }

  // The engine flag is what actually holds the fade: Repeat One and the
  // Indefinite Playback setting both free-run past durationMs through it (the
  // wrapper still ends non-looping tracks itself, since it ANDs the flag with
  // song_loops). Keep it OR'd from both sources on every transition: Repeat
  // One alone not reaching the engine would fade-and-end each cycle and
  // reload the whole miniusf/usflib per loop.
  syncIndefinitePlayback() {
    this.core._n64_set_indefinite_playback(this.looping || !!this.params.indefinitePlayback);
  }

  // Repeat One and Indefinite Playback both free-run past durationMs via the
  // engine flag, so the base end detector must stay out of the way.
  isPlayingIndefinitely() {
    return this.looping || !!this.params.indefinitePlayback;
  }

  stop() {
    this.suspend();
    cancelIdleCallback(this.seekRequestId);
    this.seekTargetMs = null;
    this.core._n64_shutdown();
    console.debug('N64Player.stop()');
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
