import Player from "./Player.js";
import { ensureEmscFileWithData, ensureEmscFileWithUrl, pathJoin } from '../util';
import { CATALOG_PREFIX } from '../config';
import pathe from 'pathe';
import autoBind from 'auto-bind';
import chipImage from '../images/chip.png';

const fileExtensions = [
  'mdx',
];
const MOUNTPOINT = '/mdx';
const INT16_MAX = Math.pow(2, 16) - 1;
// MDX songs with an infinite loop play this many times before fading out.
// Two passes matches libvgm's default and the app's loop model (see
// Player.getLoopBandMs), so MDX gets the same slider band and head fold.
const DEFAULT_LOOP_COUNT = 2;

export default class MDXPlayer extends Player {
  constructor(...args) {
    super(...args);
    autoBind(this);

    // Initialize MDX filesystem
    this.core.FS.mkdirTree(MOUNTPOINT);
    this.core.FS.mount(this.core.FS.filesystems.IDBFS, {}, MOUNTPOINT);

    this.playerKey = 'mdx';
    this.name = 'Sharp X68000 MDX Player';
    this.speed = 1;
    this._durationMs = 0;
    this._maxLoopCount = DEFAULT_LOOP_COUNT;
    this.durationExtended = false; // repeat-one left after passing the fade
    this.mdxCtx = this.core._mdx_create_context();
    this.core._mdx_set_rate(this.sampleRate);
    this.core._mdx_set_dir(this.mdxCtx, MOUNTPOINT);
    this.fileExtensions = fileExtensions;
    this.buffer = this.core._malloc(this.bufferSize * 4); // 2 ch, 16-bit
  }

  loadData(data, filename, persistedSettings) {
    // MDXPlayer reads song data from the Emscripten filesystem,
    // rather than loading bytes from memory like other players.
    let err;
    this.filepathMeta = Player.metadataFromFilepath(filename);
    const dir = pathe.dirname(filename);
    const mdxFilename = pathJoin(MOUNTPOINT, filename);
    // First, write PDX sample files into Emscripten filesystem.
    return ensureEmscFileWithData(this.core, mdxFilename, data)
      .then(() => {
        const pdx = this.core.ccall(
          'mdx_get_pdx_filename', 'string',
          ['number', 'string'],
          [this.mdxCtx, mdxFilename],
        );
        if (pdx) {
          const pdxFilename = pathJoin(MOUNTPOINT, dir, pdx);
          // Force upper case in the URL, as the entire MDX archive is upper case.
          // MDX files were authored on old case-insensitive filesystems, but
          // the music server filesystem (and URLs in general) are case-sensitive.
          const pdxUrl = pathJoin(CATALOG_PREFIX, dir, pdx.toUpperCase());
          // Write MDX file into Emscripten filesystem.
          return ensureEmscFileWithUrl(this.core, pdxFilename, pdxUrl);
        }
      })
      .then(() => {
        this.muteAudioDuringCall(this.audioNode, () => {
          err = this.core.ccall(
            'mdx_open', 'number',
            ['number', 'string', 'string'],
            [this.mdxCtx, mdxFilename, null],
          );

          if (err !== 0) {
            console.error("mdx_load_file failed. error code: %d", err);
            throw Error('mdx_load_file failed');
          }

          // Metadata
          const ptr = this.core._malloc(256);
          this.core._mdx_get_title(this.mdxCtx, ptr);
          const buf = this.core.HEAPU8.subarray(ptr, ptr + 256);
          const len = buf.indexOf(0);
          const title = new TextDecoder("shift-jis").decode(buf.subarray(0, len));
          this.metadata = { title: title || pathe.basename(filename) };
          this._readLoopRegion();
          this.applyLoopCount(false);

          this.resolveParamValues(persistedSettings);
          this.setTempo(persistedSettings.tempo || 1);
          this.resume();
          this.emit('playerStateUpdate', {
            ...this.getBasePlayerState(),
            isStopped: false,
          });
        });
      });
  }

