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
  lede: `Two changes, shown rather than described. <strong>Sub-songs become ordinary
    songs</strong>: a file containing many songs browses as a folder, each
    sub-song can be favourited, searched, shuffled, shared and charted on its own,
    and the footer widget that used to switch between them is gone.
    <strong>Repeat One loops the region the composer wrote</strong> on every
    format we can, seamlessly, with the region drawn on the timeline — including
    the two formats where it does not, shown honestly.`,
};

export const prose = {
'loop-band': {
    title: 'The loop region, drawn on the slider',
    before: 'master had no loop region at all: the slider was a plain progress bar, and Repeat One stopped the song and reloaded it from 0:00 with a gap. The <em>Show Loop Area</em> setting is new too — master had no band to hide.',
  },
  songfolder: {
    title: 'A file with many songs is a folder',
    before: 'master listed a multi-song NSF as one opaque file row, and the only way to reach a sub-song was a separate footer widget — a "Tune N of M" label and prev/next buttons. Worth watching for what is <em>absent</em> here: no footer sub-tune widget, no "tune 8 of 28" counter.',
  },
  'favorite-subtune': {
    title: "A sub-tune can be favourited on its own",
    before: "master stored a favourite as a file, so a 28-tune NSF could only be loved or not loved as a whole.",
  },
  'repeat-toggle-smooth': {
    title: "Turning Repeat One on mid-song is jump-free",
    before: "master restarted the song from 0:00 with a gap in the audio.",
  },
  'repeat-leave-fade': {
    title: "Turning it off plays the song out",
    before: "master cut the song off at the loop point instead of finishing the pass and the fade.",
  },
  'vgm-native': {
    title: "VGM/VGZ — the engine loops, so nothing reloads",
    before: "master stopped the song and re-fetched it from the network on every repeat.",
  },
  'mdx-native': {
    title: "MDX — the engine loop and the loop points, exactly",
    before: "master stopped and reloaded, cutting the song at the loop boundary.",
  },
  'midi-cc102': {
    title: "MIDI — loop markers become a real loop",
    before: "master had no notion of a loop region in a MIDI file at all, and nothing kept a synth playing past the end of one.",
  },
  'xmp-learned-band': {
    title: "MOD/XM/IT — the loop is found by listening",
    before: "master stopped and reloaded at the order jump, with nothing on the slider to say the music repeats.",
  },
  'n64-indefinite': {
    title: "N64/USF — the engine free-runs under Repeat One",
    before: "master faded and reloaded the track on every cycle.",
  },
  // v2m-tier3's prose is kept but the scenario is ready:false while its duration bug
  // is open (AGENTS.md, "V2M's reported duration does not match the engine"). Deleting
  // the entry would also unpublish it, but leaves nothing pointing at why.
  'v2m-tier3': {
    title: "V2M — the honest fallback",
    before: "master behaved the same way here: this format has no loop points, so the song stops and reloads and the page says so rather than pretending.",
  },
  'sequencer-default-loop': {
    title: "No loop markers — the song replays from the top",
    before: "master behaved the same way here. Where a format offers no loop region, nothing changes: the Sequencer's own Repeat One stands.",
  },
  'blind-loop': {
    title: "No loop region? The head parks instead of lying",
    before: "master clamped the head at the track length with nothing to say that playback would carry on past it.",
  },
  'gme-looping-driver': {
    title: "NSF — a driver that loops on its own is never cut off",
    before: "master had no way to tell a self-looping driver from a finished one; the only answer it had was to stop and reload.",
  },
  'sid-tail-restart': {
    title: "SID — no loop API, so a tail detector restarts the tune",
    before: "master could only stop at the tune's listed length and reload, cutting off anything that played past it.",
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
      each a playable file with its own <code>/?play=…&amp;subtune=N</code>. Nothing in
      the client has to know that NSFE and SID are "multi-song formats".`,
  },
  {
    id: 'schema-subtune',
    title: 'Sub-tunes are rows, and they are searchable',
    file: 'scripts/build-music.js',
    lines: [118, 141],
    why: `One table, one <code>UNIQUE(music_id, subtune)</code>, an fts5 mirror so
      sub-song titles are searchable, and <code>subtune_count</code> denormalised onto the
      file row. Only multi-song files get rows, so a single-song file and a sub-song are
      the same kind of thing to the client.`,
  },
  {
    id: 'songref',
    title: 'Identity: a song is a path plus a sub-tune',
    file: 'src/util.js',
    lines: [20, 55],
    why: `This is the whole reason the highlight, the now-playing row and the shuffle
      order stay correct: every list, key and comparison goes through a
      <code>songRef</code>, never a bare path.`,
  },
  {
    id: 'handle-song-end',
    title: 'The player plays one song and stops',
    file: 'src/players/Player.js',
    lines: [205, 215],
    why: `master chained to the next sub-tune from inside the player, which is why the
      sub-tunes were not context entries. Now the sequencer owns navigation and every
      sub-tune is just another entry in the play context.`,
  },
  {
    id: 'parser-parity',
    title: 'NSFE sub-tunes are resolved the way the emulator does',
    file: 'scripts/metadata-parsers.js',
    lines: [60, 78],
    why: `With a non-empty <code>plst</code> chunk the track count is the playlist length and
      track N is remapped through it; without one, all physical tracks are used 1:1. This
      mirrors <code>game-music-emu/gme/Nsfe_Emu.cpp</code>, which is the authority — an
      earlier version reported 106 sub-tunes for a file the emulator plays as 73.`,
  },
  {
    id: 'wasm-loop-export',
    title: 'One new engine export, and why it multiplies by playback speed',
    file: 'src/bindings/libvgm-wrapper.cpp',
    lines: [386, 397],
    why: `The band has to be the song's true playing time at 1x, so
      <code>Tick2Second</code> (which divides by the speed factor) is multiplied back by
      <code>GetPlaybackSpeed()</code>. That cancels out and makes the value speed-invariant
      — measured identical at 0.5x, 1x and 2x, which is what makes it safe to show in a
      UI where the user can change speed. Both getters return 0 when the file defines no loop
      points, which is how the player decides it has no region to draw.`,
  },
  {
    id: 'sid-subtune-reload',
    title: 'The one-line fix that makes sub-tunes audible',
    file: 'src/bindings/libsidplayfp-wrapper.cpp',
    lines: [206, 214],
    why: `Selecting a SID sub-tune marks the tune's current song; the engine keeps playing
      the previously loaded one until <code>load()</code> is called again. Without this the
      wrapper reports the requested sub-tune while every sub-tune plays song 0 — a defect
      you cannot see in code review and cannot hear unless you compare two sub-tunes.`,
  },
];

export const limitations = [
  `MOD/XM/IT/S3M: the loop band is <em>learned</em> from the engine's first backward order
    jump, because libxmp exposes no loop position up front. It is exact once found, but it
    appears mid-song — on TECHTRIS about 80 seconds in. Showing a band that early would mean
    guessing, and a wrong band is worse than a late one.`,
  `V2M has no loop points and no loop API at all, so Repeat One is the engine's end →
    stop → reload: a visible jump to 0:00. That is master's behaviour, unchanged, and it is
    in the page so the floor is visible.`,
  `MIDI format 2 (async patterns, no shared timeline) gets no loop band: there is no single
    timeline to mark a region on. The player says so rather than highlighting the whole file.`,
  `SID has no loop API. Under Repeat One the tune free-runs past its listed length and a
    tail detector restarts it when the music goes quiet and still — a heuristic, and the one
    place in this change where a setting exists to turn the heuristic off.`,
];