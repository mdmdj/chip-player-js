/**
 * ReplayGain manager.
 *
 * Owns the scan worker and the per-song / per-folder measurements, and tells the
 * app what linear gain to apply. The audio graph stays simple: the app multiplies
 * the user's volume by `linear` on its existing gain node.
 *
 * Two modes:
 *   song  - static gain from the track's integrated loudness.
 *   album - static gain from the duration-weighted loudness of every track in the
 *           same folder, so an album keeps its internal dynamics.
 * Off leaves the output exactly as it was.
 */
import {
  albumFromTracks,
  gainFromMeasurement,
} from './loudness';
import {
  getCachedTrack,
  putCachedTrack,
} from './loudness-cache';

const DEFAULT_TARGET_LUFS = -18;
const MAX_ALBUM_TRACKS = 40;

function byteLengthOf(buffer) {
  if (!buffer) return 0;
  return buffer.byteLength !== undefined ? buffer.byteLength : buffer.length;
}

function copyForTransfer(buffer) {
  if (buffer instanceof Uint8Array) {
    return buffer.slice().buffer;
  }
  if (buffer instanceof ArrayBuffer) {
    return buffer.slice(0);
  }
  return new Uint8Array(buffer).slice().buffer;
}

export default class ReplayGain {
  constructor({ sampleRate, getSettings, onChange, fetchBuffer }) {
    this.sampleRate = sampleRate;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.fetchBuffer = fetchBuffer;

    this.worker = null;
    this.nextJobId = 1;
    this.pendingJobs = new Map();
    this.scanToken = 0;

    this.song = null;
    this.trackMeasurement = null;
    this.albumMeasurement = null;
    this.albumProgress = null;

    this.trackCache = new Map(); // filepath -> measurement (including byteLength)
    this.lastEmitted = null;
  }

  get mode() {
    return this.getSettings()?.volumeNormalization || 'song';
  }

  get targetLufs() {
    const value = Number(this.getSettings()?.normalizationTarget);
    return Number.isFinite(value) ? value : DEFAULT_TARGET_LUFS;
  }

  /** Called when the user changes a normalization setting. */
  refresh() {
    if (!this.song) {
      this.applyCurrentGain();
      return;
    }
    if (this.mode === 'off') {
      this.scanToken++; // stop applying late results to a now-off setting
      this.cancelPending();
      this.applyCurrentGain();
      return;
    }
    if (this.mode === 'song' && this.trackMeasurement) {
      this.applyCurrentGain();
    } else if (this.mode === 'album' && this.albumMeasurement) {
      this.applyCurrentGain();
    } else {
      this.startSong(this.song);
    }
  }

  clear() {
    this.scanToken++;
    this.cancelPending();
    this.song = null;
    this.trackMeasurement = null;
    this.albumMeasurement = null;
    this.albumProgress = null;
    this.emit({ gainDb: 0, linear: 1, source: 'off' });
  }

  cancelPending() {
    if (!this.worker) return;
    for (const [id, job] of this.pendingJobs) {
      this.worker.postMessage({ type: 'cancel', id });
      const error = new Error('cancelled');
      error.cancelled = true;
      job.reject(error);
    }
    this.pendingJobs.clear();
  }

  /**
   * @param {object} song
   * @param {string} song.filepath
   * @param {ArrayBuffer|Uint8Array} song.buffer
   * @param {number} [song.subtune]
   * @param {string[]} [song.albumPaths] - sibling paths in the same folder
   */
  setSong(song) {
    this.song = song;
    this.trackMeasurement = null;
    this.albumMeasurement = null;
    this.albumProgress = null;
    this.startSong(song);
  }

  async startSong(song) {
    // A new song outranks any album siblings still queued for the previous one.
    this.cancelPending();
    const token = ++this.scanToken;
    if (this.mode === 'off') {
      this.emit({ gainDb: 0, linear: 1, source: 'off' });
      return;
    }

    // A cached track can be applied before any work is scheduled. This is what
    // makes the second play of a song (and every play after a reload) seamless.
    const cached = await this.cachedFor(song.filepath, byteLengthOf(song.buffer));
    if (token !== this.scanToken) return;
    if (cached) {
      this.trackMeasurement = cached;
      this.applyCurrentGain();
    } else {
      this.emit({ gainDb: 0, linear: 1, source: 'pending' });
    }

    const track = cached || await this.scanTrack(song.filepath, song.buffer, song.subtune || 0);
    if (token !== this.scanToken) return;
    if (!track || track.silent) {
      this.trackMeasurement = track || null;
      this.applyCurrentGain();
      return;
    }
    this.trackMeasurement = track;
    this.applyCurrentGain();

    if (this.mode === 'album') {
      await this.scanAlbum(token, song);
    }
  }

