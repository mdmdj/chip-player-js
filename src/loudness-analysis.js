/**
 * Render a song through the real player engines, as fast as the CPU allows, and
 * measure it. This is the piece that makes a scan independent of real time: the
 * engines are driven in a tight loop with no audio context, exactly the way the
 * app drives them in `App.playerNode.onaudioprocess`.
 *
 * Runs inside `loudness-worker.js` in the browser. The dev harness drives the
 * same module under Node with a Babel require hook, which is why it has no
 * worker-specific API.
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
import { LoudnessMeter } from './loudness';

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

function cancelledError() {
  const error = new Error('cancelled');
  error.cancelled = true;
  return error;
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

  return async function analyze(buffer, filepath, subtune = 0, isCancelled = null) {
    const ext = filepath.slice(filepath.lastIndexOf('.') + 1).toLowerCase();
    const player = players.find(p => p.canPlay(ext));
    if (!player) {
      throw new Error(`No player for .${ext}`);
    }

    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    await player.loadData(bytes, filepath, {}, subtune);
    if (isCancelled && isCancelled()) return cancelledError();

    const meter = new LoudnessMeter(sampleRate);
    const durationMs = player.getDurationMs();
    const durationSeconds = durationMs > 0
      ? Math.min(durationMs / 1000, MAX_RENDER_SECONDS)
      : DEFAULT_DURATION_SECONDS;
    const maxFrames = Math.ceil(durationSeconds * sampleRate);
    const started = performance.now();
    let lastYield = started;
    let frames = 0;
    let partial = false;

    while (!player.stopped && frames < maxFrames) {
      channels[0].fill(0);
      channels[1].fill(0);
      player.processAudio(channels);
      meter.processBlock(channels[0], channels[1]);
      frames += BUFFER_SIZE;
      if ((frames & 0x3ffff) === 0) {
        // Let the worker receive a cancel message from the main thread while a
        // long/slow engine is being rendered.
        const now = performance.now();
        if (now - lastYield > 500) {
          await new Promise(resolve => setTimeout(resolve, 0));
          lastYield = now;
          if (isCancelled && isCancelled()) throw cancelledError();
        }
        if (now - started > WALL_BUDGET_MS) {
          partial = true;
          break;
        }
      }
    }

    const measurement = meter.result();
    measurement.durationSec = frames / sampleRate;
    measurement.partial = partial || (frames >= maxFrames && !player.stopped);
    measurement.engine = player.playerKey;
    measurement.renderMs = performance.now() - started;

    try {
      player.stop();
    } catch (e) {
      // A stop() failure must not lose a completed measurement.
      console.debug('Loudness analyzer: player.stop() failed.', e);
    }

    if (!(measurement.peakDb > -120) || !Number.isFinite(measurement.lufs)) {
      measurement.silent = true;
    }
    return measurement;
  };
}