  // Measure the song's built-in loop region once, at load. _mdx_get_length
  // re-parses the song and resets the track work area to the start, so it must
  // only run here (never while playing -- callers poll getDurationMs every
  // 100 ms tick, and re-reading it would rewind the engine each tick). Passing
  // max_loop=2 also makes the engine record where its infinite loop completes
  // each pass: length(k) = intro + k * loop + fade, so two recorded loop points
  // give the exact loop length and, since the fade is a constant offset, the
  // intro as well (no fade guessing). Engines without the loop API fall back to
  // a plain duration and no band.
  _readLoopRegion() {
    const core = this.core;
    this.durationExtended = false;
    this._maxLoopCount = DEFAULT_LOOP_COUNT;
    if (typeof core._mdx_set_max_loop === 'function') {
      core._mdx_set_max_loop(this.mdxCtx, DEFAULT_LOOP_COUNT);
    }
    this._durationMs = core._mdx_get_length(this.mdxCtx) * 1000;
    if (typeof core._mdx_get_loop_start_ms === 'function' &&
        typeof core._mdx_get_loop_length_ms === 'function') {
      const introMs = core._mdx_get_loop_start_ms(this.mdxCtx);
      const loopMs = core._mdx_get_loop_length_ms(this.mdxCtx);
      if (loopMs > 0) {
        // The shared intro_length/loop_length vocabulary maps MDX onto the
        // generic loop hooks, exactly as VGMPlayer does for libvgm.
        this.metadata.intro_length = introMs;
        this.metadata.loop_length = loopMs;
      }
    }
  }

  processAudioInner(channels) {
    let i, ch;

    if (this.paused) {
      for (ch = 0; ch < channels.length; ch++) {
        channels[ch].fill(0);
      }
      return;
    }

    const next = this.core._mdx_calc_sample(this.mdxCtx, this.buffer, this.bufferSize);
    if (next === 0) {
      this.handleSongEnd();
      return;
    }

    for (ch = 0; ch < channels.length; ch++) {
      for (i = 0; i < this.bufferSize; i++) {
        channels[ch][i] = this.core.getValue(
          this.buffer +           // Interleaved channel format
          i * 2 * 2 +             // frame offset   * bytes per sample * num channels +
          ch * 2,                 // channel offset * bytes per sample
          'i16'                   // the sample values are signed 16-bit integers
        ) / INT16_MAX;
      }
    }
  }

  getTempo() {
    return this.speed;
  }

  setTempo(val) {
    this.speed = val;
    return this.core._mdx_set_speed(this.mdxCtx, val);
  }

  getPositionMs() {
    return this.core._mdx_get_position_ms(this.mdxCtx);
  }

  // Repeat One loops MDX natively: the engine's own infinite loop, with the
  // loop-count limit disabled (0 = forever) so the region repeats seamlessly
  // instead of fading after N passes. Leaving Repeat One restores a finite
  // count so the current pass finishes and the engine fades, like libvgm.
  setLooping(looping) {
    const wasLooping = this.looping;
    super.setLooping(looping);
    // The engine loops natively; the base "late repeat" seek would fight it.
    this.restartAtEndPending = false;
    this.applyLoopCount(wasLooping);
  }

  // Loop count to hand the engine for the current state: 0 forever while
  // repeating, otherwise finish the in-progress pass and fade. Only re-derive
  // when actually leaving a looping state; a no-op toggle must not push the
  // fade boundary past a fade that is already scheduled.
  applyLoopCount(wasLooping) {
    if (!this.mdxCtx || typeof this.core._mdx_set_max_loop !== 'function') return;
    const hasLoop = this.metadata && this.metadata.loop_length > 0;
    if (this.looping) {
      this._maxLoopCount = 0;
    } else if (wasLooping && hasLoop) {
      const curLoop = this.getCurLoop();
      this._maxLoopCount = Math.max(DEFAULT_LOOP_COUNT, curLoop + 1);
      // Leaving after passing the default fade: the position is already past
      // the reported duration, so the base end detector must stand down and let
      // the engine's fade end the song (the display runs its tail from here).
      if (curLoop >= DEFAULT_LOOP_COUNT) this.durationExtended = true;
    } else {
      this._maxLoopCount = DEFAULT_LOOP_COUNT;
    }
    this.core._mdx_set_max_loop(this.mdxCtx, this._maxLoopCount);
  }

