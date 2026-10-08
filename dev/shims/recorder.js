// DEV-ONLY browser tooling for repeatable clip recording (dev/record/README.md).
//
// Staged to `src/chip-player-record.js` (untracked, gitignored) by
// `dev/apply.sh` and injected into the dev bundle by the overlay-only webpack
// dev config entry, exactly like `chip-player-devtools.js`. Not part of the
// app; never shipped. `dev/remove.sh` deletes the staged file.
//
// Why it exists: a clip's two halves come from different places. The video is
// the host's tab recorder (preview_recording_start/stop) -- a DOM app has no
// canvas to capture and the preview exposes no getDisplayMedia. The audio is
// here: a MediaStreamAudioDestinationNode fed from the app's own gain node, so
// a clip carries the real mix even with no sound device present.
//
// Why it is scheduled rather than awaited: preview_evaluate times out at 15 s
// (measured), so a scenario cannot block a call for its whole duration.
// start() arms timers and returns a handle; finish() collects the verdict,
// the trace and the uploaded audio. The tab recorder runs host-side throughout,
// which also means a dropped preview tab mid-clip does not lose the take.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same module the app uses, so the API base follows NODE_ENV/host instead of
// being guessed at (dev server on :8080/api, prod on chiptune.app/api).
// eslint-disable-next-line global-require
const { API_BASE } = require('./config');

const app = () => window.ChipPlayer;
const player = () => {
  const a = app();
  return a && a.sequencer && a.sequencer.getPlayer();
};

// Pinned for every clip. `tempo` is the in-app Speed slider and is the one that
// actually bites: a stale `tempo: 2` left over from earlier debugging made every
// position advance at 1.99x, which would have baked double-speed "seamless
// loop" claims into the videos.
//
// The first five values mirror UserProvider's own DEFAULT_SETTINGS; `silenceDuration:
// -1` is that default ("Insert Silence: None"), and it matters: the base end
// detector is only armed when silenceDuration >= 0, so pinning 0 would arm it and
// let a looping clip be ended by a silence heuristic instead of by the behaviour
// under test. A clip that is *about* the detector overrides it.
// `showVisualizer: true` because the spectrum is the one thing in the frame that
// visibly reacts to the audio, which is the point of shipping audio in the clips.
const DEFAULT_SETTINGS = {
  showPlayerSettings: false,
  showVisualizer: true,
  theme: 'msdos',
  silenceDuration: -1,
  showLoopArea: true,
  tempo: 1,
  repeat: 0,
};

const REPEAT = { off: 0, all: 1, one: 2 };

// Generic, engine-agnostic player state. The devtools shim only exposes libvgm's
// loop fields, which makes cross-format assertions impossible; these are the
// hooks every player answers, with Player.js owning the vocabulary.
const snap = () => {
  const p = player();
  // The play context, read above the player check: "Shuffle Play shuffled a
  // directory" is a claim about how many entries the sequencer is walking and
  // how many files they live in, and that is true of the context whether or not
  // an engine happens to be attached to it at this instant.
  const ctx = (app().sequencer && app().sequencer.getCurrContext()) || [];
  const ctxLen = ctx.length;
  const ctxFiles = new Set(ctx.map((r) => r.path)).size;
  if (!p) return { hasPlayer: false, ctxLen, ctxFiles };
  const s = {
    player: p.constructor.name,
    path: app().sequencer.currSongPath,
    ref: app().sequencer.currSongRef,
    ctxLen,
    ctxFiles,
    paused: typeof p.isPaused === 'function' ? p.isPaused() : null,
    playing: typeof p.isPlaying === 'function' ? p.isPlaying() : null,
    looping: !!p.looping,
    tempo: typeof p.getTempo === 'function' ? p.getTempo() : null,
    positionMs: typeof p.getPositionMs === 'function' ? p.getPositionMs() : null,
    displayMs: typeof p.getDisplayPositionMs === 'function' ? p.getDisplayPositionMs() : null,
    durationMs: typeof p.getDurationMs === 'function' ? p.getDurationMs() : null,
    durationExtended: p.durationExtended ?? null,
    loopEndMs: typeof p.getLoopEndMs === 'function' ? p.getLoopEndMs() : null,
    band: typeof p.getLoopBandMs === 'function' ? p.getLoopBandMs() : null,
    indefinite: typeof p.isPlayingIndefinitely === 'function' ? p.isPlayingIndefinitely() : null,
    subtune: typeof p.getSubtune === 'function' ? p.getSubtune() : null,
    subtunes: typeof p.getNumSubtunes === 'function' ? p.getNumSubtunes() : null,
  };
  // The length the app is working from is engine-reported rather than catalogued
  // (GME parses play_length at load; SID fetches HVSC lengths over HTTP and falls
  // back to a default), so it cannot be read from the DB -- a clip that asserts
  // "past the reported length" has to see the number the player used. tripAtMs is
  // the tail detector's trip gate, which is what the SID clip's claim is about.
  if (typeof p.getEndDetectTripAtMs === 'function') s.tripAtMs = p.getEndDetectTripAtMs();
  if (p.params && 'detectSongEnd' in p.params) s.detectSongEnd = !!p.params.detectSongEnd;
  // libvgm's own loop counter: the one engine-specific number worth showing.
  if (p.vgmCtx && p.core && typeof p.core._lvgm_get_cur_loop === 'function') {
    s.curLoop = p.core._lvgm_get_cur_loop(p.vgmCtx);
    s.fadeStartMs = p.core._lvgm_get_fade_start_ms(p.vgmCtx);
  }
  if (typeof p.maxLoopCount !== 'undefined') s.maxLoopCount = p.maxLoopCount;
  // Is the *current* song a favourite? Favourites live in UserProvider's state, not
  // on the player, so the only observable is the button's own class -- which is
  // exactly what the eye checks, and it only flips once the POST has landed and the
  // context has re-fetched. A clip that claims to favourite something needs this,
  // because "the row is on the Favorites page" is also true of the previous take.
  // Scoped to the footer: the browse list has a heart per row, so an unscoped query
  // answers for row 1 rather than for what is playing.
  s.fav = !!document.querySelector('.AppFooter button.FavoriteButton.isFavorite');
  // Which SoundFont the synth is actually on. MIDI mounts the file's *own* sf2
  // asynchronously (MIDIPlayer.metadataFromFilepath), so for the first few hundred
  // ms of a take the synth is still on the default GM font while the transport is
  // already running. Measured on the Mario Kart fixture: position 0 and
  // isPlaying() false at 313 ms, both true and `user/...sf2` mounted at 585 ms.
  // A clip that claims "the file's own SoundFont is what you are hearing" cannot
  // read that off `playing`, so it reads the parameter -- and `fileSoundfont` is
  // what a scenario gates on, since that is the claim in one boolean.
  if (typeof p.getParameter === 'function' && p.params && 'soundfont' in p.params) {
    s.soundfont = p.getParameter('soundfont');
    s.fileSoundfont = !!(s.soundfont && String(s.soundfont).startsWith('user/'));
  }
  return s;
};

