import axios from 'redaxios';
import autoBind from 'auto-bind';
import pathe from 'pathe';
import React from 'react'; // For the icon in the detectSongEnd label

import Player from "./Player.js";
import EndDetector, { DETECT_SONG_END_HINT } from './EndDetector.js';
import { vectorToArray } from '../util';
import { API_BASE } from '../config';

const fileExtensions = [
  'sid', 'mus'
];

const DEFAULT_SONG_LENGTH_MS = 2.5 * 60 * 1000;

// Convert song length to milliseconds. Each song length is of format:
// mm:ss[.SSS]
function parseSongLength(length) {
  const parts = length.split(':');
  return Math.floor((parseFloat(parts[0]) * 60 + parseFloat(parts[1])) * 1000);
}

export default class SIDPlayer extends Player {
  paramDefs = [
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

    this.playerKey = 'sid';
    this.name = 'SID Player';
    this.speed = 1;
    // Bumped per load. getSidMetadata() below is a network fetch, so a slower
    // older load can resume after a newer selection has already started and
    // would otherwise reset the shared core to its own sub-tune and resume it.
    this.loadGeneration = 0;
    this.fileExtensions = fileExtensions;
    this.bufferL = this.core._malloc(this.bufferSize * 4);
    this.bufferR = this.core._malloc(this.bufferSize * 4);
    this.subtuneDurations = [];
    this.initialized = false;
    this.endDetector = new EndDetector({
      sampleRate: this.sampleRate,
      bufferSize: this.bufferSize,
    });
  }

  resetEndDetector() {
    this.endDetector.reset();
  }

  // Start of the end-detection trip window, one window before the expected
  // end. Cached per sub-tune: the duration only changes on load/sub-tune
  // switches, which both reset the detector.
  getEndDetectTripAtMs() {
    return this.endDetector.getTripAtMs(this.getDurationMs());
  }

  setParameter(id, value) {
    if (id === 'detectSongEnd') {
      this.params[id] = !!value;
      this.resetEndDetector();
      return;
    }
    super.setParameter(id, value);
  }

  getSidMetadata(md5) {
    console.log("SIDPlayer: Fetching metadata for SID:", md5);
    const metadataUrl = `${API_BASE}/hvsc?sidHash=${md5}`;

    // Resolves with real durations/names, or with defaults on 404/failure.
    // Never rejects: metadata must not break playback (playSongBuffer treats
    // a loadData rejection as an unplayable song).
    return axios.get(metadataUrl, {
      validateStatus: status => status === 404 || (status >= 200 && status < 300)
    }).then(response => {
      if (response.status === 404) return;
      console.log('SIDPlayer: Got metadata for SID:', response.data);
      const { lengths, name, author, copyright, image_url } = response.data;
      this.subtuneDurations = lengths.split(' ').map(parseSongLength);
      this.metadata = {
        imageUrl: image_url,
        formatted: {
          title: name,
          subtitle: `${author} - ${copyright}`,
        },
      };
    }).catch(e => {
      console.warn('SIDPlayer: HVSC metadata unavailable, using defaults.', e?.message);
    });
  }

  async loadData(data, filepath, persistedSettings, subtune = 0) {
    // Claim this load. Anything still awaiting below checks it before touching
    // the shared core, so a superseded load cannot restart the previous song.
    const generation = ++this.loadGeneration;
    if (!this.initialized) {
      this.core._sid_init(this.sampleRate);
      this.initialized = true;
    }

    const dataPtr = this.copyToHeap(data);
    const err = this.core._sid_load_data(dataPtr, data.byteLength);
    this.core._free(dataPtr);
    this.subtuneDurations = Array(this.getNumSubtunes()).fill(DEFAULT_SONG_LENGTH_MS);
    this.resetEndDetector();

    if (err !== 0) {
      throw Error('Unable to load this file!');
    }

    this.metadata = { title: pathe.basename(filepath) };

    // Resolve HVSC lengths/names before the first state emit, so duration
    // and titles arrive together (no default-then-real flicker). Audio
    // starts right after, delayed only by this fetch.
    const ptr = this.core._sid_get_song_md5();
    const md5 = this.core.UTF8ToString(ptr);
    await this.getSidMetadata(md5);
    // A newer load took over while we fetched; it owns the core and the state
    // emit now, so stop here rather than resuming this song over the top of it.
    if (generation !== this.loadGeneration) return;

    this.mask = Array(18).fill(true);
    this.core._sid_set_voice_mask(0);
    // Start on the requested sub-tune (each sub-tune is its own SongRef).
    this.playSubtune(subtune);
    this.resolveParamValues(persistedSettings);
    this.setTempo(persistedSettings.tempo || 1);
    this.resume();
    this.emit('playerStateUpdate', {
      ...this.getBasePlayerState(),
      isStopped: false
    });
  }

