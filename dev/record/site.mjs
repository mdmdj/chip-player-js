// DEV-ONLY: the page's prose and snippets (dev/record/README.md §8, §9).
//
// Kept apart from build-site.mjs so the writing is editable without touching the
// generator. `prose` is keyed by scenario id and a scenario with no entry here is
// simply not on the page yet. Snippet line ranges are resolved against the
// working tree at build time: a range that has drifted fails the build instead of
// rendering an empty <pre>.

export const header = {
  title: 'Sub-songs as songs, and Repeat One that loops',
  pr: 'chip-player-js PR',
  lede: `Two changes, each with a clip. <strong>A file that contains many songs browses
    as a folder</strong>, and each sub-song is an ordinary song from then on: favourite
    it, search it, shuffle it, share it, chart it. <strong>Repeat One loops the region
    the composer wrote</strong> wherever the engine knows where it is, and draws it on
    the timeline. The formats with no such region are on the page too.`,
};

// The summary that opens the page: what the change is, and what a maintainer has
// to know before deploying it.
//
// Written as HTML, like `prose` below, because it carries <code> and <em> and it is
// authored in this tree. Everything quantitative in it was measured rather than
// remembered -- the migration timing and the byte-identical comparison come from
// running the real builder against a scratch catalog, and the production-export
// comparison from prod's own shipped bundle. See dev/record/README.md.
export const summary = {
  changed: [
    {
      heading: 'Sub-tunes are songs',
      points: [
        'A file that holds many songs (NSFE/NSF, SID, GBS, AY) browses as a <strong>song folder</strong>: a directory listing whose rows are its songs.',
        'Everywhere else a sub-song is an ordinary song: favourited, searched, shared, charted and shuffled on its own.',
        'Identity is <code>{path, sub-tune}</code>, defined once (<code>songRef</code>), so the row highlight, the now-playing song, a playlist and a share link cannot disagree.',
        'A share link keeps its format, <code>/?play=&lt;id&gt;&amp;subtune=N</code>, and lands inside the song folder with that sub-song selected instead of on the containing directory.',
        '<code>/shuffle</code> and <code>/random</code> return one row per playable song, not per file, so a 13-file directory shuffles all 352 of its songs.',
        'Top Charts group by <code>(song_id, sub-tune)</code>, so one file can hold several ranks at once, each labelled with its own song.',
        'The footer sub-tune widget (“Tune N of M”, prev/next) is gone; the sequencer owns navigation, so a sub-song is another entry in the play context.',
      ],
    },
    {
      heading: 'Repeat One loops the intended region',
      points: [
        'One Repeat One across formats. It loops the region the composer wrote where the engine exposes it: VGM/VGZ, MDX, MIDI (CC 102/103, CC 110/111) and MOD/XM/IT/S3M (learned from playback). For NSFE/SID/N64 there is no region, so the driver free-runs and a tail detector restarts a finished one.',
        'The region is drawn on the timeline. The band math is on the base player; engine policy stays in each engine’s player.',
        'Toggling it does not move the transport. The playhead is continuous across the toggle, and leaving a deep repeat plays out the rest of the pass and the fade instead of cutting the song.',
        'V2M has no region and no loop API; its fallback is unchanged — play the song, then start it again.',
      ],
    },
  ],
  // What to look out for. Each block is a thing that is true *before* you deploy,
  // not a caveat about the code.
  lookout: [
    {
      id: 'database',
      title: 'Database — rebuild the catalog before deploying',
      body: [
        'The server prepares every statement at <code>require</code> time, and the new charts, search and browse statements reference three objects this change adds: the <code>subtune</code> table, <code>subtune_fts</code>, and <code>music.subtune_count</code>. Against an older catalog, startup throws <code>SqliteError: no such table: subtune</code>. It is a boot failure, not a per-request error, and it takes <code>/top</code>, <code>/search</code>, <code>/browse</code> and <code>/user/favorites</code> down with it.',
        '<strong>The fix is one command and not a rebuild:</strong> run <code>node scripts/build-music.js</code> (no <code>--reset-db</code>, no <code>-n</code>). It creates the tables and adds the column, then re-parses every file to fill in the counts and labels, because a <code>DEFAULT 1</code> is indistinguishable from a genuine single-song file and a <code>user_version</code> marker records whether that backfill has run. Measured on 6,787 files: <strong>11.7 s</strong>, producing a catalog byte-identical to the feature branch’s (1,140 sub-tune rows, 87 multi-song files).',
        '<code>playbacks.subtune</code> needs no step: it is added at boot by an idempotent <code>ALTER TABLE … DEFAULT 0</code>.',
        'Two consequences for existing data, both unavoidable. A file’s prior play count lands on its <strong>first</strong> sub-tune, because nothing recorded which tune was playing. And since rows now group by <code>(song_id, sub-tune)</code>, historical charts re-rank — one file’s total splits across several rows.',
        'Favourites need no migration: <code>subtune</code> is optional in the stored JSON, and an entry without one means sub-tune 0.',
      ],
    },
    {
      id: 'chip-core',
      title: 'Chip-core — the wasm here is not the one you build',
      body: [
        'This branch’s wasm was built from the trees vendored in this repo, and those are not what production is built from. Production’s shipped bundle exports <code>_xmp_seek_time_frame</code> and <code>_gme_disable_echo</code>; neither exists anywhere in the vendored trees, yet <em>master</em> lists both in its build script and calls both unguarded (<code>XMPPlayer.seekMs</code>, <code>GMEPlayer</code>’s <code>disableEcho</code>). The vendored trees cannot satisfy master’s own build. The PR therefore feature-detects both, so the app works against either vintage of libxmp and GME.',
        'One measurement caveat. <strong>This PR does not change VGM position</strong>: <code>lvgm_get_position_ms</code> is byte-identical to <em>master</em> and <code>libvgm/</code> is not in the diff. But the counter is inconsistent at speeds other than 1×. It counts wall-clock while the speed is steady, so at 2× it reads half the true song position; libvgm also rescales it on every speed change (<code>RefreshTSRates</code> rewrites the sample counter it reports — measured: 1×→2× halves it, 2×→1× doubles it), so dragging the Speed slider jumps the playhead. Production counts song position throughout and does neither. The music is unaffected: at 2× both builds reach the same point in half the wall time, only the number differs. Our vendored libvgm is older, and refreshing it is engine work outside this PR.',
        'Same caveat for song length: read it late in a song, not early. It starts about 7 s short and settles once the engine has worked out where the fade ends. Production reports <code>1:36.0</code> for the track above, we report <code>1:40.5</code> — a difference in how the two libvgm versions close out a fade, not something this PR causes.',
        '<strong>Seven exports</strong> are added to <code>scripts/build-chip-core.js</code>: <code>_lvgm_get_cur_loop</code>, <code>_lvgm_get_fade_start_ms</code>, <code>_lvgm_get_loop_start_ms</code>, <code>_lvgm_get_loop_end_ms</code>, <code>_lvgm_set_loop_count</code>, <code>_mdx_get_loop_start_ms</code>, <code>_mdx_get_loop_length_ms</code>. They are plain getters and setters, and every call site feature-detects, so a core without them falls back to the blind-loop UI rather than breaking. (Production exports none of them; it ships no VGM loop-region feature.)',
        '<strong>One engine change is load-bearing for sub-tunes.</strong> <code>libsidplayfp-wrapper.cpp</code> calls <code>engine-&gt;load(currentTune)</code> after <code>selectSong()</code>. <code>selectSong</code> only marks the tune’s current song, so without the reload the wrapper reports the sub-tune you asked for while every sub-tune plays song 0 — a bug that is invisible in review and inaudible unless you compare two sub-tunes.',
        '<strong>The only vendored engine source in the diff is <code>mdxmini/</code></strong> (4 files). Two changes. A fade that reaches zero now stops there instead of counting into negative numbers, which could leave a song that never ended. And position is counted in <strong>microseconds</strong> (<code>int64_t position_us</code>) rather than whole milliseconds per frame, whose discarded remainder was up to a third of a frame and made the count run slow, so seeks overshot and could start a fade early. It is 64-bit because <code>long</code> is 32-bit under wasm and would wrap after about 35 minutes into a negative position. Checked in-app on <code>G2MST6.MDX</code>: position tracks real time, a seek lands within one frame of the target, and it never goes negative. Every other vendored tree is build-only and absent from the PR.',
        'Also absent on purpose: the engine build scripts, the GME OPN prune, <code>tinyplayer.c</code>, and the test harnesses. The two wrappers that changed (<code>libvgm-wrapper.cpp</code>, <code>libsidplayfp-wrapper.cpp</code>) carry only the loop getters and the SID reload. If your build differs, the loop policy is portable JS under <code>src/players/</code>; only the region getters are engine-specific.',
      ],
    },
    {
      id: 'api',
      title: 'API shapes',
      body: [
        'Additive except where noted: <code>/api/top</code> rows gained <code>subtune</code>, <code>subtuneCount</code> and <code>subtune_title</code>; <code>/api/browse</code> returns <code>type: "songfolder"</code> for multi-song files and sub-tune rows (<code>subtune</code>, <code>durationMs</code>, <code>url</code>) when you browse inside one; <code>/api/search</code> unions sub-song titles, so a hit can name a song rather than a file; <code>/api/playback</code> accepts <code>subtune</code>.',
        '<strong>Watch <code>/shuffle</code> and <code>/random</code>:</strong> they now return one row per playable song as <code>{path, subtune}</code>, which for the same directory is <em>more</em> rows than before plus a new field. Anything walking a shuffle has to key on the pair, not the path.',
      ],
    },
    {
      id: 'tests',
      title: 'Testing is not in the PR',
      body: [
        'This repo has no test runner, no CI and no <code>test</code> script, and the catalog is gitignored, so a tracked suite would silently skip about a third of its checks for want of a fixture. The harnesses behind every number on this page live in <code>dev/</code> and are not in the diff; they build their own minimal SMFs for the edge cases rather than depending on a catalog file. If you want them tracked, they can move to a <code>test/</code> directory running on <code>node --test</code> with no new dependencies.',
      ],
    },
    {
      id: 'limits',
      title: 'Formats with no loop region',
      body: [
        'Repeated in <a href="#limits">Known limits</a> below: V2M has no loop points and no loop API, so it stops and reloads; SID has no loop API, so its tune free-runs past its listed length and a tail detector restarts it when the output is quiet and still (a heuristic, with a setting to disable it); XMP’s band is learned from the engine’s first backward order jump, so it appears mid-song; MIDI format 2 has no shared timeline and gets no band.',
      ],
    },
    {
      id: 'subtrees',
      title: 'Vendored engines — four subtrees are dead',
      body: [
        'Unrelated to this change, and worth doing when convenient: <code>libvgm/</code>, <code>libxmp/</code>, <code>fluidlite/</code> and <code>game-music-emu/</code> (about 3,000 files) are still committed but cannot build. <code>README.md</code> already calls them deprecated, and <code>scripts/build-chip-core.js</code> exports <code>_gme_disable_echo</code>, <code>_gme_seek_scaled</code> and <code>_xmp_seek_time_frame</code>, none of which exist in the vendored trees, so a build against them cannot link.',
        'They are a second, stale copy of every engine, and all they do now is make “which libvgm am I compiling against?” a reasonable question — we spent time on exactly that. Deleting them is a straight simplification. This change does not touch them or depend on it.',
      ],
    },
  ],
};

