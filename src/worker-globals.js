/**
 * Player modules assume a browser page (`window`, `requestIdleCallback`). A
 * worker has `self` and `performance` but no `window`, so make the aliases
 * before any player module is evaluated. Import this module first.
 */
const workerGlobal = typeof window === 'undefined' ? globalThis.self : null;

if (workerGlobal) {
  workerGlobal.window = workerGlobal;

  // The dev server injects `window.__devApiPort` into the HTML so a second tree
  // finds its own API port. A worker gets the same origin but not that script, so
  // derive it from the worker URL (the chunk is served by the app's own origin).
  if (workerGlobal.location && workerGlobal.location.port && !workerGlobal.__devApiPort) {
    workerGlobal.__devApiPort = Number(workerGlobal.location.port);
  }

  // Web MIDI is meaningless while scanning, and requesting permission from a
  // worker logs an unhandled rejection in Chromium. The synth engines do not use
  // it.
  if (typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator) {
    try {
      Object.defineProperty(navigator, 'requestMIDIAccess', {
        value: undefined,
        configurable: true,
      });
    } catch (e) {
      // Nothing to do; the player also checks for a function.
    }
  }

  if (!workerGlobal.requestIdleCallback) {
    workerGlobal.requestIdleCallback = function (cb) {
      return setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
    };
    workerGlobal.cancelIdleCallback = function (id) {
      clearTimeout(id);
    };
  }
}