// Level meter on the app's own gain node (never a system device -- this host has
// none). Without it every assertion in a MIDI clip can pass while the synth is
// silent on a missing or wrong SoundFont: the transport moves, the band is
// reported, the position advances, and the published clip is 4 s of nothing. This
// is the same tap probe.mjs uses, and the same reason it is there.
let levelAnalyser = null;
const levelRms = () => {
  if (!levelAnalyser) return null;
  try {
    const b = new Float32Array(levelAnalyser.fftSize);
    levelAnalyser.getFloatTimeDomainData(b);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i] * b[i];
    return Number(Math.sqrt(sum / b.length).toFixed(5));
  } catch {
    return null;
  }
};

// Sampled state, so a clip's claim is backed by numbers rather than by what the
// recording happens to look like. Marks (from scenario steps) land in the same
// timeline, which is what makes the published proof readable.
const startTrace = (intervalMs = 100) => {
  const trace = { t0: Date.now(), marks: [], samples: [] };
  trace.mark = (label) => trace.marks.push({ t: Date.now() - trace.t0, label });
  const push = () => {
    const s = snap();
    // Sampled keys are deliberately the union of what the registered assertions
    // read. An assertion on `tr.samples` that reaches for a field the sampler does
    // not record silently sees `undefined` and fails for the wrong reason -- so
    // add the field here when an assertion needs it, do not assert on `s` instead.
    trace.samples.push({
      t: Date.now() - trace.t0,
      p: s.positionMs,
      d: s.displayMs,
      dur: s.durationMs,
      b: s.band,
      looping: s.looping,
      loop: s.curLoop,
      ind: s.indefinite,
sub: s.subtune,
      fav: s.fav,
      // Is the band element in the DOM right now? The engine still reports a band
      // while it is hidden (the setting is visual only), so a clip that toggles the
      // band off and on cannot be checked from `s.band` -- it needs the DOM, on every
      // tick, to show the band was actually absent for a stretch.
      hasBand: !!document.querySelector('.Slider-loop'),
      // Which song, per tick. The Sequencer can reload a different context entry
      // mid-take (that is what `nextSong` does when a song ends), and an assertion
      // that only looks at the final state cannot tell "reloaded the same song" from
      // "reloaded something else and it happens to be the last one".
      path: s.path,
      // Which page, per tick, decoded. A navigation clip's claim is about the pages
      // it passed *through*, and the final pathname says nothing about the other
      // seven -- and it lies about this one whenever a short song ends mid-take and
      // the sequencer advances underneath a folder page for the song it just left.
      loc: decodeURIComponent(window.location.pathname),
      // Is a row highlighted as the now-playing song right now? Sampled rather than
      // read at the end for the reason `path` is: the highlight is per-tick evidence
      // (VirtualizedList marks a row `Song-now-playing` from the sequencer's ref),
      // and a clip that walks through many song folders needs to know it was right
      // at the time, not only at the end.
      hl: !!document.querySelector('.Song-now-playing'),
      // Which song the highlighted row *is*, so "the chart highlights the sub-song
      // I am hearing" is checkable rather than merely plausible. Both charts and
      // browse rows carry `/?play=<songId>&subtune=N` on the name anchor, and the
      // chart names a sub-song row `<filename> (<label>)`, so the row's own text
      // plus its sub-tune parameter identify it against the playing song. Sampled
      // per tick because the highlight moves between rows during playback.
      hlName: (() => {
        const row = document.querySelector('.Song-now-playing');
        if (!row) return null;
        const a = row.querySelector('.BrowseList-colName a');
        return (a ? a.textContent : row.textContent).trim().slice(0, 80);
      })(),
      hlSub: (() => {
        const row = document.querySelector('.Song-now-playing');
        const a = row && row.querySelector('.BrowseList-colName a');
        const m = a && /subtune=(\d+)/.exec(a.getAttribute('href') || '');
        return m ? Number(m[1]) : null;
      })(),
      // ...and whether that row is inside the scroll container's box. The browse
      // list is virtualized: it renders about 33 rows and highlights one that the
      // viewer cannot see, so "a highlighted row exists" is not "the picture shows
      // a highlighted row". Sampled per tick because the two are different claims
      // and a clip about the highlight has to make the second one.
      hlInView: (() => {
        const row = document.querySelector('.Song-now-playing');
        const box = document.querySelector('.App-main-content-area');
        if (!row || !box) return false;
        const b = row.getBoundingClientRect();
        const c = box.getBoundingClientRect();
        return b.top >= c.top - 1 && b.bottom <= c.bottom + 1 && b.height > 0;
      })(),
      // Audibility, per tick. See levelRms: a MIDI clip whose SoundFont failed to
      // mount still advances the transport and still reports its band.
      rms: levelRms(),
    });
  };
  trace.mark('start');
  push();
  const timer = setInterval(push, intervalMs);
  trace.stop = () => { clearInterval(timer); push(); };
  return trace;
};

