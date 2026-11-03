/**
 * ReplayGain manager.
 *
 * Catalog tracks are measured by `scripts/analyze-loudness.js` and served from
 * the catalog database, so the browser does no work for them: one small lookup
 * and the gain is applied. Local files have no catalog row, so those are
 * measured here in a worker — with a hard watchdog, because a malformed file can
 * keep a wasm engine inside one call where JavaScript cannot interrupt it.
 *
 * Modes:
 *   song  - static gain from the selected song's integrated loudness.
 *   album - for a catalog folder, the folder's aggregate; for a multi-song file
 *           (catalog or local), the file's sub-tunes aggregated. A single-song
 *           local file is simply its track gain.
 *   auto  - album when the playback context is one album, song when it spans
 *           several. See resolveAutoMode().
 * Off leaves the output exactly as it was.
 */
import pathe from 'pathe';
import {
  albumFromTracks,
  gainFromMeasurement,
} from './loudness';
import {
  getCachedTrack,
  putCachedTrack,
} from './loudness-cache';

const DEFAULT_TARGET_LUFS = -18;

const MAX_LOCAL_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_RENDER_SECONDS = 300;
const LOCAL_WALL_BUDGET_MS = 15000;
const LOCAL_JOB_TIMEOUT_MS = 30000;
const LOCAL_MAX_SUBTUNES = 32;
const LOCAL_RETRY_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

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

function finite(value) {
  return Number.isFinite(value);
}

/**
 * Decide what "album" means for a playback context.
 *
 * A SongRef is `{ path, subtune }`. A path that appears more than once is a
 * multi-song file (a song folder), so the file is the album; a path that appears
 * once is a normal file, so its containing directory is the album. One distinct
 * album key means album mode; more than one means the context is a mixed list
 * and song mode is the honest choice. A one-song context is song mode: there is
 * no album sequence to preserve.
 */
export function resolveAutoMode(context) {
  if (!Array.isArray(context) || context.length <= 1) return 'song';
  const counts = new Map();
  for (const item of context) {
    const filepath = typeof item === 'string' ? item : item?.path;
    if (!filepath) continue;
    counts.set(filepath, (counts.get(filepath) || 0) + 1);
  }
  const keys = new Set();
  for (const [filepath, count] of counts) {
    keys.add(count > 1 ? `file:${filepath}` : `dir:${pathe.dirname(filepath)}`);
    if (keys.size > 1) return 'song';
  }
  return keys.size === 1 ? 'album' : 'song';
}

export default class ReplayGain {
  constructor({ sampleRate, getSettings, onChange, fetchServer, analysisTimeoutMs }) {
    this.sampleRate = sampleRate;
    this.getSettings = getSettings;
    this.onChange = onChange;
    this.fetchServer = fetchServer;
    this.analysisTimeoutMs = analysisTimeoutMs || LOCAL_JOB_TIMEOUT_MS;

    this.worker = null;
    this.nextJobId = 1;
    this.pendingJobs = new Map();
    this.scanToken = 0;

    this.song = null;
    this.remote = null;
    this.local = null;
    this.lastEmitted = null;
    this.autoMode = 'song';

    this.remoteCache = new Map(); // `${path}\0${subtune}` -> server response
    this.localCache = new Map();  // filepath -> local cache entry
  }

  get requestedMode() {
    return this.getSettings()?.volumeNormalization || 'auto';
  }

