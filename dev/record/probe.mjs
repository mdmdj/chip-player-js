// DEV-ONLY: measure a fixture in the live app (dev/record/README.md).
//
//   node dev/record/probe.mjs <url> [seek|watch] [arg]
//
// Why this exists: the clip registry pins fixtures by path, but the numbers a
// clip's assertions depend on -- GME's `play_length`, SID's listed length and
// its end-detector trip gate -- are parsed at load by the engine or defaulted,
// not stored in the catalog (catalog `subtune.length_ms` is NULL for both). So
// they have to be *measured* in the running app, not read from the DB.
//
// Same launch shape as shoot.mjs (own browser, one node process) so it never
// rides the preview tab's flaky evaluate transport. All measurement happens in
// ONE page.evaluate per phase and returns scalars/short arrays: the point is to
// keep the output small enough to read.

import { chromium } from 'playwright';

const BASE = process.env.RECORD_BASE || 'http://mms-1:8080';
const target = process.argv[2];
const mode = process.argv[3] || 'seek';
const arg = process.argv[4];
if (!target) {
  console.error('usage: probe.mjs <url> [seek|watch] [arg]');
  process.exit(1);
}

const round = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n) : n);

// Installed once: a 200 ms state sampler the phases read from. Sampling in the
// page (rather than polling from node) keeps a 60 s watch to one round trip.
const INSTALL_SAMPLER = () => {
  const pl = () => window.ChipPlayer.sequencer.getPlayer();
  const round = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n) : n);
  window.__probe = { on: false, samples: [] };
  // Tap the app's own gain node (never a system device -- this host has none) so a
  // seek can be checked for *audible* content, not just a moving clock. A clip that
  // seeks into a silent tail would pass every position assertion and still be unwatchable.
  let ana = null;
  try {
    const g = window.ChipPlayer.gainNode;
    ana = g.context.createAnalyser();
    ana.fftSize = 2048;
    g.connect(ana);
    window.__probe.rms = () => {
      const b = new Float32Array(ana.fftSize);
      ana.getFloatTimeDomainData(b);
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i] * b[i];
      return Math.sqrt(s / b.length);
    };
  } catch { /* no graph yet */ }
  window.__probe.info = () => {
    const p = pl();
    if (!p) return { hasPlayer: false };
    return {
      player: p.constructor.name,
      path: window.ChipPlayer.sequencer.currSongPath,
      ref: window.ChipPlayer.sequencer.currSongRef,
      // durationMs IS the engine-reported length here (GME: metadata.play_length,
      // SID: subtuneDurations[]), which is exactly the number the DB does not have.
      durationMs: p.getDurationMs(),
      rawPlayLength: p.metadata ? p.metadata.play_length ?? null : null,
      tripAtMs: typeof p.getEndDetectTripAtMs === 'function' ? p.getEndDetectTripAtMs() : null,
      detectSongEnd: p.params ? p.params.detectSongEnd ?? null : null,
      band: p.getLoopBandMs ? p.getLoopBandMs() : null,
      indefinite: typeof p.isPlayingIndefinitely === 'function' ? p.isPlayingIndefinitely() : null,
    };
    // SID's listed lengths are not in the catalog: the core reports the RSID/PSID
    // MD5 of the loaded data, and the app fetches lengths from /api/hvsc?sidHash=
    // at load (falling back to a 150 s default). Surface the hash so the source of
    // the number can be checked from outside the page.
    try {
      if (typeof p.core?._sid_get_song_md5 === 'function') {
        s.sidMd5 = p.core.UTF8ToString(p.core._sid_get_song_md5());
      }
    } catch { /* no core */ }
  };
  window.__probe.tick = () => {
    if (!window.__probe.on) return;
    const p = pl();
    if (!p) return;
    window.__probe.samples.push({
      t: Math.round(performance.now()),
      p: round(p.getPositionMs()),
      d: round(p.getDisplayPositionMs()),
      dur: p.getDurationMs(),
      playing: !!p.isPlaying(),
      looping: !!p.looping,
      loopingUI: document.body.textContent.includes('Looping'),
      rms: window.__probe.rms ? Number(window.__probe.rms().toFixed(5)) : null,
      // The player's own last-rendered buffer. Distinguishes "the engine is
      // rendering silence" from "the audio graph stopped", which the gain-node tap
      // alone cannot: both read as near-zero RMS.
      buf: (() => {
        if (!p.wasmViewL || !p.bufferSize) return null;
        let sum = 0, n = 0;
        for (let i = 0; i < p.bufferSize; i += 8) { sum += Math.abs(p.wasmViewL[i]); n++; }
        return n ? Number((sum / n).toFixed(5)) : null;
      })(),
    });
  };
  window.__probe.timer = setInterval(window.__probe.tick, 200);
  return true;
};

