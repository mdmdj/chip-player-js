// DEV-ONLY: the page's prose and snippets (dev/record/README.md §8, §9).
//
// Kept apart from build-site.mjs so the writing is editable without touching the
// generator. `prose` is keyed by scenario id and a scenario with no entry here is
// simply not on the page yet. Snippet line ranges are resolved against the
// working tree at build time: a range that has drifted fails the build instead of
// rendering an empty <pre>.

export const header = {
  title: 'First Class Sub-Tunes and More Powerful Looping',
  pr: 'chip-player-js PR',
    lede: `
    <h2>Overview</h2>
    This is a high level overview, there is a more detailed <a href="#summary">summary</a>, <a href="#demos">per-feature demos</a> and <a href="#snippets">code snippets</a> below.
    <h3>Why?</h3>
    Many chiptune formats have single files that contain multiple songs. In the current version, this creates a split where some files
    need special UI to navigate and operate differently in many ways. <br>
    The classic way of listening to looping chiptunes is obscured in a per-engine setting that is difficult to understand.<br>
    This PR aims to make sub-tunes fully integrated with easy browsing, searching and looping across all formats.<br>
    With these improvements Chip Player JS matches or even exceeds the usability and capability of other major music players like foobar2000.
    The existing Brows and Player UI is augmented instead of expanded, reducing overall complexity to the user.

    <h3>Each sub-tune is a first-class song</h3>
    A file that contains sub-tunes browses like a folder
    <p>
    Sub-tunes now support:
    <ul>
    <li>Favorite</li>
    <li>Search</li>
    <li>Shuffle</li>
    <li>Charts</li>
    <li>Loops via Repeat One</li>
    <li>Date Label (with improved parsing)</li>
    </ul>
    Share links are fully backward compatible.<br>
    The favorites list is now sorted and shows paths (similar to search results) for clarity and ease of navigation.<br>
    </p>

    <h3>Repeat One Upgraded For Sub-Tunes and Seamless Loops</h3>
    <p>
    Formats with native loop regions loop seamlessly, on load where available
    <ul>
      <li>Slider Knob reflects the relative position across loops</li>
      <li>MIDI piano roll is now populated across loop boundaries</li>
      <li>Loop regions can optionally be displayed to the user</li>
      </ul></li>
    </ul>
    </p>
    <p>
    Formats that loop via Indefinite Playback use it automatically
      <ul>
      <li>Applied optional GME-style ending detection to N64 and SID
        <ul>
          <li>Parameters are tunable, can be customized by the player.</li>
          <li>Implented is its own module, can be reused by any new player.</li>
        </ul>
      </li>
      <li>Slider Knob will park at the end of the Slider Bar</li>
      <li>A "Looping" message has been added to clarify to the user</li>
      </ul>
    </p>
    <p>
    Seamless looping behavior is opt-in on certain players, by default the original Sequencer behavior applies.<br>
    When Repeat One is not active, the Sequencer is fully in control.<br>
    There is no incremental burden for new formats by default.<br>
    The existing per-song Indefinite Playback setting has not changed.<br>
    </p>
    <h3>Catches</h3>
    <h4>Database</h4>
    <ul>
    <li>The database will need to be migrated.</li>
    <li>The catalog will need to be rebuilt.</li>
    <li>New sub-tune metadata parsing may conflict with any undocumented metadata overlays.</li>
    <li>Any undocumented metadata overlays may need to be re-applied matching the updated schema.</li>
    </ul>

    <h4>Chip Core</h4>
    Need to rebuild the Chip Core:
    <ul>
    <li>There are new exports</li>
    <li>There are changes to wrappers</li>
    <li>There is a fix in vendored mdxmini</li>
    </ul>

    <strong>There may be unexpected differences in your build due to the sibling libraries not being version pinned.<br>
    ⚠Specifically, seeking N64 miniusf files has glitchy audio in my version and I'm not sure how it's fixed on your side.</strong>
    <p>
    <h4>Auth</h4>
    This feature was developed using a mock user shim,
    best effort was make to mock the user properly,
    but it's possible unxepected issues will appear when using the real Firebase config.
    `,
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
        'Each sub-tune is an ordinary song: favorited, searched, shared, charted and shuffled on its own.',
        'A file that holds many songs (NSFE/NSF, SID, GBS, AY) browses as a <strong>song folder</strong>: a directory listing whose rows are its songs.',
        'Identity is <code>{path, sub-tune}</code>, defined once (<code>songRef</code>), so the row highlight, the now-playing song, a playlist and a share link cannot disagree.',
        'A share link keeps its format, <code>/?play=&lt;id&gt;&amp;subtune=N</code>, and lands inside the song folder with that sub-tune selected instead of on the containing directory.',
        '<code>/shuffle</code> and <code>/random</code> return one row per playable song, not per file, so a directory containing multi-song files will shuffle all songs, including sub-tunes.',
        'Top Charts group by <code>(song_id, sub-tune)</code>, so one file can hold several ranks at once, each labelled with its own song.',
        'The footer sub-tune widget (“Tune N of M”, prev/next) has been removed bcause it is obsolete. Browse/Sequencer owns song-level navigation, so a sub-tune is just another entry in the play context.',
      ],
    },
    {
      heading: 'Repeat One loops the intended region',
      points: [
        'One Repeat One across formats. Where the engine exposes the region the composer wrote, it loops it: VGM/VGZ, MDX, MIDI (CC 102/103, CC 110/111), and MOD/XM/IT/S3M (learned from playback, because libxmp exposes no loop position up front).',
        'Where there is no region, the driver free-runs and a tail detector restarts a finished one: NSFE, SID and N64.',
        'The region is drawn on the timeline. The band math is on the base player; engine policy stays in each engine’s player.',
        'Toggling it does not move the transport. The playhead is continuous across the toggle, and leaving a deep repeat plays out the rest of the pass and the fade instead of cutting the song.',
        'V2M has no region and no loop API; its fallback is unchanged: play the song, then start it again.',
      ],
    },
  ],
  // What to look out for. Each block is a thing that is true *before* you deploy,
  // not a caveat about the code. The no-region formats get no block here; they are
  // the `#limits` section, and repeating them was pure duplication.
  lookout: [
    {
      id: 'database',
      title: 'Database: rebuild the catalog before deploying',
      body: [
        'The server prepares every statement at <code>require</code> time, and the new statements reference <code>subtune</code>, <code>subtune_fts</code> and <code>music.subtune_count</code>. Against an old catalog, startup throws <code>SqliteError: no such table: subtune</code>. That takes down <code>/top</code>, <code>/search</code>, <code>/browse</code> and <code>/user/favorites</code>.',
        '<strong>Fix:</strong> run <code>node scripts/build-music.js</code> (no <code>--reset-db</code>, no <code>-n</code>). It creates the tables, adds the column, and re-parses every file to backfill counts and labels. A <code>user_version</code> marker records that the backfill ran, since <code>DEFAULT 1</code> looks the same as a real single-song file. On 6,787 files this took <strong>11.7 s</strong> and produced a catalog byte-identical to the feature branch’s (1,140 sub-tune rows, 87 multi-song files).',
        '<code>playbacks.subtune</code> needs no step; boot adds it with an idempotent <code>ALTER TABLE … DEFAULT 0</code>. Favorites need no migration either: a missing <code>subtune</code> means 0.',
        'Two effects on existing data are unavoidable. A file’s prior play count lands on its <strong>first</strong> sub-tune, because nothing recorded which one was playing. And because charts now group by <code>(song_id, sub-tune)</code>, historical rankings change as one file’s total splits across rows.',
      ],
    },
    {
      id: 'chip-core',
      title: 'Chip-core: the vendored wasm differs from production’s',
      body: [
        'Read song length late in a song, not early: <code>getDurationMs()</code> reports short until the engine has worked out where the fade ends, then settles. Never compare two readings taken at different points in a song.',
        '<strong>Seven exports</strong> are added to <code>scripts/build-chip-core.js</code>: <code>_lvgm_get_cur_loop</code>, <code>_lvgm_get_fade_start_ms</code>, <code>_lvgm_get_loop_start_ms</code>, <code>_lvgm_get_loop_end_ms</code>, <code>_lvgm_set_loop_count</code>, <code>_mdx_get_loop_start_ms</code>, <code>_mdx_get_loop_length_ms</code>. They are plain getters and setters, and every call site feature-detects, so a core without them falls back to the blind-loop UI rather than breaking. (Production exports none of them; it ships no VGM loop-region feature.)',
        '<strong>One engine change is crucial for sub-tunes.</strong> <code>libsidplayfp-wrapper.cpp</code> reloads the tune after selecting it. Without that, the wrapper reports the requested sub-tune while every one plays song 0; the full explanation is in the code section.',
        '<strong>The only vendored engine source in the diff is <code>mdxmini/</code></strong> (4 files):',
        '<ul><li>A fade that reaches zero now stops there. Before, it counted into negative numbers and could leave a song that never ended.</li><li>Position is counted in microseconds (<code>int64_t position_us</code>) instead of whole milliseconds per frame. The discarded remainder (up to a third of a frame) made the count run slow, so seeks overshot and could start a fade early. It is 64-bit because <code>long</code> is 32-bit under wasm and would wrap negative after about 35 minutes.</li></ul>',
        'Checked in-app on <code>G2MST6.MDX</code>: position tracks real time, seeks land within one frame, and it never goes negative. Every other vendored tree is build-only and absent from the PR.',
        'The two wrappers that changed (<code>libvgm-wrapper.cpp</code>, <code>libsidplayfp-wrapper.cpp</code>) carry only the loop getters and the SID reload. If your build differs, the loop policy is portable JS under <code>src/players/</code>; only the region getters are engine-specific.',
      ],
    },
    {
      id: 'api',
      title: 'API shapes',
      body: [
        'Additive except where noted: <code>/api/top</code> rows gained <code>subtune</code>, <code>subtuneCount</code> and <code>subtune_title</code>; <code>/api/browse</code> returns <code>type: "songfolder"</code> for multi-song files and sub-tune rows (<code>subtune</code>, <code>durationMs</code>, <code>url</code>) when you browse inside one; <code>/api/search</code> unions sub-tune titles, so a hit can name a song rather than a file; <code>/api/playback</code> accepts <code>subtune</code>.',
        '<strong>Watch <code>/shuffle</code> and <code>/random</code>:</strong> they now return one row per playable song as <code>{path, subtune}</code>, which for the same directory is <em>more</em> rows than before plus a new field. Anything walking a shuffle has to key on the pair, not the path.',
      ],
    },
    {
      id: 'tests',
      title: 'Testing is not in the PR',
      body: [
        'This repo has no test runner, no CI and no <code>test</code> script, and the catalog is gitignored, so a tracked suite would silently skip about a third of its checks because there is no fixture. The harnesses behind every number on this page live in <code>dev/</code> and are not in the diff; they build their own minimal SMFs for the edge cases rather than depending on a catalog file. If you want them tracked, they can move to a <code>test/</code> directory running on <code>node --test</code> with no new dependencies.',
      ],
    },
    {
      id: 'subtrees',
      title: 'Vendored engines: four subtrees can be deleted',
      body: [
        'Unrelated to this change, and worth doing when convenient: <code>libvgm/</code>, <code>libxmp/</code>, <code>fluidlite/</code> and <code>game-music-emu/</code> (about 3,000 files) are still committed but cannot build. <code>README.md</code> already calls them deprecated, and <code>scripts/build-chip-core.js</code> exports <code>_gme_disable_echo</code>, <code>_gme_seek_scaled</code> and <code>_xmp_seek_time_frame</code>, none of which exist in the vendored trees, so a build against them cannot link.',
        'They’re a stale second copy of each engine, which makes it unclear which libvgm you’re building against. Deleting them is a straight simplification; this change does not touch them or depend on it.',
      ],
    },
  ],
};