  // Which pass of the built-in loop we are in (0 during the intro/first pass).
  getCurLoop() {
    const meta = this.metadata;
    const intro = meta ? meta.intro_length : -1;
    const loop = meta ? meta.loop_length : 0;
    if (!(loop > 0) || !(intro >= 0)) return 0;
    return Math.max(0, Math.floor((this.getPositionMs() - intro) / loop));
  }

  // Same playlist-position model as VGMPlayer: the head cycles inside the
  // highlighted band (the last non-fade pass) while repeating, and runs the
  // fade tail from the band end once the fade starts, so toggling Repeat One
  // never makes the head jump.
  getDisplayPositionMs() {
    const abs = this.getPositionMs();
    const meta = this.metadata;
    const intro = meta ? meta.intro_length : -1;
    const loop = meta ? meta.loop_length : 0;
    if (!(intro >= 0) || !(loop > 0) || abs == null) return abs;

    const band = this.getLoopBandMs();
    if (!band) return abs;
    const bandStart = band.startMs;
    const bandEnd = band.endMs;
    if (abs <= bandStart) return abs;

    const fadeStartMs = this.looping ? null : (intro + this._maxLoopCount * loop);
    if (fadeStartMs != null && abs >= fadeStartMs) {
      return Math.min(bandEnd + (abs - fadeStartMs), this.getDurationMs());
    }

    if (abs < bandEnd) return abs;
    const phase = ((abs - intro) % loop + loop) % loop;
    return bandStart + phase;
  }

  isPlayingIndefinitely() {
    return this.looping || !!this.durationExtended;
  }

  getDurationMs() {
    return this._durationMs;
  }

  getMetadata() {
    return this.metadata;
  }

  isPlaying() {
    return !this.isPaused();
  }

  getVoiceName(index) {
    if (this.mdxCtx) return this.core.UTF8ToString(this.core._mdx_get_track_name(this.mdxCtx, index));
  }

  getVoiceGroups() {
    if (!this.mdxCtx) return [];
    const voiceGroups = [];
    const numVoices = this.core._mdx_get_tracks(this.mdxCtx);
    let currGroup;
    for (let i = 0; i < numVoices; i++) {
      const voiceName = this.core.UTF8ToString(this.core._mdx_get_track_name(this.mdxCtx, i));
      if (i === 0) {
        currGroup = {
          name: 'YM2151 (OPM)',
          icon: chipImage,
          voices: [],
        };
        voiceGroups.push(currGroup);
      }
      if (i === 8) {
        currGroup = {
          name: numVoices === 9 ? 'OKI MSM6258' : 'Mercury Unit (PCM8)',
          icon: chipImage,
          voices: [],
        };
        voiceGroups.push(currGroup);
      }
      currGroup.voices.push({
        idx: i,
        name: voiceName,
      });
    }
    return voiceGroups;
  }

  getVoiceMask() {
    const voiceMask = [];
    const mask = this.core._mdx_get_track_mask(this.mdxCtx);
    for (let i = 0; i < this.core._mdx_get_tracks(this.mdxCtx); i++) {
      voiceMask.push(((mask >> i) & 1) === 0);
    }
    return voiceMask;
  }

  setVoiceMask(voiceMask) {
    let mask = 0;
    voiceMask.forEach((isEnabled, i) => {
      if (!isEnabled) {
        mask += 1 << i;
      }
    });
    if (this.mdxCtx) this.core._mdx_set_track_mask(this.mdxCtx, mask);
  }

  seekMs(seekMs) {
    this.muteAudioDuringCall(this.audioNode, () =>
      this.core._mdx_set_position_ms(this.mdxCtx, seekMs)
    );
  }

  stop() {
    this.suspend();
    this.core._mdx_close(this.mdxCtx);
    console.debug('MDXPlayer.stop()');
    this.emit('playerStateUpdate', { isStopped: true });
  }
}