export const prose = {
'loop-band': {
    title: 'The loop region, drawn on the slider',
    before: 'master had no loop region. The slider was a plain progress bar, and Repeat One stopped and reloaded the song from 0:00 with a gap. <em>Show Loop Area</em> is new.',
  },
  songfolder: {
    title: 'A file with many songs is a folder',
    before: 'master listed a multi-song NSF as one file row; sub-songs were reachable only through a footer widget (“Tune N of M” with prev/next). Note what is absent here: no footer sub-tune widget, no “tune 8 of 28” counter.',
  },
  'favorite-subtune': {
    title: 'A sub-tune can be favourited on its own',
    before: 'master stored a favourite as a file, so a 28-tune NSF was favourited as a whole or not at all.',
  },
  'shuffle-subtunes': {
    title: 'Shuffle Play shuffles songs, not files',
    before: 'master shuffled <em>files</em>. <code>/shuffle</code> picked a file and played one of its tracks, so 13 multi-song files yielded at most 13 of their 352 songs, and the same track could repeat within a pass.',
  },
  'charts-subtunes': {
    title: 'Sub-songs chart and play as themselves',
    before: 'master charted <em>files</em>. One NSF was one row however many tunes it held; play counts belonged to the file, and the only sub-song the charts could name was the one the app happened to start on.',
  },
  'repeat-toggle-smooth': {
    title: 'Turning Repeat One on mid-song is jump-free',
    before: 'master restarted the song from 0:00 with a gap in the audio.',
  },
  'repeat-leave-fade': {
    title: 'Turning it off plays the song out',
    before: 'master cut the song off at the loop point instead of finishing the pass and the fade.',
  },
  'vgm-native': {
    title: 'VGM/VGZ — the engine loops, so nothing reloads',
    before: 'master stopped the song and re-fetched it from the network on every repeat.',
  },
  'mdx-native': {
    title: 'MDX — the engine loop and the loop points, exact',
    before: 'master stopped and reloaded, cutting the song at the loop boundary.',
  },
  'midi-cc102': {
    title: 'MIDI — loop markers become a loop',
    before: 'master had no notion of a MIDI loop region, and nothing kept a synth playing past the end of one.',
  },
  'xmp-learned-band': {
    title: 'MOD/XM/IT — the loop is found by listening',
    before: 'master stopped and reloaded at the order jump, with nothing on the slider to show the repeat.',
  },
  'n64-indefinite': {
    title: 'N64/USF — the engine free-runs under Repeat One',
    before: 'master faded and reloaded the track on every cycle.',
  },
  // v2m-tier3's prose is kept but the scenario is ready:false while its duration bug
  // is open (AGENTS.md, "V2M's reported duration does not match the engine"). Deleting
  // the entry would also unpublish it, but leaves nothing pointing at why.
  'v2m-tier3': {
    title: 'V2M — the fallback',
    before: 'Same as master: the format has no loop points, so the song stops and reloads.',
  },
  'sequencer-default-loop': {
    title: 'No loop markers — the song replays from the top',
    before: 'Same as master. With no loop region, nothing changes: the Sequencer’s own Repeat One replays the file.',
  },
  'blind-loop': {
    title: 'No loop region — the head parks at the end',
    before: 'master clamped the head at the track length and gave no sign that playback continued past it.',
  },
  'gme-looping-driver': {
    title: 'NSF — a driver that loops on its own is never cut off',
    before: 'master could not tell a self-looping driver from a finished one, so it stopped and reloaded.',
  },
  'sid-tail-restart': {
    title: 'SID — no loop API, so a tail detector restarts the tune',
    before: 'master stopped at the tune’s listed length and reloaded, cutting off anything that played past it.',
  },
  };