// Sample for `ms`, then summarise: enough to see a sawtooth (reset) and whether
// the position crossed the reported length.
const SAMPLE = async (ms) => {
  window.__probe.on = true;
  await new Promise((r) => setTimeout(r, ms));
  window.__probe.on = false;
  const s = window.__probe.samples;
  const ps = s.map((x) => x.p).filter((n) => typeof n === 'number');
  let resets = 0;
  for (let i = 1; i < ps.length; i++) if (ps[i] < ps[i - 1] - 250) resets++;
  const dur = s.length ? s[s.length - 1].dur : null;
  return {
    n: s.length,
    first: ps[0] ?? null,
    last: ps[ps.length - 1] ?? null,
    min: ps.length ? Math.min(...ps) : null,
    max: ps.length ? Math.max(...ps) : null,
    dur,
    crossedLength: typeof dur === 'number' ? ps.some((v) => v >= dur) : null,
    resets,
    stillPlaying: s.length ? s[s.length - 1].playing : null,
    loopingUI: s.length ? s[s.length - 1].loopingUI : null,
    rmsMean: s.length ? Number((s.reduce((a, x) => a + (x.rms || 0), 0) / s.length).toFixed(5)) : null,
    rmsMax: s.length ? Number(Math.max(...s.map((x) => x.rms || 0)).toFixed(5)) : null,
    displayLast: s.length ? s[s.length - 1].d : null,
    trace: ps.filter((_, i) => i % 5 === 0).slice(0, 24),
  };
};

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 720, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));
// SID logs the HVSC payload it resolved at load, which is where its listed
// lengths come from -- the catalog has none. Surface it instead of guessing.
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('SIDPlayer: Got metadata')) console.log(`hvsc: ${t.slice(0, 400)}`);
});

const url = target.includes('?') ? `${target}&r=${Date.now()}` : `${target}?r=${Date.now()}`;
await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.ChipPlayer?.sequencer?.getPlayer?.(), null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.evaluate(INSTALL_SAMPLER);

const show = (label, o) => console.log(`${label}: ${JSON.stringify(o)}`);

show('info@load', await page.evaluate(() => window.__probe.info()));
// Repeat One, as the clip does at 100 ms: the blind-loop UI and the SID
// free-run only exist while the player is looping.
await page.evaluate(() => {
  window.ChipPlayer.sequencer.setRepeat(2);
  window.ChipPlayer.setState({ repeat: 2 });
});
await page.waitForTimeout(600);
show('info@repeat', await page.evaluate(() => window.__probe.info()));
show('sample@0', await page.evaluate(SAMPLE, mode === 'watch' ? 4000 : 6000));

if (mode === 'calls') {
  // Wrap the *instance's* bound copies (players are auto-bound, so patching the
  // prototype is a no-op) and log every restart/seek with the position around it.
  // Distinguishes "the restart ran and the engine stayed silent" from "something
  // else moved the transport back".
  await page.evaluate(() => {
    const p = window.ChipPlayer.sequencer.getPlayer();
    window.__calls = [];
    const wrap = (name) => {
      const orig = p[name];
      p[name] = function wrapped(...a) {
        const before = p.getPositionMs();
        const r = orig.apply(p, a);
        window.__calls.push({ name, args: a.slice(0, 2), before, after: p.getPositionMs(), t: Math.round(performance.now()) });
        return r;
      };
    };
    ['playSubtune', 'seekMs', 'stop', 'setTempo'].forEach(wrap);
  });
  await page.evaluate(SAMPLE, Number(arg) || 16000);
  show('calls', await page.evaluate(() => window.__calls));
  show('samples', await page.evaluate(() => {
    const s = window.__probe.samples;
    return s.filter((_, i) => i % 5 === 0).map((x) => `${Math.round(x.t / 100) / 10}s:p${x.p}:buf${x.buf}`);
  }));
}

