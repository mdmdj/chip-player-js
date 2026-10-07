// DEV-ONLY browser tooling for chip-player-js.
//
// Staged to `src/chip-player-devtools.js` (untracked, gitignored) by
// `dev/apply.sh` and injected into the dev bundle by the overlay-only webpack
// dev config entry (config/webpack.config.dev.js). Nothing tracked is touched,
// so there are no in-place patches to revert.
//
// It exposes `window.__cpDev` so the t3 preview (or any console) can script
// repeat/loop behavior and spy on player state without listening to audio.
// Not part of the app; never shipped. `dev/remove.sh` deletes the staged file.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The app assigns itself to `window.ChipPlayer` in its constructor. Poll for it
// so this bootstrap can run before React mounts.
function whenAppReady() {
  return new Promise((resolve) => {
    const check = () => {
      if (window.ChipPlayer && window.ChipPlayer.sequencer) resolve(window.ChipPlayer);
      else setTimeout(check, 50);
    };
    check();
  });
}

const getPlayer = () => {
  const app = window.ChipPlayer;
  return app && app.sequencer && app.sequencer.getPlayer();
};

const snapshot = () => {
  const p = getPlayer();
  if (!p) return { hasPlayer: false };
  const core = p.core;
  const ctx = p.vgmCtx;
  const s = {
    player: p.constructor.name,
    repeat: window.ChipPlayer.state.repeat,
    looping: !!p.looping,
    indefinitePlayback: !!(p.params && p.params.indefinitePlayback),
    fadeTailStartMs: p.fadeTailStartMs ?? null,
    paused: typeof p.isPaused === 'function' ? p.isPaused() : undefined,
    positionMs: typeof p.getPositionMs === 'function' ? p.getPositionMs() : null,
    displayPositionMs: typeof p.getDisplayPositionMs === 'function' ? p.getDisplayPositionMs() : null,
    durationMs: typeof p.getDurationMs === 'function' ? p.getDurationMs() : null,
    // Engine-reported, not catalogued (see dev/record/README.md): GME parses
    // play_length at load, SID fetches HVSC lengths over HTTP. Plus the tail
    // detector's trip gate, so a probe can tell "the gate is shut" from "the tune
    // has not gone quiet yet".
    tripAtMs: typeof p.getEndDetectTripAtMs === 'function' ? p.getEndDetectTripAtMs() : null,
    detectSongEnd: p.params && 'detectSongEnd' in p.params ? !!p.params.detectSongEnd : null,
    metadata: p.metadata
      ? { intro_length: p.metadata.intro_length, loop_length: p.metadata.loop_length }
      : null,
  };
  if (ctx && core && typeof core._lvgm_get_cur_loop === 'function') {
    s.curLoop = core._lvgm_get_cur_loop(ctx);
    s.fadeStartMs = core._lvgm_get_fade_start_ms(ctx);
  }
  return s;
};

