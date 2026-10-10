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
//   group    which of the page's sections the clip belongs to. For section 'main'
//            this is one of the two classes of change the PR makes, rendered as its
//            own top-level section: 'subtunes' (a file that contains many songs is
//            a folder of songs) or 'looping' (one Repeat One for every format).
//            For section 'deep' it is the mechanism family the clip belongs to,
//            rendered as a subheading. 'native'  the format declares a loop region
//                     at load (VGM's loop points, MDX's mdxmini loop points, MIDI's
//                     CC 102/103), so the band is correct from the first frame
//            'indefinite' no loop region exists or is needed; the engine free-runs
//                     and the song ends by silence detection following GME
//            'learned'  no loop position is exposed up front; the region is found
//                     by listening, so the band appears mid-song
//            'floor'    the honest fallback: no loop points and no loop API, so the
//                     song stops and reloads. Not a success -- the baseline the
//                     others are measured against
//            Every clip must name one. scenarios.check.mjs rejects a missing or
//            unknown group, because a clip that silently drops out of its section
//            is the kind of thing that ships looking complete.
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
const NSFE_DIR = 'nsfe';                                 // 13 multi-song files

const HURRY = "arcade-capcom/Ghosts'N_Goblins_(Arcade)/16 Hurry Up!.vgz";
const HURRY_DIR = "arcade-capcom/Ghosts'N_Goblins_(Arcade)";

// loop-band and repeat-toggle-smooth both live in the Sonic Genesis VGZ set: a
// long, cleanly marked loop, so the band is a stretch you can read (rather than
// Hurry Up!'s 800 ms) and seeking *into* it is a watchable jump.
const VGZ_GENESIS_DIR = 'vgz-genesis';
const GREEN_HILL = 'vgz-genesis/Sega Genesis_Sonic the Hedgehog_02 - Green Hill Zone.vgz';
const SONIC2_CHEMICAL = 'vgz-genesis/Sega Genesis_Sonic the Hedgehog 2_05 - Chemical Plant Zone.vgz';

// The shuffle clip's timeline: play a song, open the folder it lives in, show the
// row being played, move on. Repeated eight times, so it is generated rather than
// written out -- the numbers below are the whole design, and a hand-copied eighth
// block is where the seventh block's timings would go wrong.
//
// Timings are measured, not chosen for looks. The play hold is 1700ms because the
// footer's folder link is only the *song folder* once /metadata has answered --
// measured 149ms, and the link points at the parent directory until then, so a
// click earlier would navigate to the directory and the beat would silently not
// happen. The 1200ms after the folder click is the listing fetch plus render.
//
// REVEAL is the beat this clip is about, and it is the one that was too short: the
// first take held the highlighted row on screen for 400ms before moving on, which
// reads as a flicker rather than as "this song is highlighted in its folder". At
// 1100ms the viewer gets time to read the label next to the highlight and connect
// it to the title in the footer. That plus a slightly longer play hold is the whole
// of the "too fast" fix, and it costs 9 seconds of take and ~4 MB.
const SHUFFLE_SONGS = 8;
const shuffleSubtuneWalk = (() => {
  const PLAY = 1700;
  const FOLDER = 1200;
  const REVEAL = 1100;
  const NEXT = 500; // after which the next song has loaded and is playing
  const steps = [{ atMs: 300, play: '.Browse-topRow button[title^="Shuffle"]', label: 'shuffle play this directory' }];
  let at = 300;
  for (let i = 1; i <= SHUFFLE_SONGS; i++) {
    at += PLAY;
    // `onlyIf` so a song that ended by itself -- a one-second sound effect, of
    // which this directory has dozens -- skips its folder beat instead of opening
    // the folder of the song it replaced. Measured: 2 of 14 draws advance inside a
    // 1500ms play hold, so without it roughly one beat in four showed a folder page
    // whose highlight was not the song in the footer.
    steps.push({
      atMs: at,
      play: '.AppFooter .SongDetails-filepath a',
      onlyIf: 'song-folder-link',
      label: `song ${i}: open the file it lives in`,
    });
    at += FOLDER;
    steps.push({ atMs: at, reveal: true, label: `song ${i}: the row being played` });
    if (i === SHUFFLE_SONGS) break;
    at += REVEAL;
    steps.push({ atMs: at, play: '.AppFooter button[title="Next"]', label: 'next song' });
    at += NEXT;
  }
  return steps;
})();

// The Top Charts clip: the same walk as the shuffle clip, but the list on screen is
// the chart instead of a song folder.
//
// The chart is a *different* list in two ways that shaped this script. It is not
// virtualized, so the highlighted row is already rendered and revealing it is a
// plain scroll (see dev.revealPlayingSong's other branch) -- but it is 50 rows tall,
// so most rows start below the fold and the highlight would otherwise spend most of
// the take off screen. And its Shuffle Play shuffles the rows the chart is showing,
// client-side, which is the claim: what plays is what was charted.
//
// No song-folder detour, where the shuffle clip has one: the chart page is the
// subject, and seeing each song light up its own row is the whole point.
//
// Ten songs rather than six, and that is a measured number rather than a taste one.
// The chart is ~30% sub-song rows (30 of the top 100 on this catalog), so a shuffle
// draws a sub-song with p = 0.3 and "at least one sub-song was played" fails with
// (1 - 0.3)^n: 12% of six-song takes, and the first two takes here duly drew six and
// seven songs that were *all* sub-tune 0 -- vgz, MDX, MOD, MIDI, miniusf, every one a
// single-song file. Ten draws puts it at ~3%, which is worth the extra 8 seconds;
// the reveal is doing real work in those seconds too, since a chart row can start
// 900px down the list.
const CHARTS_SONGS = 10;
const chartsSubtuneWalk = (() => {
  const PLAY = 1600;
  const CHART_HOLD = 900;
  const NEXT = 400;
  const steps = [{ atMs: 300, play: '.Browse-topRow button[title^="Shuffle all"]', label: 'shuffle play the chart' }];
  let at = 300;
  for (let i = 1; i <= CHARTS_SONGS; i++) {
    at += PLAY;
    steps.push({ atMs: at, reveal: true, label: `song ${i}: its row on the chart` });
    at += CHART_HOLD;
    if (i === CHARTS_SONGS) break;
    at += 250;
    steps.push({ atMs: at, play: '.AppFooter button[title="Next"]', label: 'next song' });
    at += NEXT;
  }
  return steps;
})();

