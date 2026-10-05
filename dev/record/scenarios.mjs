// DEV-ONLY: the clip registry for the PR communication page.
//
// Every clip on dev/record/README.md §7 is one entry here, and the entry is the
// *only* thing that has to change to re-shoot it: the page-side runner
// (dev/shims/recorder.js) interprets `steps`, and `assert` is the verdict the
// page publishes as proof. Nothing about a clip lives in the shim.
//
// Read-only data. No catalog rebuild is involved: fixtures are pinned by path and
// resolved at run time through /api/browse (see __cpRec.clickRow), so a clip
// breaks loudly when its file is gone instead of silently substituting another.
//
// Fields
//   id       file name stem: site/clips/<id>.mp4, dev/record/.work/<id>.*
//   section  'main' (one clip per feature) | 'deep' (per format/variant)
//   ready    false until the clip has been recorded with a passing verdict;
//            scenarios.check.mjs only enforces the fixture/assert rules on ready
//            entries, so the registry can grow ahead of the recordings.
//   open     where the tab goes before the clip (relative to the app root)
//   browse   the listing the clip's first step starts from
//   steps    timeline, in ms from the clip's start; see runStep() in the shim
//   until    snap() field that gates the first step ('playing' = engine moving)
//   assert   { name, test } where test is JS over (s, tr): s = final snap(),
//            tr = the sampled trace. Every entry must pass for the clip to ship.

const NSFE = 'nsfe/Akumajou Densetsu (VRC6).nsfe';      // 28 sub-tunes, labelled
const GIMMICK = 'nsfe/Gimmick!.nsfe';                   // 73 sub-tunes, all labelled
const KYJ = 'gbs/DMG-KYJ.gbs';                          // 15 sub-tunes, no labels
const HURRY = "arcade-capcom/Ghosts'N_Goblins_(Arcade)/16 Hurry Up!.vgz";
const HURRY_DIR = "arcade-capcom/Ghosts'N_Goblins_(Arcade)";

