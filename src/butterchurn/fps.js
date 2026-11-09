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
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      // The counter is unmounted (Settings closed). Keep the last target, but
      // stop advertising a frame rate nobody is displaying.
      current = { ...current, fps: 0, active: false };
    }
  };
}

export function reportVisualizerFps(fps, active = true) {
  // Settings is the only consumer. Do not churn the store while it is closed.
  if (listeners.size === 0) return;
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
  const started = performance.now();
  const sample = (timestamp) => {
    if (last !== null) intervals.push(timestamp - last);
    last = timestamp;
    // Bound the probe in wall-clock time, not just frame count: a slow scene
    // must still produce a target (the fastest interval is clipped to >=60 Hz).
    if (intervals.length < 60 && performance.now() - started < 800) {
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