export const scenarios = [
  // ---------------------------------------------------------------- main ----
  {
    id: 'songfolder',
    section: 'main',
    group: 'subtunes',
    ready: true,
    title: 'A file with many songs is a folder',
    watch: [
      'The row is marked &lt;TUNES&gt; with a count, not &lt;DIR&gt;',
      'Clicking it navigates *into the file*, exactly like a directory.',
      'Two different song files, entered and left the same way, each playing a named sub-song.',
      'Each row is a real song from there on: the footer tracks the file path and names the sub-song it is playing, with no "Tune 8 of 28" nav label and no prev/next sub-tune widget; the share link is the same <code>/?play=…&amp;subtune=N</code> it has always been.',
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
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 120)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  {
    id: 'favorite-subtune',
    section: 'main',
    group: 'subtunes',
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
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 40)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  {
    id: 'shuffle-subtunes',
    section: 'main',
    group: 'subtunes',
    ready: true,
    title: 'Shuffle Play shuffles songs, not files',
    watch: [
      'One directory, one <b>Shuffle Play</b>: the transport walks song after song and the path under the title moves from file to file.',
      'Click the folder path under the title and it opens the file that song actually lives in, with the row being played highlighted in it.',
      'Some of these are one-second sound effects — when one ends the sequencer moves on by itself, and the next song is just the next entry in the same shuffle.',
    ],
    before: 'master shuffled <em>files</em>. <code>/shuffle</code> picked a file and played one of its tracks, so this directory\'s 13 files gave you at most 13 songs out of the 352 in them, and everything else was only reachable by hand — and because the pick was per file, a repeat pass could hand you the same track twice. Now it asks for songs: this take walks 100 of them across all 13 files (the request is capped at 100).',
    harness: 'dev/test-subtunes-server.js',
    browse: '/browse/nsfe',
    // No fixture and no preload: the take opens on the listing with an empty
    // transport, which is the state this clip is about. A preload would start a
    // song and leave the shuffle with a song already half-played when it starts.
    steps: shuffleSubtuneWalk,
    until: null,
    assert: [
      // The whole claim, in one comparison. Shuffle Play asks /shuffle for 100
      // items, and /shuffle returns one row per *playable song* (a LEFT JOIN on
      // subtune), so the context is 100 entries spread over the 13 files in this
      // directory -- not 13 entries that are files. master would read 13 and 13.
      // This is also what proves the Shuffle Play click landed: without it the
      // context would be the directory listing the page opened on, which is 13
      // entries over 13 files and fails the first half of the test.
      { name: 'shuffle-list-is-one-entry-per-song', test: 's.ctxLen >= 90 && s.ctxFiles >= 10 && s.ctxLen > 5 * s.ctxFiles' },
      // Several *different* songs were played: distinct (path, sub-tune) pairs in
      // the trace. Deliberately not "more songs than files" -- that reads like the
      // same claim and is not: with 13 files and 8 draws, eight distinct files is a
      // perfectly ordinary shuffle and the ratio failed a take whose every other
      // number was right. The songs-not-files claim is settled exactly by
      // ctxLen/ctxFiles above, where nothing is sampled.
      { name: 'several-different-songs-were-played', test: '(() => { const seen = tr.samples.filter((x) => x.path); if (!(seen.length >= 200)) return false; return new Set(seen.map((x) => x.path + ":" + x.sub)).size >= 6; })()' },
      // Not whole files: at least three distinct songs past the first sub-tune were
      // played. 95 of this directory's 100 shuffle entries have subtune > 0, so
      // this is not close, and it is what separates "shuffled songs" from
      // "shuffled the first track of each file over and over".
      { name: 'sub-tunes-past-the-first-were-played', test: '(() => { const seen = tr.samples.filter((x) => x.path); if (!(seen.length >= 200)) return false; return new Set(seen.filter((x) => x.sub > 0).map((x) => x.path + ":" + x.sub)).size >= 3; })()' },
      // The beat this clip exists for: for at least five different songs, the page on
      // screen was that song's own folder *and* the row being played was highlighted
      // in it *and visible*. Per tick, not at the end -- a song folder page is also
      // on screen for the whole stretch between a Next click and the folder click
      // after it, when it belongs to the song that just ended. And "visible", not
      // "in the DOM": the list is virtualized, so a highlighted row that is rendered
      // but scrolled out of the box satisfies the weaker test and shows the viewer
      // nothing. An earlier version of this assertion used the weaker one and a take
      // passed with three of its eight folders showing no highlight at all.
      { name: 'each-song-folder-highlighted-the-playing-song', test: '(() => { if (!(tr.samples.length >= 200)) return false; const ok = new Set(); for (const x of tr.samples) { if (!x.path || !x.hl || !x.hlInView) continue; if (x.loc === "/browse/" + x.path) ok.add(x.path + ":" + x.sub); } return ok.size >= 5; })()' },
      // The safety the folder click now has, asserted as an absence: there is no
      // instant in the take where a highlighted row is on screen inside a page that
      // is *not* the playing song's folder. That is the frame a short sound effect
      // used to produce -- the click landing on the previous song's folder -- and it
      // is the exact shape of a green take that does not show its own claim, so it
      // is now forbidden outright rather than counted.
      { name: 'never-highlights-a-song-that-is-not-playing', test: '(() => { if (!(tr.samples.length >= 200)) return false; return !tr.samples.some((x) => x.hl && x.hlInView && x.loc !== "/browse/" + x.path); })()' },
      // The Next clicks landed. Only a real advance changes (path, subtune), so a
      // take whose Next buttons matched nothing still shows one song and fails the
      // count above; this names the mechanism instead of only its consequence.
      { name: 'next-was-clicked-repeatedly', test: 'tr.marks.filter((m) => /^next song$/.test(m.label)).length >= 5' },
      // The frame supports the claim at the end: a highlighted row inside the scroll
      // container's box, rather than one that exists but is rendered off-screen --
      // same reasoning as loop-band's "checkbox-was-really-clickable". The fallback
      // is for the last song having been *skipped*, which leaves the previous song's
      // folder on screen with nothing highlighted; that is a legitimate state now
      // that the skip is deliberate, and the clip's own marks say so. Capped at three
      // so a take where nothing was shown cannot pass on the fallback alone.
      { name: 'ends-on-a-song-folder-showing-the-playing-song', test: '(() => { if (!(tr.samples.length >= 200)) return false; const row = document.querySelector(".Song-now-playing"); const sc = document.querySelector(".App-main-content-area"); if (row && sc) { const b = row.getBoundingClientRect(); const c = sc.getBoundingClientRect(); if (b.top >= c.top - 1 && b.bottom <= c.bottom + 1 && b.height > 0) return true; } const skips = tr.marks.filter((m) => /^skipped /.test(m.label)).length; return skips >= 1 && skips <= 3; })()' },
      // Every assertion above reads the transport or the DOM, neither of which can
      // tell a playing engine from a silent one. 40 audible 100ms ticks is ~4s of
      // music, well under the ~12s this take plays, so it cannot pass on one song.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 200)) return false; return r.filter((n) => n > 0.02).length >= 40; })()' },
    ],
  },

  {
    id: 'charts-subtunes',
    section: 'main',
    group: 'subtunes',
    ready: true,
    title: 'Sub-songs chart, label and play as themselves',
    watch: [
      'The chart ranks <em>songs</em>, not files: <code>Cybernoid_II.sid (Tune 2)</code> is a row of its own, and <code>Akumajou Densetsu (VRC6).nsfe</code> turns up three times at three different ranks with three different songs.',
      '<b>Shuffle Play</b> on this page plays those rows, so what you hear is the exact sub-song that was charted.',
      'Each song lights up its own row, including the ones further down the chart, which the take scrolls to.',
    ],
    before: 'master charted <em>files</em>. One NSF was one row however many tunes it held, so a file nobody played sat at zero no matter which of its songs you liked, and the only sub-song the charts could ever show was the one the app happened to start on. Play counts were a property of the file, not of the song.',
    harness: 'dev/test-subtunes-server.js',
    browse: '/top',
    // No fixture and no preload: the take opens on the chart with an empty transport,
    // which is the state this clip is about. Preloading would start a song and leave
    // Shuffle Play with one already half-played.
    steps: chartsSubtuneWalk,
    until: null,
    assert: [
      // The claim is about the chart, so it is checked against the chart's own DOM
      // rather than against what the transport happens to be doing. Every chart row
      // links `/?play=<songId>&subtune=N`; a sub-song row is the one carrying a
      // subtune parameter, which is the same identity the rest of the app uses.
      { name: 'the-chart-itself-ranks-sub-songs', test: 'document.querySelectorAll(".BrowseList-colName a[href*=\'subtune=\']").length >= 3' },
      // Shuffle Play on this page plays the chart's own rows, so at least one song
      // past sub-tune 0 was played -- the chart is ~30% sub-song rows, which is why
      // the walk is ten songs long (see chartsSubtuneWalk). Without the button the
      // page opens with nothing playing and every other assertion here fails on an
      // empty trace.
      { name: 'shuffle-played-sub-songs-not-just-files', test: '(() => { const seen = tr.samples.filter((x) => x.path); if (!(seen.length >= 200)) return false; return new Set(seen.filter((x) => (x.sub || 0) > 0).map((x) => x.path + ":" + x.sub)).size >= 2; })()' },
      // The beat: on the chart page, the highlighted row *is* the song playing.
      // Checked per tick and per song rather than once at the end, because a
      // highlight that appears without belonging to anything would satisfy the weak
      // version -- and TopCharts compares the sequencer's ref against each row, so
      // the row's own text (which names the file) and its sub-tune parameter have to
      // agree with the transport on their own.
      { name: 'chart-highlighted-the-song-being-played', test: '(() => { if (!(tr.samples.length >= 200)) return false; const ok = new Set(); for (const x of tr.samples) { if (!x.path || x.loc !== "/top" || !x.hl || !x.hlName) continue; if (!x.hlName.startsWith(x.path.split("/").pop())) continue; if ((x.hlSub == null ? 0 : x.hlSub) !== (x.sub || 0)) continue; ok.add(x.path + ":" + x.sub); } return ok.size >= 3; })()' },
      // The highlight has to be on screen, not merely rendered: the chart is 50 rows
      // tall and only about 20 fit, so a row can be highlighted while the picture
      // shows nothing but other songs.
      { name: 'chart-highlight-was-on-screen', test: '(() => { const n = tr.samples.filter((x) => x.hl && x.hlInView && x.loc === "/top").length; return tr.samples.length >= 200 && n >= 15; })()' },
      { name: 'next-was-clicked-repeatedly', test: 'tr.marks.filter((m) => /^next song$/.test(m.label)).length >= 7' },
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 200)) return false; return r.filter((n) => n > 0.02).length >= 40; })()' },
    ],
  },

  {
    id: 'loop-band',
    section: 'main',
    group: 'looping',
    ready: true,
    title: 'The loop region, drawn on the slider',
    watch: [
      'The shaded band is the loop the composer wrote: a 14.8 s intro then a 38.4 s loop — 0:53 to 1:31 of a 1:36 track.',
      'With Repeat One on, the lead-in plays unfolded before the band is reached; once it is, the playhead cycles inside the band instead of running to the end.',
      'Seek into the band at 1:28 and the head runs to the far edge and folds back to the band start (0:53), then climbs again — the same fold, reached by a jump.',
      'Untick Show Loop Area and the band goes; the playhead keeps folding exactly as before. Tick it again and the band is back — the setting is visual only, it never touched playback.',
    ],
    before: 'master had no loop region at all: the slider was a plain progress bar and Repeat One stopped and reloaded the song from 0:00.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${VGZ_GENESIS_DIR}`,
    fixture: GREEN_HILL,
    preload: { dir: VGZ_GENESIS_DIR, name: 'Sega Genesis_Sonic the Hedgehog_02 - Green Hill Zone.vgz' },
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
    // Two beats, both unhurried so a viewer can register the band appearing, then
    // disappearing, then reappearing, and connect each to its click.
    //
    // The first beat toggles the band off and on while the song is still in its
    // 14.8 s lead-in (unfolded); the second does it after the seek, while the head
    // is folding. The seek to 1:28 lands inside the band near its far edge (91 599),
    // so the fold is ~3.6 s away -- and it is a `waitFor`, not a guessed delay, so
    // the take keeps its shape wherever the seek lands. The last marks then run off
    // that event: off at +1 s, on at +1.5 s, and the folded display passes 0:56 at
    // ~+2.9 s, which is where the take ends.
    steps: [
      { atMs: 1000, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 2000, play: '#showLoopArea', label: 'untick Show Loop Area' },
      { atMs: 3000, play: '#showLoopArea', label: 'tick Show Loop Area again' },
      { atMs: 6500, seek: 88000, label: 'seek to 1:28 — inside the band, near its far edge' },
      // The fold is the event, so wait for it: position keeps climbing past the
      // band end while display falls back to the band start, which is the fold.
      { atMs: 0, waitFor: 's.positionMs - s.displayMs > 1000', waitForTimeoutMs: 8000, label: 'looped — the head is back at the band start (0:53)' },
      { atMs: 1000, play: '#showLoopArea', label: 'untick Show Loop Area' },
      { atMs: 1500, play: '#showLoopArea', label: 'tick Show Loop Area again' },
      { atMs: 2000, label: 'inside the band again, climbing' },
      { atMs: 2900, label: 'display past 0:56' },
    ],
    finishAfterMs: 200,
    until: 'playing',
    assert: [
      { name: 'band-known', test: 's.band && s.band.endMs > s.band.startMs' },
      // The engine's own region: intro 14799 + loop 38400 = 53199, +38400 = 91599.
      { name: 'band-is-intro-plus-one-loop', test: 's.band && Math.abs(s.band.startMs - 53199) < 300 && Math.abs(s.band.endMs - 91599) < 300' },
      { name: 'engine-loop-count-rising', test: 'tr.samples.filter((x) => x.loop >= 1).length >= 5' },
      // The band only applies once the engine has looped; before that the head
      // is showing the real lead-in (which is the point of #3 below).
      { name: 'head-folds-into-band', test: 'tr.samples.filter((x) => x.loop >= 1).length >= 5 && tr.samples.filter((x) => x.loop >= 1).every((x) => x.d >= s.band.startMs - 40 && x.d <= s.band.endMs + 40)' },
      { name: 'lead-in-unfolded', test: 'tr.samples.filter((x) => x.loop === 0 && x.p < s.band.startMs).length >= 3 && tr.samples.filter((x) => x.loop === 0 && x.p < s.band.startMs).every((x) => x.d === x.p)' },
      { name: 'tempo-1x', test: 'Math.abs(s.tempo - 1) < 0.001' },
      // The clip's actual claim about the seek: the head really did fold back to
      // the band start. Read from the trace, not the mark: the maximum display is
      // the far edge, and a later sample sits at the band start.
      { name: 'seek-folded-back-to-band-start', test: '(() => { const ds = tr.samples.map((x) => x.d).filter((n) => typeof n === "number"); if (!(ds.length >= 40)) return false; const i = ds.indexOf(Math.max(...ds)); return i > 0 && ds.slice(i).some((d) => Math.abs(d - s.band.startMs) < 1500); })()' },
      // ...and then the folded display climbed past 0:56, which is where the take
      // ends. Tied to the fold (find the band start, look after it) so a take that
      // never folded cannot pass on the 88-91 s it held before the fold.
      { name: 'display-climbed-past-56s-after-fold', test: '(() => { const ds = tr.samples.map((x) => x.d).filter((n) => typeof n === "number"); if (!(ds.length >= 40)) return false; const f = ds.findIndex((d) => Math.abs(d - s.band.startMs) < 1500); return f >= 0 && ds.slice(f).some((d) => d >= 56000); })()' },
      // The merged Show Loop Area claim: the band was drawn, then not drawn, then
      // drawn again, and the head never stopped folding across any of it. A DOM
      // query alone cannot show "drawn, then hidden, then drawn" -- that needs the
      // timeline -- so this is asserted over the trace, not the final state. The
      // *second* pair is the one that matters here: it flanks the fold.
      { name: 'band-toggled-off-then-on', test: 'tr.marks.filter((m) => /untick Show Loop Area/.test(m.label)).length >= 2 && tr.marks.filter((m) => /tick Show Loop Area again/.test(m.label)).length >= 2' },
      { name: 'head-kept-folding-while-hidden', test: '(() => { const u = tr.marks.filter((m) => /untick Show Loop Area/.test(m.label)); const t = tr.marks.filter((m) => /tick Show Loop Area again/.test(m.label)); if (u.length < 2 || t.length < 2) return false; const w = tr.samples.filter((x) => x.t > u[1].t - 80 && x.t < t[1].t); return w.length >= 2 && w.every((x) => x.loop >= 1 && x.d >= s.band.startMs - 40 && x.d <= s.band.endMs + 40); })()' },
      // And the band really was absent in that window: the sampler records whether
      // the band element is in the DOM on every tick.
      { name: 'band-absent-while-unticked', test: '(() => { const u = tr.marks.filter((m) => /untick Show Loop Area/.test(m.label)); const t = tr.marks.filter((m) => /tick Show Loop Area again/.test(m.label)); if (u.length < 2 || t.length < 2) return false; return tr.samples.filter((x) => x.t > u[1].t + 100 && x.t < t[1].t - 50 && x.hasBand === false).length >= 2; })()' },
      { name: 'band-present-again-at-end', test: '!!document.querySelector(".Slider-loop")' },
      // And the control that was clicked is genuinely on screen: topmost element at
      // the checkbox's own centre must be the checkbox. This is the assertion that
      // catches an occluded control, which no band assertion can -- a synthetic click
      // dispatches straight to the handler whatever is painted over it.
      { name: 'checkbox-was-really-clickable', test: '(() => { const cb = document.querySelector("#showLoopArea"); if (!cb) return false; const r = cb.getBoundingClientRect(); const t = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return t === cb || cb.contains(t) || (t && t.contains(cb)); })()' },
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 70)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  {
    id: 'repeat-toggle-smooth',
    section: 'main',
    group: 'looping',
    ready: true,
    title: 'Turning Repeat One on after the loop never moves the playhead',
    watch: [
      'Repeat One is off: the song plays from 0:00 and the shaded band is the loop the composer wrote — 1:02 to 1:51 of a 1:55 track.',
      'Seek to 1:45.6, inside the band near its end, and let it play on into the fade that follows the last loop — still with Repeat One off.',
      'Turn Repeat One on <em>after</em> the loop region, mid-fade. The playhead does not jump: the display keeps tracking the real position instead of folding back into the band.',
      'The song plays out to its end and the file restarts from 0:00 — the Sequencer’s Repeat One, reached without a mid-song jump.',
    ],
    before: 'Repeat One was a stop-and-reload: turning it on mid-song restarted the song from 0:00 with a gap.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${VGZ_GENESIS_DIR}`,
    fixture: SONIC2_CHEMICAL,
    preload: { dir: VGZ_GENESIS_DIR, name: 'Sega Genesis_Sonic the Hedgehog 2_05 - Chemical Plant Zone.vgz' },
    // The opposite direction from loop-band: here Repeat One is turned on *after*
    // the loop region, while libvgm is already fading the last pass out. The
    // engine has nowhere to jump back to (the pass is over and the fade has
    // begun), so it plays the tail to the song's end; the Sequencer then replays
    // the file, which is what reaches 0:03 a second time. Every beat is a
    // `waitFor`, so the take does not depend on where the seek lands or how long
    // the fade runs.
    steps: [
      { atMs: 0, waitFor: 's.displayMs >= 3000', label: 'playing from 0:00, Repeat One off' },
      { atMs: 0, seek: 105600, label: 'seek to 1:45.6 — inside the band, near its end' },
      { atMs: 0, waitFor: 's.positionMs > s.band.endMs', label: 'past the loop region — the fade is running' },
      { atMs: 0, repeat: 'one', label: 'Repeat One ON — after the loop region' },
      { atMs: 0, waitFor: 's.positionMs < 1000', label: 'song ended — the file restarts from 0:00' },
      { atMs: 0, waitFor: 's.displayMs >= 3000', label: 'playing from 0:03 again' },
    ],
    finishAfterMs: 300,
    until: 'playing',
    assert: [
      { name: 'band-is-intro-plus-one-loop', test: 's.band && Math.abs(s.band.startMs - 62908) < 300 && Math.abs(s.band.endMs - 111091) < 300' },
      { name: 'repeat-was-off-at-the-start', test: 'tr.samples.length >= 10 && tr.samples.slice(0, 20).every((x) => x.looping === false)' },
      { name: 'looping-after-toggle', test: 's.looping === true' },
      // The toggle happened *after* the loop region -- that is the whole point.
      { name: 'toggled-after-the-loop-region', test: 'tr.samples.length >= 40 && s.band && tr.samples.some((x) => x.looping === true && x.p > s.band.endMs)' },
      // The claim: at the moment Repeat One goes on, the transport does not jump
      // backward. The display is continuous across the toggle mark.
      { name: 'no-backward-jump-at-the-toggle', test: 'tr.samples.length >= 40 && (() => { const t = tr.marks.find((m) => /^Repeat One ON/.test(m.label)); if (!t) return false; const w = tr.samples.filter((x) => x.t > t.t - 400 && x.t < t.t + 400).map((x) => x.d).filter((n) => typeof n === "number"); if (w.length < 3) return false; for (let i = 1; i < w.length; i++) if (w[i] < w[i-1] - 60) return false; return true; })()' },
      // ...and it did not fold the head back into the band either: after the
      // toggle the display kept tracking the position through the fade.
      { name: 'display-rode-the-tail-not-the-band', test: '(() => { if (tr.samples.length < 40) return false; const t = tr.marks.find((m) => /^Repeat One ON/.test(m.label)); if (!t || !s.band) return false; const w = tr.samples.filter((x) => x.t > t.t + 100 && x.t < t.t + 3000); return w.length >= 5 && w.every((x) => x.d > s.band.endMs - 500); })()' },
      // The song ended and the same file restarted from the top, then played to 0:03.
      { name: 'song-ended-and-restarted', test: '(() => { if (tr.samples.length < 40) return false; const ps = tr.samples.map((x) => x.p); for (let i = 1; i < ps.length; i++) if (ps[i-1] > 100000 && ps[i] < 5000) return true; return false; })()' },
      { name: 'restarted-file-played-to-3s', test: 'tr.samples.length >= 40 && (() => { const ps = tr.samples.map((x) => x.p); let idx = -1; for (let i = 1; i < ps.length; i++) if (ps[i-1] > 100000 && ps[i] < 5000) { idx = i; break; } return idx >= 0 && ps.slice(idx).some((p) => p >= 3000); })()' },
      { name: 'same-song-restarted', test: 'tr.samples.length >= 10 && tr.samples.slice(-10).every((x) => decodeURIComponent(x.path || "").indexOf("Chemical Plant Zone") >= 0)' },
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 70)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  {
    id: 'repeat-leave-fade',
    section: 'main',
    group: 'looping',
    ready: true,
    title: 'Turning Repeat One off plays the rest of the song',
    watch: [
      'After six loops the toggle is turned off — deep enough that a naive implementation would cut the song instantly.',
      'The volume falls away over four seconds rather than stopping: this is libvgm’s own fade, which the wrapper configures at 4 s.',
      'Only when the fade has run out does the song end. The playhead rides the tail the whole way.',
    ],
    before: 'master left Repeat One by stopping the song; a deep repeat ended instantly with no fade.',
    harness: 'dev/test-vgm-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    // Timings measured off the recorded envelope, not estimated. Leaving at 5 s, the
    // recorded level falls 0.144 -> 0.000 over the next ~4.8 s (libvgm's configured
    // 4 s fade plus its 0.5 s of trailing silence), and the sequencer then restarts
    // the file: position 10356 -> 278 at ~10.3 s, because the context is one song and
    // a finished song advances to it. So the last mark sits before the restart -- the
    // clip is about the fade, and a restarted song is a different clip.
    steps: [
      { atMs: 100, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 5000, repeat: 'off', label: 'Repeat One OFF — from loop 6' },
      { atMs: 6600, label: 'the pass finishes, the fade begins' },
      { atMs: 8500, label: 'fading out — still playing' },
      // The fade reaches silence at ~9.6 s and the sequencer restarts the file at ~10.1 s
      // (position 10448 -> 92). The recording runs to the last step plus
      // `finishAfterMs`, so the span has to end *inside* the silence or the restart's
      // own audio lands in the clip and the envelope assertions measure the new song
      // instead of the fade. Measured, not guessed: level 0.00009 at 9.5 s, 0 from
      // 9.6 s, back to 0.097 by 10.4 s. 9500 + 600ms of finish = 10.1 s of trace,
      // which is the last sample before the restart.
      // The fade reaches silence at ~9.6 s and the sequencer restarts the file at ~10.1 s
      // (position 10448 -> 92). The recording runs to the last step plus
      // `finishAfterMs`, so the span has to end *inside* the silence or the restart's
      // own audio lands in the clip and the envelope assertions measure the new song
      // instead of the fade. Measured, not guessed: level 0.00009 at 9.5 s, 0 from
      // 9.6 s, back to 0.097 by 10.4 s.
      { atMs: 9500, label: 'silence: the fade ran out, the song ended' },
    ],
    // Cut the recording 100 ms after the last step rather than the default 600 ms.
    // At 600 ms the trace ran to 10.2 s and caught the restart's first buffer, which
    // is both the wrong sound for a clip about a fade and the wrong thing for the
    // envelope assertions to measure. finishAfterMs is the seam for exactly this --
    // a take that must not run past its own last event.
    finishAfterMs: 100,
    until: 'playing',
    assert: [
      { name: 'left-looping', test: 's.looping === false' },
      // Read from the trace, NOT from s: durationExtended is cleared when the
      // sequencer restarts the file, so the final snapshot says false even though
      // the flag was correctly set for the whole fade. The evidence is the envelope.
      { name: 'fade-tail-played', test: '(() => { const t = tr.samples.filter((x) => x.t > 5100); return t.length >= 40 && t.some((x) => x.p > 9000); })()' },
      // "The fade plays out, and only then does the song end" is an *amplitude*
      // claim, and durationExtended is only a flag saying the tail was scheduled.
      // So read the envelope: it has to decline, and be near silence at the end.
      // A hard cut -- what master did -- fails here.
      {
        name: 'volume-faded-out-rather-than-cut',
        test: '(() => { const r = tr.samples.filter((x) => x.t > 5100).map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 40)) return false; const max = Math.max(...r); return max > 0.05 && r[r.length - 1] < 0.02; })()',
      },
      // ...and it must be a decline, not one quiet sample: check the level keeps
      // falling across the stretch rather than dropping straight to zero. Sampled
      // while the position is still climbing, or this measures the *next* song's
      // attack -- which is loud, and would make the fade look like it did nothing.
      {
        name: 'fade-is-gradual',
        test: '(() => { const r = tr.samples.filter((x) => x.t > 5100 && x.p > 1000).map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 30)) return false; const hi = Math.max(...r.slice(0, 12)); const lo = Math.min(...r.slice(-12)); return hi > 0.02 && lo < hi * 0.5; })()',
      },
    ],
  },

  {
    id: 'blind-loop',
    section: 'main',
    group: 'looping',
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
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 30)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  // ---------------------------------------------------------------- deep ----
  {
    id: 'vgm-native',
    section: 'deep',
    group: 'native',
    ready: true,
    title: 'VGM/VGZ — the engine loops, so nothing reloads',
    watch: [
      'libvgm loops inside the engine, so the song never stops and nothing is re-fetched: the engine’s own loop counter climbs from 1 to 5 while the clip plays.',
      'The band is the 800 ms the file marks as its loop, and the playhead cycles inside it — position 1.1 to 1.9 of a 6.4 s track.',
      'Nothing else happens for the whole clip, which is the point: the loop is the engine’s, not the sequencer’s.',
    ],
    before: 'master stopped at the end of the song and re-fetched it from the network on every repeat.',
    harness: 'dev/test-v2m-loops.js',
    browse: `/browse/${HURRY_DIR}`,
    fixture: HURRY,
    preload: { dir: HURRY_DIR, name: '16 Hurry Up!.vgz' },
    // Timings are measured off the recorded proof, not estimated: curLoop first
    // reaches 1 at 800 ms, 2 at 1600, 3 at 2400, 4 at 3200 and 5 at 4000 — one every
    // 800 ms, which is the loop length. The marks name the same numbers the proof
    // reports, so a reader can check one against the other. Held past the last one
    // because the point is a counter that keeps climbing.
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 1000, label: 'loop 1 — 0.8 s in, still the same engine' },
      { atMs: 2000, label: 'loop 2' },
      { atMs: 3000, label: 'loop 3' },
      { atMs: 4500, label: 'loop 5 — and still climbing, nothing reloaded' },
      { atMs: 6000, label: 'the music never stopped' },
    ],
    until: 'playing',
    assert: [
      { name: 'looping', test: 's.looping === true' },
      { name: 'vgm-engine', test: 's.player === "VGMPlayer"' },
      // Quote the numbers the bullets quote, so the text and the proof agree.
      { name: 'band-known', test: 's.band && s.band.endMs > s.band.startMs' },
      { name: 'band-is-the-file-loop', test: 's.band && Math.abs(s.band.startMs - 1142) < 150 && Math.abs(s.band.endMs - 1942) < 150' },
      // The claim, with the number in it: the engine’s own counter reached 5.
      { name: 'curLoop-reached-5', test: 'tr.samples.length >= 40 && Math.max(...tr.samples.map((x) => x.loop || 0)) >= 5' },
      { name: 'no-reload', test: 'tr.samples.length >= 40 && tr.samples.at(-1).p > tr.samples[0].p' },
      // The playhead cycling inside the band is the visual half of the claim; a
      // climbing counter alone would also be true of a transport that stopped moving.
      {
        name: 'head-cycling-in-the-band',
        test: '(() => { const t = tr.samples; if (!(t.length >= 40)) return false; let folds = 0; for (let i = 1; i < t.length; i++) { if (typeof t[i].p === "number" && typeof t[i].d === "number" && Math.abs(t[i].p - t[i].d) > 200) folds++; } return folds >= 8; })()',
      },
      { name: 'audible', test: 'tr.samples.length >= 40 && tr.samples.filter((x) => x.rms != null).length > 20 && Math.max(...tr.samples.map((x) => x.rms || 0)) > 0.02' },
    ],
  },

  {
    id: 'gme-looping-driver',
    section: 'deep',
    group: 'indefinite',
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
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 30)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  {
    id: 'mdx-native',
    section: 'deep',
    group: 'native',
    ready: true,
    title: 'MDX — the engine loops, and the band is exact',
    watch: [
      'mdxmini repeats the song’s own built-in loop like VGM, so the music is continuous — there is no reload and no gap.',
      'The calculation of the song duration is also now more precise.',
    ],
    before: 'master faded out and returned to the start',
    harness: 'dev/test-mdx-loops.js',
    browse: '/browse/mdx',
    fixture: 'mdx/G2MST6.MDX',
    preload: { dir: 'mdx', name: 'G2MST6.MDX' },
    // Timings are measured. MDX uses the base two-pass band, so it folds only *after*
    // intro + 2 x loop = 103809 ms — a take that starts at the beginning never gets
    // there (the previous version of this clip reached 5% of the song and folded 0
    // times, which is why its "the band is exact" claim had nothing on screen).
    // Measured with a 100 ms sampler: seek 101000 lands at 101330, and the first fold
    // follows ~2.5 s later with the display returning to 69239, i.e. the band start of
    // 69206. That equality is the "exact" claim, and asserted-below is what proves it.
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 1500, label: 'playing — the band is on the slider, the head has not folded yet' },
      { atMs: 1800, seek: 101000, label: 'seek to just before the far edge' },
      // ~4.3 s: the head crosses 103809 and returns to the band start.
      { atMs: 4600, label: 'head folds back to 1:09 — the engine’s loop, not a reload' },
      // Held well past it, so the folding is watchable rather than a single frame.
      { atMs: 9000, label: 'still folding while the position keeps climbing' },
    ],
    until: 'playing',
    assert: [
      { name: 'looping', test: 's.looping === true' },
      { name: 'mdx-engine', test: 's.player === "MDXPlayer"' },
      { name: 'band-known', test: 's.band && s.band.endMs > s.band.startMs' },
      // "Exact" means the engine’s own numbers, so assert them rather than just
      // asserting a band exists. intro_length 34603 and loop_length 34603 give the
      // base band [intro+loop, intro+2*loop] = [69206, 103809].
      { name: 'band-is-the-engine-region', test: 's.band && Math.abs(s.band.startMs - 69206) < 400 && Math.abs(s.band.endMs - 103809) < 400' },
      // The clip’s actual claim: the head really does fold back to the band start,
      // repeatedly, while the absolute position keeps climbing. Both halves matter —
      // a fold with a frozen position would mean the engine stopped.
      {
        name: 'head-folds-into-the-band',
        test: '(() => { const tr2 = tr.samples; if (!(tr2.length >= 60)) return false; let folds = 0; for (let i = 1; i < tr2.length; i++) { if (typeof tr2[i].p === "number" && typeof tr2[i].d === "number" && Math.abs(tr2[i].p - tr2[i].d) > 1000) folds++; } return folds >= 3; })()',
      },
      {
        name: 'position-keeps-climbing',
        test: '(() => { const ps = tr.samples.map((x) => x.p).filter((n) => typeof n === "number"); if (!(ps.length >= 60)) return false; return ps[ps.length - 1] > ps[0]; })()',
      },
      // Audible: a fold and a moving position are both true of a silent engine.
      { name: 'audible', test: 'tr.samples.length >= 60 && tr.samples.filter((x) => x.rms != null).length > 30 && Math.max(...tr.samples.map((x) => x.rms || 0)) > 0.02' },
    ],
  },

  {
    id: 'midi-cc102',
    section: 'deep',
    group: 'native',
    ready: true,
    title: 'MIDI — the loop region is read from CC 102/103',
    watch: [
      'Opened straight from a <code>/?play=…</code> link, so the take starts on the share link itself: the song plays, and the file brings its own SoundFont rather than the default GM one.',
      'The band is the region the file marks itself — CC 102/103 puts it at 1:12–2:24 of a 2:24 track.',
      'Play into the end of the band and the transport returns to 1:12: the marked region is what repeats, and it repeats in place without a reload.',
      '1:08 is before the band and plays straight through; 2:15 is inside it and comes back to the top. Same file, two seeks, and only one of them loops.',
    ],
    harness: 'dev/test-midi-loops.js',
    // Opened on the share link rather than by clicking a row, so the clip shows the
    // link working. `browse` is a whole path here: shoot.mjs assembles the URL with
    // the URL API, so the `r=` cache-buster does not fold itself into the song id
    // (which is what concatenating `?play=<id>?r=…` did).
    browse: '/?play=0yQ5qCD3',
    fixture: 'Nintendo 64 (SoundFont MIDI)/Mario Kart 64/03 - 3 Raceways, Wario Stadium.mid',
    // No preload: the `?play=` handler has already loaded the song and mounted its
    // SoundFont by the time the gate opens, and a preload would click a row this
    // clip is deliberately not using.
    steps: [
      { atMs: 300, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 7300, seek: 68000, label: 'seek to 1:08 — before the marked region' },
      { atMs: 15300, seek: 135000, label: 'seek to 2:15 — inside the marked region' },
      // The wrap lands on the band end (144125 ms) and returns to the band start
      // (72062 ms), measured 143359 -> 72295: 9.1 s after the seek, so this mark
      // sits just past the boundary rather than exactly on it.
      { atMs: 24600, label: 'looped — back to the top of the region' },
      { atMs: 28600, label: 'still looping in the region' },
    ],
    // Gate on the SoundFont, not on `playing`. The MIDI player mounts the file's
    // own sf2 asynchronously, so the two became true on the same tick here — but
    // `playing` would also be satisfied by a take that silently fell back to the
    // default GM font, which is the failure this gate exists to catch.
    until: 'fileSoundfont',
    assert: [
      { name: 'share-link-played-this-song', test: 'decodeURIComponent(s.path || "") === "Nintendo 64 (SoundFont MIDI)/Mario Kart 64/03 - 3 Raceways, Wario Stadium.mid"' },
      { name: 'files-own-soundfont-mounted', test: 's.fileSoundfont === true' },
      { name: 'band-from-markers', test: 's.band && s.band.endMs > s.band.startMs' },
      { name: 'band-is-the-marked-region', test: 's.band && Math.abs(s.band.startMs - 72062) < 400 && Math.abs(s.band.endMs - 144125) < 400' },
      { name: 'looping', test: 's.looping === true' },
      // A MIDI clip whose SoundFont failed to mount still advances the transport
      // and still reports its band, so audibility is asserted on its own rather
      // than inferred from the position moving.
      { name: 'audible-throughout', test: 'tr.samples.length > 40 && tr.samples.filter((x) => x.rms != null).length > 40 && Math.max(...tr.samples.map((x) => x.rms || 0)) > 0.02' },
      { name: 'played-inside-the-band', test: 'tr.samples.length > 40 && tr.samples.some((x) => x.p > 73000 && x.p < 144000)' },
      // The loop itself, from the trace rather than from a mark, so a clip that
      // merely *labelled* the loop cannot pass: the position reached deep inside
      // the band and then came back into it.
      {
        name: 'looped-back-to-band-start',
        test: '(() => { const ps = tr.samples.map((x) => x.p).filter((n) => typeof n === "number"); const i = ps.indexOf(Math.max(...ps)); return ps.length >= 40 && i > 0 && ps.slice(i).some((p) => p < 80000); })()',
      },
    ],
  },

  {
    id: 'xmp-learned-band',
    section: 'deep',
    group: 'learned',
    ready: true,
    title: 'MOD/XM — the loop is found by listening',
    watch: [
      'The first pass has no band: libxmp exposes no loop position up front, so the slider has nothing to highlight.',
      'The band appears the moment the engine actually jumps orders — 11 → 1 — and not a moment before. That is the honest shape of this feature: it is learned from playback, not declared.',
      'On this file that jump is 80 s in, which is why the clip plays past the loop start and then seeks into the last stretch to reach it rather than sit through the whole wait.',
      'The band is the repeating span, 0:04 to 1:20, running to the end of the single pass. The wrap is in place: no stop, no reload, no gap.',
    ],
    harness: 'dev/test-xmp-loops.js',
    browse: '/browse/mods',
    fixture: 'mods/TECHTRIS.MOD',
    preload: { dir: 'mods', name: 'TECHTRIS.MOD' },
    // This file's numbers, measured for this take (and on record in AGENTS.md):
    // duration 80700, the 11->1 backward jump, intro_length 3940, band
    // [3940, 80700]. The clip does not discover the learning point, it is scheduled
    // around it -- the jump is a property of the file, not something to poll for.
    //
    // Learning needs two things, and this script supplies both cheaply:
    //   1. the loop START visited linearly, so its first-visit time is recorded
    //      (order 1, at 3940 ms -- hence playing the first 10.5 s rather than seeking);
    //   2. a backward jump onto that order, which fires the learning.
    // A seek is fine for (2) because seekMs only forgets the *last* order; first-visit
    // times are absolute and survive it. A seek is fatal for (1): landing on an order
    // the linear flow never visited is skipped by design, so seeking straight to ~78 s
    // would never learn anything. Playing past the loop start first is what makes this
    // work -- an earlier draft of this comment claimed no seek could help, which was
    // wrong, and cost a 92 s take to find out.
    //
    // The seek target is 68000 rather than "band end minus 4 s" (76700) because
    // libxmp 4.5's xmp_seek_time snaps to an order boundary: measured, 76700 lands at
    // 68600 and 80500 at 68880, while 68000 lands at 68040. So the last stretch before
    // the jump is entered by asking for 68000, which is the accurate end of the seek
    // range, and the wrap is then 12.7 s of playback away rather than 4 s.
    steps: [
      { atMs: 300, repeat: 'one', label: 'Repeat One ON' },
      // A label on the *absence*: this is the whole point of the clip, and the marks
      // list is the only place a reader can see that the band was not there.
      { atMs: 6000, label: 'first pass — nothing highlighted on the slider yet' },
      // 10.5 s of music before the seek, which is what makes the clip watchable:
      // the first stretch is there to be heard, not just to prime `seen`. Order 1
      // (the loop start) is recorded at 3940 ms, so there is 6.5 s of margin.
      { atMs: 10500, seek: 68000, label: 'seek into the last stretch' },
      // The seek lands at ~68040, so the wrap at 80700 is 12.66 s later, i.e. take
      // time ~23.3 s. Marked with room to spare: the landing point moves a few tens
      // of ms between runs (68000-68080 measured) and a mark is a fixed time, not a
      // condition.
      { atMs: 23800, label: 'band learned at the backward order jump (11 → 1)' },
      // ~7.7 s of the loop afterwards, so the band is on screen long enough to read
      // and the music is audibly still going when the clip ends.
      { atMs: 31500, label: 'still looping, now with the band drawn' },
    ],
    until: 'playing',
    assert: [
      { name: 'xmp-engine', test: 's.player === "XMPPlayer"' },
      { name: 'looping', test: 's.looping === true' },
      // The clip's actual claim: the band is *absent* at the start and *present*
      // later. Read from the DOM on every tick, because the player reports a band
      // internally the whole time -- "there was no band for the first minute" is not
      // the same as "the player had nothing to draw".
      {
        name: 'band-appears-only-after-listening',
        test: 'tr.samples.length >= 100 && tr.samples.slice(0, 40).every((x) => !x.hasBand) && tr.samples.slice(-40).every((x) => x.hasBand)',
      },
      // The precondition for learning, asserted because the whole script depends on
      // it: the loop start was visited linearly before the seek. If a future edit
      // seeks early, the band never appears and this fails first with the reason.
      { name: 'loop-start-played-before-seek', test: 'tr.samples.length >= 100 && tr.samples.some((x) => x.p > 3900 && x.p < 6500)' },
      { name: 'band-is-the-learned-region', test: 's.band && Math.abs(s.band.startMs - 3940) < 400 && Math.abs(s.band.endMs - 80700) < 400' },
      // The band ends at the single-pass duration, because that is where the order
      // jump happened. A band stopping short would be a different claim.
      { name: 'band-runs-to-the-end-of-the-pass', test: 's.band && Math.abs(s.band.endMs - s.durationMs) < 400' },
      // The wrap itself, from the trace rather than from a mark, so a clip that merely
      // labelled the loop cannot pass. One wrap is the learning jump itself.
      {
        name: 'wrapped-at-the-band-end',
        test: '(() => { const ps = tr.samples.map((x) => x.p).filter((n) => typeof n === "number"); if (!(ps.length >= 100)) return false; for (let i = 1; i < ps.length; i++) if (ps[i] < ps[i - 1] - 2000) return true; return false; })()',
      },
      // "In place" is the claim of the native loop: the song never changed, so
      // nothing stopped and reloaded at the wrap.
      { name: 'no-reload-at-the-wrap', test: 'decodeURIComponent(s.path || "") === "mods/TECHTRIS.MOD"' },
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 200)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  {
    id: 'sid-tail-restart',
    section: 'deep',
    group: 'indefinite',
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
      // The audio is half the claim on this page, and none of the assertions above can
      // tell a playing engine from a silent one: every one of them reads the transport.
      { name: 'audible', test: '(() => { const r = tr.samples.map((x) => x.rms).filter((n) => n != null); if (!(r.length >= 90)) return false; return Math.max(...r) > 0.02; })()' },
    ],
  },

  {
    id: 'n64-indefinite',
    section: 'deep',
    group: 'indefinite',
    ready: true,
    title: 'N64/USF — the engine free-runs under Repeat One',
    watch: [
      'Repeat One sets the engine’s own indefinite flag, so the track keeps rendering past the length the file reports — 1:54 here.',
      'The position climbs through 1:54 and keeps going, with no rewind: the cycle boundary is the engine’s own, not a reload.',
      'The take starts partway through the song, because a seek on this format is slow enough to be worth keeping off camera.',
    ],
    before: 'master faded and reloaded the track on every cycle.',
    harness: 'dev/test-end-detector.js',
    browse: '/?play=TkTO3bP2',
    fixture: 'n64/Blast Corps/04 Time to Get Moving!.miniusf',
    // Off-screen seek, so the sluggishness is not in the clip. N64’s seek renders
    // forward to the target and the catch-up is visible and slow, so seeking on
    // camera would show a lurch rather than a cut. Measured on this file: asking
    // 105000 reads 4395 immediately, and 92260 or 112995 once settled, after ~9 s. The
    // landing is NOT repeatable between runs, so the script does not schedule around
    // a particular number -- it asks for a point, lets the pre-roll settle, and
    // asserts the behaviour after it. settleMs is generous for that reason.
    preRoll: { seek: 105000, settleMs: 12000, minMs: 400 },
    // No preload: the share link loads the song in App’s mount handler, and a
    // preload would click a row this clip is deliberately not using.
    steps: [
      { atMs: 200, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 2000, label: 'playing from partway through' },
      // The length is 114000 and the pre-roll leaves the position near the top of the
      // song, so the crossing lands in the first second or two. Marked well past it.
      // Span sized from the pre-roll's landing, not guessed: it settled at 104659 and
      // the assertion wants to clear 114000 + 2000, so 15 s of take is needed and 8 s
      // was ~3 s short (measured -- that take peaked at 113645).
      { atMs: 4000, label: 'past the reported 1:54, still rendering' },
      { atMs: 15000, label: 'still climbing — no reload' },
    ],
    until: 'playing',
    assert: [
      { name: 'looping', test: 's.looping === true' },
      { name: 'n64-engine', test: 's.player === "N64Player"' },
      // The clip’s actual claim: the reported length was passed and the position did
      // not rewind. Both from the trace, so a clip that merely labelled the crossing
      // cannot pass -- and "no backward jump" is what separates a free-run from a
      // reload that happens to finish further along.
      {
        name: 'passed-the-reported-length',
        test: '(() => { const ps = tr.samples.map((x) => x.p).filter((n) => typeof n === "number"); if (!(ps.length >= 40)) return false; return Math.max(...ps) > s.durationMs + 2000; })()',
      },
      {
        name: 'never-rewound',
        test: '(() => { const ps = tr.samples.map((x) => x.p).filter((n) => typeof n === "number"); if (!(ps.length >= 40)) return false; for (let i = 1; i < ps.length; i++) if (ps[i] < ps[i - 1] - 250) return false; return true; })()',
      },
      { name: 'free-running', test: 's.indefinite === true' },
      // A clip can hold a position claim while the engine is silent, so audibility is
      // asserted rather than inferred from the transport moving.
      { name: 'audible', test: 'tr.samples.length >= 40 && tr.samples.filter((x) => x.rms != null).length > 20 && Math.max(...tr.samples.map((x) => x.rms || 0)) > 0.02' },
    ],
  },

  {
    // TODO(unpublish): withdrawn from the page pending the V2M duration bug -- see
    // the note below and AGENTS.md ("V2M's reported duration does not match the
    // engine"). `ready: false` is what keeps it off the page: build-site.mjs publishes
    // on `ready`, so this clip is no longer shot or uploaded until it is fixed. The
    // entry is kept rather than deleted because the harness and the finding both
    // still matter, and deleting a clip is how the reason gets lost.
    //
    // Two things are wrong with it, and only the first is the bug:
    //   1. The clip does not show its own claim. The song is 63 s and the take is
    //      5.7 s, so it ends long before the engine does: the "reload" mark at 5106
    //      labels an event that never happens on screen. Measured, not inferred --
    //      the trace climbs monotonically to 6084 ms and stops.
    //   2. The duration is wrong, which is why the UI gives it the blind-loop look.
    //      getDurationMs() reports 63000 while the engine plays on past that, so the
    //      slider reserves a 63 s box and the head parks at the end for a song that
    //      has not finished. That is the actual defect, and it is why this clip is
    //      not representative of the default group.
    //
    // The default-Sequencer-loop group is now shown by `sequencer-default-loop`
    // instead, which is a cleaner demonstration of the same thing.
    id: 'v2m-tier3',
    section: 'deep',
    group: 'floor',
    ready: false,
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

  {
    id: 'sequencer-default-loop',
    section: 'deep',
    group: 'floor',
    ready: true,
    title: 'No loop markers — Repeat One replays the whole file',
    watch: [
      'This MIDI file has no loop markers at all, so there is no region to draw: CC 102, 103, 110 and 111 are all absent from the byte stream, and the player reports no band.',
      'Repeat One still does what it always did. The song plays, the engine ends it, and the Sequencer starts it again — the same file, from the top.',
      'This is the floor, and it is the default rather than a failure: any format added tomorrow inherits it with nothing to implement.',
      'Seek to near the end to reach the boundary without waiting out the whole song.',
    ],
    before: 'identical to master: where a format offers no loop region, nothing here changes.',
    harness: 'dev/test-midi-loops.js',
    browse: '/?play=xLCmKSWf',
    fixture: 'midi/DOOM/Game MIDI_Doom (PC∕DOS, 1993)_02 - At Doom\'s Gate (E1M1).mid',
    // No preload: the share link loads the song in App's mount handler, and a
    // preload would click a row this clip is deliberately not using.
    //
    // Timings are the song-time values read off the player, and this file plays at
    // 1:1 -- measured over a 12 s window: 11981 ms of song in 12000 ms of wall clock,
    // a rate of 0.9984. So each number below is both the position and the clock,
    // which is why the same integers appear on both sides of every comment.
    //
    // (An earlier draft measured a 1.53x rate and mis-timed the whole clip. It came
    // from starting a stopwatch after the share link had already autoplayed ~2.4 s, so
    // "4500 ms later" was really 6920 ms of position. A long window, and a start
    // position near zero, are what make a rate trustworthy.)
    //
    // Measured with a 40 ms sampler on this timeline:
    //   seek 90000  -> lands at 90139, leaving 4177 ms of song to the engine's end
    //   +4676 ms    -> position drops to 0: the Sequencer reload, same file
    //   +4455 ms    -> the display reads 0:04.5 again: the second pass
    steps: [
      { atMs: 300, repeat: 'one', label: 'Repeat One ON' },
      { atMs: 4500, label: 'playing from 0 — no band on the slider' },
      { atMs: 5000, seek: 90000, label: 'seek to 1:30, near the end' },
      // The engine ends 4177 ms after the seek and the reload lands at 4676, so the
      // boundary is ~10.2 s. A fixed time rather than a condition, because the
      // boundary moves with tempo.
      { atMs: 10200, label: 'song ended — the Sequencer started it again' },
      { atMs: 14700, label: 'same file, playing on from the top' },
    ],
    // Gate on 'playing', NOT 'fileSoundfont' as midi-cc102 does. This file has no
    // soundfont of its own -- its catalog row carries none, so MIDIPlayer leaves the
    // synth on the default gmgsx-plus.sf2 -- and `fileSoundfont` requires a user/*
    // mount, so gating on it here times out after 10 s and the take publishes nothing.
    // Measured: soundfont reads gmgsx-plus.sf2 from load and never changes.
    until: 'playing',
    assert: [
      { name: 'share-link-played-this-song', test: 'decodeURIComponent(s.path || "").indexOf("At Doom") >= 0' },
      { name: 'looping', test: 's.looping === true' },
      // The group's premise: there is no region to draw, so there is no band. If a
      // future MIDI parser starts finding markers in files like this, this fails and
      // the clip has to be re-thought rather than quietly re-shot.
      { name: 'no-band-because-no-markers', test: 's.band == null' },
      // The same file came back rather than the sequencer advancing to a different
      // one. The path is sampled on every tick for exactly this: after a reload the
      // old take showed `p > 80000` inside the trailing window, because the 6 s tail
      // after the reload still contained the pre-reload position. Asserting on the
      // path is also the stronger claim -- currIdx staying put is the mechanism, but
      // what a viewer sees is the same song again.
      {
        name: 'reloaded-the-same-song',
        test: 'tr.samples.length >= 100 && tr.samples.some((x) => x.p > 80000) && tr.samples.slice(-40).every((x) => decodeURIComponent(x.path || "").indexOf("At Doom") >= 0)',
      },
      // The actual claim: the transport went back to the top. Read from the trace, so
      // a clip that merely labelled the reload cannot pass.
      {
        name: 'wrapped-back-to-zero',
        test: '(() => { const ps = tr.samples.map((x) => x.p).filter((n) => typeof n === "number"); if (!(ps.length >= 100)) return false; for (let i = 1; i < ps.length; i++) if (ps[i] < 200 && ps[i - 1] > 80000) return true; return false; })()',
      },
      // A MIDI clip whose SoundFont failed to mount still advances the transport and
      // still reports "no band", so audibility is asserted on its own.
      { name: 'audible', test: 'tr.samples.length >= 100 && tr.samples.filter((x) => x.rms != null).length > 40 && Math.max(...tr.samples.map((x) => x.rms || 0)) > 0.02' },
    ],
  },
];

export const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
export const main = scenarios.filter((s) => s.section === 'main');
export const deep = scenarios.filter((s) => s.section === 'deep');