export const prose = {
'loop-band': {
    title: 'The loop region, drawn on the slider',
    before: '<code>master</code> had no loop region. The slider was a plain progress bar, and Repeat One stopped and reloaded the song from 0:00 with a gap. <em>Show Loop Area</em> is new.',
  },
  songfolder: {
    title: 'A file with many songs is a folder',
    before: '<code>master</code> listed a multi-song NSF as one file row; sub-tunes were reachable only through a footer widget (“Tune N of M” with prev/next). Absent here: that widget and the “tune 8 of 28” counter.',
  },
  'favorite-subtune': {
    title: 'A sub-tune can be favorited on its own',
    before: '<code>master</code> stored a favorite as a file, so a 28-tune NSF was favorited as a whole or not at all.',
  },
  'shuffle-subtunes': {
    title: 'Shuffle Play shuffles songs, not files',
    before: '<code>master</code> shuffled <em>files</em>. <code>/shuffle</code> picked a file and played one of its tracks, so 13 multi-song files yielded at most 13 of their 352 songs, and the same track could repeat within a pass.',
  },
  'charts-subtunes': {
    title: 'Each sub-tune gets its own chart rank',
    before: '<code>master</code> charted <em>files</em>. One NSF was one row however many tunes it held; play counts belonged to the file, and the only sub-tune the charts could name was the one the app happened to start on.',
  },
  'repeat-toggle-smooth': {
    title: 'Turning Repeat One on after the loop region never jumps the playhead',
    before: '<code>master</code> restarted the song from 0:00 with a gap. Here Repeat One is turned on after the loop region, mid-fade, and the head never jumps backward: the song plays out to its end and the file restarts.',
  },
  'repeat-leave-fade': {
    title: 'Turning it off plays the song out',
    before: '<code>master</code> cut the song off at the loop point instead of finishing the pass and the fade.',
  },
  'vgm-native': {
    title: 'VGM/VGZ: the engine loops, nothing reloads',
    before: '<code>master</code> stopped the song and re-fetched it from the network on every repeat.',
  },
  'mdx-native': {
    title: 'MDX: exact loop points from the engine',
    before: '<code>master</code> faded out and reloaded, not looping smoothly.',
  },
  'midi-cc102': {
    title: 'MIDI: loop markers become a loop',
    before: '<code>master</code> had no notion of a MIDI loop region, and nothing kept a synth playing past the end of one.',
  },
  'xmp-learned-band': {
    title: 'MOD/XM/IT: loop learned from playback',
    before: '<code>master</code> stopped and reloaded at the order jump, with nothing on the slider to show the repeat.',
  },
  'n64-indefinite': {
    title: 'N64/USF: the engine free-runs under Repeat One',
    before: '<code>master</code> faded and reloaded the track on every cycle.',
  },
  // v2m-tier3's prose is kept but the scenario is ready:false while its duration bug
  // is open (AGENTS.md, "V2M's reported duration does not match the engine"). Deleting
  // the entry would also unpublish it, but leaves nothing pointing at why.
  'v2m-tier3': {
    title: 'V2M: the fallback',
    before: 'Unchanged from <code>master</code>: the format has no loop points, so the song stops and reloads.',
  },
  'sequencer-default-loop': {
    title: 'No loop markers: the song replays from the top',
    before: 'Unchanged from <code>master</code>. With no loop region, nothing changes: the Sequencer’s own Repeat One replays the file.',
  },
  'blind-loop': {
    title: 'No loop region: the head parks at the end',
    before: '<code>master</code> clamped the head at the track length and gave no sign that playback continued past it.',
  },
  'gme-looping-driver': {
    title: 'NSF: a driver that loops on its own is never cut off',
    before: '<code>master</code> could not tell a self-looping driver from a finished one, so it stopped and reloaded.',
  },
  'sid-tail-restart': {
    title: 'SID: no loop API, so a tail detector restarts the tune',
    before: '<code>master</code> stopped at the tune’s listed length and reloaded, cutting off anything that played past it.',
  },
  };