if (mode === 'restart') {
  // Isolate the tail-restart mechanism from the tail detector: play, then call
  // playSubtune() on the *same* index -- exactly what SIDPlayer does when the
  // detector trips -- and watch the engine's own buffer. `arg` = ms to play first.
  const pre = Number(arg) || 3000;
  await page.evaluate(SAMPLE, pre);
  show('before restart', await page.evaluate(() => {
    const s = window.__probe.samples;
    const p = window.ChipPlayer.sequencer.getPlayer();
    return {
      buf: s.length ? s[s.length - 1].buf : null,
      rms: s.length ? s[s.length - 1].rms : null,
      pos: p.getPositionMs(),
      dur: p.getDurationMs(),
    };
  }));
  await page.evaluate(() => {
    const p = window.ChipPlayer.sequencer.getPlayer();
    window.__probe.samples = [];
    p.playSubtune(p.getSubtune());
  });
  await page.waitForTimeout(200);
  show('after restart+200ms', await page.evaluate(SAMPLE, 3000));
  await page.evaluate(SAMPLE, 3000);
  show('after restart+3.2s', await page.evaluate(SAMPLE, 3000));
}

if (mode === 'seek') {
  // arg = comma-separated ms targets; default: walk back from the reported
  // length, then step just past it.
  const info = await page.evaluate(() => window.__probe.info());
  const dur = Number(info.durationMs) || 0;
  const targets = arg
    ? arg.split(',').map((n) => Number(n.trim()))
    : [dur - 8000, dur - 3000, dur - 1000, dur + 500].filter((n) => n >= 0);
  for (const t of targets) {
    await page.evaluate((ms) => {
      const p = window.ChipPlayer.sequencer.getPlayer();
      window.__probe.samples = [];
      if (p) p.seekMs(ms);
    }, t);
    await page.waitForTimeout(250);
    show(`seek ${t}`, await page.evaluate(SAMPLE, Number(process.env.PROBE_HOLD) || 2500));
  }
}

if (mode === 'watch') {
  // SID: play from 0 and wait for the tail detector to restart the tune. Stops
  // on the first position reset after the reported length, or at the timeout.
  const limit = Number(arg) || 60000;
  const r = await page.evaluate(async (ms) => {
    window.__probe.on = true;
    const t0 = performance.now();
    const dur = window.__probe.info().durationMs;
    let restartedAt = null;
    while (performance.now() - t0 < ms) {
      await new Promise((res) => setTimeout(res, 200));
      const s = window.__probe.samples;
      if (s.length < 3) continue;
      for (let i = 2; i < s.length; i++) {
        if (s[i].p < s[i - 1].p - 250 && s[i - 1].p > dur * 0.5) {
          restartedAt = { at: Math.round(performance.now() - t0), from: s[i - 1].p, to: s[i].p };
          break;
        }
      }
      if (restartedAt) break;
    }
    window.__probe.on = false;
    const s = window.__probe.samples;
    return {
      dur,
      tripAtMs: window.__probe.info().tripAtMs,
      restartedAt,
      samples: s.length,
      maxP: s.length ? Math.max(...s.map((x) => x.p)) : null,
      rmsMin: s.length ? Number(Math.min(...s.map((x) => x.rms ?? 1)).toFixed(5)) : null,
      rmsMax: s.length ? Number(Math.max(...s.map((x) => x.rms ?? 0)).toFixed(5)) : null,
      rmsAfterRestart: s.length
        ? Number(Math.max(...s.slice(-8).map((x) => x.rms ?? 0)).toFixed(5))
        : null,
      last: s.length ? s[s.length - 1] : null,
      trace: s.filter((_, i) => i % 25 === 0).slice(0, 20).map((x) => `${x.t}:${x.p}`),
      // 1 Hz series of t:position:rms, so a frozen engine and a second quiet
      // tail are distinguishable (rms separates them; position alone does not).
      series: s.filter((_, i) => i % 5 === 0).map((x) => `${Math.round(x.t / 100) / 10}s:p${x.p}:rms${x.rms}:buf${x.buf}`),
    };
  }, limit);
  show('watch', r);
  show('info@end', await page.evaluate(() => window.__probe.info()));
}

await context.close();
await browser.close();