const dev = {
  player: getPlayer,
  snapshot,
  log: [],
  setRepeat(mode) {
    window.ChipPlayer.setState({ repeat: mode });
    window.ChipPlayer.sequencer.setRepeat(mode);
    return snapshot();
  },
  cycleRepeat() {
    window.ChipPlayer.handleCycleRepeat();
    return snapshot();
  },
  seek(ms) {
    const p = getPlayer();
    if (p) p.seekMs(ms);
    return snapshot();
  },
  // Click through the real UI: dispatch a genuine click on the first element
  // matching `sel` (CSS or text match like `button:contains("Repeat")`).
  click(sel) {
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch {
      // Not a valid CSS selector; fall back to text matching.
      const text = sel.replace(/:contains\("(.*)"\)$/, '$1');
      el = [...document.querySelectorAll('button, [role="button"], a')]
        .find((n) => n.textContent.trim().includes(text));
    }
    if (!el) return { clicked: false, sel };
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, sel, label: el.textContent.trim().slice(0, 40) };
  },
  // Set a player parameter through the app handler, as the UI would.
  setParam(id, value) {
    const app = window.ChipPlayer;
    app.handleParamChange(id, value);
    return snapshot();
  },
  // Poll `fn` until true (or `timeoutMs`); resolves to the last snapshot.
  async waitUntil(fn, timeoutMs = 15000, intervalMs = 100) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      const s = snapshot();
      if (fn(s, dev)) return s;
      await sleep(intervalMs);
    }
    return { timeout: true, ...snapshot() };
  },
  play() {
    const p = getPlayer();
    if (p && p.resume) p.resume();
  },
  pause() {
    const p = getPlayer();
    if (p && p.pause) p.pause();
  },
  // Stall watchdog: engines that wedge stop advancing positionMs while
  // still "playing" (e.g. the GPGX YM2612 stall: position frozen at 0 with
  // the tab alive). startStallWatch() polls in the background and warns the
  // moment a freeze is detected, with the file/position attached, instead of
  // silently sitting at 0. stopStallWatch() ends it. The latest verdict also
  // rides on every snapshot() as `stall`.
  startStallWatch(intervalMs = 2000, frozenMs = 6000) {
    dev.stopStallWatch();
    dev._stall = { armed: true, lastPos: null, lastT: 0, fired: false };
    dev._stallTimer = setInterval(() => dev._stallCheck(intervalMs, frozenMs), intervalMs);
    return 'watching for stalls';
  },
  stopStallWatch() {
    if (dev._stallTimer) clearInterval(dev._stallTimer);
    dev._stallTimer = null;
    if (dev._stall) dev._stall.armed = false;
    return 'stall watch stopped';
  },
  _stallCheck(intervalMs, frozenMs) {
    const s = snapshot();
    const st = dev._stall;
    if (!st || !st.armed) return s;
    const songKey = (s.metadata && (s.metadata.title || '')) + '@' + (s.durationMs || 0);
    if (songKey !== st.songKey) {
      // New song (or reload): re-arm silently.
      dev._stall = { armed: true, songKey, lastPos: s.positionMs, lastT: performance.now(), fired: false };
      return { ...s, stall: { stalled: false } };
    }
    const now = performance.now();
    if (!s.paused && s.positionMs != null && s.positionMs === st.lastPos &&
        now - st.lastT >= frozenMs && (s.durationMs || 0) > (s.positionMs || 0)) {
      if (!st.fired) {
        st.fired = true;
        console.warn('[dev] STALL? position frozen at %s ms for %s ms (player %s, repeat %s)',
          s.positionMs, Math.round(now - st.lastT), s.player, s.repeat);
      }
      return { ...s, stall: { stalled: true, frozenMs: Math.round(now - st.lastT) } };
    }
    if (s.positionMs !== st.lastPos) {
      st.lastPos = s.positionMs;
      st.lastT = now;
      st.fired = false;
    }
    return { ...s, stall: { stalled: false } };
  },
  // Sample the state every `intervalMs` for `durationMs`.
  async record(durationMs, intervalMs = 100) {
    const samples = [];
    const end = performance.now() + durationMs;
    while (performance.now() < end) {
      samples.push({ t: Date.now(), ...snapshot() });
      await sleep(intervalMs);
    }
    return samples;
  },
  // Fire-and-forget recorder: samples into `__cpDev.rec` until stopRecord().
  // Keeps long runs from blocking an evaluate() call.
  startRecord(intervalMs = 200) {
    dev.rec = [];
    dev._recT0 = performance.now();
    dev._recTimer = setInterval(() => {
      dev.rec.push({ t: Math.round(performance.now() - dev._recT0), ...snapshot() });
    }, intervalMs);
    return 'recording';
  },
  stopRecord() {
    if (dev._recTimer) clearInterval(dev._recTimer);
    dev._recTimer = null;
    return { n: dev.rec.length, rec: dev.rec };
  },
  // Run timed actions relative to now: [{ atMs, setRepeat?, seek?, fn? }].
  // With { record: true }, also sample state at `intervalMs`.
  async runTimeline(events, opts = {}) {
    const t0 = performance.now();
    const rec = opts.record ? [] : null;
    const timer = rec
      ? setInterval(() => rec.push({ t: Math.round(performance.now() - t0), ...snapshot() }), opts.intervalMs || 100)
      : null;
    await Promise.all(events.map((e) =>
      sleep(Math.max(0, e.atMs - (performance.now() - t0))).then(() => {
        dev.log.push({ atMs: e.atMs, event: e });
        if (e.setRepeat != null) dev.setRepeat(e.setRepeat);
        else if (e.seek != null) dev.seek(e.seek);
        else if (e.fn) e.fn(dev);
      })
    ));
    if (timer) clearInterval(timer);
    return { log: dev.log, samples: rec };
  },
};

window.__cpDev = dev;
whenAppReady().then(() => console.log('[dev] window.__cpDev ready'));