export const snippets = [
  {
    id: 'api-songfolder',
    title: 'A song folder is a listing, not a special case',
    file: 'server/index.js',
    from: /const result = children\.map\(\(child\) => \{/,
    before: /\} else \{/,
    expect: 'isSongFolder',
    why: `The parent listing returns <code>type: "songfolder"</code> with a count and
      <code>url: null</code>; asking for the file itself returns one row per sub-tune,
      each a playable file with its own <code>/?play=…&amp;subtune=N</code>. No client
      code has to know that NSFE and SID are multi-song formats.`,
  },
  {
    id: 'schema-subtune',
    title: 'Sub-tunes are rows, and they are searchable',
    file: 'scripts/build-music.js',
    from: /^  -- Each row is a playable sub-tune/,
    before: /^  -- Triggers/,
    expect: 'UNIQUE(music_id, subtune)',
    // The file is JS, but this excerpt is the DDL inside its template literal, so
    // highlight it as SQL rather than as the JS that wraps it.
    lang: 'sql',
    why: `One table, one <code>UNIQUE(music_id, subtune)</code>, an fts5 mirror so
      sub-tune titles are searchable, and <code>subtune_count</code> on the file row.
      Only multi-song files get rows, so a sub-tune and a single-song file are the
      same to the client.`,
  },
  {
    id: 'songref',
    title: 'Identity: a song is a path plus a sub-tune',
    file: 'src/util.js',
    from: /^export function songRef\(/,
    before: /^export function isSongFolder\(/,
    expect: 'songRefKey',
    why: `The row highlight, the now-playing song and the shuffle order stay correct
      because every list, key and comparison goes through a <code>songRef</code>,
      never a bare path.`,
  },
  {
    id: 'handle-song-end',
    title: 'The player plays one song and stops',
    file: 'src/players/Player.js',
    from: /^  handleSongEnd\(onSilenceEnd = null\) \{/,
    to: /^  \}/,
    expect: 'this.stop()',
    why: `<code>master</code> advanced to the next sub-tune inside the player, which is why sub-tunes
      were not context entries. The sequencer owns navigation now, so a sub-tune is
      another entry in the play context.`,
  },
  {
    id: 'parser-parity',
    title: 'NSFE sub-tunes are resolved the way the emulator does',
    file: 'scripts/metadata-parsers.js',
    from: /^  \/\/ Mirror game-music-emu's Nsfe_Info:/,
    to: /^  \}/,
    expect: 'usePlaylist',
    why: `With a non-empty <code>plst</code> chunk the track count is the playlist length
      and track N is remapped through it; without one, all physical tracks are used 1:1.
      This mirrors <code>game-music-emu/gme/Nsfe_Emu.cpp</code>, which is the authority.
      An earlier version reported 106 sub-tunes for a file the emulator plays as 73.`,
  },
  {
    id: 'wasm-loop-export',
    title: 'One engine export, and why it multiplies by playback speed',
    file: 'src/bindings/libvgm-wrapper.cpp',
    from: /^\/\/ Loop region: the first pass is intro \+ loop/,
    before: /^\/\/ Current loop index/,
    expect: 'GetPlaybackSpeed',
    why: `The band has to be the song’s playing time at 1x, so <code>Tick2Second</code>
      (which divides by the speed factor) is multiplied back by
      <code>GetPlaybackSpeed()</code>. The two cancel, which is what makes the value
      speed-invariant (measured identical at 0.5x, 1x and 2x) and safe to show while
      the user can change speed. Both getters return 0 when the file has no loop points,
      which is how the player knows it has no region to draw.`,
  },
  {
    id: 'sid-subtune-reload',
    title: 'The fix that makes SID sub-tunes audible',
    file: 'src/bindings/libsidplayfp-wrapper.cpp',
    from: /^void sid_set_subtune\(int subtune\) \{/,
    to: /^\}/,
    expect: 'load(currentTune)',
    why: `Selecting a SID sub-tune marks the tune’s current song; the engine keeps playing
      the previously loaded one until <code>load()</code> is called again. The bug is
      easy to miss: the wrapper reports the requested sub-tune while every one plays
      song 0, so comparing two sub-tunes is the only way to hear it.`,
  },
];

export const limitations = [
  `MOD/XM/IT/S3M: the loop band is <em>learned</em> from the engine’s first backward order
    jump, because libxmp exposes no loop position up front. It is exact once found, but it
    appears mid-song: on TECHTRIS about 80 seconds in. A band shown earlier would be a guess,
    and a wrong band is worse than a late one.`,
  `V2M has no loop points and no loop API at all, so Repeat One is the engine’s end →
    stop → reload: a visible jump to 0:00. Unchanged from <code>master</code>, and shown here so
    the floor is on the page.`,
  `MIDI format 2 (async patterns, no shared timeline) gets no loop band: there is no single
    timeline to mark a region on. The player says so rather than highlighting the whole file.`,
  `SID has no loop API. Under Repeat One the tune free-runs past its listed length and a
    tail detector restarts it when the output is quiet and still. That is a heuristic, and the
    one place in this change where a setting exists to turn it off.`,
];
