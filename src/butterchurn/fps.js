// Frame-rate telemetry for the MilkDrop renderer, and a display-refresh estimate.
//
// Browsers do not expose a reliable display refresh rate (screen.refreshRate is
// non-standard and usually absent), so the target is inferred from the fastest
// requestAnimationFrame intervals: the display cannot present faster than that,
// while a heavy scene drags the average down. Label it as an estimate, not a
// measured monitor mode.
'use strict';

const listeners = new Set();
let current = { fps: 0, refresh: 0, active: false };
let probeStarted = false;

function emit() {
  for (const listener of listeners) listener(current);
}

export function subscribeVisualizerStats(listener) {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

export function reportVisualizerFps(fps, active = true) {
  current = {
    ...current,
    fps: active ? Math.max(0, Math.round(fps)) : 0,
    active,
  };
  emit();
}

export function startRefreshProbe() {
  if (probeStarted || typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') {
    return;
  }
  probeStarted = true;

  const nativeRate = Number(window.screen && window.screen.refreshRate);
  if (Number.isFinite(nativeRate) && nativeRate > 0) {
    current = { ...current, refresh: Math.round(nativeRate) };
    emit();
    return;
  }

  const intervals = [];
  let last = null;
  const sample = (timestamp) => {
    if (last !== null) intervals.push(timestamp - last);
    last = timestamp;
    if (intervals.length < 90) {
      requestAnimationFrame(sample);
      return;
    }
    const sorted = intervals.filter((ms) => ms > 0).sort((a, b) => a - b);
    if (!sorted.length) return;
    // Use the fastest tenth: any idle frame exposes the panel's ceiling even if
    // the scene misses frames. The median of those is robust against timestamp
    // jitter; common displays are 60/75/90/120/144/165/240 Hz.
    const fastest = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1)));
    const median = fastest[Math.floor(fastest.length / 2)];
    const hz = Math.round(1000 / median);
    current = { ...current, refresh: Math.max(60, Math.min(240, hz)) };
    emit();
  };
  requestAnimationFrame(sample);
}
