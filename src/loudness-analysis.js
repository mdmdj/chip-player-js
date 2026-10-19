/**
 * Render a song through the real player engines, as fast as the CPU allows, and
 * measure it. This is the piece that makes a scan independent of real time: the
 * engines are driven in a tight loop with no audio context, exactly the way the
 * app drives them in `App.playerNode.onaudioprocess`.
 *
 * Runs inside `loudness-worker.js` in the browser and inside the catalog
 * scanner's child process under Node. Both use this module so a track measured
 * for `catalog.db` and the same track measured locally agree.
 */
import './worker-globals';

import GMEPlayer from './players/GMEPlayer';
import MIDIPlayer from './players/MIDIPlayer';
import V2MPlayer from './players/V2MPlayer';
import XMPPlayer from './players/XMPPlayer';
import N64Player from './players/N64Player';
import GSFPlayer from './players/GSFPlayer';
import MDXPlayer from './players/MDXPlayer';
import VGMPlayer from './players/VGMPlayer';
import SIDPlayer from './players/SIDPlayer';
import { LoudnessMeter, albumFromTracks } from './loudness';

const PLAYER_CLASSES = [
  MIDIPlayer,
  GMEPlayer,
  XMPPlayer,
  V2MPlayer,
  N64Player,
  GSFPlayer,
  MDXPlayer,
  VGMPlayer,
  SIDPlayer,
];

const BUFFER_SIZE = 4096;
// A scan is a background nicety, not playback. Stop a pathological file rather
// than pin a core forever; the result is marked partial and still used.
const WALL_BUDGET_MS = 20000;
const MAX_RENDER_SECONDS = 600;
const DEFAULT_DURATION_SECONDS = 180;
const MAX_SUBTUNES = 64;

function cancelledError() {
  const error = new Error('cancelled');
  error.cancelled = true;
  return error;
}

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

