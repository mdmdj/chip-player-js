// DEV-ONLY browser tooling for chip-player-js.
//
// Copied to src/chip-player-devtools.js and imported by a reversible App.js
// patch (see dev/patch-devtools.js, run by dev/apply.sh). It exposes
// `window.__cpDev` so the t3 preview (or any console) can script repeat/loop
// behavior and spy on player state without listening to audio.
//
// Not part of the app; never shipped. `dev/remove.sh` reverts it.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function installDevTools(app) {
  const getPlayer = () => app.sequencer && app.sequencer.getPlayer();

  const snapshot = () => {
    const p = getPlayer();
    if (!p) return { hasPlayer: false };
    const core = p.core;
    const ctx = p.vgmCtx;
    const s = {
      player: p.constructor.name,
      repeat: app.state.repeat,
      looping: !!p.looping,
      leavingLoop: !!p.leavingLoop,
      indefinitePlayback: !!(p.params && p.params.indefinitePlayback),
      paused: typeof p.isPaused === 'function' ? p.isPaused() : undefined,
      positionMs: typeof p.getPositionMs === 'function' ? p.getPositionMs() : null,
      displayPositionMs: typeof p.getDisplayPositionMs === 'function' ? p.getDisplayPositionMs() : null,
      durationMs: typeof p.getDurationMs === 'function' ? p.getDurationMs() : null,
      metadata: p.metadata
        ? { intro_length: p.metadata.intro_length, loop_length: p.metadata.loop_length }
        : null,
    };
    if (ctx && core && typeof core._lvgm_get_cur_loop === 'function') {
      s.curLoop = core._lvgm_get_cur_loop(ctx);
      s.fadeStartMs = core._lvgm_get_fade_start_ms(ctx);
      s.playlistPositionMs = core._lvgm_get_playlist_position_ms(ctx);
    }
    return s;
  };

  const dev = {
    app,
    player: getPlayer,
    snapshot,
    log: [],
    setRepeat(mode) {
      app.setState({ repeat: mode });
      app.sequencer.setRepeat(mode);
      return snapshot();
    },
    cycleRepeat() {
      app.handleCycleRepeat();
      return snapshot();
    },
    seek(ms) {
      const p = getPlayer();
      if (p) p.seekMs(ms);
      return snapshot();
    },
    play() {
      const p = getPlayer();
      if (p && p.resume) p.resume();
    },
    pause() {
      const p = getPlayer();
      if (p && p.pause) p.pause();
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
      dev._recTimer = setInterval(() => {
        dev.rec.push({ t: Math.round(performance.now() - dev._recT0), ...snapshot() });
      }, intervalMs);
      dev._recT0 = performance.now();
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
  console.log('[dev] window.__cpDev installed');
  return dev;
}