export const snippets = [
  {
    id: 'api-songfolder',
    title: 'A song folder is a listing, not a special case',
    file: 'server/index.js',
    lines: [478, 500],
    why: `The parent listing returns <code>type: "songfolder"</code> with a count and
      <code>url: null</code>; asking for the file itself returns one row per sub-tune,
      each a playable file with its own <code>/?play=…&amp;subtune=N</code>. No client
      code has to know that NSFE and SID are multi-song formats.`,
  },
  {
    id: 'schema-subtune',
    title: 'Sub-tunes are rows, and they are searchable',
    file: 'scripts/build-music.js',
    lines: [118, 141],
    why: `One table, one <code>UNIQUE(music_id, subtune)</code>, an fts5 mirror so
      sub-song titles are searchable, and <code>subtune_count</code> on the file row.
      Only multi-song files get rows, so a sub-song and a single-song file are the
      same to the client.`,
  },
  {
    id: 'songref',
    title: 'Identity: a song is a path plus a sub-tune',
    file: 'src/util.js',
    lines: [20, 55],
    why: `The row highlight, the now-playing song and the shuffle order stay correct
      because every list, key and comparison goes through a <code>songRef</code>,
      never a bare path.`,
  },
  {
    id: 'handle-song-end',
    title: 'The player plays one song and stops',
    file: 'src/players/Player.js',
    lines: [205, 215],
    why: `master advanced to the next sub-tune inside the player, which is why sub-tunes
      were not context entries. The sequencer owns navigation now, so a sub-tune is
      another entry in the play context.`,
  },
  {
    id: 'parser-parity',
    title: 'NSFE sub-tunes are resolved the way the emulator does',
    file: 'scripts/metadata-parsers.js',
    lines: [60, 78],
    why: `With a non-empty <code>plst</code> chunk the track count is the playlist length
      and track N is remapped through it; without one, all physical tracks are used 1:1.
      This mirrors <code>game-music-emu/gme/Nsfe_Emu.cpp</code>, which is the authority —
      an earlier version reported 106 sub-tunes for a file the emulator plays as 73.`,
  },
  {
    id: 'wasm-loop-export',
    title: 'One engine export, and why it multiplies by playback speed',
    file: 'src/bindings/libvgm-wrapper.cpp',
    lines: [386, 397],
    why: `The band has to be the song's playing time at 1x, so <code>Tick2Second</code>
      (which divides by the speed factor) is multiplied back by
      <code>GetPlaybackSpeed()</code>. The two cancel, which is what makes the value
      speed-invariant — measured identical at 0.5x, 1x and 2x — and safe to show while
      the user can change speed. Both getters return 0 when the file has no loop points,
      which is how the player knows it has no region to draw.`,
  },
  {
    id: 'sid-subtune-reload',
    title: 'The fix that makes SID sub-tunes audible',
    file: 'src/bindings/libsidplayfp-wrapper.cpp',
    lines: [206, 214],
    why: `Selecting a SID sub-tune marks the tune's current song; the engine keeps playing
      the previously loaded one until <code>load()</code> is called again. Without this the
      wrapper reports the requested sub-tune while every sub-tune plays song 0 — a bug
      you cannot see in review and cannot hear unless you compare two sub-tunes.`,
  },
];

export const limitations = [
  `MOD/XM/IT/S3M: the loop band is <em>learned</em> from the engine's first backward order
    jump, because libxmp exposes no loop position up front. It is exact once found, but it
    appears mid-song — on TECHTRIS about 80 seconds in. A band shown earlier would be a guess,
    and a wrong band is worse than a late one.`,
  `V2M has no loop points and no loop API at all, so Repeat One is the engine's end →
    stop → reload: a visible jump to 0:00. Unchanged from master, and shown here so the floor
    is on the page.`,
  `MIDI format 2 (async patterns, no shared timeline) gets no loop band: there is no single
    timeline to mark a region on. The player says so rather than highlighting the whole file.`,
  `SID has no loop API. Under Repeat One the tune free-runs past its listed length and a
    tail detector restarts it when the output is quiet and still — a heuristic, and the one
    place in this change where a setting exists to turn it off.`,
];
