/**
 * Background loudness scanner.
 *
 * The main thread sends the song bytes it already fetched for playback, plus a
 * job id. Rendering happens here so a scan never steals time from the audio
 * callback, and the measured result is cached by the main thread.
 */
import './worker-globals';
import { createLoudnessAnalyzer } from './loudness-analysis';

let analyzerPromise = null;
let sampleRate = 48000;

async function getAnalyzer() {
  if (!analyzerPromise) {
    analyzerPromise = (async () => {
      const { default: ChipCore } = await import(/* webpackChunkName: "chip-core" */ './chip-core');
      const core = await ChipCore({
        print: (msg) => console.debug('[loudness stdout] ' + msg),
        printErr: (msg) => console.debug('[loudness stderr] ' + msg),
      });
      return createLoudnessAnalyzer(core, sampleRate);
    })();
  }
  return analyzerPromise;
}

let queue = Promise.resolve();
const cancelled = new Set();

function reportCancelled(id) {
  globalThis.self.postMessage({ type: 'cancelled', id });
}

globalThis.self.onmessage = (event) => {
  const message = event.data;
  if (!message) return;

  if (message.type === 'init') {
    if (Number.isFinite(message.sampleRate) && message.sampleRate > 0) {
      sampleRate = message.sampleRate;
    }
    return;
  }

  if (message.type === 'cancel') {
    cancelled.add(message.id);
    return;
  }

  if (message.type !== 'analyze') return;

  queue = queue.then(async () => {
    const { id, filepath, buffer, subtune } = message;
    if (cancelled.has(id)) {
      cancelled.delete(id);
      reportCancelled(id);
      return;
    }
    try {
      const analyze = await getAnalyzer();
      const measurement = await analyze(buffer, filepath, {
        subtune: subtune || 0,
        allSubtunes: !!message.allSubtunes,
        maxSubtunes: message.maxSubtunes,
        maxRenderSeconds: message.maxRenderSeconds,
        wallBudgetMs: message.wallBudgetMs,
        isCancelled: () => cancelled.has(id),
      });
      if (cancelled.has(id)) {
        cancelled.delete(id);
        reportCancelled(id);
        return;
      }
      globalThis.self.postMessage({ type: 'result', id, measurement });
    } catch (e) {
      const wasCancelled = cancelled.has(id) || (e && e.cancelled);
      cancelled.delete(id);
      if (wasCancelled) {
        reportCancelled(id);
      } else {
        globalThis.self.postMessage({
          type: 'error',
          id,
          message: e && e.message ? e.message : String(e),
        });
      }
    }
  });
};