  get mode() {
    const requested = this.requestedMode;
    return requested === 'auto' ? (this.autoMode || 'song') : requested;
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
      this.scanToken++;
      this.cancelPending();
      this.applyCurrentGain();
      return;
    }
    if (this.song.isLocal) {
      // Switching to album mode needs every sub-tune of a multi-song file.
      if (this.mode === 'album' && !this.localAllSubtunes()) {
        this.setSong(this.song);
      } else {
        this.applyCurrentGain();
      }
      return;
    }
    this.applyCurrentGain();
  }

  clear() {
    this.scanToken++;
    this.cancelPending();
    this.song = null;
    this.remote = null;
    this.local = null;
    this.emit({ gainDb: 0, linear: 1, source: 'off' });
  }

  /**
   * @param {object} song
   * @param {string} song.filepath
   * @param {number} [song.subtune]
   * @param {ArrayBuffer|Uint8Array} [song.buffer] - local files only
   * @param {boolean} [song.isLocal]
   * @param {Array} [song.context] - the playback context (SongRefs)
   */
  setSong(song) {
    this.song = {
      filepath: song.filepath,
      subtune: Number.isInteger(song.subtune) ? song.subtune : 0,
      buffer: song.buffer,
      isLocal: !!song.isLocal || song.filepath.startsWith('local/'),
      context: song.context,
    };
    this.autoMode = resolveAutoMode(song.context);
    this.remote = null;
    this.local = null;
    this.startSong(this.song);
  }

  async startSong(song) {
    this.cancelPending();
    const token = ++this.scanToken;
    if (this.mode === 'off') {
      this.emit({ gainDb: 0, linear: 1, source: 'off' });
      return;
    }
    if (song.isLocal) {
      await this.startLocal(song, token);
    } else {
      await this.startCatalog(song, token);
    }
  }

  // --- Catalog: read the measured row; never scan in the browser ----------

  async startCatalog(song, token) {
    const key = `${song.filepath}\0${song.subtune}`;
    let response = this.remoteCache.get(key);
    if (!response) {
      try {
        response = await this.fetchServer(song.filepath, song.subtune);
      } catch (e) {
        response = null;
      }
      if (token !== this.scanToken) return;
      if (response) this.remoteCache.set(key, response);
    }
    if (!response) {
      this.remote = null;
      this.devWarnMissing(song);
      this.applyCurrentGain();
      return;
    }
    this.remote = response;
    this.applyCurrentGain();
  }

  devWarnMissing(song) {
  }

  // --- Local: measure in the worker, with limits and a watchdog ------------

  startLocal(song, token) {
    const byteLength = byteLengthOf(song.buffer);
    if (byteLength > MAX_LOCAL_BYTES) {
      this.local = {
        version: CACHE_VERSION,
        status: 'skipped',
        byteLength,
        retryAfter: Infinity,
        reason: 'too large',
      };
      this.localCache.set(song.filepath, this.local);
      putCachedTrack(song.filepath, this.local);
      this.applyCurrentGain();
      return;
    }
    const key = song.filepath;
    const cached = this.localCache.get(key) || null;
    if (cached && this.canUseLocal(cached, byteLength)) {
      if (token !== this.scanToken) return;
      this.local = cached;
      this.applyCurrentGain();
      return;
    }

    // Check IndexedDB once per path; the in-memory map is filled from it.
    return getCachedTrack(key).then((stored) => {
      if (token !== this.scanToken) return;
      if (stored && stored.version === CACHE_VERSION && stored.byteLength === byteLength) {
        this.localCache.set(key, stored);
        if (this.canUseLocal(stored, byteLength)) {
          this.local = stored;
          this.applyCurrentGain();
          return;
        }
        if (this.isRetrying(stored)) {
          this.local = stored;
          this.emit({ gainDb: 0, linear: 1, source: 'off' });
          return;
        }
      }
      this.local = null;
      this.emit({ gainDb: 0, linear: 1, source: 'pending' });
      const allSubtunes = this.mode === 'album';
      return this.scanLocal(song, token, allSubtunes);
    });
  }

  canUseLocal(entry, byteLength) {
    if (!entry || entry.version !== CACHE_VERSION || entry.byteLength !== byteLength) return false;
    if (this.isRetrying(entry)) return false;
    if (this.mode === 'album' && entry.subtuneCount > 1 && !entry.allSubtunes) return false;
    return true;
  }

  isRetrying(entry) {
    if (!entry) return false;
    if (entry.status === 'skipped') return true;
    return entry.status !== 'ok'
      && entry.status !== 'partial'
      && typeof entry.retryAfter === 'number'
      && entry.retryAfter > Date.now();
  }

  localAllSubtunes() {
    if (!this.local) return false;
    return !!this.local.allSubtunes
      || (this.local.subtuneCount || 1) <= 1;
  }

  async scanLocal(song, token, allSubtunes) {
    try {
      const result = await this.requestAnalysis(song.filepath, song.buffer, {
        subtune: song.subtune,
        allSubtunes,
        maxSubtunes: LOCAL_MAX_SUBTUNES,
        maxRenderSeconds: MAX_LOCAL_RENDER_SECONDS,
        wallBudgetMs: LOCAL_WALL_BUDGET_MS,
        timeoutMs: this.analysisTimeoutMs,
      });
      if (token !== this.scanToken) return;
      const entry = {
        version: CACHE_VERSION,
        byteLength: byteLengthOf(song.buffer),
        status: result.status || 'ok',
        subtuneCount: result.subtuneCount || 1,
        allSubtunes: !!allSubtunes,
        subtunes: {},
        file: result.file || null,
        engine: result.engine,
        analyzedAt: Date.now(),
      };
      for (const track of result.tracks || []) {
        entry.subtunes[track.subtune] = track;
      }
      if (!entry.subtunes[song.subtune] && result.lufs) {
        entry.subtunes[song.subtune] = result;
      }
      this.localCache.set(song.filepath, entry);
      putCachedTrack(song.filepath, entry);
      this.local = entry;
      this.applyCurrentGain();
    } catch (e) {
      if (token !== this.scanToken) return;
      const timedOut = e && e.timeout;
      this.local = {
        version: CACHE_VERSION,
        byteLength: byteLengthOf(song.buffer),
        status: timedOut ? 'timeout' : 'error',
        retryAfter: Date.now() + LOCAL_RETRY_MS,
        reason: e && e.message ? e.message : String(e),
      };
      this.localCache.set(song.filepath, this.local);
      putCachedTrack(song.filepath, this.local);
      if (!(e && e.cancelled)) {
        console.warn(`ReplayGain: local scan failed for ${song.filepath}:`, this.local.reason);
      }
      this.applyCurrentGain();
    }
  }

  localMeasurement() {
    if (!this.local || !this.local.subtunes) return null;
    if (this.mode === 'album') {
      if (this.local.file) return this.local.file;
      const tracks = Object.values(this.local.subtunes);
      if (this.local.subtuneCount > 1) return albumFromTracks(tracks);
    }
    return this.local.subtunes[this.song?.subtune || 0]
      || this.local.subtunes[0]
      || null;
  }

  // --- Gain ---------------------------------------------------------------

  applyCurrentGain() {
    const mode = this.mode;
    if (mode === 'off') {
      this.emit({ gainDb: 0, linear: 1, source: 'off' });
      return;
    }

    let measurement = null;
    let source = 'pending';
    if (this.song?.isLocal) {
      const local = this.localMeasurement();
      if (local && finite(local.lufs)) {
        measurement = local;
        source = mode === 'album' && this.local?.subtuneCount > 1 ? 'album' : 'song';
      }
    } else if (this.remote) {
      const album = this.remote.album;
      const useAlbum = mode === 'album'
        && album
        && album.status === 'complete'
        && finite(album.lufs);
      measurement = useAlbum ? album : this.remote.track;
      if (measurement && finite(measurement.lufs)) {
        source = useAlbum ? 'album' : 'song';
      } else {
        measurement = null;
      }
    }

    if (!measurement) {
      // A missing catalog row is deliberately silent in the UI; the dev-only
      // warning above is the signal.
      this.emit({ gainDb: 0, linear: 1, source: 'off' });
      return;
    }

    const gain = gainFromMeasurement(measurement, this.targetLufs);
    this.emit({
      ...gain,
      lufs: measurement.lufs,
      peakDb: measurement.peakDb,
      source,
      subtuneCount: this.song?.isLocal
        ? this.local?.subtuneCount
        : this.remote?.subtuneCount,
    });
  }

  emit(result) {
    const key = `${result.source}|${result.gainDb.toFixed(2)}`;
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.onChange(result);
  }

  // --- Worker -------------------------------------------------------------

  cancelPending() {
    if (!this.worker) return;
    for (const [id, job] of this.pendingJobs) {
      this.worker.postMessage({ type: 'cancel', id });
      clearTimeout(job.timer);
      const error = new Error('cancelled');
      error.cancelled = true;
      job.reject(error);
    }
    this.pendingJobs.clear();
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
      clearTimeout(job.timer);
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
      this.failAll(new Error(event.message || 'Loudness worker error'));
    };
    worker.postMessage({ type: 'init', sampleRate: this.sampleRate });
    this.worker = worker;
    return worker;
  }

  failAll(error) {
    for (const job of this.pendingJobs.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pendingJobs.clear();
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) { /* already gone */ }
    }
    this.worker = null;
  }

  requestAnalysis(filepath, buffer, options) {
    const worker = this.ensureWorker();
    const id = this.nextJobId++;
    const copy = copyForTransfer(buffer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`local scan timed out after ${options.timeoutMs} ms`);
        error.timeout = true;
        // terminate() is the only way to stop a wasm call that never returns.
        this.failAll(error);
        reject(error);
      }, options.timeoutMs);
      this.pendingJobs.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({
          type: 'analyze',
          id,
          filepath,
          buffer: copy,
          subtune: options.subtune,
          allSubtunes: options.allSubtunes,
          maxSubtunes: options.maxSubtunes,
          maxRenderSeconds: options.maxRenderSeconds,
          wallBudgetMs: options.wallBudgetMs,
        }, [copy]);
      } catch (e) {
        clearTimeout(timer);
        this.pendingJobs.delete(id);
        reject(e);
      }
    });
  }
}