  async cachedFor(filepath, byteLength) {
    const memory = this.trackCache.get(filepath);
    if (memory) {
      if (!byteLength || memory.byteLength === byteLength) return memory;
      return null;
    }
    const cached = await getCachedTrack(filepath);
    if (!cached) return null;
    if (byteLength && cached.byteLength !== byteLength) return null;
    this.trackCache.set(filepath, cached);
    return cached;
  }

  async scanTrack(filepath, buffer, subtune = 0) {
    const byteLength = byteLengthOf(buffer);
    try {
      const measurement = await this.requestAnalysis(filepath, buffer, subtune);
      const value = {
        ...measurement,
        path: filepath,
        byteLength,
        analyzedAt: Date.now(),
      };
      this.trackCache.set(filepath, value);
      putCachedTrack(filepath, value);
      return value;
    } catch (e) {
      if (!(e && e.cancelled)) {
        console.warn(`ReplayGain: could not analyze ${filepath}:`, e.message || e);
      }
      return null;
    }
  }

  async scanAlbum(token, song) {
    const paths = Array.isArray(song.albumPaths) ? song.albumPaths : [];
    if (paths.length < 2 || paths.length > MAX_ALBUM_TRACKS) {
      // Not an album-shaped folder, or too large for a meaningful album gain.
      return;
    }

    const measurements = new Map();
    if (this.trackMeasurement) measurements.set(song.filepath, this.trackMeasurement);

    for (const filepath of paths) {
      if (token !== this.scanToken || this.mode !== 'album') return;
      if (measurements.has(filepath)) continue;

      let measurement = this.trackCache.get(filepath) || await getCachedTrack(filepath);
      if (token !== this.scanToken || this.mode !== 'album') return;

      if (!measurement && this.fetchBuffer) {
        try {
          const buffer = await this.fetchBuffer(filepath);
          if (token !== this.scanToken || this.mode !== 'album') return;
          if (buffer) measurement = await this.scanTrack(filepath, buffer, 0);
        } catch (e) {
          if (!(e && e.cancelled)) {
            console.debug(`ReplayGain: no album scan for ${filepath}:`, e.message || e);
          }
        }
      }

      if (measurement) measurements.set(filepath, measurement);
      this.albumProgress = { analyzed: measurements.size, total: paths.length };
      this.applyCurrentGain();
    }

    if (token !== this.scanToken || this.mode !== 'album') return;
    const album = albumFromTracks([...measurements.values()]);
    if (!album) return;
    this.albumMeasurement = {
      ...album,
      path: song.filepath,
      byteLength: 0,
    };
    this.applyCurrentGain();
  }

  applyCurrentGain() {
    const mode = this.mode;
    if (mode === 'off') {
      this.emit({ gainDb: 0, linear: 1, source: 'off' });
      return;
    }

    const measurement = mode === 'album'
      ? (this.albumMeasurement || this.trackMeasurement)
      : this.trackMeasurement;

    if (!measurement || measurement.silent) {
      this.emit({ gainDb: 0, linear: 1, source: 'pending' });
      return;
    }

    const gain = gainFromMeasurement(measurement, this.targetLufs);
    this.emit({
      ...gain,
      lufs: measurement.lufs,
      peakDb: measurement.peakDb,
      source: mode === 'album' && this.albumMeasurement ? 'album' : 'song',
      albumAnalyzed: this.albumProgress?.analyzed,
      albumTotal: this.albumProgress?.total,
    });
  }

  emit(result) {
    const key = `${result.source}|${result.gainDb.toFixed(2)}|${result.albumAnalyzed || ''}|${result.albumTotal || ''}`;
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.onChange(result);
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./loudness-worker.js', import.meta.url));
    worker.onmessage = (event) => {
      const message = event.data;
      if (!message) return;
      const job = this.pendingJobs.get(message.id);
      if (!job) return;
      this.pendingJobs.delete(message.id);
      if (message.type === 'result') {
        job.resolve(message.measurement);
      } else if (message.type === 'cancelled') {
        const error = new Error('cancelled');
        error.cancelled = true;
        job.reject(error);
      } else {
        job.reject(new Error(message.message || 'Loudness scan failed'));
      }
    };
    worker.onerror = (event) => {
      console.warn('ReplayGain worker error:', event.message || event);
      for (const job of this.pendingJobs.values()) {
        job.reject(new Error(event.message || 'Loudness worker error'));
      }
      this.pendingJobs.clear();
      this.worker = null;
    };
    worker.postMessage({ type: 'init', sampleRate: this.sampleRate });
    this.worker = worker;
    return worker;
  }

  requestAnalysis(filepath, buffer, subtune = 0) {
    const worker = this.ensureWorker();
    const id = this.nextJobId++;
    const copy = copyForTransfer(buffer);
    return new Promise((resolve, reject) => {
      this.pendingJobs.set(id, { resolve, reject });
      worker.postMessage({ type: 'analyze', id, filepath, buffer: copy, subtune }, [copy]);
    });
  }
}