const audio = {
  dest: null,
  rec: null,
  chunks: [],
  startedAt: null,

  start() {
    const a = app();
    if (!a || !a.audioCtx || !a.gainNode) throw new Error('no audio graph: is the app booted?');
    if (this.rec) throw new Error('audio already recording');
    this.dest = a.audioCtx.createMediaStreamDestination();
    a.gainNode.connect(this.dest);
    this.chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    this.rec = new MediaRecorder(this.dest.stream, mime ? { mimeType: mime } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.startedAt = Date.now();
    this.rec.start();
    return this.startedAt;
  },

  async stop() {
    const rec = this.rec;
    if (!rec) throw new Error('audio not recording');
    const blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      rec.stop();
    });
    this.rec = null;
    this.chunks = [];
    // Only our mirror track; the app's own bus must keep playing afterwards.
    this.dest.stream.getTracks().forEach((t) => t.stop());
    try { app().gainNode.disconnect(this.dest); } catch { /* already gone */ }
    this.dest = null;
    return { blob, startedAt: this.startedAt };
  },

  async upload(blob, file) {
    // Same hostname as the page, never 127.0.0.1: the preview tab's browser is
    // sandboxed off the host's loopback (measured -- a fetch to
    // http://127.0.0.1:3999 fails with "Failed to fetch" while
    // http://mms-1:3999 returns 200), so the receiver has to be addressed the
    // way the app itself addresses the API (see src/config/index.js).
    const port = new URLSearchParams(window.location.search).get('recordPort') ?? '3999';
    const base = `http://${window.location.hostname}:${port}`;
    const res = await fetch(`${base}/upload?file=${encodeURIComponent(file)}`, {
      method: 'POST',
      body: blob,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()} (is dev/record/upload-server.mjs running on ${base}?)`);
    return res.json();
  },

  // Same receiver, but the payload is JSON: the proof a clip publishes
  // (verdict + trace) is bigger than preview_evaluate's 64 KB return limit, so
  // it goes to disk the same way the audio does.
  async uploadJson(obj, file) {
    return this.upload(new Blob([JSON.stringify(obj)], { type: 'application/json' }), file);
  },
};

// Repaint heartbeat. The host tab recorder is change-driven, not clock-driven:
// a 46 s take of a static page contained 4 frames, and a clip with no audio
// playing (so the spectrum visualiser never repaints) came out as a slideshow.
// Clips whose whole point is navigation have almost nothing moving, so without
// this they are 4-frame artefacts. A 2 px element nudged on every animation
// frame is enough to make the compositor produce a frame each time; it is
// invisible in the published clip and lives only in the dev shim.
const heartbeat = {
  el: null,
  timer: null,
  on: false,
  // A background-color toggle, not a transform nudge: the recorder is a
  // low-rate screencast that emits a frame when the page *paints*, and a
  // compositor-only transform on a 2 px element produced almost nothing extra
  // (measured: 81 frames over 78 s, i.e. the idle 1 fps). Forcing a real paint on
  // a small patch is what makes the page look changed to the capture pipeline.
  start() {
    if (this.on) return;
    const el = document.createElement('div');
    el.id = '__cpRecBeat';
    el.style.cssText = 'position:fixed;left:0;bottom:0;width:24px;height:24px;z-index:2147483646;pointer-events:none;opacity:0.04';
    document.body.appendChild(el);
    let i = 0;
    this.timer = setInterval(() => {
      i += 1;
      el.style.background = i % 2 ? 'rgb(255,255,255)' : 'rgb(0,0,0)';
    }, 66);
    this.el = el;
    this.on = true;
  },
  stop() {
    this.on = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.el) this.el.remove();
    this.el = null;
  },
};

// Full-viewport colour frame: the sync mark find-flash.sh looks for.
//
// It must be *green*, and that is not a style choice. A white mark is
// indistinguishable from the two other full-frame whites in a recording: the
// blank page the capture starts on, and the occasional blank frame Playwright's
// screencast emits mid-clip. find-flash.sh duly locked onto the page load and
// trimmed ~3.5 s early, which desynced the clip while every assertion still
// passed. Green is unique here by construction: the app is blue (high U) and
// yellow (high V) on near-black, so a frame that is bright with *both* U and V
// low cannot be app content, and a blank page is neutral (U = V = 128). No
// post-scaling by ffmpeg can produce that signature from white or grey.
const flash = (ms = 150, color = '#00ff00') => {
  const el = document.createElement('div');
  el.id = '__cpRecFlash';
  el.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${color};pointer-events:none`;
  document.body.appendChild(el);
  const at = Date.now();
  return new Promise((resolve) => setTimeout(() => {
    el.remove();
    resolve({ at, ms });
  }, ms));
};

// One step of a scenario. Data-shaped on purpose: the registry in
// dev/record/scenarios.mjs holds these literally, so a clip is re-shootable
// without editing the shim.
const runStep = (step, trace) => {
  const fire = (fn) => { try { fn(); } catch (e) { trace.mark(`ERROR ${step.label || ''}: ${e.message}`); } };
  if (step.open) fire(() => {
    dev.clickRow(step.open).then((r) => trace.mark(`opened ${r.name}${r.subtune != null ? ` #${r.subtune}` : ''}`))
      .catch((e) => trace.mark(`ERROR open ${e.message}`));
  });
  if (step.nav) fire(() => dev.navigate(step.nav));
  if (step.reveal) fire(() => {
    // The outcome is recorded, not just attempted. A reveal that found nothing is
    // a silent no-op that looks exactly like a reveal that worked -- the page is
    // unchanged either way -- which is the shape this pipeline keeps having to
    // guard against. Asynchronous because the listing may still be in flight.
    Promise.resolve(dev.revealPlayingSongWhenReady()).then(
      (r) => trace.mark(`reveal: ${r.alreadyVisible
        ? 'already visible'
        : r.revealed
          ? `${r.index == null ? 'the highlighted row' : `row ${r.index}`} -> ${r.scrolledTo}px`
          : `no-op (${r.why})`}`),
      (e) => trace.mark(`ERROR reveal: ${e.message}`));
  });
  if (step.play) fire(() => {
    const r = dev.tryClick(step.play, step.onlyIf);
    // A blocked click is marked, because a step that does nothing and a step that
    // did what it said look identical on screen -- the same trap as a selector
    // that matches nothing. The mark is also the clip's own record of why a beat
    // is missing, which is what the scenario's assertions fall back on.
    if (r.blocked) trace.mark(`skipped "${step.label || step.play}": ${r.why}`);
  });
  if (step.dbl) fire(() => dev.clickSelector(step.dbl, { dbl: true }));
  if (step.seek != null) fire(() => { const p = player(); if (p) p.seekMs(step.seek); });
  if (step.repeat != null) fire(() => {
    const mode = typeof step.repeat === 'string' ? REPEAT[step.repeat] : step.repeat;
    app().setState({ repeat: mode });
    app().sequencer.setRepeat(mode);
  });
  if (step.tempo != null) fire(() => {
    const p = player();
    if (p) p.setTempo(step.tempo);
    app().setState({ tempo: step.tempo });
  });
  if (step.param) fire(() => app().handleParamChange(step.param[0], step.param[1]));
  if (step.eval) fire(() => { if (!step.eval()) trace.mark(`assert failed: ${step.label || step.eval}`); });
  if (step.label) trace.mark(step.label);
};

const dev = {
  snap,
  sleep,
  audio,
  flash,
  heartbeat,
  repeat: REPEAT,

  /** Generic click: CSS selector, or a `sel` matched by substring. */
  clickSelector(sel, opts = {}) {
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch {
      el = [...document.querySelectorAll('button, [role="button"], a')].find((n) => n.textContent.includes(sel));
    }
    if (!el) return { clicked: false, sel };
    const type = opts.dbl ? 'dblclick' : 'click';
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, sel, label: el.textContent.trim().slice(0, 40) };
  },

  /**
   * `clickSelector`, optionally behind a named guard.
   *
   *   onlyIf: 'song-folder-link'  click only while the footer's folder path still
   *                               points at the song that is playing *now*
   *
   * That guard exists because a shuffled directory is full of one-second sound
   * effects, and the sequencer advances by itself when one ends. By the time the
   * scenario gets round to clicking the folder path, the link belongs to the song
   * that just ended, so the click navigates to *its* folder -- and the take then
   * shows a folder page whose highlighted row is not the song in the footer, which
   * is precisely the "green verdict over a frame that does not show the claim"
   * failure this file keeps having to guard against. Skipping is honest and the
   * skip is recorded; navigating to the song that *is* playing would paper over it.
   */
  tryClick(sel, guard) {
    if (guard === 'song-folder-link') {
      const a = app();
      const song = a && a.sequencer && a.sequencer.currSongPath;
      const link = document.querySelector('.AppFooter .SongDetails-filepath a');
      // The href is react-router's doubly-encoded form; one decode matches the
      // path the link was built from, which is what the app compares against.
      const href = link ? decodeURIComponent(link.getAttribute('href') || '').split('?')[0] : null;
      if (!song || href !== `/browse/${song}`) {
        return { clicked: false, blocked: true, sel, why: 'the footer still links the previous song' };
      }
    }
    return { blocked: false, ...this.clickSelector(sel) };
  },

  // VirtualizedList activates a row on double-click, and Favorites/LocalFiles
  // rows are not anchors at all, so a real dblclick is sometimes the only way in.
  dblclick(sel) {
    return this.clickSelector(sel, { dbl: true });
  },

  /**
   * Client-side navigate to a browse path, the way an in-app breadcrumb does.
   *
   * Needed because clicking a sub-tune row *leaves* the listing: the row's href is
   * `/?play=<id>&subtune=N`, so the app goes to the home route and the browse rows
   * unmount. A scenario that has to show two different directories in one take
   * therefore cannot open rows in both -- the second `open` fails with "row not
   * rendered", and that error is about the *previous* navigation, not the row.
   *
   * A plain `location.href = ...` would reload the page and destroy the run
   * (the trace, the audio recorder and the pending assertions all live in the
   * document), so this pushes state and fires `popstate`, which is what
   * react-router v5 listens for.
   */
  navigate(browsePath) {
    const path = browsePath.startsWith('/') ? browsePath : `/browse/${browsePath}`;
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return { navigated: path };
  },

  /**
   * Scroll the list until the *playing* song's row is on screen.
   *
   * Two cases, because two different lists are involved. On a song folder the
   * list is virtualized, so "the app highlights the playing row" is only a claim
   * about the picture while the row is rendered -- a folder of 73 sub-tunes
   * renders about 33 of them, so a row for sub-tune 60 of a shuffled song is
   * simply not in the DOM at scrollTop 0. That is why this exists rather than an
   * assertion: the alternative was a take that is green on 7 takes in 10 and
   * shows nothing on the other 3. On a list that is *not* virtualized (Top
   * Charts) the row is already rendered and this is just a scroll, so it needs
   * no index and no knowledge of the page -- which is why it is written as one
   * function rather than a per-page hook.
   *
   * Three things here are measured rather than guessed, and each replaced a
   * version that looked fine and did not work:
   *
   *  - The row is found by matching the app's own listing against the
   *    *sequencer's* ref, which is the same `songRefKey` comparison
   *    VirtualizedList highlights with. The player's `getSubtune()` is not a
   *    usable index: measured on the nsfe fixtures, it disagreed with the
   *    sequencer's ref on 2 of 14 songs (56 vs 19), because GME reports the
   *    track it loaded after the file's `plst` remap while the app's identity is
   *    the sub-tune the shuffle asked for. Scrolling to the player's number
   *    scrolled to the wrong row, or off the end of a 23-row list.
   *  - The scroll is a direct `scrollTop` write, not `list.scrollToRow`. That is
   *    measured working where `scrollToRow` is not: it is a no-op on this list,
   *    because the WindowScroller forwards positions to a List whose visible slice
   *    is already what `scrollToRow`'s visibility test thinks about. Writing
   *    `scrollTop` on the scroll element fires the scroll event VirtualizedList
   *    listens for, and it follows. 10/10 songs in view, where the imperative call
   *    managed 3/4 of the ones it was asked to move.
   *  - Nothing is scrolled when the row is already visible. A shuffle draws a
   *    sub-tune index uniformly, so most songs need no scroll at all, and a jump
   *    on every one would be noise in a clip about something else.
   *
   * Returns what it did, so a scenario can assert the beat actually happened
   * rather than trusting that a scroll that changed nothing still looks fine.
   */
  revealPlayingSong() {
    const a = app();
    const scroller = document.querySelector('.App-main-content-area');
    const ref = a && a.sequencer && a.sequencer.currSongRef;
    if (!scroller || !ref) return { revealed: false, why: 'no list open' };
    const row = document.querySelector('.Song-now-playing');
    const box = scroller.getBoundingClientRect();
    const inView = (el) => {
      const b = el.getBoundingClientRect();
      return b.top >= box.top - 1 && b.bottom <= box.bottom + 1 && b.height > 0;
    };
    const scrollRowIntoView = () => {
      // A list that is not virtualized has already rendered the row, so this is all
      // that is needed -- and it needs no index and no per-list arithmetic, which is
      // what makes it work on a page this shim knows nothing about (the Top Charts
      // list). Nudged to put the row a little below the top edge rather than flush
      // against it, so it is plainly in the middle of the picture.
      const b = row.getBoundingClientRect();
      const target = scroller.scrollTop + (b.top - box.top) - 24;
      scroller.scrollTop = Math.max(0, Math.round(target));
      return { revealed: true, scrolledTo: scroller.scrollTop };
    };

    // On a page that is not a song folder -- Top Charts, Favorites -- the highlighted
    // row is the thing to show, and it is already in the DOM.
    if (decodeURIComponent(window.location.pathname) !== `/browse/${ref.path}`) {
      if (row) return inView(row) ? { revealed: true, alreadyVisible: true } : scrollRowIntoView();
      return { revealed: false, why: 'no highlighted row on this page' };
    }

    const key = (r) => `${r.path}\u0000${r.subtune ?? 0}`;
    const browsePath = decodeURIComponent(window.location.pathname).replace(/^\/browse\//, '');
    const items = (a.state.directories && a.state.directories[browsePath]) || [];
    // Distinguishing "not here yet" from "not here to be found" matters, because
    // only the first is worth waiting for. The second means the sequencer moved on
    // to a song in another file while this folder was on screen -- which the short
    // SFX tracks in a shuffled directory do often enough to matter -- and no amount
    // of waiting puts the playing song into this listing.
    if (!items.length) return { revealed: false, why: 'listing not fetched yet', retry: true };
    const index = items.findIndex((it) => key(it) === key(ref));
    if (index < 0) return { revealed: false, why: 'the playing song is not a row in this listing', rows: items.length };
    if (row && inView(row)) return { revealed: true, alreadyVisible: true, index };
    const rowHeight = parseInt(getComputedStyle(scroller).getPropertyValue('--rowHeight'), 10);
    if (!rowHeight) return { revealed: false, why: 'no --rowHeight on the scroll container' };
    // The listing is virtualized, so the row for a high sub-tune may not be rendered
    // at all and there is nothing to scroll *to*: index off the app's own listing,
    // matched against the sequencer's ref -- never the player's getSubtune(), which
    // reports the track GME loaded after the file's `plst` remap and disagreed with
    // it on 2 of 14 songs. The scrollTop write is deliberate: list.scrollToRow is a
    // no-op on this WindowScroller/List pair, and this works 10/10.
    scroller.scrollTop = index * rowHeight;
    return { revealed: true, index, scrolledTo: scroller.scrollTop };
  },

  /**
   * `revealPlayingSong`, retried while the listing is still in flight.
   *
   * The clip steps click a folder link and then reveal 1100ms later, which is
   * usually but not always after the listing has been fetched: a 74-row folder
   * whose rows are still being measured is not ready, and the single-shot version
   * no-op'd on exactly those. Measured on the nsfe fixtures, the takes that came
   * out with an unhighlighted list were the ones whose reveal landed first.
   */
  async revealPlayingSongWhenReady(waitMs = 1600, stepMs = 60) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const r = this.revealPlayingSong();
      if (r.revealed || !r.retry || Date.now() > deadline) return r;
      await sleep(stepMs);
    }
  },

  /**
   * Resolve a Browse row from the listing API, then click the DOM row whose
   * name cell matches *exactly*. AGENTS.md records the alternative -- matching
   * loose text -- as the cause of a whole round of voided conclusions
   * (a `text=TECHTRIS.MOD` click landed on THALAMUS.MOD), so nothing here
   * fuzzy-matches. The API decides which row is meant; the DOM only supplies
   * the anchor.
   *
   *   open: { dir, name }                  -> a file row in `dir`
   *   open: { dir: '<song file path>', subtune }  -> sub-tune rows share one path,
   *                                             so they are matched by label
   */
  async clickRow({ dir, name, subtune = null }) {
    // ".." is not a listing row: App.js unshifts it client-side (and omits it at
    // the top level), so there is nothing to look up over the browse API. Click the
    // rendered anchor by exact text instead. Kept ahead of the fetch so a back
    // navigation costs one round trip less, not one more.
    if (name === '..') {
      const cell = [...document.querySelectorAll('.BrowseList-row .BrowseList-colName')]
        .find((c) => c.querySelector('a')?.textContent.trim() === '..');
      if (!cell) throw new Error('no ".." row rendered (top level has none)');
      cell.querySelector('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { name: '..', type: 'directory', url: null, subtune: null };
    }
    const rows = await (await fetch(`${API_BASE}/browse?path=${encodeURIComponent(dir)}`)).json();
    const wantPath = `${dir.replace(/\/$/, '')}/${name}`;
    let row = null;
    if (subtune == null) {
      row = rows.find((r) => r.path === wantPath) || rows.find((r) => r.name === name);
    } else {
      row = rows.find((r) => r.name === name && r.subtune === subtune);
      if (!row) row = rows.find((r) => r.subtune === subtune);
    }
    if (!row) throw new Error(`no listing row for ${JSON.stringify({ dir, name, subtune })}`);
    // A directory listing has no `name` field -- the browser derives it from the
    // path. Sub-tune rows do carry one (the label, or "Tune N").
    const label = row.name || row.path.slice(row.path.lastIndexOf('/') + 1);

    const cell = [...document.querySelectorAll('.BrowseList-row .BrowseList-colName')]
      .find((c) => {
        const a = c.querySelector('a');
        return a && a.textContent.trim() === label;
      });
    if (!cell) throw new Error(`row not rendered (scrolled out?): ${label}`);
    const anchor = cell.querySelector('a');
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { name: label, type: row.type, url: row.url, subtune: row.subtune ?? null };
  },

  /**
   * Get to the clip's starting state *before* the host recorder starts: open the
   * fixture by exact name and wait for the engine to actually move. Without this
   * every take would contain a file load, and the load is not what the clip is
   * about.
   */
  async preload({ dir, name, seek = 0 }) {
    const opened = await this.clickRow({ dir, name });
    const playing = await this.waitForSong(20000);
    if (playing.timeout) throw new Error(`preload: ${opened.name} never started playing`);
    // Rewind to the top so the take always shows the same part of the song.
    // Without this the clip depends on how long the tool round-trips took
    // between preload and preview_recording_start, and a clip that starts at
    // 4:00 of a 6:00 song cannot show the lead-in at all.
    if (seek != null) {
      const p = player();
      if (p) p.seekMs(seek);
      await sleep(400);
    }
    return { opened, playing };
  },

  /** Assert where we ended up, so a mis-aimed click can never pass silently. */
  where() {
    const a = app();
    return {
      url: window.location.pathname,
      songPath: a.sequencer.currSongPath,
      ref: a.sequencer.currSongRef,
    };
  },

  /**
   * Pin every setting a clip can be perturbed by, in BOTH stores: UserProvider
   * boots with {...localSettings, ...serverSettings}, so a local-only write is
   * undone by the next navigation. The server's POST /user/settings replaces the
   * whole object, which is what drops stale pinned player params (`gme.subbass`,
   * `n64.indefinitePlayback`) rather than merging them back.
   */
  async pinDefaults(overrides = {}) {
    const a = app();
    const clean = { ...DEFAULT_SETTINGS, ...overrides };
    const user = a.props && a.props.userContext && a.props.userContext.user;
    if (user && typeof user.getIdToken === 'function') {
      const token = await user.getIdToken();
      const res = await fetch(`${API_BASE}/user/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(clean),
      });
      if (!res.ok) throw new Error(`pinDefaults: POST /user/settings -> ${res.status}`);
    }
    a.props.userContext.replaceSettings(clean);
    const p = player();
    if (p && typeof p.setTempo === 'function') p.setTempo(clean.tempo);
    a.setState({ tempo: clean.tempo, repeat: clean.repeat });
    if (a.sequencer.setRepeat) a.sequencer.setRepeat(clean.repeat);
    return clean;
  },

  /**
   * Empty the signed-in user's favourites, so a take that demonstrates favouriting
   * starts from an empty list and the row the viewer sees appear is unambiguously
   * the one the clip just added.
   *
   * Needed because the Favorites page is *virtualized*: measured 33 rows in the DOM
   * against a 33-row list that the nsfe group sat outside of. A clip that clicks the
   * heart and then shows the page cannot claim "your favourite is listed" if the
   * group is scrolled out of frame -- and worse, "Epitaph" and the folder name are
   * on screen anyway in the *footer*, which still shows the playing song, so text
   * assertions pass while the claim is not visible. Accumulated dev-user favourites
   * also made the page content differ from take to take.
   *
   * Dev-only and reversible in the sense that matters: it only empties the dev user's
   * list, and the next take re-adds what it needs. The server has no bulk clear, so
   * this removes them one at a time through the same endpoint the UI uses.
   */
  async clearFavorites() {
    const a = app();
    const user = a.props && a.props.userContext && a.props.userContext.user;
    if (!user || typeof user.getIdToken !== 'function') return { cleared: 0, skipped: 'no user' };
    const token = await user.getIdToken();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const res = await fetch(`${API_BASE}/user/favorites`, { headers });
    if (!res.ok) throw new Error(`clearFavorites: GET /user/favorites -> ${res.status}`);
    const { favorites } = await res.json();
    let cleared = 0;
    // Toggle through the app rather than POSTing /favorites/remove directly, and that
    // is the fix for the second silent no-op this function had. `faves` is seeded from
    // localStorage, so clearing only the *server* left the client still believing the
    // old favourites existed -- the clip's heart click then read "already favourited"
    // and REMOVED it, and the take ended with an empty list. handleToggleFavorite
    // re-reads the server and rewrites localStorage on every call, so going through it
    // keeps all three stores (React state, localStorage, server) in step.
    //
    // Sequential on purpose: each toggle re-reads the whole list, so overlapping them
    // would race the state this is resetting.
    for (const f of favorites || []) {
      // eslint-disable-next-line no-await-in-loop
      await a.props.userContext.handleToggleFavorite(f.path, f.subtune ?? 0, f.songId);
      cleared++;
    }
    return { cleared, had: (favorites || []).length };
  },

  /** Resolve once a player exists and the engine has actually started moving. */
  async waitForSong(timeoutMs = 20000) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      const p = player();
      if (p && p.isPlaying && p.isPlaying() && p.getPositionMs() > 0) return snap();
      await sleep(100);
    }
    return { timeout: true, ...snap() };
  },

  /**
   * Arm a clip in one call: preload, then flash, then schedule the steps.
   *
   * The order is load-bearing and was found the hard way. Loading the song
   * *before* the host recorder starts looks tidier, but each tool round trip
   * costs seconds, the pinned settings have Repeat One OFF, and a song shorter
   * than the round trip ends while nobody is watching -- the sequencer then
   * advances and the take silently records the *next* song in the directory.
   * Loading inside the window cannot race; the flash then marks the instant to
   * trim to, which removes the load from the published clip.
   *
   * Because the audio mirror also starts at the flash, both streams share an
   * origin by construction (audioStartToFlashMs is 0) and need no offset.
   *
   * Returns immediately: preview_evaluate times out at 15 s, so a scenario may
   * not block a call for its whole duration.
   */
  async run(spec) {
    if (dev._run) throw new Error('a clip is already running; call abort() first');

    // Delayed start. preview_evaluate fails at the transport level while the host
    // tab recorder is streaming (measured: five consecutive kicks with nothing
    // running on the page, all of which landed fine once the recorder stopped), so
    // the only reliable protocol is to have *no* evaluate inside the recorded
    // window: schedule the take here, let the host start recording, and let the
    // page run the whole take on its own timers. The verdict is read after the
    // recorder stops.
    if (spec.delayMs) {
      dev._pending = setTimeout(() => {
        dev._pending = null;
        this.run({ ...spec, delayMs: 0 });
      }, spec.delayMs);
      return { scheduled: true, startsInMs: spec.delayMs, name: spec.name };
    }

    const { name, preload, steps = [], until = null, preRoll } = spec;
    let opened = null;
    if (preload) opened = await this.preload(preload);

    // Off-screen pre-roll: seek *before* the trace, the audio recorder and the flash,
    // so none of it is in the published clip.
    //
    // Built for N64/USF, whose seek renders forward to the target and takes a moment
    // to catch up -- measured on '04 Time to Get Moving!': asking for 60000 reads
    // 43451 immediately and 60518 once settled, so a seek recorded on camera shows a
    // lurch and a pause rather than a jump. Seeking first and letting it settle turns
    // that into a clip that simply starts partway through the song, which is the
    // honest way to skip an intro nobody wants to watch.
    //
    // `settleMs` is measured, not guessed: the take must not start until the position
    // has stopped catching up, so this waits for it to actually stabilise rather than
    // sleeping a fixed time that a slower machine would not honour.
    let preRolled = null;
    if (preRoll) {
      const { seek, settleMs = 6000, minMs = 400 } = preRoll;
      const q = player();
      if (!q) throw new Error('pre-roll needs a player; is the song loaded?');
      const before = q.getPositionMs();
      q.seekMs(seek);
      const t0 = Date.now();
      let last = q.getPositionMs();
      let stableFor = 0;
      // Stable = the position moved by less than ~1 frame in 250 ms, while the engine
      // is still playing. A seek that is genuinely stuck therefore never "settles" and
      // the clip fails loudly at the timeout instead of recording a frozen engine.
      while (Date.now() - t0 < settleMs) {
        await sleep(250);
        const now = player() ? player().getPositionMs() : null;
        if (now == null) break;
        if (Math.abs(now - last) < 60) {
          stableFor += 250;
          if (stableFor >= minMs) break;
        } else {
          stableFor = 0;
        }
        last = now;
      }
      const q2 = player();
      preRolled = {
        askedMs: seek,
        settledMs: Math.round(q2 ? q2.getPositionMs() : NaN),
        errorMs: Math.round((q2 ? q2.getPositionMs() : NaN) - seek),
        tookMs: Date.now() - t0,
        fromMs: Math.round(before),
        playing: q2 && typeof q2.isPlaying === 'function' ? q2.isPlaying() : null,
      };
    }

    const trace = startTrace(spec.intervalMs ?? 100);
    // Tap the app's gain node for the level meter the trace samples. Created here,
    // not at module load, because the audio graph does not exist until the app has
    // booted; a null analyser makes levelRms() return null, so an assertion that
    // needs audio fails loudly instead of reading a fabricated 0.
    try {
      const g = app().gainNode;
      levelAnalyser = g.context.createAnalyser();
      levelAnalyser.fftSize = 2048;
      g.connect(levelAnalyser);
    } catch {
      levelAnalyser = null;
    }
    heartbeat.start();
    const audioStartedAt = audio.start();
    const flashMark = flash(spec.flashMs ?? 150);
    trace.mark('clip start');

    const span = Math.max(...steps.map((st) => st.atMs || 0), 0);
    let armed = !until;
    const arm = () => {
      armed = true;
      clearInterval(dev._armTimer);
      trace.mark('armed');
      steps.forEach((step) => setTimeout(() => runStep(step, trace), step.atMs || 0));
      // Finish on a page-side timer rather than waiting for a tool call. The
      // finalize-and-upload step is long and lands right where the tool call
      // boundary is least reliable; doing it here means the agent's second call
      // is a small read of an already-computed result. Everything is idempotent
      // per run, so a dropped tool call costs nothing.
      if (spec.assert) {
        dev._finisher = setTimeout(() => {
          this.finish(spec.assert)
            .then((r) => { dev._result = r; dev._finishing = false; })
            .catch((e) => { dev._result = { error: String((e && e.message) || e) }; dev._finishing = false; });
        }, span + (spec.finishAfterMs ?? 600));
      }
    };
    if (armed) arm(); else {
      // The gate is bounded and says so out loud. An open-ended poll is how a
      // clip whose `until` field can never be true (e.g. 'hasPlayer' on a clip
      // that never plays a song) records an empty take with no error anywhere:
      // the take looked fine and showed nothing.
      const gateStart = Date.now();
      const gateLimitMs = spec.untilTimeoutMs ?? 10000;
      dev._armTimer = setInterval(() => {
        if (snap()[until]) return arm();
        if ((Date.now() - gateStart) > gateLimitMs) {
          clearInterval(dev._armTimer);
          trace.mark(`GATE TIMEOUT: until="${until}" never became true in ${gateLimitMs}ms`);
          if (spec.assert) {
            dev._finisher = setTimeout(() => {
              this.finish(spec.assert)
                .then((r) => { dev._result = r; dev._finishing = false; })
                .catch((e) => { dev._result = { error: String((e && e.message) || e) }; dev._finishing = false; });
            }, 200);
          }
        }
        return undefined;
      }, 100);
    }

    dev._run = { name, steps, trace, audioStartedAt, flashMark, t0: Date.now(), opened, preRolled };
    dev._result = null;
    dev._finishing = false;
    // preRolled is returned (and lands in the proof) so the seek's accuracy is on the
    // record. A pre-roll that silently landed somewhere else would make the clip's
    // position claims uncheckable, which is the same "green verdict, wrong artefact"
    // shape this whole pipeline keeps having to guard against.
    return {
      name, t0: dev._run.t0, audioStartedAt, opened: opened ? opened.opened.name : null,
      steps: steps.length, span, preRolled,
    };
  },

  /** Small read of the finished take; safe to call repeatedly. */
  result() {
    if (dev._result) return dev._result;
    return { pending: !!dev._run || !!dev._finishing };
  },

  /** Drop a stuck run (a failed tool call mid-take) so the next clip is clean. */
  abort() {
    clearInterval(dev._armTimer);
    clearTimeout(dev._finisher);
    clearTimeout(dev._pending);
    dev._pending = null;
    heartbeat.stop();
    dev._run = null;
    dev._finishing = false;
    dev._result = null;
    try { if (audio.rec) { audio.rec.onstop = null; audio.rec.stop(); } } catch { /* already stopped */ }
    audio.rec = null;
    audio.chunks = [];
    if (audio.dest) {
      try { audio.dest.stream.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
      try { app().gainNode.disconnect(audio.dest); } catch { /* gone */ }
      audio.dest = null;
    }
    return 'aborted';
  },

  /**
   * Collect the take: stop the trace, finalize + upload the audio, and evaluate
   * the scenario's assertions against the trace and the final state. Returns
   * everything the page publishes as proof. `assert` entries are
   * { name, test } where test is a JS expression over (s, tr).
   */
  async finish(assertions = []) {
    // Built-in guard, not optional: a take that recorded the wrong song is the
    // one failure mode the page cannot detect by looking at it. If the run
    // preloaded a fixture and something else is playing at the end (the song
    // ended mid-take and the sequencer advanced, a step clicked the wrong row),
    // the clip is void even if every scenario assertion passes.
    const run = dev._run;
    if (!run) throw new Error('no clip running');
    clearInterval(dev._armTimer);
    // Stay "pending" for the whole of finish(), including the audio finalize and
    // upload: result() keys off dev._run, so clearing it first told a polling
    // driver the take was complete before the verdict existed.
    dev._finishing = true;
    dev._run = null;
    run.trace.stop();
    heartbeat.stop();
    const { blob, startedAt } = await audio.stop();
    const uploaded = await audio.upload(blob, `${run.name}.webm`);
    const flashMark = await run.flashMark;

    const s = snap();
    const tr = run.trace;
    const verdict = {};
    for (const a of assertions) {
      let pass = false;
      let detail = null;
      try {
        // eslint-disable-next-line no-new-func
      pass = !!new Function('s', 'tr', `return (${a.test});`)(s, tr);
      } catch (e) {
        detail = e.message;
      }
      verdict[a.name] = { pass, detail };
    }
    // A gate that timed out, or a step that threw, is a failed take even when
    // every assertion happens to hold: the marks are the only record of what the
    // clip was supposed to do.
    const badMark = tr.marks.find((m) => /^(GATE TIMEOUT|ERROR)/.test(m.label));
    if (badMark) verdict['scenario-ran-cleanly'] = { pass: false, detail: badMark.label };
    if (run.opened && run.opened.playing && run.opened.playing.path) {
      const want = run.opened.playing.path;
      verdict['expected-song-still-playing'] = { pass: s.path === want, detail: want };
    }

    const proof = {
      name: run.name,
      pass: assertions.length > 0 && assertions.every((a) => verdict[a.name].pass),
      verdict,
      audio: {
        startedAt,
        flashAt: flashMark.at,
        bytes: blob.size,
        uploaded: uploaded.path,
        // Mux calibration: how far into the audio the flash landed. mux.sh
        // pairs this with find-flash.sh's video timestamp.
        audioStartToFlashMs: flashMark.at - startedAt,
      },
      marks: tr.marks,
      trace: tr.samples,
      final: s,
      // null for every clip that does not use one; present so a pre-roll's landing
      // accuracy is auditable from the proof alone.
      preRoll: run.preRolled || null,
    };
    const proofUp = await audio.uploadJson(proof, `${run.name}.proof.json`);
    // The returned value stays small on purpose: the full trace went to disk,
    // and a big evaluate payload is the one thing that reliably fails here.
    return {
      name: run.name,
      pass: proof.pass,
      verdict,
      audio: proof.audio,
      proofPath: proofUp.path,
      marks: tr.marks,
      traceSamples: tr.samples.length,
      final: s,
    };
  },
};

window.__cpRec = dev;
console.log('[dev] window.__cpRec ready');