  processAudioInner(channels) {
    if (this.paused) {
      channels[0].fill(0);
      channels[1].fill(0);
      this.resetEndDetector();
      return;
    }

    if (this.lastHeapBuffer !== this.core.HEAPU8.buffer) {
      console.debug('SIDPlayer: Detected HEAPU8 buffer change, updating views.');
      this.wasmViewL = new Float32Array(this.core.HEAPU8.buffer, this.bufferL, this.bufferSize);
      this.wasmViewR = new Float32Array(this.core.HEAPU8.buffer, this.bufferR, this.bufferSize);
      this.lastHeapBuffer = this.core.HEAPU8.buffer;
    }

    let samplesWritten = this.core._sid_render(this.bufferL, this.bufferR, this.bufferSize);
    // Repeat One behaves like indefinite playback: the driver loops
    // internally and the HVSC length is just metadata, so keep rendering past
    // it. The tail detector below decides when an ending tail gets restarted.
    if (samplesWritten === 0 ||
        (!this.isPlayingIndefinitely() && this.getPositionMs() > this.subtuneDurations[this.getSubtune()])) {
      this.handleSongEnd();
      return;
    }

    // Tail-end restart, Repeat One only: a tail that goes quiet AND static
    // for a full window is an ending, so re-run the sub-tune from the top
    // (stop + load re-runs the init routine, like GME's restartTrack). The
    // position gate comes first, so the per-buffer tap only runs once the
    // trip window opens one window before the expected end -- the listed
    // length is approximate, so the detector may conclude slightly early
    // (fade-outs). Anything earlier stays gated, keeping quiet intros and
    // breakdowns mid-song from ever tripping it. Repeat-off keeps the HVSC
    // behavior above, unchanged.
    // Caveat: tunes shorter than the window trip nearly ungated; a quiet
    // static intro there could restart early. Rare, and the toggle covers it.
    if (this.params.detectSongEnd && this.isPlayingIndefinitely() &&
        this.getPositionMs() >= this.getEndDetectTripAtMs() && this.updateEndDetector()) {
      this.playSubtune(this.getSubtune());
      samplesWritten = this.core._sid_render(this.bufferL, this.bufferR, this.bufferSize);
      if (samplesWritten === 0) {
        this.handleSongEnd();
        return;
      }
    }

    channels[0].set(this.wasmViewL);
    channels[1].set(this.wasmViewR);
  }

  // Fold one rendered buffer into the tail detector. Muted voices fake both
  // gates, so stand down while the mask is not clean -- the JS echo of GME
  // disabling its own silence detection on any mute.
  updateEndDetector() {
    if (!Array.isArray(this.mask) || !this.mask.every(Boolean)) {
      this.endDetector.reset();
      return false;
    }
    return this.endDetector.fold(this.wasmViewL, this.wasmViewR);
  }

  getNumSubtunes() {
    return this.core._sid_get_num_subtunes();
  }

  getSubtune() {
    return this.core._sid_get_subtune();
  }

  playSubtune(subtune) {
    this.silenceSamplesRemaining = 0;
    this.onSilenceEnd = null;
    this.resetEndDetector();
    this.core._sid_set_subtune(subtune);
  }

  getTempo() {
    return this.speed;
  }

  setTempo(val) {
    this.core._sid_set_speed(val);
    this.speed = val;
  }

  getPositionMs() {
    return this.core._sid_get_position_ms();
  }

  getDurationMs() {
    return this.subtuneDurations[this.getSubtune()];
  }

  getMetadata() {
    return this.metadata;
  }

  isPlaying() {
    return !this.isPaused();
  }

  getVoiceGroups() {
    return vectorToArray(this.core.sidGetVoiceGroups()).map((group, g) => ({
      icon: true,
      name: group.groupName,
      voices: vectorToArray(group.voiceNames).map((name, v) => ({ name, idx: g*3+v })),
    }));
  }

  getVoiceMask() {
    return this.mask;
  }

  setVoiceMask(mask) {
    this.mask = mask;

    let bitmask = 0;
    mask.forEach((b, i) => {
      if (!b) bitmask |= (1 << i);
    });

    this.core._sid_set_voice_mask(bitmask);
  }

  seekMs(seekMs) {
    this.muteAudioDuringCall(this.audioNode, () => this.core._sid_set_position_ms(seekMs));
  }

  stop() {
    this.suspend();
    this.core._sid_stop();
    console.debug('SIDPlayer.stop()');
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
