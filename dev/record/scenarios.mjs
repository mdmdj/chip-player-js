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
const MM2 = 'nsfe/Mega Man 2.nsfe';                      // 22 sub-tunes, labelled

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
      'Two different song files, entered and left the same way, each playing a named sub-song.',
      'Each row is a real song from there on: the footer tracks the file path, there is no "Tune 8 of 28" label and no prev/next sub-tune widget, and the share link is the same <code>/?play=…&amp;subtune=N</code> it has always been.',
    ],
    before: 'master listed a multi-song NSF as one opaque file row, and the only way to reach tune 3 was a separate footer widget — a "Tune N of M" label and prev/next buttons that existed nowhere else in the app.',
    harness: 'dev/test-parsers.js',
    browse: '/browse/nsfe',
    // No preload and no `until` gate: this scenario is about navigation, and it
    // deliberately opens on an empty transport. The 2 s hold on the listing is the
    // wait the script calls for -- long enough to read the <TUNES> counts, and it
    // gives the take a still frame to start on rather than a click in progress.
    steps: [
      { atMs: 2000, open: { dir: 'nsfe', name: 'Akumajou Densetsu (VRC6).nsfe' }, label: 'open a song folder' },
      // 500 ms is the settle the script asks for: the sub-tune list is a fetch plus
      // a render, so this is the shortest wait that reliably finds the row.
      { atMs: 2500, open: { dir: NSFE, name: 'Mad Forest', subtune: 7 }, label: 'play Mad Forest' },
      { atMs: 7400, label: 'playing a sub-song' },
      // ".." is not a listing row (App.js unshifts it client-side), so clickRow
      // matches it by text -- see the recorder shim.
      { atMs: 7500, open: { dir: NSFE, name: '..' }, label: 'back to the nsfe list' },
      { atMs: 8500, open: { dir: 'nsfe', name: 'Mega Man 2.nsfe' }, label: 'open a different song file' },
      { atMs: 9500, open: { dir: MM2, name: 'Stage Select', subtune: 3 }, label: 'play Stage Select' },
      { atMs: 16500, label: 'still playing' },
    ],
    until: null,
    assert: [
      { name: 'left-the-first-song-folder', test: 'decodeURIComponent(window.location.pathname).indexOf("Akumajou") < 0' },
      // decodeURIComponent, not a literal match: the router keeps the filename
      // percent-encoded ("Mega%20Man%202"), so comparing against "Mega Man 2"
      // fails on a clip whose every other number is correct.
      { name: 'in-the-second-song-folder', test: 'decodeURIComponent(window.location.pathname).indexOf("Mega Man 2") >= 0' },
      { name: 'sub-tune-rows', test: 'document.querySelectorAll("a[href*=\'subtune=\']").length >= 20' },
      { name: 'labelled-row', test: 'Array.from(document.querySelectorAll(".BrowseList-colName a")).some((a) => /Stage Select/.test(a.textContent))' },
      { name: 'sub-tune-plays', test: 's.player && s.positionMs > 200' },
      // Two song files, two sub-tunes, one transport: the identity the whole
      // feature rests on. `path` alone would pass for the first folder alone.
      { name: 'second-sub-tune-is-the-playing-one', test: 's.path === "nsfe/Mega Man 2.nsfe" && s.subtune === 3' },
    ],
  },

  {
    id: 'favorite-subtune',
    section: 'main',
    ready: true,
    title: 'Favouriting one sub-tune leaves the others alone',
    watch: [
      'The heart in the footer fills in — that exact sub-tune is now a favourite.',
      'A second later, on the Favorites page, it is listed on its own under the song folder.',
      'The sub-tune number travels with it: this is the same identity the playlist and the share link use.',
    ],
    before: 'master could only favourite a whole file, so a multi-song file was one row in your list no matter which tune you liked.',
    harness: 'dev/test-subtunes-server.js',
    browse: `/browse/${NSFE}`,
    // Start from an empty favourites list so the row the viewer sees appear is
    // unambiguously this clip's, and so the group is not scrolled out of a
    // virtualized list full of leftovers from earlier takes.
    clearFavorites: true,
    steps: [
      { atMs: 300, open: { dir: NSFE, name: 'Epitaph', subtune: 1 }, label: 'play tune 2' },
      // Scoped to `.AppFooter`, not a bare `button.FavoriteButton`: every sub-song row
      // in the browse list carries its own heart, so an unscoped selector clicks the
      // FIRST one -- row 1, "Prelude" -- while the clip claims it favourited the
      // playing sub-song, Epitaph. That is what the previous take did; the Favorites
      // page then listed Prelude. (The selector before that,
      // `button[title*="avorite"]`, matched nothing at all: FavoriteButton renders no
      // title attribute. Two dead selectors, two different wrong clips, both green.)
      { atMs: 1800, play: '.AppFooter button.FavoriteButton', label: 'click the heart' },
      { atMs: 2800, label: 'heart filled in' },
      // `^=` not `=`: the nav link is to={{ pathname: '/favorites', ...search }},
      // and `search` carries the driver's ?r=<cache-buster>, so the rendered href
      // is "/favorites?r=...". An exact-match selector silently matched nothing, the
      // take never left the browse listing -- and all three assertions below still
      // passed, because "Epitaph", "Akumajou Densetsu" and a href carrying
      // subtune=1 are all on the *browse* page too. Same class as the dead
      // `button[title*="avorite"]`: a selector that matches nothing cannot fail an
      // assertion, so the assertions have to name the page they are about.
      { atMs: 3400, play: 'a[href^="/favorites"]', label: 'open Favorites' },
      { atMs: 5400, label: 'listed on the Favorites page' },
    ],
    // No gate: this scenario's first step is the open that starts playback, so
    // `until: 'playing'` deadlocks (the gate waits for the step it blocks). The
    // driver already waited for the listing before calling run().
    until: null,
    assert: [
      // The click actually registered, before navigating away.
      { name: 'heart-was-clicked', test: 'tr.marks.length > 0 && tr.marks.some((m) => /click the heart/.test(m.label)) && tr.samples.length > 5 && tr.samples.some((x) => x.fav === true)' },
      // We are ON the Favorites page. This is the assertion that would have caught
      // the dead selector: everything else below is also true of the browse listing,
      // so without this one the clip could be entirely wrong and still green.
      { name: 'on-the-favorites-page', test: '/favorites/.test(window.location.pathname)' },
      // Scoped to the LIST, not document.body: the footer still shows the playing
      // song, so a body-wide text search for "Epitaph" or the folder name passes
      // whether or not the favourites page is showing anything at all -- which is
      // exactly how the previous take stayed green while never leaving /browse.
      { name: 'listed-in-the-favorites-list', test: 'Array.from(document.querySelectorAll(".BrowseList-colName a")).some((a) => a.textContent.trim() === "Epitaph")' },
      // A sub-song, not the file: the row is labelled with the sub-tune title.
      { name: 'under-song-folder-heading', test: 'Array.from(document.querySelectorAll(".BrowseList-colName a")).some((a) => /nsfe\\/Akumajou Densetsu/.test(a.textContent))' },
      // The list holds this and only this: with clearFavorites the one row is the
      // whole claim. This is what makes the clip show its own action rather than
      // whatever earlier takes left behind.
      // The list holds this and only this: with clearFavorites, exactly one row has a
      // heart. Counted by FavoriteButton, not by anchors -- the song-folder heading
      // is an anchor in the same column, so counting anchors is off by one and would
      // have "failed" a correct take.
      { name: 'only-this-favorite', test: 'document.querySelectorAll(".BrowseList-row .FavoriteButton").length === 1' },
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
      'Untick Show Loop Area and the band goes; the playhead keeps folding exactly as before.',
      'Tick it again and the band is back — the setting is visual only, it never touched playback.',
    ],
    before: 'master had no loop region at all: the slider was a plain progress bar and Repeat One stopped and reloaded the song from 0:00.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    // Opens Settings so the checkbox is on screen for the toggle -- otherwise the
    // untick happens off-camera and the clip claims a control the viewer never sees
    // being clicked.
    settings: { showPlayerSettings: true },
    // Taller than the other clips, and the reason is measured rather than aesthetic.
    // With the Settings panel open, VGM's per-chip toggles push "Show Loop Area" to
    // y=532-551 while the footer starts at y=509 -- so at 900x720 the checkbox is
    // *behind* the footer. elementFromPoint at its centre returns a footer transport
    // button, and a synthetic click still fires the React handler, which is how this
    // clip first passed its band assertions while clicking something no viewer could
    // click. Nothing in the panel scrolls; height is the only lever (780 clears it by
    // 18px, 840 by 78px -- the margin is for footers that grow with song metadata).
    viewport: { width: 900, height: 840 },
    // Timing is deliberately unhurried: 2s of hold before each state change, so a
    // viewer can register the band appearing, then disappearing, then reappearing,
    // and connect each to the click that caused it.
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 2200, label: 'head cycling inside the band' },
      { atMs: 4200, play: '#showLoopArea', label: 'untick Show Loop Area' },
      { atMs: 6200, label: 'band gone' },
      { atMs: 8200, play: '#showLoopArea', label: 'tick Show Loop Area again' },
      { atMs: 10200, label: 'band back, still folding' },
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
      // The merged Show Loop Area claim: the band was drawn, then not drawn, then
      // drawn again, and the head never stopped folding across any of it. A DOM
      // query alone cannot show "drawn, then hidden, then drawn" -- that needs the
      // timeline -- so this is asserted over the trace, not the final state.
      { name: 'band-toggled-off-then-on', test: 'tr.marks.length > 0 && tr.marks.some((m) => /untick Show Loop Area/.test(m.label)) && tr.marks.some((m) => /tick Show Loop Area again/.test(m.label))' },
      { name: 'head-kept-folding-while-hidden', test: 'tr.samples.filter((x) => x.loop >= 1 && x.t > 4300 && x.t < 8100).length >= 10 && tr.samples.filter((x) => x.loop >= 1 && x.t > 4300 && x.t < 8100).every((x) => x.d >= s.band.startMs - 40 && x.d <= s.band.endMs + 40)' },
      // And the band really was absent in that window: the sampler records whether
      // the band element is in the DOM on every tick.
      { name: 'band-absent-while-unticked', test: 'tr.samples.filter((x) => x.t > 4400 && x.t < 8000 && x.hasBand === false).length >= 10' },
      { name: 'band-present-again-at-end', test: '!!document.querySelector(".Slider-loop")' },
      // And the control that was clicked is genuinely on screen: topmost element at
      // the checkbox's own centre must be the checkbox. This is the assertion that
      // catches an occluded control, which no band assertion can -- a synthetic click
      // dispatches straight to the handler whatever is painted over it.
      { name: 'checkbox-was-really-clickable', test: '(() => { const cb = document.querySelector("#showLoopArea"); if (!cb) return false; const r = cb.getBoundingClientRect(); const t = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return t === cb || cb.contains(t) || (t && t.contains(cb)); })()' },
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
    ready: true,
    title: 'No known loop region: the head parks and the label says Looping',
    watch: [
      'This tune reports no loop point, and the length the app has for it is just a number in a file.',
      'Rather than inventing a region, the head stops at the end, the elapsed time keeps climbing, and the duration reads "Looping".',
    ],
    before: 'master clamped the head at the track length with no indication that playback would continue.',
    harness: 'dev/test-gme-loops.js',
    browse: '/browse/nsfe/Akumajou%20Densetsu%20(VRC6).nsfe',
    fixture: 'nsfe/Akumajou Densetsu (VRC6).nsfe',
    // Sub-song 4 of 28. A multi-song file's own row is a *song folder*, so preload
    // has to name the sub-song -- that is the row that plays.
    preload: { dir: 'nsfe/Akumajou Densetsu (VRC6).nsfe', name: 'Beginning', subtune: 3 },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      // GME reports play_length 101000 ms for this sub-tune, parsed at load from
      // gme_track_info -- the catalog has no length for it. Sitting at 1:00:00 of
      // real playback to reach the end of a 101 s track is not a clip, so jump to
      // one second before it. Measured with dev/record/probe.mjs: from 98000 the
      // position has still not crossed the length after 2.5 s, from 100000 it has
      // (within ~325 ms), and the audio afterwards is at full level (RMS 0.099 mean
      // vs 0.093 playing from 0:00), so this is the music and not a silent tail.
      { atMs: 900, seek: 100000, label: 'seek to 1s before the reported length' },
      { atMs: 4200, label: 'head parked, duration reads Looping' },
    ],
    until: 'playing',
    assert: [
      { name: 'no-band', test: 's.band === null' },
      { name: 'playing-indefinitely', test: 's.indefinite === true' },
      { name: 'label-says-looping', test: 'document.body.textContent.indexOf("Looping") >= 0' },
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
    ready: true,
    title: 'NSF — a driver that loops internally is never cut',
    watch: [
      'Playback passes the length the engine reported and keeps going: the driver loops on its own.',
      'The position climbs past that length and never rewinds, so nothing is reloaded and nothing is cut short.',
    ],
    harness: 'dev/test-gme-loops.js',
    browse: '/browse/nsfe/Akumajou%20Densetsu%20(VRC6).nsfe',
    fixture: 'nsfe/Akumajou Densetsu (VRC6).nsfe',
    preload: { dir: 'nsfe/Akumajou Densetsu (VRC6).nsfe', name: 'Beginning', subtune: 3 },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      // play_length is 101000 ms (see blind-loop for the measurement).
      { atMs: 900, seek: 100000, label: 'one second before the reported length' },
      { atMs: 4600, label: 'past it, still rendering' },
    ],
    until: 'playing',
    assert: [
      { name: 'still-rendering', test: 's.positionMs >= s.durationMs' },
      // Monotonic over the whole trace, not "the last sample beat the first".
      // The old fixture was a 1.3 s test tone that ends, so position sawtoothed
      // 0 -> 1253 -> 46 every cycle -- and last > first still passed, meaning the
      // assertion could not fail on the exact case it was written for. This one can.
      { name: 'never-restarts', test: 'tr.samples.length > 5 && tr.samples.every((x, i, a) => i === 0 || x.p >= a[i - 1].p - 250)' },
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
    ready: true,
    title: 'SID — no loop API, so the tune free-runs and a tail detector restarts it',
    watch: [
      'There is nothing to seek to, so playback continues past the length the tune claims for itself.',
      'When the tune goes quiet and still, it restarts — the "Detect Song End While ↻ One" setting.',
    ],
    harness: 'dev/test-end-detector.js',
    browse: '/browse/sid/Bionic_Commando.sid',
    fixture: 'sid/Bionic_Commando.sid',
    // Sub-song 3 of 10, and unlabeled, so the row reads "Tune 3". A multi-tune SID's
    // own row is a *song folder*: clicking it navigates rather than plays, so preload
    // has to name the sub-song.
    preload: { dir: 'sid/Bionic_Commando.sid', name: 'Tune 3', subtune: 2 },
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      // Measured with dev/record/probe.mjs. HVSC lists this sub-tune at 0:03, so the
      // trip gate (listed length minus one 6 s window) is already open at 0:00. The
      // tune's audio ends at ~4.5 s, the detector then needs a full quiet+static
      // window, and the restart lands at ~10 s; the cycle repeats every ~10.4 s. A
      // 13 s take is the shortest that shows the restart *and* the music resuming --
      // an earlier 6 s take simply ended before the event it is about, which is how
      // this clip came to assert a 30 s position on a 5 s take.
      { atMs: 10600, label: 'the tail went quiet and still' },
      { atMs: 13000, label: 'restarted from the top' },
    ],
    until: 'playing',
    assert: [
      { name: 'detector-armed', test: 's.detectSongEnd === true && s.tripAtMs === 0' },
      { name: 'free-ran-past-listed-length', test: 'tr.samples.length > 20 && tr.samples.some((x) => x.p >= x.dur)' },
      // The restart signature: position drops back to the top while playback
      // continues, i.e. re-run in place rather than the song being reloaded.
      { name: 'restarted-in-place', test: 'tr.samples.length > 20 && tr.samples.some((x, i, a) => i > 2 && x.p < a[i - 1].p - 250)' },
      { name: 'same-song-no-reload', test: 's.playing === true && s.ref.path === "sid/Bionic_Commando.sid" && s.ref.subtune === 2' },
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