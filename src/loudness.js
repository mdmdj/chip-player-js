/**
 * Loudness measurement and ReplayGain-style gain math.
 *
 * The measurement follows ITU-R BS.1770-4 / EBU R128 closely enough for music
 * normalization: K-weighting (a high shelf followed by the RLB high pass),
 * 400 ms gating blocks with a 100 ms hop, absolute -70 LUFS and relative -10 dB
 * gates, and integrated loudness in LUFS. Peak is sample peak, not true peak;
 * chiptune players render at the audio context rate and do not oversample, so
 * sample peak is what the output graph can actually clip on.
 *
 * This module is deliberately dependency-free so the worker, the UI and the Node
 * harness can all use the same code.
 */

// Target levels in LUFS. -18 is a comfortable "same as each other" level and
// leaves headroom; -14 is the streaming-ballpark level, but chiptune peaks are
// often high enough that a static (non-limiting) gain cannot reach it. See
// gainFromMeasurement().
export const TARGET_QUIET_LUFS = -23;
export const TARGET_NORMAL_LUFS = -18;
export const TARGET_LOUD_LUFS = -14;
export const DEFAULT_TARGET_LUFS = TARGET_NORMAL_LUFS;

// Never boost or cut beyond this. A measurement that asks for more is almost
// always a broken/empty render, and a huge cut is not what a listener wants.
export const MIN_GAIN_DB = -24;
export const MAX_GAIN_DB = 24;

// Peak ceiling used to prevent clipping. -1 dBFS leaves room for the user's own
// volume slider and for inter-sample overs on the destination.
export const PEAK_CEILING_DB = -1;

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;
const BLOCKS_PER_GATE_BLOCK = Math.round(BLOCK_SECONDS / HOP_SECONDS);

// K-weighting filters from pyloudnorm's BS.1770 implementation. Coefficients
// are computed for the actual sample rate instead of the published 48 kHz set.
function kWeightingCoefficients(sampleRate) {
  // Stage 1: high shelf (+4 dB above ~1.7 kHz).
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfFc = 1681.974450955533;
  let K = Math.tan(Math.PI * shelfFc / sampleRate);
  const Vh = Math.pow(10, shelfGainDb / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / shelfQ + K * K;
  const shelf = {
    b0: (Vh + Vb * K / shelfQ + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / shelfQ + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / shelfQ + K * K) / a0,
  };

  // Stage 2: high pass at 38 Hz (the "RLB" curve).
  const hpQ = 0.5003270373238773;
  const hpFc = 38.13547087602444;
  K = Math.tan(Math.PI * hpFc / sampleRate);
  a0 = 1 + K / hpQ + K * K;
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / hpQ + K * K) / a0,
  };

  return [shelf, highpass];
}