export function createLoudnessAnalyzer(core, sampleRate) {
  const channels = [
    new Float32Array(BUFFER_SIZE),
    new Float32Array(BUFFER_SIZE),
  ];
  const players = [];
  for (const PlayerClass of PLAYER_CLASSES) {
    try {
      const player = new PlayerClass(core, sampleRate, BUFFER_SIZE);
      // Some loaders (MDX, and seek paths in several players) suspend the audio
      // context while they touch the filesystem. There is no context here, and a
      // suspended placeholder takes the synchronous branch instead of trying to
      // suspend one.
      player.audioNode = { context: { state: 'suspended' } };
      players.push(player);
    } catch (e) {
      console.warn(`Loudness analyzer: could not create ${PlayerClass.name}.`, e);
    }
  }

  function measureSubtune(player, targetSubtune, options, deadline, started) {
    const meter = new LoudnessMeter(sampleRate);
    const durationMs = player.getDurationMs();
    // Six seconds of tail: GME's default fade is five seconds after the track
    // length, and stopping exactly on the computed frame would mark every
    // normal track "partial". The extra time lets the engine stop itself.
    const durationSeconds = isFinitePositive(durationMs)
      ? Math.min(durationMs / 1000 + 6, options.maxRenderSeconds)
      : DEFAULT_DURATION_SECONDS;
    const maxFrames = Math.ceil(durationSeconds * sampleRate);
    let frames = 0;
    let partial = false;
    let advanced = false;
    let lastYield = performance.now();

    while (frames < maxFrames) {
      if (player.stopped) break;
      if (typeof player.getSubtune === 'function' && player.getSubtune() !== targetSubtune) {
        // The player auto-advanced into the next subtune. Stop at the boundary
        // so song mode measures only the subtune the user selected.
        advanced = true;
        break;
      }

      channels[0].fill(0);
      channels[1].fill(0);
      player.processAudio(channels);
      meter.processBlock(channels[0], channels[1]);
      frames += BUFFER_SIZE;

      if ((frames & 0x3ffff) === 0) {
        const now = performance.now();
        // Let the worker receive a cancel message, and keep a UI/audio thread
        // from starving behind a long scan.
        if (now - lastYield > 500) {
          lastYield = now;
          if (options.isCancelled && options.isCancelled()) throw cancelledError();
        }
        if (now > deadline) {
          partial = true;
          break;
        }
      }
    }

    const measurement = meter.result();
    measurement.durationSec = frames / sampleRate;
    measurement.partial = partial || (frames >= maxFrames && !player.stopped && !advanced);
    measurement.engine = player.playerKey;
    measurement.renderMs = performance.now() - started;
    measurement.silent = !(measurement.peakDb > -120) || !Number.isFinite(measurement.lufs);
    return measurement;
  }

  /**
   * @param {ArrayBuffer|Uint8Array} buffer
   * @param {string} filepath
   * @param {object|number} [optionsOrSubtune] - number for compatibility, or
   *   { subtune, allSubtunes, maxSubtunes, maxRenderSeconds, wallBudgetMs,
   *     isCancelled }
   */
  return async function analyze(buffer, filepath, optionsOrSubtune = {}) {
    const options = typeof optionsOrSubtune === 'number'
      ? { subtune: optionsOrSubtune }
      : (optionsOrSubtune || {});
    const targetSubtune = Number.isInteger(options.subtune) ? options.subtune : 0;
    const allSubtunes = !!options.allSubtunes;
    const maxSubtunes = Math.max(1, Math.min(options.maxSubtunes || MAX_SUBTUNES, 256));
    const maxRenderSeconds = Math.max(1, options.maxRenderSeconds || MAX_RENDER_SECONDS);
    const wallBudgetMs = Math.max(1000, options.wallBudgetMs || WALL_BUDGET_MS);
    const started = performance.now();
    const deadline = started + wallBudgetMs;
    const isCancelled = options.isCancelled;

    const ext = filepath.slice(filepath.lastIndexOf('.') + 1).toLowerCase();
    const player = players.find(p => p.canPlay(ext));
    if (!player) {
      throw new Error(`No player for .${ext}`);
    }

    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    await player.loadData(bytes, filepath, {}, targetSubtune);
    if (isCancelled && isCancelled()) throw cancelledError();

    let subtuneCount = 1;
    try {
      subtuneCount = Math.max(1, player.getNumSubtunes() || 1);
    } catch (e) {
      subtuneCount = 1;
    }

    const tracks = [];
    const first = allSubtunes ? Math.min(subtuneCount, maxSubtunes) : 1;
    for (let index = 0; index < first; index++) {
      if (isCancelled && isCancelled()) throw cancelledError();
      const subtune = allSubtunes
        ? index
        : Math.max(0, Math.min(targetSubtune, subtuneCount - 1));
      if (allSubtunes && index > 0) {
        // Reload for each subtune. It is slower than playSubtune() but it is
        // isolated from auto-advance and from players whose stop() closes the
        // context; catalog scans run offline and can afford it.
        await player.loadData(bytes, filepath, {}, subtune);
        if (isCancelled && isCancelled()) throw cancelledError();
      }
      if (typeof player.getSubtune === 'function' && player.getSubtune() !== subtune) {
        player.playSubtune(subtune);
      }

      const measurement = measureSubtune(player, subtune, {
        ...options,
        maxRenderSeconds,
        isCancelled,
      }, deadline, started);
      measurement.subtune = subtune;
      tracks.push(measurement);

      if (performance.now() > deadline) break;
    }

    try {
      player.stop();
    } catch (e) {
      // A stop() failure must not lose a completed measurement.
      console.debug('Loudness analyzer: player.stop() failed.', e);
    }

    if (tracks.length === 0) {
      throw new Error('No subtune could be measured');
    }

    const file = albumFromTracks(tracks);
    const result = {
      ...tracks[0],
      subtune: targetSubtune,
      subtuneCount,
      analyzedSubtunes: tracks.length,
      tracks,
      file,
      status: tracks.length < subtuneCount ? 'partial' : 'ok',
      renderMs: performance.now() - started,
    };
    if (allSubtunes) {
      result.subtuneCount = subtuneCount;
      result.lufs = file ? file.lufs : result.lufs;
      result.peakDb = file ? file.peakDb : result.peakDb;
      result.durationSec = file ? file.durationSec : result.durationSec;
      result.silent = !(result.peakDb > -120) || !Number.isFinite(result.lufs);
    }
    return result;
  };
}