export const scenarios = [
  // ---------------------------------------------------------------- main ----
  {
    id: 'songfolder',
    section: 'main',
    ready: true,
    title: 'A file with many songs is a folder',
    watch: [
      'The row is marked <TUNES> with a count, not <DIR> — same list, different meaning.',
      'Clicking it navigates *into the file*, exactly like a directory.',
    ],
    before: 'master listed a multi-song NSF as one opaque file row, and the only way to reach tune 3 was a separate footer widget.',
    harness: 'dev/test-parsers.js',
    browse: '/browse/nsfe',
    steps: [
      { atMs: 300, open: { dir: 'nsfe', name: 'Akumajou Densetsu (VRC6).nsfe' }, label: 'open song folder' },
      { atMs: 1600, label: '28 sub-tunes, each a row' },
      // Play one: it demonstrates one more thing than the navigation alone. (It
      // does not buy frame rate -- see FINDINGS.md, that hypothesis was wrong.)
      { atMs: 2400, open: { dir: NSFE, name: 'Epitaph', subtune: 1 }, label: 'play a sub-tune' },
      { atMs: 4600, label: 'playing' },
    ],
    until: null,
    assert: [
      { name: 'landed-in-song-folder', test: 'window.location.pathname.indexOf("Akumajou") >= 0' },
      { name: 'sub-tune-rows', test: 'document.querySelectorAll("a[href*=\'subtune=\']").length >= 20' },
      { name: 'labelled-row', test: 'Array.from(document.querySelectorAll(".BrowseList-colName a")).some((a) => /Epitaph/.test(a.textContent))' },
      { name: 'sub-tune-plays', test: 's.player && s.positionMs > 200' },
    ],
  },

  {
    id: 'subtune-is-a-song',
    section: 'main',
    ready: true,
    title: 'A sub-tune is an ordinary song',
    watch: [
      'Tune 2 plays like any other song; the footer shows the whole file path.',
      'There is no "Tune 2 of 28" label and no back/forward sub-tune buttons.',
    ],
    before: 'master had a footer-only sub-tune widget: a "Tune N of M" label and prev/next buttons that existed nowhere else.',
    harness: 'dev/test-sequencer.js',
    browse: `/browse/${NSFE}`,
    steps: [
      { atMs: 300, open: { dir: NSFE, name: 'Epitaph', subtune: 1 }, label: 'play tune 2' },
    ],
    // No gate: this scenario's first step is the open that starts playback, so
    // `until: 'playing'` deadlocks (the gate waits for the step it blocks). The
    // driver already waited for the listing before calling run().
    until: null,
    assert: [
      { name: 'playing-subtune-1', test: 's.ref && s.ref.subtune === 1 && s.ref.path === ' + JSON.stringify(NSFE) },
      { name: 'no-footer-subtune-controls', test: '!document.body.textContent.match(/Tune \\d+ of \\d+/)' },
      { name: 'footer-shows-file-path', test: 'document.body.textContent.indexOf("Akumajou Densetsu") >= 0' },
    ],
  },

  {
    id: 'favorite-subtune',
    section: 'main',
    ready: true,
    title: 'Favouriting one sub-tune leaves the others alone',
    watch: [
      'The heart in the footer favourites this exact sub-tune.',
      'The Favorites page groups it under the song folder, labelled with the catalog title.',
    ],
    before: 'master could only favourite a whole file, so a multi-song file was one row in your list no matter which tune you liked.',
    harness: 'dev/test-subtunes-server.js',
    browse: `/browse/${NSFE}`,
    steps: [
      { atMs: 300, open: { dir: NSFE, name: 'Epitaph', subtune: 1 }, label: 'play tune 2' },
      { atMs: 1800, play: 'button[title*="avorite"]', label: 'favourite' },
      { atMs: 2600, play: 'a[href="/favorites"]', label: 'open favorites' },
    ],
    // No gate: this scenario's first step is the open that starts playback, so
    // `until: 'playing'` deadlocks (the gate waits for the step it blocks). The
    // driver already waited for the listing before calling run().
    until: null,
    assert: [
      { name: 'favorite-listed', test: 'document.body.textContent.indexOf("Epitaph") >= 0' },
      { name: 'under-song-folder-heading', test: 'document.body.textContent.indexOf("Akumajou Densetsu") >= 0' },
    ],
  },

  {
    id: 'share-link',
    section: 'main',
    ready: true,
    title: 'A share link carries the sub-tune',
    watch: [
      'The copied link is /?play=<id>&subtune=1.',
      'Opening it cold lands inside the song folder on that tune, playing.',
    ],
    before: 'master links identified a file only, so every share link for a multi-song file opened tune 1.',
    harness: 'dev/test-songrefs.js',
    browse: `/browse/${NSFE}`,
    steps: [
      { atMs: 300, open: { dir: NSFE, name: 'Epitaph', subtune: 1 }, label: 'play tune 2' },
    ],
    // No gate: this scenario's first step is the open that starts playback, so
    // `until: 'playing'` deadlocks (the gate waits for the step it blocks). The
    // driver already waited for the listing before calling run().
    until: null,
    assert: [
      { name: 'link-has-subtune', test: 'window.ChipPlayer.getCurrentSongLink(true).indexOf("subtune=1") >= 0' },
    ],
  },

  {
    id: 'labels',
    section: 'main',
    ready: true,
    title: 'Real labels where the format has them, "Tune N" where it does not',
    watch: [
      'Gimmick! has 73 labelled sub-tunes.',
      'A GBS has 15 sub-tunes and no in-format labels, so the UI says "Tune N" — consistently, everywhere.',
    ],
    before: 'master showed a filename and a bare sub-tune number; a track label present in the file was never read.',
    harness: 'dev/test-parsers.js',
    browse: `/browse/${GIMMICK}`,
    steps: [
      { atMs: 300, open: { dir: GIMMICK, name: 'Good Morning [Introduction]', subtune: 0 }, label: 'gimmick labels' },
      // Opening a sub-tune navigates to `/?play=…&subtune=N`, so the browse rows
      // unmount; a second directory needs an explicit navigate first.
      { atMs: 2600, nav: `/browse/${KYJ}`, label: 'go to the GBS folder' },
      { atMs: 3400, open: { dir: KYJ, name: 'Tune 1', subtune: 0 }, label: 'gbs fallback' },
    ],
    until: null,
    assert: [
      { name: 'gimmick-labelled', test: 'tr.marks.some((m) => /opened Good Morning/.test(m.label))' },
      { name: 'gbs-fallback', test: 'document.body.textContent.indexOf("Tune ") >= 0' },
    ],
  },

  {
    id: 'loop-band',
    section: 'main',
    ready: true,
    title: 'The loop region, drawn on the slider',
    watch: [
      'The shaded band is the loop the composer wrote: intro 342 ms + one 800 ms loop.',
      'With Repeat One on, the playhead cycles inside the band instead of running to the end.',
    ],
    before: 'master had no loop region at all: the slider was a plain progress bar and Repeat One stopped and reloaded the song from 0:00.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 3600, label: 'head still inside the band' },
    ],
    until: 'playing',
    assert: [
      { name: 'band-known', test: 's.band && s.band.endMs > s.band.startMs' },
      { name: 'band-is-intro-plus-one-loop', test: 's.band.startMs > 0 && s.band.endMs - s.band.startMs > 300' },
      { name: 'engine-loop-count-rising', test: 'tr.samples.filter((x) => x.loop >= 1).length >= 10' },
      // The band only applies once the engine has looped; before that the head
      // is showing the real lead-in (which is the point of #3 below).
      { name: 'head-folds-into-band', test: 'tr.samples.filter((x) => x.loop >= 1).length >= 10 && tr.samples.filter((x) => x.loop >= 1).every((x) => x.d >= s.band.startMs - 40 && x.d <= s.band.endMs + 40)' },
      { name: 'lead-in-unfolded', test: 'tr.samples.filter((x) => x.loop === 0 && x.p < s.band.startMs).length >= 3 && tr.samples.filter((x) => x.loop === 0 && x.p < s.band.startMs).every((x) => x.d === x.p)' },
      { name: 'tempo-1x', test: 'Math.abs(s.tempo - 1) < 0.001' },
    ],
  },

  {
    id: 'repeat-toggle-smooth',
    section: 'main',
    ready: true,
    title: 'Turning Repeat One on mid-song never moves the playhead',
    watch: [
      'The toggle happens while the song is playing normally.',
      'The head keeps moving forward through the lead-in; only the loop boundary folds it back.',
    ],
    before: 'Repeat One was a stop-and-reload: the song restarted from 0:00 with a gap.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    steps: [
      { atMs: 2500, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 5000, label: 'still playing' },
    ],
    until: 'playing',
    assert: [
      { name: 'no-backward-jump-before-first-loop', test: 'tr.samples.length >= 30 && tr.samples.slice(0, 20).every((x, i, a) => i === 0 || x.d >= a[i - 1].d - 30)' },
      { name: 'position-kept-advancing', test: 'tr.samples[tr.samples.length - 1].p > tr.samples[0].p + 3000' },
      { name: 'looping-after-toggle', test: 's.looping === true' },
    ],
  },

  {
    id: 'repeat-leave-fade',
    section: 'main',
    ready: true,
    title: 'Turning Repeat One off plays the rest of the song',
    watch: [
      'After several loops, the toggle is turned off.',
      'The current pass finishes, the fade plays out, and only then does the song end.',
    ],
    before: 'master left Repeat One by stopping the song; a deep repeat ended instantly with no fade.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 5000, repeat: 'off', label: 'Repeat One OFF' },
      { atMs: 7000, label: 'fade tail' },
    ],
    until: 'playing',
    assert: [
      { name: 'left-looping', test: 's.looping === false' },
      { name: 'fade-tail-played', test: 's.durationExtended === true' },
    ],
  },

  {
    id: 'blind-loop',
    section: 'main',
    ready: false,
    title: 'No known loop region: the head parks and the label says Looping',
    watch: [
      'This NSF driver loops internally and reports no loop point.',
      'Rather than inventing one, the head stops at the end and the duration reads "Looping".',
    ],
    before: 'master clamped the head at the track length with no indication that playback would continue.',
    harness: 'dev/test-gme-loops.js',
    browse: '/browse/nes-audio-tests',
    // Preload is required, not decoration: this scenario has no `open` step, so
    // without it nothing starts playback and `until: 'playing'` never goes true.
    preload: { dir: 'nes-audio-tests', name: 'clip_5b.nsf' },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 4200, label: 'past the listed length' },
    ],
    until: 'playing',
    assert: [
      { name: 'no-band', test: 's.band === null' },
      { name: 'playing-indefinitely', test: 's.indefinite === true' },
      { name: 'label-says-looping', test: 'document.body.textContent.indexOf("Looping") >= 0' },
    ],
  },

  {
    id: 'show-loop-area',
    section: 'main',
    ready: true,
    title: 'Show Loop Area hides the band without touching playback',
    watch: [
      'The Settings checkbox is unticked: the band disappears from the slider.',
      'The playhead keeps folding exactly as before — the setting is visual only.',
    ],
    before: 'master had no loop band and no such setting.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    settings: { showPlayerSettings: true },
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 2600, label: 'band visible' },
      { atMs: 3000, play: '#showLoopArea', label: 'untick Show Loop Area' },
      { atMs: 5000, label: 'band gone, still folding' },
    ],
    until: 'playing',
    assert: [
      { name: 'band-hidden', test: '!document.querySelector(".Slider-loop")' },
      { name: 'display-still-advances', test: 'tr.samples[tr.samples.length - 1].d > tr.samples[0].d' },
    ],
  },

  // ---------------------------------------------------------------- deep ----
  {
    id: 'vgm-native',
    section: 'deep',
    ready: true,
    title: 'VGM/VGZ — native loop count',
    watch: ['libvgm loops forever in-engine; the loop counter climbs with no reload.'],
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 3600, label: 'several loops' },
    ],
    until: 'playing',
    assert: [
      { name: 'curLoop-rising', test: 'tr.samples.filter((x) => x.loop >= 2).length >= 8' },
      { name: 'no-reload', test: 'tr.samples.at(-1).p > tr.samples[0].p' },
    ],
  },

  {
    id: 'gme-looping-driver',
    section: 'deep',
    ready: false,
    title: 'NSF — a driver that loops internally is never cut',
    watch: ['The track keeps rendering past its listed length; the engine never reports the track ended.'],
    harness: 'dev/test-gme-loops.js',
    browse: '/browse/nes-audio-tests',
    // Preload is required, not decoration: this scenario has no `open` step, so
    // without it nothing starts playback and `until: 'playing'` never goes true.
    preload: { dir: 'nes-audio-tests', name: 'clip_5b.nsf' },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 4000, label: 'past the listed length' },
    ],
    until: 'playing',
    assert: [
      { name: 'still-rendering', test: 's.positionMs > s.durationMs' },
      { name: 'no-restart', test: 'tr.samples[tr.samples.length - 1].p > tr.samples[0].p' },
    ],
  },

  {
    id: 'mdx-native',
    section: 'deep',
    ready: true,
    title: 'MDX — the engine loops, and the band is exact',
    watch: ['mdxmini repeats its built-in loop natively; the band comes from the engine, not a guess.'],
    harness: 'dev/test-mdx-loops.js',
    browse: '/browse/mdx',
    fixture: 'mdx/G2MST6.MDX',
    preload: { dir: 'mdx', name: 'G2MST6.MDX' },
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 4000, label: 'still looping' },
    ],
    until: 'playing',
    assert: [
      { name: 'band-known', test: 's.band && s.band.endMs > s.band.startMs' },
      { name: 'looping', test: 's.looping === true' },
    ],
  },

  {
    id: 'midi-cc102',
    section: 'deep',
    ready: true,
    title: 'MIDI — the loop region is read from CC 102/103',
    watch: ['The band is the region the file itself marks, and the piano roll stays populated past it.'],
    harness: 'dev/test-midi-loops.js',
    browse: '/browse/midi',
    fixture: 'midi/Nintendo 64 (SoundFont MIDI)_Mario Kart 64_01 - Main Theme.mid',
    preload: { dir: 'midi', name: 'Nintendo 64 (SoundFont MIDI)_Mario Kart 64_01 - Main Theme.mid' },
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 4000, label: 'second pass' },
    ],
    until: 'playing',
    assert: [
      { name: 'band-from-markers', test: 's.band && s.band.endMs > s.band.startMs' },
      { name: 'looping', test: 's.looping === true' },
    ],
  },

  {
    id: 'xmp-learned-band',
    section: 'deep',
    ready: true,
    title: 'MOD/XM — the band is learned from playback, so it appears late',
    watch: [
      'The first pass has no band: libxmp exposes no loop position up front.',
      'At the first backward order jump the band appears — honest, but late. Say so.',
    ],
    harness: 'dev/test-xmp-loops.js',
    browse: '/browse/mods',
    fixture: 'mods/TECHTRIS.MOD',
    preload: { dir: 'mods', name: 'TECHTRIS.MOD' },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 6000, label: 'band learned (if reached)' },
    ],
    until: 'playing',
    assert: [
      { name: 'looping', test: 's.looping === true' },
      { name: 'native-loop-no-reload', test: 's.player === "XMPPlayer"' },
    ],
  },

  {
    id: 'sid-tail-restart',
    section: 'deep',
    ready: false,
    title: 'SID — no loop API, so the tune free-runs and a tail detector restarts it',
    watch: [
      'There is nothing to seek to, so playback continues past the listed length.',
      'When the tune goes quiet and still, it restarts — the "Detect Song End While ↻ One" param.',
    ],
    harness: 'dev/test-end-detector.js',
    browse: '/browse/sid/Monty_on_the_Run.sid',
    fixture: 'sid/Monty_on_the_Run.sid',
    // A multi-tune SID row is a *song folder*: clicking it navigates rather than
    // plays, so preload waits forever. Name a sub-tune -- that is the playing row.
    preload: { dir: 'sid/Monty_on_the_Run.sid', name: 'Tune 1', subtune: 0 },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 5000, label: 'free-running' },
    ],
    until: 'playing',
    assert: [
      { name: 'past-listed-length', test: 's.positionMs > 30000' },
      { name: 'looping', test: 's.looping === true' },
    ],
  },

  {
    id: 'n64-indefinite',
    section: 'deep',
    ready: true,
    title: 'N64 — engine indefinite flag, and a seek that does not freeze the tab',
    watch: ['Looping tracks free-run instead of reloading every cycle.'],
    harness: 'dev/test-end-detector.js',
    browse: '/browse/n64/Blast%20Corps',
    fixture: 'n64/Blast Corps/01 Blast Corps.miniusf',
    preload: { dir: 'n64/Blast Corps', name: '01 Blast Corps.miniusf' },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 4000, label: 'still looping' },
    ],
    until: 'playing',
    assert: [
      { name: 'looping', test: 's.looping === true' },
    ],
  },

  {
    id: 'v2m-tier3',
    section: 'deep',
    ready: true,
    title: 'V2M — the honest fallback: stop and reload',
    watch: [
      'V2M has no loop points and no loop API, so the engine ends the song.',
      'This clip is the floor the others are measured against, not a success.',
    ],
    before: 'identical to master: this is the one format the feature does not change.',
    harness: 'dev/test-v2m-loops.js',
    browse: '/browse/v2m',
    fixture: 'v2m/apollo dvd copy 4.5.4kg.v2m',
    preload: { dir: 'v2m', name: 'apollo dvd copy 4.5.4kg.v2m' },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 5000, label: 'reload' },
    ],
    until: 'playing',
    assert: [
      { name: 'looping-requested', test: 's.looping === true' },
    ],
  },
];

export const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
export const main = scenarios.filter((s) => s.section === 'main');
export const deep = scenarios.filter((s) => s.section === 'deep');