class Biquad {
  constructor(coefficients) {
    this.c = coefficients;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  reset() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2
      - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function meanSquareToLufs(meanSquare) {
  return -0.691 + 10 * Math.log10(Math.max(meanSquare, 1e-30));
}

function lufsToMeanSquare(lufs) {
  return Math.pow(10, (lufs + 0.691) / 10);
}

export class LoudnessMeter {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.filters = kWeightingCoefficients(sampleRate).map(c => [new Biquad(c), new Biquad(c)]);
    this.hopSamples = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
    this.hopEnergy = 0;
    this.hopSamplesSeen = 0;
    this.hopPowers = [];
    this.blockPowers = [];
    this.totalEnergy = 0;
    this.totalSamples = 0;
    this.peak = 0;
  }

  /** Feed one stereo frame. `left` and `right` are expected in -1..1. */
  processFrame(left, right) {
    const l = this.filters[1][0].process(this.filters[0][0].process(left));
    const r = this.filters[1][1].process(this.filters[0][1].process(right));
    this.hopEnergy += l * l + r * r;
    this.totalEnergy += l * l + r * r;
    this.totalSamples += 2;
    this.peak = Math.max(this.peak, Math.abs(left), Math.abs(right));
    this.hopSamplesSeen++;
    if (this.hopSamplesSeen >= this.hopSamples) {
      this.hopPowers.push(this.hopEnergy / (this.hopSamples * 2));
      this.hopEnergy = 0;
      this.hopSamplesSeen = 0;
      if (this.hopPowers.length === BLOCKS_PER_GATE_BLOCK) {
        const sum = this.hopPowers.reduce((a, b) => a + b, 0);
        this.blockPowers.push(sum / BLOCKS_PER_GATE_BLOCK);
        this.hopPowers = [];
      }
    }
  }

  processBlock(left, right) {
    for (let i = 0; i < left.length; i++) {
      this.processFrame(left[i], right ? right[i] : left[i]);
    }
  }

  result() {
    let blocks = this.blockPowers;
    if (blocks.length === 0 && this.hopPowers.length > 0) {
      // Shorter than one 400 ms block. Fall back to the partial hop mean so a
      // very short jingle still gets a usable number.
      const sum = this.hopPowers.reduce((a, b) => a + b, 0);
      blocks = [sum / this.hopPowers.length];
    }
    const absolute = blocks.filter(p => meanSquareToLufs(p) > ABSOLUTE_GATE_LUFS);
    const absoluteMean = absolute.length
      ? absolute.reduce((a, b) => a + b, 0) / absolute.length
      : (this.totalEnergy / Math.max(this.totalSamples, 1));
    const relativeGate = meanSquareToLufs(absoluteMean) + RELATIVE_GATE_LU;
    const gated = absolute.filter(p => meanSquareToLufs(p) > relativeGate);
    const meanSquare = gated.length
      ? gated.reduce((a, b) => a + b, 0) / gated.length
      : absoluteMean;
    return {
      lufs: meanSquareToLufs(meanSquare),
      peakDb: 20 * Math.log10(Math.max(this.peak, 1e-12)),
      durationSec: this.totalSamples / 2 / this.sampleRate,
      gatingBlocks: gated.length,
    };
  }
}

/**
 * Turn a measurement into a gain, clamped by the requested loudness target and
 * by peak headroom. A static replay gain cannot make a very dynamic quiet track
 * as loud as a streaming service without a limiter; when the peak ceiling is
 * the binding constraint, the peak is protected and the track stays quieter.
 */
export function gainFromMeasurement(measurement, targetLufs = DEFAULT_TARGET_LUFS) {
  if (!measurement || !Number.isFinite(measurement.lufs)) {
    return { gainDb: 0, linear: 1, limitedBy: 'none' };
  }
  let gainDb = targetLufs - measurement.lufs;
  let limitedBy = 'target';
  if (Number.isFinite(measurement.peakDb)) {
    const headroomDb = PEAK_CEILING_DB - measurement.peakDb;
    if (gainDb > headroomDb) {
      gainDb = headroomDb;
      limitedBy = 'peak';
    }
  }
  gainDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gainDb));
  return {
    gainDb,
    linear: Math.pow(10, gainDb / 20),
    limitedBy,
  };
}

/**
 * Album loudness is duration-weighted: playing every track back to back means
 * the album's mean square is the time-weighted mean of the tracks' mean squares.
 * Peak is the loudest track's peak, because album gain is applied to all of them.
 */
export function albumFromTracks(tracks) {
  const valid = tracks.filter(t => t && Number.isFinite(t.lufs));
  if (valid.length === 0) return null;
  let energy = 0;
  let duration = 0;
  let peakDb = -Infinity;
  for (const track of valid) {
    const seconds = Number.isFinite(track.durationSec) && track.durationSec > 0
      ? track.durationSec
      : 1;
    energy += lufsToMeanSquare(track.lufs) * seconds;
    duration += seconds;
    if (Number.isFinite(track.peakDb)) {
      peakDb = Math.max(peakDb, track.peakDb);
    }
  }
  return {
    lufs: meanSquareToLufs(energy / Math.max(duration, 1e-9)),
    peakDb: Number.isFinite(peakDb) ? peakDb : null,
    durationSec: duration,
    trackCount: valid.length,
  };
}
