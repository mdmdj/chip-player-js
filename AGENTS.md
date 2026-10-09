# AGENTS.md — Sub-songs as first-class songs

This file documents a feature branch and its development setup for AI agents
(and humans) picking up the work. Read it fully before making changes.

## Session start

Begin every session with `nvm use` (repo `.nvmrc` pins **Node 24.21.0**), then
confirm with `node -v` / `nvm current`. The host default `node` is newer (26.x)
and `better-sqlite3` is compiled per Node ABI, so running `npm`/`node` under the
wrong version fails with `NODE_MODULE_VERSION` mismatches. Also check whether an
`npm run dev` is already up before assuming the environment is correct — a
long-running server may have been started under a different Node than the shell.

## Project

**chip-player-js** is a web music player for chiptune/game audio formats
(NSF/NSFE, SID, SPC, VGM, MOD/XM/IT/S3M, MIDI, etc.), by **Matt Montag**.
React (class + hooks) frontend, Express + better-sqlite3 server, C/C++ player
engines compiled to WebAssembly via Emscripten.

- Upstream: `git@github.com:mmontag/chip-player-js.git` (remote `upstream`)
- Our fork: `https://github.com/mdmdj/chip-player-js.git` (remote `origin`)

**Important:** Matt has personally given permission for this feature fork, and
the goal is a merge he will accept. Match existing conventions, keep the diff
minimal and coherent, and do not ship "slop." Read surrounding code before
editing; mirror its style (comment tone, SQL formatting, naming, etc.).

## Branches

Two long-lived branches, one concern each. The PR is defined by topology, not by
a list of commits to remember:

- **`feature/subtunes-as-first-class`** — the PR. Based on `master` and contains
  **only** the sub-tunes feature: `scripts/{build-music,metadata-parsers}.js`,
  `server/{database,index,schemas}.js`, and the feature parts of `src/`
  (components, `Sequencer`, `util`, plus the small `Player.handleSongEnd`
  change). No `dev/` shims, no engine/build tooling, no `AGENTS.md`/`.nvmrc`.
  `git diff master..feature/subtunes-as-first-class` is the reviewable PR.
- **`dev/overlay`** — stacked on top of the feature branch and holds everything
  that must **not** be part of the PR: engine build scripts, `src/bindings/`,
  `src/tinyplayer.c`, the audio parts of `src/players/*Player.js`, vendored-tree
  fixes, `config/webpack.config.dev.js`, the `dev/` shims and browser test hooks,
  `AGENTS.md`, `.nvmrc`, `.gitignore`. Think of it as our personal dev overlay:
  the local setup and tooling we need to work, layered on the reviewable feature.
  This is where the app is developed and run. Lives in our fork (`origin`);
  nothing here is part of the PR.

Workflow: commit feature changes on the feature branch; commit dev/overlay changes
only on `dev/overlay`; then, after a promote, pick up the feature moves with
`./dev/rebase.sh` — which rebases (`-X theirs`, so DEV regions survive) **and
verifies the tree did not move**, which a hand-run rebase cannot tell you. The
rebase rewrites `dev/overlay`'s history, so publish it with
`./dev/push-overlay.sh` (a `--force-with-lease` push) — never `git pull`
`dev/overlay` after a rebase. Never rebase by hand; expect *duplicated* content
in path-listed files, which is what
the script's check is for (see the handoff notes). Note that "promote" is its own
step and is **the user's to trigger** — see "Dev overlay & promotion" below
before going near `dev/promote-apply.sh` or `dev/.promote-armed`. Never commit
overlay changes to the
feature branch, and never push either branch to `upstream` — everything stays in
our fork (`origin`). The main worktree (`chip-player-js/`) runs `dev/overlay`; the
feature branch is checked out in the sibling `chip-player-js-feature/` worktree.

## Dev overlay & promotion

> **Promotion is user-initiated. Do not promote because you finished something.**
> Landing a fix on `dev/overlay` and landing it on the reviewable PR branch are
> different acts, and only the second one is a decision for the user:
>
> - **Never run `dev/promote-apply.sh`** and **never create `dev/.promote-armed`**
>   unless the user asked for that promotion in that turn. "Fix this bug", "make
>   it clean", "commit and push" and "this is feature work" are not that ask.
>   A key file exists so the gate is an act a person does on purpose; an agent
>   creating it has already made the decision it was meant to prevent.
> - **Do not run `dev/promote.sh` as a per-change ritual** either. It is safe
>   (plan-only, no write path), but re-checking it after every commit is noise,
>   not diligence. Run it when the user asks, when reporting promote state at
>   handoff, or immediately before a promotion the user requested.
> - **Nothing else promotes.** No CI, no git hooks, no npm script, no test
>   harness references it; `dev/run-tests.sh` runs parsers and harnesses only.
>   If you ever add one that does, that is the bug, not the policy.

`dev/overlay` is the **dirty working branch**: it deliberately mixes feature,
audio/engine and dev-tooling commits, and that is fine. The goal is not a clean
tree — it is a **deterministic, low-effort way to promote feature work to the
parent** without leaking overlay content. Promotion is two steps, the second of
which the user takes explicitly:

```sh
./dev/promote.sh           # plan only; no write path. Prints the next command.
touch dev/.promote-armed   # the user arms the writer
./dev/promote-apply.sh     # promotes, then rebases, verifies, and pushes
```

`promote-apply.sh` runs the whole mechanical tail once armed: commit the
stripped files on the feature branch, `./dev/rebase.sh` (rebase + verify), push
the feature branch, then `./dev/push-overlay.sh`. The arm key is the only
decision; the rest is one command. `PROMOTE_SKIP_PUSH=1` stops after the rebase.

`promote.sh` requires a clean overlay tree, then, for every file that differs
from the feature branch, it:
- skips anything listed in `dev/promote-paths.txt` (overlay-only **areas**:
  `dev/**`, the engine build scripts, vendored trees, and the one "seam" file),
- strips `DEV-BEGIN … DEV-END` regions from the rest,
- promotes only files whose stripped content still differs from the feature
  branch (i.e. real feature work),
- and refuses to plan a file whose stripped output does not parse.

Two rules the stripping obeys, both learned the hard way:

- **A sentinel must be the first word on its line.** Matching the bare
  substring meant a comment merely *mentioning* `DEV-BEGIN` switched skipping
  on and swallowed every line after it. "First word behind non-alphanumeric
  characters" is the rule — it covers `//`, `#`, `--` and JSX's `{/* … */}`
  without enumerating comment styles.
- **Stripping must leave a valid file.** JS goes through `node --check`, with a
  `@babel/core` parse (jsx plugin) as fallback because `node --check` rejects
  JSX outright — several `src/` files are JSX-bearing, so without the fallback
  any JSX file that differs from the feature branch reads as unsound; everything
  else goes through brace balance. A region that unbalances a brace used
  to produce a file that was wrong but still committed.

It writes the result into the feature-branch worktree and commits it there as one
commit ("Promote feature work from dev/overlay"), leaves `dev/overlay`
untouched, and refuses if `DEV-BEGIN`/`DEV-END` sentinels are unbalanced. Then
`promote-apply.sh` puts `dev/overlay` back on top — **via the script, not by
hand** — and publishes both branches:

```sh
./dev/rebase.sh        # rebases onto the feature branch, then verifies the tree
git -C ../chip-player-js-feature push origin feature/subtunes-as-first-class
./dev/push-overlay.sh  # --force-with-lease; NEVER `git pull` dev/overlay
```

The rebase is the only step of the cycle that can change the tree without saying
so: `-X theirs` resolves an overlapping hunk toward the replayed commit, and work
the feature branch already carries is dropped or emptied. On 2026-10-07 a rebase
printed "Successfully rebased", exited 0, dropped the shuffle rewrite and put
`server/database.js` back to a superseded design — the only reason it was caught
is that the tree was diffed against a pre-rebase snapshot. `dev/rebase.sh` makes
that the tool's job:

- it **refuses to resume** a rebase that stopped (`git rebase --abort`, then
  re-run). An interrupted rebase leaves the partially applied commit staged and
  `--continue` trusts it, which is how that one went wrong;
- `git range-diff` over the two ranges **names every commit the rebase emptied
  or dropped**. A promoted commit is expected here — the feature branch carries
  the work now, so only its dev-only remainder is left, and the commit and its
  message stay on `dev/overlay`. A commit that is gone *and* whose content is
  not on the feature branch is a lost change;
- `git diff <tip> HEAD` **must be empty**, *unless the base supplied the
  movement*. That exception is not academic: on 2026-10-07, catching up to
  upstream, 23 files moved and 3 of them (`scripts/build-chip-core.js`,
  `server/index.js`, `src/index.js`) also hold overlay-only deltas, so the whole
  set was not identical to the feature branch and the byte-identical rule called
  it a lost change. The check is now **per file**: did the base change this file
  between the merge base and itself? If yes, its content moving is explained; if
  no, the rebase changed something nothing supplied and the script exits
  non-zero naming exactly those files, to restore from the recorded tip
  (`dev/.pre-rebase`). Both directions are covered by synthetic repos: a
  DEV region in an upstream-touched file exits 0, a dropped delta in a file the
  base never touched exits 1.

  **When it does fire, check before restoring.** The 2026-10-07 case was a false
  positive: `range-diff` reported 0 commits dropped, all 206 overlay-only lines
  across the three files were still present, and the whole `origin/dev/overlay →
  HEAD` delta was exactly upstream's 23 files. Nothing was lost.

Measured, for the record: a clean, uninterrupted rebase of these branches drops
nothing and reproduces the pre-rebase tree exactly. The damage came from the
interrupted-then-resumed rebase, **not** from the hand-carry convention, and
`--reapply-cherry-picks` changes nothing here.

### Two mechanisms — how to choose

- **Whole files → physical paths.** Dev/engine areas live under paths that never
  overlap feature code, so they never appear in the promoted diff. Add an entry
  to `dev/promote-paths.txt` only for a whole AREA (directory / build file /
  vendored tree) — **not** for individual feature files.
- **Chunks inside a shared file → additive sentinel regions.** Wrap the dev-only
  code so *removing the region restores prod behavior exactly*:
  ```
  // DEV-BEGIN (stripped for promotion; <why>)
  ...dev-only code that only ever ADDS behavior...
  // DEV-END
  ```
  Prefer moving dev-only code into `dev/` or an untracked module; prefer a region
  over a path-list entry. "Additive" is the key property: do not put code inside
  a region that prod also needs.

### What promotes and what does not — how to judge

Three buckets. When unsure, ask rather than guess: a wrong call either leaks
dev tooling into Matt's review or strands feature work on the overlay.

1. **Personal dev tooling → never promotes.** Anything that exists for our
   working style rather than the product: everything under `dev/` (shims,
   harnesses, `promote.sh` itself), `AGENTS.md`, `.nvmrc`, the LAN-hostname
   tweak in `src/config/index.js`, `DEV_AUTH_MODULE`/skia seams, the SID
   silent-stub era hacks. Rule of thumb: if Matt would have to *remove* it
   to run his own setup, it stays out. Upstream has its own dev tooling;
   ours is not compatible with his by design.
2. **Short-term hacks to get it working → do not promote; fix properly or
   drop.** Markers: hard-coded values that only hold locally, disabled code
   (`#if 0`), duplicated logic that should live in one place, workarounds
   whose root cause is unknown. Either promote the real fix (e.g. pruning
   GME's OPN objects instead of forcing a core per-device) or leave the hack
   overlay-only. Never promote a hack "temporarily".
3. **Legit feature work and bug fixes → promote.** The test from the 2026-10
   audits: *does it improve the user experience, and is it compatible with
   upstream?* Sub-tune folders/identity/sharing, Repeat One per format,
   loop bands, the piano-roll expansion, the `?play=` songfolder landing —
   all feature. Compatible bug fixes ride along: the mdxmini fade/position
   latches, the `parentIdx` removal (upstream master doesn't compile without
   it), the `Spc_Sfm`/`Spc_Cpu` build fixes, the OPL3-bank guards. Vendored
   engine *sources* promote only as minimal, obviously-correct fixes; our
   build *scripts* and core *selection* (which cores/flags we compile) never
   do — Matt builds his own way. Compat shims that degrade gracefully
upstream (XMP seek fallback, ADLMIDI guards) promote as-is; behavior that
only makes sense against our core (SID wrapper, our core *selection*) stays
out.

### The 1 hard-coded seam

One seam genuinely cannot be an additive region, because prod must still load
the real module while dev loads an alternative *instead of* it:
`server/index.js`'s `DEV_AUTH_MODULE` require fallback. At final PR prep this is
the "1 line" to inline by hand.

A region can express *"dev adds behaviour"*; it cannot express *"dev loads A,
prod loads B"*, because stripping only removes lines — the stripped form either
loses the assignment or duplicates the binding. Upstream's `auth.js` requires a
service-account JSON we do not have, so the bypass is real, not hypothetical.

**De-listing was prototyped and rejected (2026-10-07).** The other two seams
were removable or deletable — the skia-canvas fallback was deleted outright (it
is a declared dependency in `server/package.json`, so the plain require is the
honest version), and `cache1Hour` became a region. That made `promote.sh` offer
the file. But the promotion delta then carried a bare
`let authModule = './middleware/auth.js';` plus `require(authModule)` — dev
plumbing in a sub-tunes PR, with no answer to "why is this a variable?". One
line of unexplained indirection is worse than hand-carrying the file, so the
file stays listed. The seam is now one line rather than two, and the blockers
are down to one.

The other remaining hand-carry is `scripts/build-chip-core.js`, 7 lines of
`EXPORTED_FUNCTIONS` entries against 186 lines of our engine build tooling.
That one is **policy, not mechanics**: the file is technically promotable (the
dev hunks could be regioned), but de-listing it would ship our duplicate-symbol
tripwire, `../`-path normalisation and GME-pruning notes into Matt's PR, and
Matt builds his own way. Hand-carrying 7 stable export entries is the right
trade.

Because the file is path-listed, `promote.sh` also skips the feature work that
lands here. **Hand-carried (2026-10-02, re-carried 2026-10-06):** the `?play=`
handler's `subtuneCount` in `__chipConfig` — now an unconditional
`subtuneCount: song.subtune_count || 1` in the `chipConfig` literal — plus the
whole `/shuffle` + `/random` rewrite (see "one field, one predicate" and the
shuffle notes below). Its counterpart, `m.subtune_count` in `getSongByIdStmt`,
lives in `server/database.js`, which promotes normally; it is carried by hand
too, because the new `/shuffle` calls `getShuffleStmt` with a path *and* a
prefix and the old two-parameter statement cannot answer that. The client half
(`App.js`) promotes on its own — see the compatibility note below.

**No longer hand-carried (2026-10-07):** the `sid_set_subtune` fix (call
`engine->load(currentTune)` after `selectSong()`) used to be hand-carried because
`src/bindings/libsidplayfp-wrapper.cpp` was path-listed for its
`SIDPLAYFP_HAVE_SEEK` guards. Those guards are gone: they defaulted to 0 and so
only guarded a build we never make — upstream's own wrapper calls `setTempo()`/
`seek()` unguarded and never defines the macro, so upstream is already
fork-only, and `build-libsidplayfp.sh` always builds mmontag's fork. The file
now matches upstream apart from the sub-tune fix and promotes with everything
else. Without that fix the PR's `SIDPlayer.playSubtune` selects a sub-tune that
never loads, so every sub-tune of a multi-song SID plays song 0 and the
tail-detector restart is a no-op. Building against the official core now fails
at compile time rather than silently ignoring seek and tempo, which is better.

### Known gaps (handoff state)

- Divergence audit 2026-10: `master..dev/overlay` is 73 files; every one is
  classified. The promote dry run (26 files) was reviewed hunk-by-hunk
  (plus two subagent passes): all promoted content is feature, no dev
  leakage. `dev/promote-paths.txt` now excludes every vendored tree
  (mdxmini fixes were leaking into the plan before) and no longer lists
  `N64Player`/`UserProvider`/`MIDIPlayer`/`XMPPlayer` (all promote cleanly:
  regions strip, portable guards ride along).
- Remaining path-listed files are intentional: `src/config/index.js` is
  dev-only throughout (LAN hostname) and `server/index.js` stays listed
  (DEV_AUTH_MODULE/skia seams) plus one hand item that is now DONE — the `?play=`
  handler's `subtuneCount` injection is hand-carried alongside the promoted
  `getSongByIdStmt` column (see "The 1 hard-coded seam" above); the remaining
  item is an unrelated HVSC `csdbid` perf guard, which stays out.
  MIDIPlayer/XMPPlayer needed no regions after all — their
  fork/API guards are portable compat — so they delisted whole.
- After the reverted libvgm attempt, the working tree is clean and VGM/looping
  work (see "Building the real chip-core").

## The feature

Today a "song" is a file. Some formats (NSF/NSFE, SID) contain **multiple
songs (sub-songs / sub-tunes)** in one file. Currently sub-songs have a separate
UI (footer `Tune N of M`, prev/next buttons), and cannot be favorited, shuffled,
or handled like single-file songs.

**Goal:** a single-file song and a sub-song are identical in the UI. A file with
multiple sub-songs is displayed as a **"song folder"**; each sub-song can be
favorited, looped, shuffled, shared, and (in future) playlisted.

## Dev environment

- Node is pinned via **`.nvmrc`** (`24.21.0`, LTS). Use `nvm use` before any
  Node/npm command. (`better-sqlite3@12.5.0` supports 20–25, not 26.)
- Root install: `npm install --ignore-scripts` then `npm rebuild better-sqlite3`.
  (The unused `sqlite3` devDependency cannot build on Node 24; `--ignore-scripts`
  skips it. Root `better-sqlite3` is needed by `scripts/build-music.js`.)
- Server deps: `npm install` inside `server/` (builds `better-sqlite3` and
  `skia-canvas` fine).
- **`npm install --no-save` is a trap here; install everything in ONE command.**
  Three separate `--no-save` installs cost three breakages, all silent until
  something else failed:
  - Each `--no-save` install **prunes the previous one** (npm resolves the whole
    tree against `package.json`, which lists neither), so install playwright +
    webpack together: `npm i --no-save --no-package-lock playwright@1.63.0
    webpack@5.106.0`.
  - It **upgrades existing deps** as a side effect: webpack went 5.106 → 5.111,
    which **removed `webpack/hot/log.js`** and broke the dev build with a missing
    module. Pin webpack to `5.106.0` explicitly and restart `npm run dev` after.
  - It **rebuilds native modules against whatever `node` is on PATH**, and the
    host default is 26.x, so `better-sqlite3` ended up compiled for the wrong ABI
    and every `node scripts/build-music.js` (and therefore `dev/run-tests.sh`)
    died with `NODE_MODULE_VERSION`. Repair with
    `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" npm rebuild better-sqlite3`
    — note `nvm use` alone does **not** fix PATH in a non-interactive shell.
  - Invariant: **`package.json` must stay unmodified** and the lockfile too (hence
    `--no-package-lock`); `node_modules` is gitignored. Verify with
    `git diff --stat package.json package-lock.json` (empty) after installing.
- **Dev shims** live in `dev/` on `dev/overlay` only (never on the feature
  branch), tracked so the dev environment is reproducible. They stage
  **untracked, gitignored** modules rather than patching tracked files, so a
  working tree stays clean (`git status` shows only intentional overlay edits):
  - `./dev/apply.sh` — stages untracked `src/chip-core.js`,
    `src/chip-player-devtools.js`, `src/chip-player-record.js`,
    `server/middleware/auth.dev.js` and a
    placeholder Firebase config; patches a dev-user `UserProvider` and a
    silent-SID `SIDPlayer` (reversible, no backups); seeds `users.db` /
    `csdb.db`; writes `server/.env.local` (with `DEV_AUTH_MODULE`); builds
    `catalog/` + `server/catalog.db`.
  - `./dev/remove.sh` — reverts the in-place patches (`--revert`) and deletes
    the staged untracked files. No tracked file is restored from a backup.
  - `node dev/test-parsers.js` — parser harness (30 checks; synthetic buffers +
    real files under `catalog/`, including RSID fixtures).
  - `node dev/test-build.js` — build-music round-trip on a temp catalog subdir
    (sub-tune rows, dates, idempotency, FK-safe delete); cleans up after itself.
    **It runs the builder against the REAL `server/catalog.db`**, so it now
    snapshots that file (WAL checkpointed first) and restores it in a `finally`.
    Do not add a schema-mutating check without that guard: on 2026-10-03 a
    `--dryrun` check run against the *pre-fix* builder dropped `subtune_count`
    and let the dry run re-add it with `DEFAULT 1`, silently resetting all 6788
    rows to `subtune_count = 1`. The 1140 `subtune` rows survived, so a plain
    `node scripts/build-music.js` (no `-n`) repaired it — and only because the
    fix forces a reprocess while the backfill marker is unset. Symptom to
    recognise: `subtune` rows exist but `SELECT COUNT(*) FROM music WHERE
    subtune_count > 1` returns 0 (should be 87).
  - `node dev/test-sequencer.js` — sequencer navigation with a fake player
    (each sub-tune plays once, mixed contexts advance entry-by-entry). Uses an
    inline Babel require hook; no new deps.
  - `node dev/test-vgm-loops.js`, `node dev/test-gme-loops.js`,
    `node dev/test-mdx-loops.js` — the VGM toggle matrix, GME's in-buffer
    restart, and MDX's native loop, each with a fake core modelling that
    engine's bookkeeping (libvgm's running fade survives `SetLoopCount(0)`;
    mdxmini's latched `fade_out` and `length(k) = intro + k*loop + fade`; GME's
    `track_ended` versus an internally looping driver). Two `xfail`s, both
    confirmed in-app: the VGM indefinite-playback fade (a known limit, see the
    decision below) and the unguarded `lvgm_get_cur_loop` sentinel.
  - `node dev/test-v2m-loops.js` — the bottom rung of the ladder: V2M has no
    loop points and no loop API, so the engine ends, the song stops, and the
    sequencer either advances or re-loads. Pins the tier-3 contract (no band, no
    late-restart seek, the base detector standing down under Repeat One) rather
    than rendering.
  - `node dev/test-midi-loops.js`, `node dev/test-xmp-loops.js` — loop-region
    harnesses for the MIDI and XMP Repeat One work. The MIDI one also *builds*
    minimal SMFs (`buildMidi`) for the edge shapes, so they do not depend on a
    user-supplied catalog: an N64 CC102/103 pair, a paired marker too short to be
    a region, a lone CC111, post-loop padding with and without notes, a markerless
    file under repeat one, and the format-2 no-band rule with a format-1 guard.
  - `node dev/test-end-detector.js` — the shared `EndDetector` as used by SID
    and N64: trip gate, level+stillness rule, muted voices, restart re-arming,
    N64's config-default length for untagged `.miniusf`, and the tuning layers
    (module defaults, and a player override replacing only named fields).
  - `node dev/test-subtunes-server.js` — the sub-tune API over HTTP against the
    running dev server (song folders, sub-song rows, search union, metadata,
    shuffle/random/playback/top, and per-sub-tune favorites including a legacy
    row with no sub-tune). It mutates the dev user's favorites and undoes them.
    Skips cleanly if the server or the catalog is absent.
  - `node dev/test-songrefs.js` — the `SongRef` identity model in `src/util.js`,
    and how a sub-tune names itself (`subtuneLabel`).
  - `node dev/test-devtools.js` — the `__cpDev` stall-watch latch.
  - `dev/record/probe.mjs` — measure a fixture in the live app
    (`node dev/record/probe.mjs "/?play=<id>&subtune=N" [seek|watch|calls|restart]`).
    For the numbers a clip's assertions depend on when the catalog has none: engine
    `play_length`, the SID end-detector trip gate, whether a driver free-runs past
    its reported length. Taps the app's own gain node, so a seek into a silent tail
    cannot pass as music.
  - `dev/record/vid*.mjs` — page-delivery checks, all headless and none of them
    needed by `run-tests.sh`: `vidcheck` (one clip's media pipeline state),
    `vidall` (every clip, per-clip verdicts), `vidleak` (bytes pulled on load),
    `vidgeom`/`vidcap`/`vidsharp` (what `recordVideo` and a window size actually
    produce — see `dev/record/FINDINGS.md`).
  - `./dev/run-tests.sh` — runs all of the above. Dev-only, not part of the PR.
  - `dev/README.md` documents the shims.
  - Two tracked seams keep the untracked overrides loadable without touching
    feature files: `server/index.js` requires `process.env.DEV_AUTH_MODULE ||
    './middleware/auth.js'` (overlay-only delta), and the overlay-only
    `config/webpack.config.dev.js` prepends `src/chip-player-devtools.js` (and
    `src/chip-player-record.js` when staged) to the
    entry. `dev/shims/devtools.js` self-installs `window.__cpDev` (browser test
    hooks: `snapshot`, `setRepeat`, `seek`, `startRecord`, ...) and polls for
    `window.ChipPlayer`. See "Repeat One / looping model".
- Run the app: `npm run dev` (webpack dev server on :3000, API server on :8080).
  The API server must run with `NODE_ENV=development` (as `npm run server`
  does): without it Express serves the raw `public/` template with literal
  `%PUBLIC_URL%` instead of proxying HTML from WDS, and manifest/icons 500.
  `ps` won't show the env, so check
  `curl -s mms-1:8080/ | grep -c PUBLIC_URL` (0 = healthy).
  **Restart after editing any webpack config file** (`config/webpack.config.*`,
  `scripts/start.js`): the config is read once at startup, so a live rebuild
  keeps serving the old one — e.g. a new `DefinePlugin` silently ships an
  unsubstituted `__BUILD_INFO__` identifier into the bundle.
  Run it with `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` (see
  "Session start"); `nvm use` alone does not fix PATH in a non-interactive
  shell.
- **Audio:** the dev stub `src/chip-core.js` is a no-op (no audio). A **real
  chip-core was built** in this session — see "Building the real chip-core"
  below. It is gitignored and not committed.

### Building the real chip-core

> **Engine sourcing changed 2026-10-08: the in-repo subtrees are gone and the
> build uses sibling clones.** `libvgm/`, `libxmp/`, `fluidlite/` and
> `game-music-emu/` were deleted — they were already dead (`master`'s own
> `build-chip-core.js` exports `_gme_disable_echo` and `_xmp_seek_time_frame`,
> neither of which the vendored trees contain, so nothing could link them) and
> were a second, stale copy of every engine. The build takes those four from
> siblings beside the checkout — `../libvgm` (ValleyBell), `../libxmp` (4.7.x),
> `../FluidLite`, `../game-music-emu` (mmontag's fork) — plus `../libsidplayfp`
> (mmontag fork, as before). `libADLMIDI/`, `psflib/` and `lazyusf2/` remain
> vendored in-repo; `mdxmini/` and `farbrausch-v2m/` compile from source.
> `scripts/build-subprojects.sh` builds all of them to the paths
> `build-chip-core.js` links. (The vendor-tree deletion and sibling build live on
> `dev/overlay` only; they are in `dev/promote-paths.txt` and never reach the PR.)
>
> **What follows is kept for its findings, but its build mechanics are
> pre-migration — read with these corrections:**
> - **Reproducible within a checkout, not across checkouts.** A rebuild in the
>   same directory is deterministic (2026-10-08: the same sha three times), but
>   the wasm embeds its build path, so two checkouts give different bytes from
>   identical sources. The pre-migration claim that a rebuild reproduced the
>   frozen `94c17c93…` artifact exactly was a 2026-10-02 in-repo-tree result and
>   no longer describes the build. Pinning the siblings (a lock of repo+commit)
>   is the open reproducibility TODO — see `dev/UPSTREAMING_PLAN.md` §4.
> - **The engine-content gate** still refuses a silent version swap (it compares
>   the recorded manifest; `CHIP_ALLOW_ENGINE_FALLBACK=1` accepts a deliberate
>   change). With the siblings present `normalizeInput()` never falls back, so an
>   `engine-fallback` warning is no longer "normal" — treat it as a mistake.
> - **Provenance is recorded, and readable from a running app.**
>   `scripts/build-info.js` is the single reader: the four deleted engines are
>   `source: 'sibling'` (a `revision`, plus recursive submodule state);
>   `libADLMIDI` is `source: 'in-repo'` (a `git rev-parse HEAD:<dir>` tree hash);
>   `tier` records confidence (`authoritative` for Matt-specified SID, `verified`
>   for upstream-matched, `base+patches`, `assumed`). Two consumers, so they
>   cannot disagree: each build writes `src/chip-core.wasm.buildinfo.json`, and
>   `config/webpack.config.common.js` `DefinePlugin`s the same object as
>   `__BUILD_INFO__`, which `src/index.js` assigns to `window.ChipCoreBuildInfo`.
>   Deliberately **not** in the UI: run `JSON.parse(window.ChipCoreBuildInfo)` in
>   a deployed build's console to ask prod what it was built from, or grep the
>   single-line literal in `main.<hash>.js`. Whitelisted fields only — hashes, no
>   `git log` (author PII), no remote URLs (may embed a credential), no absolute
>   paths (leak a home directory). Known gap: the SID submodule parser reports 1
>   submodule where `git submodule status --recursive` shows 2 (`resid` on
>   `montag-dev`, plus the xa65 `driver`) — fix before trusting SID's pin.
> - **Prod's *wrapper* is ours; its *libvgm tree* is NOT established, and
>   probably differs from ours.** Probed 2026-10-02
>   against prod's `static/js/main.acd8.js` (Emscripten export names survive as
>   string literals even though the wasm is stripped). Prod's libvgm surface is
>   19 names, every one byte-identical to ours (`lvgm_init`, `_load_data`,
>   `_render`, `_seek_ms`, `_set_indefinite_playback`, voice APIs, …), and it has
>   **none** of our loop APIs (`lvgm_get_cur_loop`, `lvgm_set_loop_count`,
>   `lvgm_get_{loop_start,loop_end,fade_start}_ms`,
>   `lvgm_get_indefinite_playback`, `lvgm_reset`) — so **prod ships no VGM
>   loop-region feature at all**, and our Repeat One baseline is new capability,
>   not a port. `lvgm_get_voice_chip_name` exists in **no** upstream libvgm — it
>   is ours, added to the wrapper 2024-06-17 (`27ad9ee11`, moved to
>   `src/bindings/` by `cad9a5545`) — and prod exports it, so prod builds from
>   **this repo's wrapper**. That does **not** identify the tree: a wrapper is
>   compiled against whatever libvgm happens to be present, so one wrapper
>   links against many trees. An earlier version of this note concluded "and
>   therefore this repo's `libvgm/`" — that was an invalid inference.
>   **Disproof, measured 2026-10-03 and re-measured 2026-10-08:** with a
>   byte-identical `lvgm_get_position_ms`, prod's position scales with playback
>   speed (1.98x at 2x on 2026-10-03; 1.99x at 2x on 2026-10-08, same file on
>   both builds) while our build's does not (1.00x). Same getter,
>   opposite behaviour, so prod's tree is not ours. Treat the target tree as
>   unknown and never reason about prod behaviour from our tree.
>
> - **What libvgm are *we* on.** The sibling `../libvgm` (ValleyBell; `c8b998b`
>   when this was written), recorded by `scripts/build-info.js` as
>   `source: 'sibling'` with its revision. The pre-migration vendored tree was
>   upstream `91b6542`; that subtree is gone. The engine-content gate is still
>   the only guard against a silent swap (it fails the build if an engine's
>   recorded identity moved; `CHIP_ALLOW_ENGINE_FALLBACK=1` to override), so
>   verify a given build with `JSON.parse(window.ChipCoreBuildInfo)`.
>   **So: our tree is documented; the tree *Matt* builds against is not
>   documented anywhere and cannot be inferred from the repo.** That is the
>   standing risk behind the `* GetPlaybackSpeed()` assumption above.
>   **Why no tick-math fix settles it** (checked 2026-10-03; this rules out the
>   obvious patch): `PlayerBase::Sample2Second()` is
>   `samples / _outSmplRate` — pure wall-clock, speed-agnostic — which is why
>   `GetCurTime()` makes position a **wall-clock** value. `Tick2Second()` is
>   instead `ticks * _ttMult / _tsDiv`, and `_tsDiv` carries `pbSpeed`. The two
>   conversions therefore differ by exactly the speed factor, and which unit the
>   band *must* be in depends on the tree:
>   - `Sample2Second(Tick2Sample(t))` → `t/88200` at 2x — matches position in
>     **our** tree.
>   - `Tick2Second(t) * GetPlaybackSpeed()` → `t/44100` at 2x — matches
>     position in **prod's** tree.
>   Mutually exclusive; both cannot be right, and the target tree is unknown, so
>   guessing is the one thing to stop doing. (`Tick2Sample` also truncates — it
>   returns `UINT32` and can be 0 for sub-sample tick counts, which would
>   silently collapse the band.)
>   `Sample2Second` is *uniform* across our variants — every per-player override
>   (`vgmplayer.hpp:176`, `droplayer.hpp:121`, `gymplayer.hpp:97`,
>   `s98player.hpp:97`) is commented out, so VGM/DRO/GYM/S98 all inherit
>   `samples / _outSmplRate`. The unknown tree, not engine variety, is the risk.
>   **Version-independent fix: stop converting units.** Derive the band by
>   observing the engine at its own loop boundary — record `getPositionMs()`
>   when `getCurLoop()` increments. That would be in position's units by
>   construction on any tree. **Rejected 2026-10-03: it costs the band at load**
>   (it can only appear after the first loop), and the tick math it would
>   replace is already correct — see below.
>
> - **The band at load is correct as written; keep it.** `Tick2Second(t) *
>   GetPlaybackSpeed()` is `t / (ticks per second at 1x)`, i.e. the song's true
>   playing time at 1x — a physical property of the file, not of the tree.
>   Measured 2026-10-03 and re-confirmed 2026-10-08, it is
>   **speed-invariant**: band `[1142, 1942]`, `intro=342`, `loop=800` at 1x, 2x
>   *and* 0.5x, and on a different file the engine returned the identical band
>   `[53199, 91599]` at all three tempos. (The `duration` figures this line once
>   quoted as the contrast — 6442 / 10942 / 4192 — were an artifact of sampling a
>   transient duration; see the speed table below. Do not reuse them.) So the
>   multiplication is doing its job — cancelling the speed term — and the band is
>   stable and physically right in every tree.
>   **The earlier "open PR risk" was overstated.** The band is not a guess that
>   might be wrong; it is a correct song-time value. The real asymmetry is that
>   **`position` means different things per tree** (wall-clock in ours, song-time
>   in prod's), so on *our* tree the band and position disagree at non-1x while
>   on prod's they agree. Since prod is the reference and our tree is
>   overlay-only, there is nothing to change here — do not "fix" the getters to
>   chase our tree. Only `duration` is genuinely non-invariant, and that is
>   pre-existing master code, not ours.
> - **What we have inferred about Matt's build that CONFLICTS with this
>   repo.** Consolidated 2026-10-03, because it is the root cause of most of
>   this branch's remaining uncertainty: we cannot assume the vendored trees are
>   what anyone else builds. Every row below is a symbol we checked, not an
>   assumption. Prod was probed live at `https://chiptune.app` via
>   `typeof window.ChipPlayer.chipCore[name]`. **The "ours" column names the
>   then-vendored trees, deleted 2026-10-08; the build now uses modern siblings, so
>   rows 1–2 no longer describe our build — they remain the proof that master's own
>   scripts cannot link the old subtrees.**
>
>   | # | Evidence | Conflict with this repo |
>   | --- | --- | --- |
>   | 1 | prod exports `_xmp_seek_time_frame`; master **and** feature list it, but the vendored libxmp has no `seek_time_frame` anywhere | **Matt's libxmp is >= 4.7; ours is 4.5.** Our own script could not link against our own tree — the overlay comments it out for that reason |
>   | 2 | prod exports `_gme_disable_echo`; master and feature list it, vendored `game-music-emu` has no `disable_echo` | **Matt's GME is >= 0.6.4; ours is the 2018 tree** |
>   | 3 | prod's position advances 1.99x at 2x speed, ours 1.00x, with a byte-identical `lvgm_get_position_ms` (re-measured 2026-10-08 on one file present in both catalogs) | **prod's libvgm is not our vendored 91b6542** |
>   | 4 | prod exports `_sid_set_speed`; **no** branch's build script lists it, yet master `SIDPlayer.js:145` calls it unguarded | our `EXPORTED_FUNCTIONS` is a **strict subset** of prod's. It works in prod and cannot work from this repo as configured — a latent break in *master*, not ours |
>   | 5 | prod exports `_fluid_synth_get_active_voice_count`; the overlay dropped it (no call site) | same subset gap; confirms the overlay diverges from prod deliberately |
>   | 6 | prod **does** export `_mdx_set_max_loop` | **an earlier note here claimed it did not** ("Prod ships MDX ... but not mdx_set_max_loop"). That was wrong; corrected 2026-10-03. Our `mdx_set_max_loop(0)` lever is therefore usable on prod's tree too |
>
>   Net: **rows 1 and 2 mean master itself cannot be built against this repo's
>   vendored trees.** That is the strongest available proof that Matt builds
>   against newer forks than we vendor, and it is why "just build the feature
>   branch locally" is not a verification strategy — that build fails on
>   pre-existing master ground, for reasons unrelated to any change of ours.
>   Corollary for review: anything proved only against our trees (speed
>   behaviour, the MDX loop getters, the XMP band) carries tree risk, and rows
>   1-3 show that risk is real rather than theoretical.
>   Unverifiable from here: the actual commits. Nothing in the repo, the wasm
>   (exports are minified), or the JS glue names them.
>
> - **XMP band at load: tried libxmp's own per-order time table, it does NOT
>   work.** Attempted and reverted 2026-10-03. The idea was good — libxmp
>   precomputes `module_data.xxo_info[].time`, the start time of every order,
>   and uses that table itself when seeking (`control.c` walks it in
>   `xmp_seek_time`), so `xxo_info[mod->rst].time` should be the loop start with
>   no waiting and no pattern scanning. Added a `src/bindings/libxmp-wrapper.cpp`
>   reading `common.h` (`ctx->m.xxo_info[]`, `ctx->m.mod.rst`), three exports,
>   and a guarded JS resolution; relinked and measured. It fails on the catalog:
>   - **`rst` is 0 for all 9 mods** (TECHTRIS, 01-Title, Bgm01, THALAMUS, tim6,
>     unreal superhero, ZOOL-1_RAVE, zuma, Unreal Tournament Menu), so the header
>     carries no usable restart order.
>   - **The time table is non-monotonic for all 9**, with the shape
>     `0, 0, ~6, ~125, 64, <large>, 0, ~6` — order 6 reads 0 and order 7
>     mirrors order 2. Mechanism (`scan.c:196`): `xxo_info[].time` is assigned
>     only `if (info->time < 0)`, so it records **the time the scan walk first
>     reached that order**, and reuse collapses it — the init comment says so
>     outright ("prevent overwrite when a position is used multiple times at
>     different starting points, see janosik.xm"). With XM/IT sub-sequences,
>     pattern jumps and repeated patterns, that is a scan-walk artifact, not a
>     position in a linear playthrough, so the values cannot be read as order
>     start times. (An earlier note here blamed "per-sequence overwriting",
>     which is not the mechanism; corrected 2026-10-03.)
>   - **The header also disagrees with the engine.** `rst = 0` says "restart at
>     the beginning", but TECHTRIS actually jumps **11 -> 1** (the learned band
>     starts at order 1 = 3940 ms). `player.c:1397` falls back to
>     `seq_data[p->sequence].entry_point` whenever `rst` is not in the current
>     sequence, so the real restart order is not `mod->rst`.
>   So this is worse than a false-positive risk: it is systematically wrong for
>   exactly the files we care about. **Do not retry this without first checking
>   `rst` on real files**, and note that a correct-looking `rst` would still not
>   predict the jump target. Scanning the patterns in JS instead is not the
>   answer either — it means reimplementing libxmp's sequencer (Fxx tempo/speed,
>   F06 loops and breaks, F9x/FEx delays, multi-sequence entry points), where a
>   single missed effect yields a *wrong* band rather than none. The XMP band
>   stays learned from playback, and keeps its known cost: it appears only after
>   the engine's first backward order jump (see the `learnLoopFromOrder` rules).
>   Side finding worth keeping: libxmp 4.5 spells the context type
>   `xmp_context` (`typedef char *`), while 4.6+ uses `xmp_ctx` — another cheap
>   version marker alongside `xmp_seek_time_frame`.
>
> - **libvgm counts loops correctly — no patch is needed.** `VGMPlayer::Cmd_
>   EndOfData()` in `player/vgmplayer_cmdhandler.cpp:574` does `_curLoop ++` on
>   every loop (and fires `PLREVT_LOOP` with it), reset only in
>   `vgmplayer.cpp:938` (init `:148`). This is identical in the vendored
>   `91b6542` and in upstream HEAD `c8b998b`, which is why the frozen artifact
>   reports `curLoop` 0/1/1/2 at seeks 1k/31k/45k/60k. **Our vendored
>   `libvgm/player/vgmplayer.cpp` is byte-identical to upstream `91b6542`
>   (2023-12-20)** (blob `591511bf`), and `libvgm/` was untouched 2024-06-20 →
>   2026-04-03, so prod and the frozen artifact agree. **Do not go looking for a
>   missing loop counter in libvgm — there isn't one.** (A 2026-10-02 detour
>   concluded otherwise by grepping only `vgmplayer.cpp` and missing the
>   increment in `vgmplayer_cmdhandler.cpp`; that also invalidated a 48-fork
>   scan. When auditing loop state, grep the *whole* player dir, not one file.)
> - **The Repeat One matrix numbers are stale.** The frozen core reports
>   `intro_length=76, loop_length=29867` (band [29943, 59810]) for
>   `16 Hurry Up!.vgz`; AGENTS.md's matrix records A=342/B=800. Re-measure before
>   trusting the matrix.
>
> - **Playback speed desyncs from the transport clock in OUR build only — prod
>   is correct.** Re-measured 2026-10-08 on `Sonic the Hedgehog - Green Hill
>   Zone`, the one file measured on *both* builds, read DOM-only from the footer
>   so neither build is privileged by how it was sampled:
>
>   | build | 1x | 2x | duration @1x | duration @2x |
>   | --- | --- | --- | --- | --- |
>   | prod (chiptune.app) | 0.995 | **1.994** | 1:36.0 | 1:36.0 |
>   | our dev core | 1.001 | **1.003** | 1:40.5 | 1:40.5 |
>
>   So prod's position scales with speed and its duration is speed-invariant,
>   i.e. prod already behaves the way the UI is designed to behave ("absolute
>   1x time, so the bar runs 2x as fast at 2x"). Our build reports position in
>   wall-clock regardless of speed. Confirmed engine-side on ours:
>   `getPositionMs()` slopes 1.005 / 0.998 / 0.998 at 0.5x / 1x / 2x, and
>   `getLoopBandMs()` returns `[53199, 91599]` at all three — so the band claim
>   above re-verifies, on the engine rather than the label.
>
>   **Do NOT repeat the old "+70% duration at 2x" figure — it does not
>   reproduce, and it was a measurement artifact.** `getDurationMs()` is
>   *transient* on our build: it reads short until the engine has resolved the
>   loop and fade end, then settles. Read in sequence on that track it gave
>   93849 (0.5x) -> 96099 (1x) -> 100599 (2x), and 100599 is where it stays —
>   so the value tracked elapsed song time, not tempo. Both builds are in fact
>   speed-invariant here; the real build difference is a constant ~4.6 s
>   (prod 1:36.0, ours 1:40.5) in how each libvgm closes out the fade.
>   **Practical rule: never sample duration before the engine has played past
>   the first loop boundary, and never compare durations taken at different
>   points in a song.** `16 Hurry Up!.vgz` is a bad fixture for any of this:
>   its band folds the *displayed* position every ~1.1 s, which invalidates an
>   end-to-end slope (measured: 2 drops, negative slope) even though the
>   duration readout itself is unaffected.
>
>   The position difference is in the tree, not the wrapper: `PlayerA::GetCurTime`
>   uses `Sample2Second` (wall-clock), and libvgm rescales the sample counter on a
>   speed change. The 2026-10-08 sibling build (`c8b998b`) still reads wall-clock
>   (1.00x at 2x), so refreshing the tree did **not** fix it. **Do not "fix" it by
>   multiplying position by speed in the wrapper** — prod is correct with the
>   byte-identical wrapper, so that would double-count against a newer libvgm; the
>   fix is tree-side (scale by `GetPlaybackSpeed()`). See the open hand-off note at
>   the top of "Session hand-off notes".
>   **Open risk for the PR:** our loop getters multiply `Tick2Second` by
>   `GetPlaybackSpeed()`, which is only correct if `Tick2Second` divides by
>   speed in whatever tree the reader builds. That holds for our stale vendored
>   tree (`_tsDiv *= genOpts.pbSpeed` in `RefreshTSRates`) and is unverified
>   against the newer libvgm prod is built from. If Matt's tree does not
>   divide there, the band and the folded head will be off by the speed factor
>   at non-1x. Cheap to confirm once a newer tree is built.

Real audio works locally. `./scripts/build-subprojects.sh` (the sibling clones +
the vendored `libADLMIDI`/`psflib`/`lazyusf2`) and `node scripts/build-chip-core.js`
produce `src/chip-core.{js,wasm}`. This work lives on `dev/overlay`, **not** the
feature branch. See "Audio engine roadmap" for what remains.

Prereqs (Arch): `sudo pacman -S cmake emscripten xa` (emcc lands in
`/usr/lib/emscripten`, added by `/etc/profile.d/emscripten.sh`; the script adds
it to PATH; `xa` is the 6502 assembler libsidplayfp needs). Then:

```sh
./scripts/build-subprojects.sh          # sibling clones + in-repo engines
./scripts/build-libsidplayfp.sh         # SID core (mmontag fork, needs xa65)
node scripts/build-chip-core.js
```

Build env vars (all optional):
- `CHIP_NO_SID=1` — skip libsidplayfp. Default already skips when the lib is
  absent.
- `CHIP_ASSERTIONS=2` — assertions + readable aborts (diagnostics).
- `CHIP_DEBUG_NAMES=1` — keep wasm function names for stack traces.
- `CHIP_MALLOC=dlmalloc|emmalloc` — allocator (default `dlmalloc`).
- `CHIP_INITIAL_MEMORY`, `CHIP_STACK_SIZE` — heap/stack sizing.

Status: **GME, libvgm, libxmp, N64 (lazyusf2), V2M, MDX, fluidlite MIDI, SID,
libADLMIDI (OPL3 MIDI)** build and run.

Provenance: the built `src/chip-core.wasm` links the sibling clones on this box
plus the in-repo `libADLMIDI`/`psflib`/`lazyusf2`; the four siblings' revisions are
recorded in `src/chip-core.wasm.buildinfo.json` (see the notes above). The
2026-10-02 claim that the shipped artifact rebuilt byte-for-byte from the in-repo
trees is historical — those trees are gone. Behavior deltas vs the *old* in-repo
builds: libxmp is 4.7.x (not 4.5.0), libvgm is the `c8b998b` sibling (not the
2023 vendored tree), GME is mmontag's fork (not the 2018 tree).

Build notes:
- `scripts/build-chip-core.js`: the duplicate-symbol tripwire over the linked
  archives still fails the build on a strong-symbol clash
  (`--allow-multiple-definition` is only belt-and-braces). The in-repo `../`→local
  path fallback never fires now that the engines are siblings and could be removed.
- libvgm charset: the configure passes `-DIconv_LIBRARY=c` because CMake's
  `FindIconv` detects iconv built into libc but then fails its `find_library(c)`
  check; Emscripten's musl iconv supports the tags libvgm needs
  (UTF-16LE/CP1252/CP932).
- `src/players/{GME,XMP,MIDI}Player.js`: feature-detect newer APIs
  (`gme_disable_echo`, `xmp_seek_time_frame`) and ADLMIDI bank options, so the app
  works against either vintage of those engines.
- **Moot since 2026-10-08** (the vendored trees are gone and the siblings build
  clean): the old `game-music-emu/gme/CMakeLists.txt` and `blargg_source.h` fixes,
  the `libvgm/player/CMakeLists.txt` `player_wrapper.cpp` drop, the hand-built
  `libxmp-lite`, and the `libvgm-wrapper.cpp` compat defines.

**libADLMIDI (OPL3 MIDI)** is built with the **Nuked** OPL3 core, not DOSBox.
The DOSBox core aborts in `~DosBoxOPL3` (`emscripten_builtin_free`) under this
Emscripten build, so `build-subprojects.sh` compiles ADLMIDI with
`ADLMIDI_DISABLE_DOSBOX_EMULATOR` and without `ADLMIDI_DISABLE_NUKED_EMULATOR`,
and `build-chip-core.js` enables the module and passes `-DTP_ENABLE_ADLMIDI` to
`tinyplayer.c`. The archive is built without `-flto` (global LTO corrupts its
C++ object model). Bank selection and OPL3 playback work; `tinyplayer.c` keeps
`adl_setNumChips` at the default 1 chip.

**libvgm YM2612 core:** all three cores (MAME/GPGX, Gens, Nuked) must be
compiled. That is a **link** requirement, not a ranking — `2612intf.h` enables
`EC_YM2612_{GPGX,GENS,NUKED}` itself, so `devDefList_YM2612` always names all
three, while the `SNDEMU_YM2612_*` CMake flags decide only which source files
are compiled. Disable one and its `devDef` still references symbols with no
object behind it, so the link fails. `devDefList_YM2612` lists **MAME/GPGX
first** (`2612intf.c:109`), so GPGX is the core that actually runs.

Root-caused 2026-10 (was misdiagnosed as a broken GPGX core): GME and libvgm
both export the MAME OPN C globals (`ym2612_write`, `ym2203_write`, …) and our
link order put `libgme.a` first, so `--allow-multiple-definition` silently
kept **GME's** MAME `ym2612_write` — which libvgm's YM2612 interface then
called on a libvgm `FM_OPN` struct. Position stuck at 0, zero buffers, and a
direct `_lvgm_render` kills the tab (the wasm-ld `function signature
mismatch: ym2612_write` warning said it all along). It reproduced natively
nowhere because native links never combined the two archives. Fix, matching
the roadmap's prune-GME direction: our GME build compiles no VGM/GYM/HES/KSS
(the app routes those to libvgm; `USE_GME_*=OFF` in `build-subprojects.sh`
plus `ym2413.c`/`Sms_Apu`/`Z80` kept unconditional for NSF/SGC), so the
duplicates are gone by construction — verified zero `ym*write` collisions
between the archives. The Gens force this replaced is deleted (GPGX was never
broken); YM2612 loop verification through any core is valid anyway, since all
loop state is `PlayerA`-level and core-independent.

**Known issue — N64 seek freeze (pre-existing, not our feature):**
`N64Player.seekMs` → `_n64_seek_ms` → `decode_seek`
(`src/bindings/lazyusf2-wrapper.cpp:368`) synchronously renders every sample to
the target on the main thread, freezing the UI (felt as ~5s). GME avoids this
with a timesliced seek (`GMEPlayer.doIncrementalSeek`, `requestIdleCallback`).
N64 would need the same treatment.

**SID:** built by `scripts/build-libsidplayfp.sh` from **mmontag/libsidplayfp**
(branch `montag-dev-2.14`) (not vendored; clones to `../libsidplayfp`). It is
based on the last release with the classic `ReSIDBuilder` the wrapper uses (3.x
dropped it for residfp) and adds the fast `seek()`/`setTempo()` the wrapper
calls; its reSID changes live in a submodule (`mmontag/resid`), so the clone is
`--recursive` (Matt pushed `mmontag/resid` so this clones reproducibly now —
previously the pinned commits were missing and the fork was unusable). Building
from git assembles the 6502 driver `.bin` files from source, so **`xa65` is
required** (Arch: `pacman -S xa`); the script skips the check when the `.bin`
files already exist (the old v2.9.0 tarball shipped them prebuilt). A
`multilib`/XTREE clone needs `autoreconf -i`, which the script runs.
`sid_set_position_ms` / `sid_set_speed` call the fork APIs unconditionally now
that the guards are gone. `setTempo` is verified working and
pitch-invariant. **But `seek()` is WIP in the fork and tune-dependent.** Measured
on the catalog set (seek to 20s mid-playback, then 1s energy per second):

- `Cybernoid_II`: resumes after a ~3s quiet dip, then normal.
- `Monty_on_the_Run`: resumes immediately with a lower first second.
- `Cybernoid`, `Bionic_Commando`: stays silent (all-zero) indefinitely.
- Seek-to-0 (the repeat-one path) is reliable.

Seeking before the first render **hangs** for every tune tested
(`Player::seek`'s `while (timeMs() < ms)` never advances when the event queue is
empty); the app's `?t=` path seeks 100ms after playback starts, so it usually
misses this, but it is reachable. The call is also synchronous: ~10 ms of wall
time per second of target (a 120s seek ≈ 1.3s main-thread block). Until the
fork's seek is finished, expect the slider / `?t=` link to be silent on some
SIDs and to briefly pause on others. This matches prod (its shipped core is
built from the same fork and shows the same Bionic Commando silence), so it is
not a regression from our integration — we deliberately keep the wrapper and app
faithful, with no seek guard or compile-time gate. Plain playback, sub-tune
switching, voice mask, and tempo are unaffected. The old silent-SID dev hack
(`dev/patch-sid-stub.js`) was removed: the real SID core now exports `_sid_*`.

`sid_set_subtune` must call `engine->load(currentTune)` after `selectSong()`:
selectSong only marks the `SidTune`'s current song, so without the reload the
engine keeps playing song 0 while `sid_get_subtune()` reports the requested
index (every sub-tune sounds identical).

### libvgm version — the 2026-09 pin attempt, resolved by the 2026-10-08 build

We build the sibling `../libvgm` (ValleyBell). The wrapper carries no
libvgm-version compat of its own any more — the `DEVID_OKIM*`/`PLAYTIME_*`
defines were removed on 2026-10-08, and the wrapper is now `master` plus the loop
functions.

History worth keeping: in 2026-09 we tried moving from the then-vendored stale
tree (`91b6542`) to upstream HEAD (`c8b998b`) and **reverted** — it compiled, but
`PlayerA::LoadFile` left `GetPlayer()` null so VGM rendered silence, and the
post-link `wasm-opt` step failed a binaryen validation (Arch's `emscripten` ships
its own `wasm-opt`, `extra/binaryen` is older, and the un-optimized wasm is valid
and only ~600 KB larger, so no package fixes it).

That same commit builds and **renders VGM** on 2026-10-08, so the `GetPlayer()`
null drift did not reproduce; treat the old "HEAD is broken" note as unverified.
(`parentIdx` was added upstream at 2026-01-21, `57585ea`, if a different pin is
ever needed.) See `dev/UPSTREAMING_PLAN.md`.

### Dev environment gotcha

**Move the session before you delete its working directory (2026-10-08).** A T3
Code thread is bound to a workspace directory. Deleting that directory out from
under a live session — the obvious `git worktree remove` on the worktree the
session is running in — breaks the thread: the next run dies with *"This
thread's workspace folder no longer exists or is not a directory"* before the
agent can act. The order is: `session_move` to the main checkout, **then** remove
the worktree and its branch, **then** clean up the now-empty parent. Recovery is
just `session_move` back to a directory that exists; the git objects are shared,
so nothing is lost.

The T3 Code browser-preview tab logs an Electron sandbox error
(`Electron sandboxed_renderer.bundle.js script failed to run` /
`Cannot destructure property 'preloadScripts' of 'binding.startupData'`) and a
blank tab shows `chrome-error://chromewebdata/`.

**Drive the preview at `http://mms-1:8080`, not `localhost:8080` (2026-10-02).**
`mms-1` is this box's Tailscale name (`mms-1.dala-gentoo.ts.net` → 100.66.142.9);
the preview's browser cannot reach the dev server on the loopback name — every
`localhost:8080` navigation lands on `chrome-error://chromewebdata/` with an empty
document, while the same page on `mms-1:8080` loads normally. Shell `curl` is
fine on either name; this is only about the preview tab.

**Prefer the t3 preview over curl** whenever the question is "does it work in a
browser" — it is the only check that catches things the served bundle cannot:
runtime globals, console errors, a booting React tree, engine state after a
click. `curl` is for cheap liveness and content greps
(`curl http://mms-1:8080/api/browse`, `curl .../static/js/bundle.js | grep -c
<newSymbol>`) while iterating on a build. When the preview does fail, the usual
triage is `preview_navigate` (re-navigate, append `?r=N` to defeat the bundle
cache) before concluding anything is broken: `evaluate` fails on its own fairly
often on a page that is otherwise healthy, and `snapshot` still works.

**Keep tool requests small — treat this as a hard rule.** The frequent failure
is the LLM provider rejecting an entire turn once the session context grows
large, not the tool transport itself. Measured from `~/.local/share/opencode`
(`opencode.log` + `opencode.db`): with `deepseek-v4.1-flash`, sessions up to
~1.8 MB of accumulated message parts completed, while sessions past ~3 MB
returned HTTP 400 (`AI_APICallError: Bad Request`, mid-stream) on every retry.
Context is cumulative, so a few large tool results early poison the rest of the
session — retrying in the same session does not recover, so start a new session
per task. Rules:
- `evaluate`: one step per call. No long inline scripts, big loops, or
  returning arrays/objects of rows. Stash state on `window`/`localStorage` and
  reuse it; return only the few scalar fields you need. If it's more than ~2-3
  lines, split it into separate calls.
- `snapshot`: pass `includeImage:false`; never dump the accessibility tree,
  console, and network at once; prefer a targeted `evaluate`.
- `read`: read a small range (`offset`/`limit`, ~40 lines) around the target;
  `grep` for the line first. Don't re-read whole large files.
- `bash`: redirect noisy output to a log under `/tmp/opencode` and print only a
  few lines (`tail -5`, `grep -c`). Never `find /` or dump full build logs.
- Session hygiene: outputs are cumulative and cannot be removed from context.
  Never paste whole files, whole logs, large JSON, or screenshots into context;
  prefer counts, short tails, scoped ranges, and summaries. If a turn starts
  returning provider 400s, start a fresh session rather than retrying.

Separate, rarer tool-layer flakes exist and are not this issue: the preview
automation can drop a tab (`No active preview tab` / `evaluate failed`), and
`pkill -f <pattern>` can match the shell running it. Re-open/re-navigate the
preview or rerun the command when that happens.

**Verifying playback from the preview.** The app exposes itself as
`window.ChipPlayer` and the live wasm core as `window.ChipPlayer.chipCore`, so
you can drive the exported `_*` functions directly from `evaluate` and measure
the rendered audio instead of listening. E.g. `_sid_init(48000)`,
`_sid_load_data`, then sum `HEAPF32` over a `_malloc`'d buffer filled by
`_sid_render`: files/sub-tunes that are actually different give clearly
different totals (all-equal energies usually mean selection isn't switching —
that's how the `sid_set_subtune` bug was caught). Two preview gotchas:
`preview_navigate` to the *same* URL may not re-instantiate the wasm, so append
a cache-buster (`?r=2`) to force a real reload; and `Player.copyToHeap` does
`HEAPU8.set(data, ptr)`, which silently copies nothing when `data` is an
`ArrayBuffer` — pass a `Uint8Array` (as `Sequencer.playSongBuffer` does). Start
direct probe sessions on a fresh page so they don't collide with the player's
own core state.

### Dev catalog fixtures

`catalog/` is gitignored and user-supplied. As of this branch it holds a
mixed-format set useful for manual testing: the Famicompo NSFE tree (many
multi-song files), a `sid/` set (including two RSID fixtures with 20 and 3
songs, extracted from the `HVSC_85-all-of-them.7z` also kept there), `nes-audio-tests/`
(28 single-song NSF hardware/expansion-chip tests, copied from the
`dev/nes-audio-tests` clone of `bbbradsmith/nes-audio-tests`), `n64/Blast Corps/` (65 `.miniusf` + one
shared `.usflib`), `mods/` (`.S3M`), `midi/`, and a `.vgz`. Rebuild with
`node scripts/build-music.js -n` after changing it. Note `.usflib` companions
are intentionally not indexed but must stay next to their `.miniusf`; a
gzipped VGM must use the `.vgz` extension (`.gz` is not recognized).

## Catalog / server data model

### Parsers (`scripts/metadata-parsers.js`)

**Upstream split this file on 2026-09-26** (commit `94dcb360b`). The sub-tune
parsers below still live here; the shared helpers and all MIDI parsing moved out:

- `scripts/metadata-utils.js` — `cleanString`, `decodeBuffer`, `isShiftJIS`,
  `readStr`. Imported at the top of `metadata-parsers.js` and re-exported from
  it, so older importers keep working. `cleanString` also maps a field that is
  *only* placeholder punctuation (`?`, `<?>`, `???` — the rippers' "unknown") to
  empty, so the catalog binds NULL rather than the marker; a title that merely
  contains a question mark (`Continue?`) is untouched. Sub-tune labels run
  through it too (in `describeSubtunes`).
- `scripts/metadata-midi.js` — every MIDI heuristic plus strategy routing.
  `parseMetadata(buffer, ext, relPath = null, strategy = null)` sends
  `mid`/`midi` to `parseMidiWithStrategy` and everything else through `PARSERS`.
  **Only `build-music.js` passes `relPath`**; a caller that omits it still gets
  correct metadata, just without MIDI strategy routing.
- `scripts/metadata-vgmusic.js`, `scripts/build-vgmusic.js`,
  `scripts/spot-check-midi.js` — VGMusic/rolandSmf sidecars, no sub-tune role.

Two of our hunks deliberately survive the merge rather than taking upstream's:

- **`parseNSFe` walks with `cursor`, not `offset`.** Upstream's version declares
  `let offset = 4` and then walks `offset`; ours renamed it `cursor` when it grew
  the `plst`/`INFO` handling. Taking upstream's declaration with our loop is a
  `ReferenceError`, which is why the merge resolved this hunk to ours.
- **`parseSPC` warns on a bad magic** instead of returning `{}` silently. Upstream's
  length+magic guard is strictly stronger and was kept; only the `console.warn`
  is ours.

Note that upstream also corrected `parseGBS`'s `system` string from `'Gameboy'`
to `'Game Boy'`. A catalog built before that correction keeps the old spelling
until you re-run with `-n`; the label is stored per row, not derived.

- `parseNSF`: songs at header `0x06` (count), `0x07` (1-based start). The guard
  requires the real `NESM\x1A` magic — upstream tightened it, and `dev/fixtures.js`
  was updated to write it.
- `parseNSFe`: chunked format, tags are **forward ASCII** (`INFO`, `auth`,
  `tlbl`, `plst`, `time`, `fade`, `NEND`), stream starts at offset 4 (no
  embedded NSF header). `INFO.track_count` (data offset +8) is the number of
  *physical* tracks; `plst` (byte array of physical indices) is the
  authoritative sub-song list AND order. **This mirrors game-music-emu**
  (`game-music-emu/gme/Nsfe_Emu.cpp:34-46,199-202`): with a non-empty playlist
  `track_count = playlist.size()` and track N remaps to `playlist[N]`;
  otherwise all physical tracks are used 1:1. `tlbl` gives per-track labels.
  NSFE `first_track` is **0-based** (store as `startingSong = first + 1`).
- `parseSID`: PSID/RSID. Strings at fixed offsets `0x16/0x36/0x56` (32 bytes
  each). Song count word at `0x0E`, start song at `0x10`. v2+ packed
  PAL/NTSC speed bits at `0x18`, bit i => PAL. **Do not** read strings from the
  header offset field at `0x06` (that is the *data* offset).
- `parseGBS`: `track_count` at `0x04`, 1-based `first_track` at `0x05` (mirrors
  `game-music-emu/gme/Gbs_Core.h`); title/artist/copyright are 32-byte fields
  at `0x10/0x30/0x50`. No per-track labels in-format (sub-tunes fall back to
  `Tune N`).
- `parseAY`: mirrors `game-music-emu/gme/Ay_Emu.h:header_t`. `numSongs =
  max_track + 1` (`0x10`), 0-based `first_track` (`0x11`); author/comment and
  the per-track names are **signed** big-endian offsets relative to their own
  field position (see `Ay_Emu.cpp:get_data`) — backward offsets are legal.
- Release dates: the formats don't have a dedicated date field, so `extractDate`
  scrapes a year (or full date) out of free-form strings — NSF/NSFE/SID
  `copyright` / `released` (e.g. `"1988 Konami"`, `"(C)1984 CAPCOM"`,
  `"2008-2009"`), and VGM GD3's explicit release date. Missing parts default to
  Jan 1 (`"2003"` -> `"2003-01-01"`). `meta.date` is stored on `music` as
  `release_date`; `describeSubtunes` also honors a per-track `meta.trackDates`
  (no parser emits one yet, but the resolution chain supports it).
- Real-file counts were validated against GME semantics (e.g. Castlevania III
  = 36 not 242; Gimmick! = 73 not 106; Gradius II plain NSF = 65 but
  Gradius II NSFE = 16, because only NSFE has `plst`).

### Schema (`scripts/build-music.js`)

`music` = one row **per file** (the downloadable unit). `subtune_count`
(denormalized) is the number of playable sub-songs (1 = single song).
`music.release_date` is the metadata date (ISO), and `subtune.date` a
per-sub-tune date (currently always NULL).

```sql
CREATE TABLE subtune (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  music_id INTEGER NOT NULL,
  subtune INTEGER NOT NULL,   -- 0-based, matches player subtune index
  title TEXT,
  length_ms INTEGER,
  date TEXT,                  -- per-sub-tune date, when a format provides one
  sort_order INTEGER DEFAULT 0,
  UNIQUE(music_id, subtune),
  FOREIGN KEY(music_id) REFERENCES music(id)
);
CREATE INDEX idx_subtune_music ON subtune(music_id);
```

- Only multi-song files get `subtune` rows. A single-song file has none, so a
  sub-song and a plain song are the same kind of thing to the client.
- `subtune.title` is set only when the format provides a label; otherwise it is
  `NULL` and clients fall back to `Tune N`. (`describeSubtunes` no longer invents
  a `Song N` placeholder — that was inconsistent with the fallback.)
- `subtune_fts` (fts5, `content='subtune'`) + `ai/ad/au` triggers mirror
  `music_fts`, making sub-song titles searchable.
- `processFile` clears a file's old sub-tune rows **before** the
  `INSERT OR REPLACE` on `music` (foreign keys are enforced, so the replace
  would otherwise fail). A `ensureColumn` shim adds `release_date`/`date` to
  DBs created before those columns existed.
- `--reset-db` drops child tables **before** `music` (FK order).
- Incremental runs are idempotent (verified, including reprocessed multi-song
  files). A `subtunes` JSON column was tried and **removed** in favor of the
  normalized table.

Verified on the real catalog: 6758 files, 1140 subtune rows, 87 multi-song files,
3806 files with a parsed `release_date`.

### Server API (`server/database.js`, `server/index.js`)

- `getDirChildrenStmt` now returns `subtune_count`.
- New: `searchSubtuneStmt`, `getSubtunesStmt`, `getSubtuneMetadataStmt`.
- `/browse`:
  - In a directory, a file with `subtune_count > 1` is `type: 'songfolder'`
    with `count = subtune_count`, `url: null`. Client navigates to
    `/browse/<path>` like a directory. A file/folder row's `mtime` prefers the
    parsed `release_date` over the file system mtime.
  - When `path` names a multi-song file, returns its sub-tunes as
    `type: 'file'` rows with `name` (label, or `Tune N` when unlabeled),
    `subtune`, `song_id`,
    `durationMs`, `url = /?play=<songId>&subtune=N`. Each row reuses the parent
    file's `size`, and `mtime` resolves **subtune date -> file `release_date` ->
    file system mtime** (as Unix seconds).
- `/search` unions `searchStmt` (file titles) and `searchSubtuneStmt`
  (sub-song titles); sub-song hits carry `subtune` + `title`, and files already
  matched at file level are de-duplicated.
- `/metadata?path=...&subtune=N` returns `subtuneTitle`.
- `/shuffle` and `/random` return `{path, subtune}`, **one item per playable
  song**: a multi-song file is expanded into *all* of its sub-tunes (a
  `LEFT JOIN` on `subtune`), so a sub-tune shuffles exactly like a single-song
  file. `?path=` may name a directory — prefix-matched recursively, with the
  prefix `LIKE`-escaped so a folder named `Famicompo_mini_vol1` cannot pull in a
  sibling — or a file, which shuffles as itself.
- `/playback` accepts `subtune`; `playbacks` gains a `subtune` column
  (idempotent `ALTER TABLE` in `server/database.js`, also in the dev seed).
  `/top` (global, user, and metric=favorites) groups by `(song_id, subtune)`
  and returns `subtune`, `subtuneCount`, and `subtune_title`.

### "Is this file a song folder?" — one field, one predicate

The only thing to know about a file's sub-tunes is *how many songs it holds*.
Every endpoint that reports a song reports it as **`subtuneCount`**, always
present and never null: `/metadata`, `/top` rows, each favorite (a
`COALESCE(…, 1)` in the SQL), and the `__chipConfig` a `?play=` share link
carries. Nothing reads meaning into an absent field any more.

The client asks it in exactly one place, `isSongFolder(song)` in `src/util.js`
(next to the `SongRef` model), with `isSongFolderListing(listing)` for the same
question asked of a Browse listing (whose rows *are* the songs when they carry
a `subtune`). Callers: `App` (share-link landing, footer link), `Favorites`,
`TopCharts`, `Browse`. `AppFooter` takes the answer as a prop, so the rule never
reaches a component that only renders.

Two deliberate exceptions: a `/browse` row answers from the server's own
`type: 'songfolder'` (the server decides a row's shape, the client does not
re-derive it), and `isSongFolder` falls back to a sub-tune *title* for
responses cached before `subtuneCount` existed — `/metadata` is cached for an
hour, so that hedge belongs to the hour, not to every call site.

Consequence for hand-carrying: the two halves of the share-link change are
independently compatible — the old client reads an absent `subtuneCount` as
"not a song folder", and the new client falls back to the title — so the client
half can arrive by promote while `server/index.js` is carried by hand.

## Client identity model: `SongRef`

A playable thing is `{ path: string, subtune: number }` (subtune 0 for
single-song files). Helpers in `src/util.js`:

- `songRef(pathOrRef, subtune = 0)` — normalize string/object/item to SongRef.
- `songRefKey(pathOrRef, subtune = 0)` — stable identity string (NUL separator),
  for `===`-style comparisons and React keys.
- `songRefsEqual(a, b)`.

`src/Sequencer.js` (updated):
- `context` is an array of SongRefs; `playContext` normalizes via `songRef`.
- `playContext(context, index = 0, subtune = null)` — `subtune` is now an
  **optional override** for the first song (used by `?play=...&subtune=N`);
  normally the sub-tune lives in the SongRef.
- `playCurrentSong()` / `currContextRef()` derive the ref (shuffle-aware).
- `playSong(songRefOrPath)` accepts a ref or bare string; sets
  `currSongRef` (and `currSongPath` for the player/UI/metadata).
- Emits `songRef` in `sequencerStateUpdate`.
- `getCurrSongRef()` added.
- **Sub-tune navigation is the sequencer's job, not the player's.** A player
  plays exactly one song and stops (`Player.handleSongEnd` no longer chains
  `playSubtune(next)`), so `nextSong()` advances one context entry. Every
  sub-tune is its own SongRef/context entry, which makes a directory of MIDI
  files, a song folder, and a mixed search/favorites context behave the same.
  The old footer `Tune N of M` + back/forward UI is gone; `currentSongSubtune`
  / `currentSongNumSubtunes` state, `Sequencer.prevSubtune` / `nextSubtune` /
  `getSubtune` / `playSubtune`, and `App`'s sub-tune props were removed. The
  only place a sub-tune index lives is the SongRef.

`src/util.js`: `getMetadataUrlForFilepath(filepath, subtune = null)` appends
`&subtune=`. `songRefListsEqual` compares two ordered SongRef lists (needed
because `Sequencer` copies its context).

## Favorites / migration notes

- Favorites are stored per user as JSON `{songId, mtime, href|path, subtune}` in
  `user_db.playlists` (type `favorites`). `songId` is the **file** hash, so the
  sub-tune is what distinguishes entries.
- **Old favorites keep working:** a missing `subtune` means sub-tune 0 / the
  parent file. Add optional `subtune`; do not rewrite old rows. For a multi-song
  file this resolves to the song-folder entry.
- Share links are canonical as `/?play=<songId>&subtune=N`
  (`App.getCurrentSongLink`, `App.js` startup parse). No link migration.
  A link into a multi-song file lands inside the virtual song folder with the
  sub-song selected: the server injects `subtuneCount` into `__chipConfig`
  (omitted for single-song files), so the client branches without probing.
  The footer copy button uses one `songLink` for href and clipboard, and
  `handleCopyLink` falls back to `execCommand` where `navigator.clipboard`
  is unavailable (plain-http remote hosts).
- `getFavoritesStmt` decorates each item with `href`, `path`, `size`,
  `subtuneCount`, and `subtuneTitle` (looked up by `(music_id, subtune)`). The
  Favorites list shows the label, or `Tune N` when unlabeled; toggling
  re-fetches so optimistic entries get the same decoration.
- **Testing favorites in the dev app:** the server auth bypass makes the API
  usable, but the client's own `user` state (Firebase) stays null. The dev
  webpack config sets `REACT_APP_DEV_USER`, which `UserProvider`'s single
  `DEV_USER` gate turns into a fake `user` with `getIdToken()` (uid `dev-user`,
  token `dev-token`), so the heart button and favorites API work in the browser.
  No tracked file is patched; see "Dev overlay & promotion".

## Current state

**Done and verified:**
1. Parsers (NSF/NSFE/SID/GBS/AY) with sub-tune counts/labels — tested.
2. Normalized schema (`subtune` table, `subtune_count`, `subtune_fts`) —
   rebuilt and verified against the real catalog.
3. Server API: `/browse` songfolder + sub-tune listing, `/search` union,
   `/metadata` subtune title — verified via curl.
4. `SongRef` helpers in `util.js`; `Sequencer` migrated to SongRef contexts.
   Sub-tune navigation is sequencer-owned: the player plays one song and stops,
   and every sub-tune is its own context entry (see `src/Sequencer.js` notes).
5. Client migrated to SongRefs: `App.js` (`directoryListingToContext`,
   `fetchDirectory`, `getCurrentSongLink` from `currSongRef.subtune`,
   `songTitleKey`/`subtuneTitle` metadata), `VirtualizedList` (`songRefKey`
   highlight, `songfolder` navigates), `Browse` (`<SONGS>` rows),
   `Favorites`/`FavoriteButton`/`UserProvider` (keyed by `(path, subtune)`,
   grouped under directory/song-folder headings), `Search` (sub-tune hits),
   `AppFooter` (favorite + share link carry subtune), `LocalFiles`/`TopCharts`
   (SongRef contexts). The footer's sub-tune-specific nav/label is gone.
6. Server `/shuffle` and `/random` return `{path, subtune}`, one item per
   playable song: a multi-song file is expanded into every one of its sub-tunes
   rather than one random sub-song, so a directory shuffle is a random walk over
   every song beneath it. (`/random` had a latent leading-slash bug; fixed.)
7. Favorites server: `FavoriteSchema.subtune`, add/remove statements keyed by
   `(path, subtune)` — verified via curl (add two sub-tunes + a plain file,
   then remove one sub-tune and confirm the others remain). `getFavoritesStmt`
   also decorates items with `size` and `subtuneTitle`, so the Favorites list
   shows the catalog title and falls back to `Tune N`. UI-verified in the dev
   app, including legacy favorites without `subtune` and per-sub-tune isolation.
8. Dates and sizes: parsers scrape a release date from free-form metadata
   (`extractDate`), stored as `music.release_date` / `subtune.date`; `/browse`
   sub-tune rows resolve date as subtune -> file metadata -> file mtime, and
   reuse the parent file's `size`. File/songfolder rows also prefer
   `release_date` over mtime. `processFile` clears sub-tune rows before the
   `music` REPLACE (FK ordering fix for incremental reprocessing).
9. `AppFooter` shows the full song-folder path (and links into it) for
   multi-song files; the answer comes from `isSongFolder()` in `src/util.js`,
   fed by `/metadata`'s `subtuneCount` (see "one field, one predicate"). A
   sub-tune the format gives **no label** for is identified by index alone —
   `(Tune 8)` after the title, dimmed — because the fallback was the file title,
   so a shuffle over a folder of unlabeled sub-tunes (gbs, sid) showed the same
   title for every tune. `util.subtuneLabel(subtune, title)` owns the wording
   (label if there is one, else `Tune N`), shared with Browse/Favorites/Top
   Charts, and `App` decides while `AppFooter` only renders. Scoped so it is
   invisible elsewhere: a single-song file's count never exceeds 1, and a
   labeled sub-tune is already named by its own title. Local files still get
   no marker (no `/metadata`, so no count).
10. `playbacks.subtune` + sub-tune-aware Top Charts: `/playback` carries the
    sub-tune, and the global/user/favorites top queries group by
    `(song_id, subtune)`, returning `subtune`/`subtuneCount`/`subtune_title`
    so `TopCharts.js` labels and plays the exact sub-song.
11. Downloads: `getUrlFromFilepath` encodes per path segment, so browsers name
    downloads correctly instead of using the whole path.
12. Real audio locally: a chip-core wasm build works (GME/libvgm/libxmp/N64/
    V2M/MDX/fluidlite MIDI). Gitignored and not committed; the current engine
    sourcing/build is documented under "Building the real chip-core".
13. Repeat One for VGM (libvgm) — the looping baseline. Native loop count plus a
    band-relative "playlist position" so the head repeats the highlighted loop
    region, and switching repeat off plays past into the fade with no head jump.
    The full toggle matrix is green (see "Repeat One test matrix"), including
    the fixes this surfaced: the base end detector respects
    `isPlayingIndefinitely()` (indefinite playback no longer dies at durationMs
    when Skip Silence is on), the head no longer folds into the band with
    repeat off / mid-fade enable, the loop count is only re-derived when
    actually leaving a looping state, and leaving a deep repeat plays the full
    fade (`durationExtended`) instead of ending instantly. On `dev/overlay`.
14. MDX Repeat One: native engine loop (`mdx_set_max_loop(0)`) plus an exact
    loop band from new `mdxmini` loop-point getters; two engine fixes (fade-end
    latch, microsecond-accurate position) came out of it, plus the fade-tail
    capture ported from VGM so enabling Repeat One mid-fade keeps the head on
    the tail. See "MDX (mdxmini)". On `dev/overlay`.

**Caveat:** `Sequencer.playContext` copies its context, so array-identity
checks no longer work. Compare a live context to a stored one with
`songRefListsEqual` (used by the local-files checks in `App` and the
`LocalFiles` highlight); compare rows with `songRefKey`.

## Session hand-off notes (read me first)

- **OPEN — VGM position/jumping-head investigation (2026-10-08). Do not trust the
  earlier entries in this file that describe this; two of them were wrong.**
  Symptom: at 2x speed the footer time and slider head report **half** the true song
  position, and **dragging the Speed slider makes the head jump backwards**.
  Measured, same file both builds (`QvGJz9sd` = Sonic GHZ, a content hash so the
  share id is identical on each):
  - position slope, speed *held*: prod 0.995/1.994 (1x/2x), ours 1.001/1.003.
  - drag test: **prod's raw counter has 0 backward steps; ours has several.** Same
    caller (`VGMPlayer.getPositionMs` -> `_lvgm_get_position_ms`, master's one-liner),
    same wrapper source ⇒ divergence is in the **tree**, not the wrapper/our JS.
  - loop point (fixed song position) reached in 53.2s at 1x vs 26.6s at 2x ⇒ the
    emulation really does run 2x faster on both builds; only the number differs.
  - root cause candidate: `libvgm/player/playera.cpp:295` `PlayerA::GetCurTime`
    uses `Sample2Second(GetCurPos(PLAYPOS_SAMPLE))` = `samples/_outSmplRate` =
    **wall-clock**, and `_playSmpl` is the one counter `VGMPlayer::RefreshTSRates`
    rescales on every speed change (`vgmplayer.cpp:769`). Measured rescale is
    exactly the speed ratio: 1x→2x **0.5000**, 2x→1x **2.0001**.
  - **The fix is in the tree, NOT the wrapper.** `PlayerA::GetCurTime` should scale
    by `GetPlaybackSpeed()` (as `lvgm_get_duration_ms` and both loop getters already
    do), which makes position song-time *and* cancels the rescale so the jump goes
    away. `libvgm/` is path-listed so this is overlay-only and the PR is untouched.
    **Do not "fix" this in `lvgm_get_position_ms`** — prod is correct with the
    byte-identical wrapper, so multiplying by speed there double-counts against a
    newer libvgm. (I proposed exactly that; the user correctly rejected it.)
  - **NOT VERIFIED:** the fix has never been built or measured — it needs
    `node scripts/build-chip-core.js` + relink. Also our fold
    (`VGMPlayer.getDisplayPositionMs`) was **dormant** in every drag test
    (`abs < bandEnd` early-out, bandEnd 91599 vs position ~64s), so **our fold has
    never been tested live**; it consumes the counter through
    `((abs-A)%B+B)%B`, which assumes monotonic song position, so the tree fix must
    land first or the fold keeps consuming a rescaled value.
- **Provenance hole (2026-10-08) — superseded by the sibling build the same day; kept as history.** The running core did **not** match
  the documented reproducible artifact: `src/chip-core.wasm` is `3108c47a…`
  / 1,913,268 B vs the frozen `94c17c93…` / 1,912,960 B. So "byte-for-byte
  reproducible (verified 2026-10-02)" does not currently hold.
  `chip-core.wasm.buildinfo.json` cannot settle it: `build-info.js` derives `tree`
  from `git rev-parse HEAD:<dir>` (committed state) and `source: "in-repo"` is the
  build script reporting on itself; the recorded build ran under node **v26.8.2**,
  not the pinned 24.21.0. Verified independently: no sibling clones exist
  (`../libvgm` absent then, only `../libsidplayfp`), so `normalizeInput` *could not*
  be preferring a sibling; and the in-repo `libvgm` worktree was == HEAD with
  `vgmplayer.cpp` blob `591511bf` (the recorded upstream `91b6542`). (Both siblings
  exist now; this describes the state before the 2026-10-08 migration.)
  **The rebuild above is what settles it** — if the jump reproduces, provenance is
  moot for this bug; if it vanishes, the running core was never the in-repo tree and
  the source-level explanation is wrong.
- **AGENTS.md build sections corrected (2026-10-08).** The libvgm-version section
  (formerly "libvgm pin") and the "Building the real chip-core" mechanics described
  the pre-migration build
  (in-repo trees, the `../` fallback, the wrapper compat); both were rewritten for
  the sibling build. If you find another line still claiming the engines are
  vendored, it is stale — the four trees were deleted on 2026-10-08.
- **Changelog (`dev/record/site.mjs`).** The chip-core section's "One measurement
  caveat" paragraph — its **second** body entry — is entirely "our build reports
  position differently"; when the tree fix lands, delete it. The first entry (why
  the app feature-detects both libvgm/GME vintages) is independent and stays. The
  whole page was given a plain-prose polish pass on 2026-10-08.
- **Committed on `dev/overlay` (2026-10-08):** `3098475e8` (the `server/index.js`
  chart exclusion), then `730adec90` (engine vendoring → sibling build),
  `9c7489b44` (upstreaming plan) and `b645bbd9f` (libvgm-wrapper `parentIdx`
  restore + compat removal). Those and everything after them are committed;
  `git status` is clean and both branches are pushed to `origin`.
- **Comment review + EndDetector, promoted (2026-10-09).** A pass over the
  comments the feature/loop work added: dev-process leakage dropped where it was
  not a recurring-trap warning (`4bf7cbbb0`), loop comments trimmed to their
  invariants (`fef5c7bff`), and wrong long-standing notes corrected
  (`isPlayingIndefinitely`, the OPL3 bank guard, the GD3 block). The SID/N64 tail
  detector became a shared `src/players/EndDetector.js` (`70e686487`,
  `d058ec3da`, `1c2484d02`; dev tuning lives in the module and the Settings panel
  keys off `player.endDetector`); `Player.isBlindLoop()` replaced the footer's
  copy of the rule (`3d9e5fd06`); the media-session position state mirrors the
  transport and uses `Infinity` for a blind loop (`926cda50d`, `a436bd25e`,
  `a2e70cab0`); MUS is no longer treated as multi-song (`039255dca`); the
  NSFe/GBS spec links are master's again plus mirrors (`c5673210c`, `4bf3bd724`);
  `parseGBS` regained its signature-guard `return {}` (`055405a70`) and
  `cleanString` now maps a bare placeholder (`?`/`<?>`/`???`) to empty so the
  catalog binds NULL (`282bcfa36`). Promoted as `5c641c240`, overlay rebased, both
  pushed. Catalog rebuilt clean (6787 files / 87 multi-song / 1140 sub-tunes /
  0 bare placeholders).
  - Promote tooling hardened here: `promote-plan.sh` falls back to a
    `@babel/core` JSX parse when `node --check` fails; `promote-apply.sh` folds
    the rebase + publish tail; `dev/push-overlay.sh` does the
    `--force-with-lease` push.
  - Left deliberately: `build-music.js` schema lines 195-196 keep the trailing
    whitespace of the `music_fts` block above them; `parseSID`'s "for now" hedge.
  - Considered and not done: dropping the promote rebase (the 2026-10-09
    discussion) to remove the history rewrite/force-push. Not needed for
    correctness, but it is the one lever if the rehash ever costs real time.
- **Measurement hygiene, learned the hard way here:** (1) the Speed setting is
  **persisted per user** — a leftover `tempo=2` from a prior session made an MDX run
  report 2.0 song-ms/wall-ms at "1x" and read as a defect; always read the engine's
  speed back from the wasm. (2) The t3 preview is the **`t3-code-…` MCP namespace**
  (`preview_open`, then `preview_navigate`); `browser.*` is a different tool and
  reports "no desktop browser connected". (3) ZCR over the audio is worthless for
  speed questions — at 2x the engine consumes *different material*, so it compares
  two different pieces of music. Use a fixed control in the song (the loop point) or
  an engine counter instead.
- **Branch model:** see "Branches" above. `feature/subtunes-as-first-class` is
  the PR (feature only); `dev/overlay` is stacked on it and holds the
  audio/engine/build/dev work. There is no commit list to maintain — a change
  either belongs to the feature branch or it does not. Run the app from the dev
  branch.
- **Hand-carried fixes are committed.** `feature/subtunes-as-first-class` carries
  the hunks `promote.sh` can never deliver: P1 `__chipConfig.subtuneCount` in
  `server/index.js` (re-carried 2026-10-06 as an unconditional
  `subtuneCount: song.subtune_count || 1`, together with the whole `/shuffle`
  rewrite; S4 `cache1Hour` stays restored to master), and P2
  `engine->load(currentTune)` in `libsidplayfp-wrapper.cpp`'s `sid_set_subtune`.
  **P1 is why the feature branch used to be broken** — its client half
  (`App.js`) promotes, so without the server half every `?play=…&subtune=N`
  share link fell back to the containing directory. Both files are path-listed
  in `dev/promote-paths.txt`, so this is the *only* way they reach the PR:
  repeat it by hand for any future feature work in them. Carry the *siblings*
  too when the two halves of an API are coupled — `server/database.js` promotes,
  but carrying it by hand alongside keeps the pair coherent (see "one field, one
  predicate").
- **Shuffle play and "is this a song folder?" (2026-10-06).** Three commits on
  `dev/overlay` — `af4e8aeb7` (shuffle play on a song-folder page returned
  nothing: `/shuffle` prefix-matched `path/`, which a *file* path never
  matches), `e9daed24c` (shuffle every sub-tune instead of one random sub-tune
  per file — one statement, `LEFT JOIN subtune`, one row per playable song, so
  `/shuffle` and `/random` now have *no* sub-tune branching at all), and
  `4c75be7e3` (one field, one predicate: see "Is this file a song folder?").
  `0c957ad5e` hand-carries the `server/index.js` half to the feature branch.
  **Both halves were promoted and the trees are back in sync (2026-10-07)**: the
  last cycle was the footer's sub-tune label — `src/util.js`, `App.js`,
  `AppFooter.js`, `Favorites.js`, `TopCharts.js`, `index.css` — plus a
  `dev/test-songrefs.js` check that stayed behind. `promote.sh` now reports
  "Nothing to promote", and `server/database.js` is identical across the
  branches; the only `server/` delta left is the four documented overlay-only
  seams. The client half is safe to promote on its own (old client reads an
  absent `subtuneCount` as "not a folder"); **the promote itself is still the
  user's to trigger.**
  Verified in-app: a song folder shuffles all its sub-tunes (28 for
  `Akumajou Densetsu (VRC6).nsfe`, 96 for `gbs/DMG-ZLJ.gbs`); `/browse/nsfe`
  draws 100 songs from all 13 files (was 13); `/browse` draws 100 songs from
  98 files with ~17 of them sub-tunes (was ~1); **natural advance between two
  entries of the same file** (index 7 sub-tune 15 → index 8 sub-tune 1 of
  `nsfe/Contra (SFX Tagged).nsfe`) works, which is the case the expansion makes
  common; `?play=` links land inside a song folder or on the containing
  directory as appropriate, including stale-cache and old-client shapes; Top
  Charts and Favorites labels/grouping unchanged. `dev/run-tests.sh` green
  (2 known VGM xfails), 20/20 in `dev/test-subtunes-server.js`.
- **Out of scope, recorded (2026-10-06):** shuffle play is dead for local
  files. Two mechanisms, neither with a catalog: browser local files are IDBFS
  (`src/LocalFilesManager.js`) listed by `fs.readdir('/local')` and addressed by
  a `local/` path prefix that `Sequencer.playSong` special-cases; and
  `BROWSE_LOCAL_FILESYSTEM=true` browses `LOCAL_CATALOG_ROOT` with
  `fs.readdir` and serves bytes from `/catalog`. Both report rows with no
  `song_id`, so `/metadata` 404s and every file plays sub-tune 0. (The server's
  filesystem mode also never populated `music`, which is why `/shuffle` and
  `/random` cannot work there at all — pre-existing, not a regression.) The
  count *is* knowable after load — `Player.getNumSubtunes()` rides the player
  state — but not before, which is what a listing and a shuffle need.
- **Engine-provenance stamping is overlay-only (2026-10-02).** `scripts/build-info.js`
  (the reader), `config/webpack.config.common.js` (the `DefinePlugin`) are listed in
  `dev/promote-paths.txt`; `src/index.js`'s `window.ChipCoreBuildInfo` assignment is
  a DEV region, because the config it depends on never promotes — leaving the
  assignment behind would reference an undefined `__BUILD_INFO__`. Its `no-undef`
  waiver has to live inside that region too (`eslintConfig` is in `package.json`,
  which promote.sh does *not* skip). Verified in-app: `JSON.parse(window.ChipCoreBuildInfo)`
  works — note the double `JSON.stringify`, because DefinePlugin substitutes a
  string value as a *code fragment*, so one stringify lands an object literal.

- **Handoff state (2026-10):** GBS/AY sub-tune parsing landed (feature:
  `parseGBS` counts, new `parseAY` with per-track labels, `gbs`/`ay` in
  `MULTISONG_EXTENSIONS`; dev-only fixtures + 10 new parser checks, 30 total).
  Catalog fixtures gained two RSID SIDs (20 + 3 songs, from `HVSC_85-all-of-them.7z`),
  a `nes-audio-tests/` dir (28 single-song expansion-chip NSFs, sources kept as the
  gitignored `dev/nes-audio-tests` clone), and 39 gzipped `.vgm` files were renamed
  to `.vgz` (they played fine via libvgm's gzip sniff but got no GD3 metadata).
  Catalog is 6758 files / 1140 subtune rows / 87 multi-song files. Missing-coverage
  notes: no `.mus`/`.smf`/`.gym`/`.s98`/`.dro` files anywhere (players claim some,
  none are routed to parsers that matter); real `.mus` is always single-song
  (`MUS.cpp: m_songs = 1`), so nothing to test there; `sgc`/`sap` stay compiled
  but unrouted,   `hes`/`kss` pruned + unrouted.
- **Rebase done (2026-10-02); the trees are in sync.** `dev/overlay` was rebased
  onto `feature/subtunes-as-first-class` (67 commits replayed, 4 dropped as
  already-promoted), and `promote.sh` now reports **"Nothing to promote"** — that
  is the healthy steady state after a promote. Two lessons, both costing a full
  redo:
  - **`-X ours` in a rebase resolves toward the *upstream*, not your branch** —
    the opposite of what it means in a merge. My first attempt with `-X ours`
    silently stripped every DEV region (`Settings.js`, `UserProvider.js`,
    `N64Player.js`, `SIDPlayer.js`) and left `VGMPlayer.js` with a duplicate
    `applyLoopCount` referencing an undefined `wasLooping`. `-X theirs` is what
    keeps overlay content. The feature branch's *hand-carried* fixes must still be
    checked by hand afterwards: `-X theirs` dropped `cache1Hour`'s dev skip
    (`server/index.js`) and a `parseAY` hunk, both restored in "Re-apply two
    deltas the rebase clobbered".
  - **Verify a rebase by tree, not by "it completed":** snapshot the old tip on a
    scratch branch first, then require `git diff <old-tip> HEAD` to be empty
    (mine was, after the fixup). That diff is the whole proof that no DEV region
    or vendored fix was lost — it is what caught the `-X ours` damage. **It is
    `dev/rebase.sh`'s job now** (see "Dev overlay & promotion"), so the habit is
    a script; on 2026-10-07 that same diff caught a *successful* rebase that had
    dropped a commit and reverted `server/database.js`, which is what prompted
    writing it.
  - **Expect *duplicated* content after promote-then-rebase, not just lost
    content (2026-10-03).** The promote writes *stripped* content onto the feature
    branch and skips path-listed files entirely, so those files keep whatever an
    *older* promote (or the branch split) left there. Replaying the overlay
    commits that touch them can then land on top of content the base already
    has. Seen once: `scripts/build-chip-core.js` (path-listed, so the promote
    left the feature copy alone) ended up listing `_mdx_get_loop_start_ms` and
    `_mdx_get_loop_length_ms` **twice** in `EXPORTED_FUNCTIONS`. Same mechanism
    would duplicate a DEV region's contents or a vendored hunk. Harmless there
    (Emscripten exports a name once), and the feature branch was never affected
    (1 occurrence, promote skipped it) — but it is residue, and the tree diff is
    the only thing that finds it: the rebase exited 0 with no conflicts and
    10f640889 dropped cleanly as "already upstream". **So treat a non-empty
    tree diff after a rebase as a real finding to diagnose, not as noise to
    re-run away** — read it, fix the duplicate back to the pre-rebase content
    (`508023685`), and only then require the diff to be empty.
- **Bug verification (2026-10-02) — two confirmed, one dead, one masked.** A sweep
  of the feature diff for defects *we caused* produced ~25 candidates; root-value
  verification settled four, and the rest were judged not worth the risk of
  fixing blind. Still to do: Stages 2-4 below.
  - **WITHDRAWN 2026-10-02 (was "CONFIRMED, catalog-scale"): the N64/SID
    end-detector trip gate does *not* collapse.** The claim rested on
    `getDurationMs()` being 0 for a file with no `time=`/`length=` tag. It is
    not: `lazyusf2-wrapper.cpp` substitutes the config defaults
    (`tag_song_ms ? : cfg_deflength`, `tag_fade_ms ? : cfg_deffade`), so
    `n64_get_duration_ms()` only returns 0 *before* initialization. Measured
    in-app on the purpose-built untagged rips: `sparse00/01/02/03.miniusf` all
    report **durationMs 171000, trip gate 165000**. SID is safe for the same
    reason (`subtuneDurations` falls back to `DEFAULT_SONG_LENGTH_MS`, 150 s);
    its gate could only collapse on an HVSC entry of `0:00`. Pinned by
    `dev/test-end-detector.js`. The *shape* of the hazard is still worth
    remembering: the gate is `Math.max(0, durationMs - windowSec*1000)`, so a
    track genuinely shorter than the 6 s window trips nearly ungated (a
    documented caveat, covered by the `detectSongEnd` toggle) — and if anyone
    ever makes the gate nullable, remember `getPositionMs() >= null` coerces to
    `>= 0`, so the call site needs its own null check too.
  - **CONFIRMED regression we introduced:** `mdxmini.h`'s `long position_us` is
    4 bytes in this wasm32/ILP32 build (no `MEMORY64` in `build-chip-core.js`), so
    it overflows at 2147.5 s = **35.8 min**; the old `int position_ms` had
    596.5 h (24.8 days) of range. A ~400x range cut bought 1 ms of seek
    accuracy. On wrap: negative position, head jumps to the start, and
    `mdx_set_position_ms`'s `seek_to_ms < position_ms` backward-seek test stops
    firing. Reachable by leaving any looping MDX on Repeat One for 36 min. One
    word: `long` → `double`.
  - **DEAD (do not "fix"):** `XMPPlayer._loopCount` appears not to reset on
    `loadData`, but `Sequencer.playSong:231` calls
    `setLooping(repeat === REPEAT_ONE)` on every load, and with repeat already
    off that hits the third branch (`XMPPlayer.js:289`) which sets it to 1. It
    self-heals before `loadData` runs.
  - **MASKED:** `lvgm_get_cur_loop` lacks the `GetPlayer()` null guard its three
    siblings have, so a pre-first-load toggle sends `UINT32(-1)` → JS
    `Math.max(2, 4294967296)` → wasm truncation → `0` = loop forever. Real
    defect, but the precondition is "no file loaded" (nothing to loop) and the
    next `loadData` → `resolveParamValues` → `setParameter('indefinitePlayback',
    false)` → `SetLoopCount(2)` resets it. Masked by call ordering, not design;
    worth the 1-line guard, not worth describing as a hang. Now pinned by an
    `xfail` in `dev/test-v2m-loops.js`'s sibling `dev/test-vgm-loops.js` (the
    fake models the export's `UINT32` truncation, so the consequence is visible).
  - **Not fixed on purpose:** the remaining ~20 candidates were either cosmetic,
    guarded behind a zero-width window in this catalog, or required speculative
    defensive code. Full list is in this session's transcript, not here.
  - **CONFIRMED in-app (2026-10-02, B4): the VGM fade outlives loop-forever.**
    Reproduced with the real core on `19 1st Place Name Registration.vgz`:
    with Repeat One on at `curLoop` 2, switching the *Indefinite Playback
    setting* off ends the song ~3.5s of song time later (position 66608 ->
    426, i.e. it restarts). Cause confirmed in the vendored tree:
    `PlayerA::SetLoopCount()` only sets `_config.loopCount` and never clears
    `_fadeSmplStart` (`playera.cpp:196`); `lvgm_set_indefinite_playback(false)`
    latches `FadeOut()` (`playera.cpp:438`) *before* `applyLoopCount` restores
    0. Only `Seek()` clears it. Pinned by the `xfail` in
    `dev/test-vgm-loops.js`. Fixing it is an engine-behavior call — see the
    open question in the handoff notes.
  - **FIXED (2026-10-02): MDX lacked VGM's fade-tail capture.**
    Enabling Repeat One while MDX's fade was already running folded the head
    back into the band instead of riding the tail (measured display 105515 ->
    71340, one 34.6s loop, on `catalog/mdx/G2MST6.MDX`).
    `MDXPlayer` now ports `VGMPlayer.syncFadeTailCapture`: the fade start is
    captured in `setLooping` before the pass count changes (mdxmini latches
    `fade_out` and only reinit clears it, so a running fade keeps running —
    the song still ends, which is correct), `getDisplayPositionMs` prefers the
    captured tail, and a seek or the next load drops it. Verified in-app:
    display 105600 -> 105982 across the toggle, fade still ends the song. Now a
    real check in `dev/test-mdx-loops.js` (promoted to the feature branch as
    `078431d4c`).
  - **WITHDRAWN 2026-10-02: the MDX `long position_us` overflow is unreachable.**
    It needs 35.8 min of one looping MDX, which is real but needs a long soak;
    not re-verified in this session, and nothing in the harness touches it.
  - **Stages still to run, in the whole app via `__cpDev`:** B6 (force it with
    `delete window.ChipPlayer.chipCore._lvgm_get_cur_loop` rather than waiting
    for a stale engine); B7/B8/B9 (synthesize 5-second MIDI files with the
    exact shape: SMF format 2 carrying CC102/103, a lone CC111 near the end, and
    >=2 note-less post-loop events); B10 (the `UserProvider` optimistic-favorite
    *failure* path isn't token-guarded, so a late rejection reverts a different
    song's favorite); B11 — **not ours, and the mechanism was misdiagnosed
    here**: a bare `%` in a filename throws `URIError`, but in
    `MIDIPlayer.metadataFromFilepath`'s unguarded `decodeURIComponent`
    (`MIDIPlayer.js:265`, Matt's, `e4e926832d` 2022, present in `master`), so
    the song is unplayable on load — not in the startup browse URL, which goes
    through `fetchDirectory`'s `encodeURIComponent` and is fine. Reachable in
    prod today by clicking such a file in the browser; fixture
    `catalog/midi/.../100% Pure Love.mid`. Our per-segment encoding fixes in
    `util.getUrlFromFilepath`/`getMetadataUrlForFilepath` cover the other call
    sites; this is the one that is left.
  - **Super-speed playback is feasible and needs no tracked-file changes:** audio
    is driven by a legacy `ScriptProcessorNode` on the main thread
    (`App.js:190`, `playerNode.onaudioprocess` — the worklet is an 11-line no-op
    stub), and `this.playerNode` is on the App instance = `window.ChipPlayer`. So
    a devtools-only `__cpDev.superSpeed(k)` can save+null `onaudioprocess` and
    call `player.processAudio(chans)` in a time-budgeted loop: identical call
    sequence, buffer size and sample rate, only wall-clock density changes.
    (Do *not* touch the sample rate handed to the players — song-time-per-buffer
    is `bufferSize / rate`, so a higher rate is *slower*, and the practical
    ceiling is 48000/8000 ~6x before engines misbehave.) Validate first by
    asserting the engine's own `getPositionMs()`/`GetCurLoop()` agree at matched
    song positions at 1x and 16x. Note that most Stage 1-4 items do **not**
    need it once you assert the root value instead of the emergent behaviour.
- **Testing is deliberately NOT in the PR.** The dev harnesses stay in `dev/`
    (excluded by `dev/promote-paths.txt`) and are version-controlled on
    `dev/overlay`, so they persist without being shipped. Rationale: the repo has
    no test runner, no CI and no `test` script; a tracked suite would silently
    skip ~30% of its checks because `catalog/` is gitignored
    (`test-parsers.js` real-file checks `return` silently, `test-midi-loops.js`
    `process.exit(0)`s); and the benefit is consumed entirely before the PR is
    written while the maintenance cost lands on Matt afterwards. Offer it, don't
    impose it. This was decided explicitly — do not re-litigate without new
    information.
- **Handoff state (2026-09, read this):**
  - **Looping is now the top priority** and is treated as **feature** work (part
    of completing the sub-tunes feature), not an overlay extra. The VGM Repeat
    One baseline is implemented and the full toggle matrix is verified; see
    "Repeat One / looping model" and the test matrix. This session fixed five
    interaction bugs on `dev/overlay`: indefinite playback ended early under
    Skip Silence (`469a8c78a`), the head folded into the band with repeat off
    (`0b8d76781`) or when repeat was enabled mid-fade (`082b83cb2`), the
     Off→All no-op toggle re-derived the loop count and jumped (`96683ba3e`),
     and leaving a deep repeat cut the song instead of playing the fade
     (`08e3bc86b`). GME was probed in-app and has no loop regions in this
     catalog (whole-track restart already complies). **MDX is now seamless too**
     (native loop + exact band; see "MDX (mdxmini)"), and **MIDI is now seamless
     too** (JS event-loop wrap + shared band; see the per-format table),
     **XMP is now seamless too** (native loop count + learned band), leaving
     V2M alone on stop + reload.
     - **OPEN (2026-10-06): V2M's reported duration does not match the engine.**
       `V2MPlayer.getDurationMs()` reports 63000 for
       `v2m/apollo dvd copy 4.5.4kg.v2m` while the engine keeps rendering past that,
       so the slider reserves a 63 s box and the head parks at the end for a song that
       has not finished — i.e. the format gets the *blind-loop* look it should not
       have. Found while recording the changelog page: the clip was 5.7 s and the
       reported song 63 s, so it could not show its own claim either (the "reload"
       mark labelled an event that never happened on screen). Root cause not yet
       established — `V2MPlayer` has no loop API at all (no `setLooping` override), so
       this looks like a length/frame-count conversion rather than loop bookkeeping,
       but that is a guess and needs measuring first: does the engine's own frame
       count disagree with `getDurationMs`, or does the position simply not stop
       advancing? Until then the V2M clip is `ready: false` and off the page
       (`dev/record/scenarios.mjs`, TODO(unpublish)), and the page's "default loop"
       group shows `sequencer-default-loop` instead — a MIDI file with no CC
       102/103/110/111 in its byte stream, so no band can exist and the reload is
       purely Sequencer-level. **Do not treat V2M as the worked example for
       stop+reload while this is open.**
     GME/MDX/`durationExtended`/
     `getLoopBandMs` all feed the shared `Player` hooks; keep engine policy in
     the engine's own player class.
  - **Overlay/promote system** is in place but **WIP**: `dev/promote.sh` +
    `dev/promote-paths.txt` + `DEV-BEGIN/DEV-END` regions. See "Dev overlay &
    promotion" for the mechanism and the **Known gaps** (a few shared files are
    still path-listed and should become regions).
  - **The libvgm pin move was attempted and reverted in 2026-09** (runtime drift +
    `wasm-opt`), then done on 2026-10-08: the build now uses the sibling `../libvgm`
    clone and VGM renders. See "libvgm version" above.
  - **Branches pushed to `origin`**: `master`, `dev/overlay`,
    `feature/subtunes-as-first-class`. Worktrees: main = `dev/overlay`, sibling
    `chip-player-js-feature/` = feature. `backup/master-pre-upstream-catchup`
    holds `49ee4cde8`, our master before the 2026-10-07 upstream catch-up.
  - **All three branches caught up to upstream (2026-10-07).** `master` is a
    fast-forward to `dba9e5f8e` (23 commits, 2026-09-26 → 10-04); the feature
    branch carries it as a **merge** commit, not a rebase, so the 25 sub-tune
    commits keep their identity; `dev/overlay` was rebased on top via
    `dev/rebase.sh`. `git diff master..feature/subtunes-as-first-class` is
    41 files and contains no dev tooling or vendored engine. Two follow-ups
    from that merge are recorded above: the parser-file split, and the
    `'Game Boy'` label correction.
  - **A catalog rebuild is a prerequisite for booting the server after a merge
    that adds a column to a query.** `server/index.js` selects `m.contributor`
    (upstream's 2026-10-04 `ce552d2f9`), but that column is created by
    `scripts/build-music.js`, not by the server. On a catalog built before the
    merge the server dies at require time with a bare
    `SqliteError: no such column: m.contributor`, which reads like a code bug
    rather than a missing migration. Run `node scripts/build-music.js -n` after
    any merge that changes the schema.
  - **Dev shims are untracked-stage, not tracked patches** (no more
    `*.dev-backup` / `--revert` for auth/UserProvider). `dev/apply.sh` /
    `dev/remove.sh` manage them; `git status` stays clean after apply.
  - Both branches are pushed to `origin` and the trees are in sync: `dev/overlay`
    differs from `feature/subtunes-as-first-class` by DEV regions only, and
    `dev/promote.sh` reports "Nothing to promote" — the healthy state after a
    promote. Do not run it as a per-change ritual (see "Dev overlay &
    promotion"). The rebase half of the cycle is `dev/rebase.sh`, which verifies
    the tree; do not rebase by hand.
- **Remote dev access (LAN/WSL/Tailscale):** fixed, dev tooling only (not the
  feature). Two root causes:
  - `scripts/start.js` built its own minimal `WebpackDevServer` options and
    silently ignored the whole `devServer` block in
    `config/webpack.config.dev.js`, so `allowedHosts: 'all'` never applied and
    the WS `Host`/`Origin` check rejected remote clients (`Invalid Host/Origin
    header`, reconnect loop). It now spreads `config.devServer`. This also makes
    the block's `hot: false` effective (HMR off, full live reload) and enables
    its middleware. The stale `.wasm` middleware had to be removed because it
    served from `public/` and 404'd the emitted `static/js/chip-core.*.wasm`;
    webpack-dev-middleware already serves it as `application/wasm`.
  - `src/config/index.js` hardcoded `http://localhost:8080` for the dev API,
    catalog, and soundfonts, so a remote browser called its own localhost
    (`ERR_CONNECTION_REFUSED`). It now uses `window.location.hostname`
    (falling back to `localhost` in Node). Restart `npm run dev` after changing
    either file.
- **Test audio on a remote machine:** start `npm run dev`, then browse the
  remote host on :8080 (the Express server proxies to WDS :3000). Verified via
  the T3 preview at `mms-1:8080`: API/wasm/catalog/soundfont requests 200, WS
  opens, and a clicked song plays. The `/preview` route needs skia-canvas;
  everything else is fine over Tailscale.
- **Verified playing:** NSF/NSFE/SPC/GBS/AY (GME), VGM/VGZ/GYM/S98/DRO (libvgm,
  including YM2612 on the default GPGX core), TG16/Game Boy/Neo Geo/Capcom/Konami VGZs,
  MOD/S3M/XM/IT (libxmp-lite), N64 `.miniusf`, V2M, MDX, MIDI (fluidlite + a
  SoundFont), SID (mmontag fork; sub-tune switching verified). Repeat-one over
  loop regions and the slider loop band are verified, including MDX's native
  built-in loop (see "MDX (mdxmini)").
- **Still broken / missing:** SID `seek()` to a non-zero position (fork WIP and
  tune-dependent: some tunes resume after a brief dip, others stay silent; a
  seek before first render hangs; seek-to-0 works); N64 seek freezes ~5s while
  timeslicing lands (pre-existing, unrelated to the feature). See "Audio engine
  roadmap" for the ordered plan.

## Remaining TODO / roadmap

1. **Looping / Repeat One across all formats — now the top priority.** The goal
   is one intuitive Repeat One for every format, for single files and sub-tunes,
   with no jarring audio or visual artifacts on enable/disable. See "Repeat One /
   looping model" below for the contract and the VGM baseline.
2. Testing. Dev-only harnesses cover parsers (`dev/test-parsers.js`),
   build-music round-trips (`dev/test-build.js`), sequencer navigation, the
   SongRef identity model, the loop model of every engine (VGM/GME/MDX/MIDI/XMP
   plus V2M's tier-3 contract), the SID/N64 end detector, and the sub-tune server
   API -- 175 checks via `./dev/run-tests.sh` (2 reported known failures: the VGM
   indefinite-playback fade, a known limit, and the unguarded
   `lvgm_get_cur_loop` sentinel). Every engine now has a harness, including the
   GME in-buffer `restartTrack` path. Not yet harnessed: the client component
   behavior (favorites/sub-tunes/share links/top charts), which needs a browser
   -- and that is a decision, not just a gap: the repo has no test runner and no
   jsdom, so it means adding a dependency or hand-verifying in the preview.
   They are removed with `dev/` before the PR, which still ships without tests
   (matching the repo, which has no test runner or CI). If Matt wants a durable
   suite, the same harnesses could move to a tracked `test/` dir and run via
   `node --test` with no new deps.
3. **Changelog page with video examples.** *Tooling built 2026-10-05; **16/16 clips
   recorded, passing and published** (8 across two top-level sections, 8 per-format),
   after a curation pass merged four clips away. The two sections are the two classes
   of change — `subtunes` (songfolder, favorite-subtune, shuffle-subtunes,
   charts-subtunes) and `looping` (loop-band, repeat-toggle-smooth, repeat-leave-fade,
   blind-loop) — because they are separate pieces of work that are not even about the
   same thing.* `dev/record/`
   holds the whole pipeline: a clip registry
   (`scenarios.mjs`, **17 scenarios of which 16 publish** — `v2m-tier3` is
   `ready: false` and withheld pending the V2M duration bug above; validated by
   `scenarios.check.mjs` and wired into `dev/run-tests.sh`), the page-side
   recorder shim
   (`dev/shims/recorder.js` → `src/chip-player-record.js`, `window.__cpRec`),
   the flash/mux scripts, and a generator that emits a self-contained `site/`
   (relative URLs only, no framework) to upload to a web server and link from the
   PR. Start at `dev/record/README.md`, and read `dev/record/FINDINGS.md`
   *before* changing the recorder — it records the measured gotchas, several of
   them counter-intuitive and several of them about the *pipeline*, not the app.
   The ones that shape everything else:
   - **Video comes from Playwright, not the host tab recorder.** The host's
     recorder captures at 1x CSS px and upscales (soft), declares a variable
     `r_frame_rate` that ffmpeg's default CFR output resamples away (60 real
     frames → 5, i.e. a slideshow), and loses takes over 50 MiB in transfer.
     `dev/record/shoot.mjs` drives Playwright instead: viewport 720x720 at
     `deviceScaleFactor` 2 with **`recordVideo.size` left unset** (setting it
     pads the frame and shrinks the app to ~57% of the picture), giving 720x720 at
     a constant 25 fps, DPR-correct, written straight to disk. It needs the
     `--no-save` playwright install — see the npm trap in "Dev environment".
   - **Audio still comes from the page**, not the capture: an in-page
     `MediaStreamAudioDestinationNode` off `ChipPlayer.gainNode`, muxed with the
     video. Playwright's `recordVideo` is silent and this host has no audio
     device at all, so nothing else is available (this also kills
     `canvas.captureStream()` / `getDisplayMedia` as options — a DOM app has no
     canvas, and the preview tab exposes no `mediaDevices`).
   - **The sync mark is green and detected by hue, not luma.** Playwright starts
     recording *before* navigation, so every clip begins on a blank page; a white
     mark was indistinguishable from that page load, `find-flash.sh` locked onto
     the load, and clips were published ~3.5 s out of sync with their own audio
     **while every assertion still passed**. Green (bright, both chroma channels
     low) is unique in this app by construction.
   - `-fps_mode passthrough` in `mux.sh` is mandatory for a VFR input, the trim
     must start a frame *past* the mark, and `shoot.mjs` asserts the capture is
     exactly the viewport so the padding failure can't return silently.
   - `preview_evaluate` still fails intermittently **at the transport level** when
     previewing; retry, and read `__cpRec._run` / `__cpRec.result()` to see
     whether a "failed" call landed.
   - **All 14 clips are recorded, passing and published** (6 main, 8 per-format).
     Four were *removed on purpose* rather than fixed, because they were redundant
     with `songfolder` or with `loop-band`: `subtune-is-a-song`, `labels`,
     `share-link` and `show-loop-area`. Their claims were folded into those two
     clips' `watch` bullets and `before` lines, so nothing was lost — the page is
     shorter and every clip earns its place.
   - **A clip has to show the event its own text names.** The curation pass found
     three clips whose `watch` bullets claimed more than their footage showed, and
     the fix is always the same: measure the moment, then script up to it.
     `mdx-native` claimed "the band is exact" while reaching 5% of its song with
     **zero** display-folds — MDX uses the base two-pass band, so the head only
     folds after `intro + 2*loop`, and a take from the beginning never arrives;
     it now seeks to 101000 first and records 51 folds, the first landing 123 ms
     from the band start. `n64-indefinite` claimed "instead of reloading every
     cycle" at 2% of its song. `vgm-native` had one bullet and quoted no numbers.
     Related: `repeat-leave-fade` asserted only `durationExtended` — *a flag
     saying the tail was scheduled* — when its claim is an amplitude one, so a
     hard cut (what master did) would have passed; it now reads the envelope
     (0.140 → 0.000 over ~4.8 s, libvgm's 4 s fade plus its 0.5 s of silence).
   - **Every clip asserts audibility.** Nine predate the RMS tap on the app's gain
     node, and every one of their assertions read the transport — which is exactly
     what a *silent* engine does too, so each would have published a moving
     playhead and no sound. Each now has an `audible` assertion on the trace's
     per-tick `rms`, with a length floor per clip so it cannot pass on a partial
     trace. `repeat-leave-fade` has none by that name and does not need one: its
     two envelope assertions are strictly stronger.
   - **Two seams exist for a clip whose seek or song-end does not suit a take.**
     `preRoll` seeks *before* the trace, audio recorder and flash — for N64/USF,
     whose seek renders forward and takes ~9 s (measured landing within 0.5–2 s
     of the ask, but **not repeatable between runs**, so those scenarios assert
     behaviour rather than a fixed position). `finishAfterMs` shortens the run
     past the last step, for a clip whose song ends mid-take: the default 600 ms
     was catching the sequencer's *restart*, which is both the wrong sound and the
     wrong thing for an envelope assertion to measure.
   - **The page's per-format section is grouped by mechanism, not format**: native
     loops at load / indefinite playback looping / learned loops / the default
     (repeat the whole song). Runs cheapest-to-dearest so the section ends on the
     fallback, and the last group is framed as *the default a new format inherits
     for free* — `Sequencer.advanceSong` never advances `currIdx` under
     `REPEAT_ONE`, so whole-file replay is what every player inherits with no
     engine override. Each clip names a `group`; `scenarios.check.mjs` rejects an
     unknown one, because a typo'd group silently drops a recorded, passing clip
     out of the page.
   - **The green-verdict trap, four times over.** The single most valuable lesson
     from the curation pass, and every instance shipped a *passing* clip that
     did not do the thing it claimed:
     1. `button[title*="avorite"]` — `FavoriteButton` renders no `title`, so the
        selector **matched nothing** and nothing was favourited. Then unscoped
        `button.FavoriteButton` clicked the **first row's heart** (Prelude) while
        the clip claimed Epitaph. Then `a[href="/favorites"]` **never matched**
        either, because the nav link spreads the search params and the href is
        `/favorites?r=<cache-buster>` — the take never left `/browse`. All three
        passed, because "Epitaph", the folder name and `subtune=1` are on the
        browse page too. **A selector that matches nothing cannot fail an
        assertion**, so an assertion has to name the page it is about.
     2. `Show Loop Area` was clicked while **behind the footer**
        (`elementFromPoint` at its centre returned a transport button). A synthetic
        click fires the React handler regardless, so the band assertions were green
        over a click no viewer could make. `loop-band` now records at 900x840 and
        asserts the checkbox is genuinely the topmost element at its own centre.
     3. `document.body.textContent` searches for a song title pass on any page,
        because the **footer** keeps showing the playing song — scope assertions to
        `.BrowseList` (or to the trace), never to `body`.
     4. The fourth instance, in `shuffle-subtunes` (2026-10-08), is the same shape
        reached from the other side: the assertion asked "is the playing row
        highlighted", and in a **virtualized** list that is true of a row rendered
        but scrolled out of the box — ~33 of up to 73 rows exist. The first recorded
        take passed 8/8 verdicts while **three of its eight song folders showed no
        highlight at all**, and the reveal step that was supposed to scroll it into
        view was a silent no-op. Three fixes, all of which the take alone would not
        have surfaced: assert **visibility** (the sampler grew `hlInView`), **record
        what the reveal did** as a trace mark (`reveal: row 25 -> 194px`, or
        `no-op (…)` — a reveal that found nothing looks exactly like one that
        worked), and make it **retry** while the listing is in flight. Two further
        measured findings are in `dev/record/README.md` §7a: the row index must come
        from the **sequencer's** ref, not `player.getSubtune()` (they disagree on ~2
        in 14 nsfe songs, because GME reports the post-`plst` track), and
        `list.scrollToRow` is a **no-op** on this WindowScroller/List pair where a
        direct `scrollTop` write works 10/10. The same clip then found the
        *click* variant: a shuffled directory is full of one-second sound effects, so
        the song can end before the step runs, leaving the footer's path link
        belonging to the song it replaced — the click navigated to that song's folder
        and the frame contradicted the clip. `tryClick(sel, 'song-folder-link')`
        refuses the click instead, and the refusal is **marked**, so a skipped beat
        is visible in the proof instead of looking like one that worked.
     The general form: **assert on the artefact, not on the state you manipulated**,
     and when the claim is "the viewer sees X happen", assert X is *visible* — and
     when a step is supposed to *make* it visible, assert that the step ran.
   - **A clip's fixture must support its own claim.** Three fixtures were replaced
     after measuring rather than after reading: a ~1.3 s test tone that *ends* for a
     clip about a driver that loops internally (GME reports `play_length` 101000 ms
     for `nsfe/Akumajou Densetsu (VRC6).nsfe` sub-tune 3, seek to `play_length -
     1000`); HVSC's real listed lengths, which arrive over HTTP at load
     (`sid/Bionic_Commando.sid` sub-tune 2 is genuinely `0:03`, and the trip gate
     `durationMs − 6000` is therefore 0 — open from the start); and a SID restart
     whose first sampling window ended *exactly* at the restart, which made a
     working mechanism look like it left the engine silent. Sampling windows must
     outlast the event being demonstrated.
   - **Lengths are not in the catalog.** `subtune.length_ms` is NULL for NSF/NSFE
     and SID; GME parses `play_length` at load, SID fetches `/api/hvsc?sidHash=`
     over HTTP and falls back to 150 s. Any clip asserting "past the reported
     length" has to read the number the *player* used — `dev/record/probe.mjs`
     exists for exactly this (`seek`/`watch`/`calls`/`restart` modes, and it taps
     the app's own gain node so a seek into a silent tail cannot pass as music).
   - **The page must be served with Range support.** `python3 -m http.server` has no
     Range support, so `video.seekable` came back empty (`0.00-0.00`), clips showed
     a first frame that would not play, and the same file played standalone — which
     reads exactly like a broken encode. `dev/record/serve.mjs` is `express.static`
     (already a repo dependency).
   - **The intermittent stalls are fixed but NOT explained — do not repeat the
     explanation.** The user reports playback is now consistent; the change set was
     `preload="none"` + posters + explicit `width`/`height` +
     `Cache-Control: max-age=3600`, and **which part fixed it is unknown**. The
     story I wrote first — 14 simultaneous preloads queueing behind the browser's
     six-connection-per-host limit — is **refuted**: `vidqueue.mjs` replays the old
     `preload="metadata"` page and the deepest clip plays fine even clicked 0.5 s
     after load, and `vidrange.mjs` shows `Range`+`If-Range` answered `206` under
     both cache policies. Keep the changes anyway, on their own merits: 0 MB on
     load is right for a page, `express.static`'s `max-age=0` re-fetched everything
     every visit, and a `preload="none"` element needs a poster and explicit
     dimensions or the box collapses. But the causal story was written *after* the
     fix and survived no test — the user's "35 MB is about a second on a LAN, and
     clicking play should make it load" was a better argument than all of it. Full
     correction in `dev/record/FINDINGS.md`.
   - `recordVideo.size` must be **exactly the viewport**, and past 800px the default
     silently rescales: 900x720 unset gives an 800x640 frame (0.889x, softening the
     glyph edges dsf exists to protect). Also measured: `deviceScaleFactor` buys
     supersampled antialiasing, **not** a bigger frame — output is CSS resolution,
     so dsf must be held constant when comparing framings. Clips capture 900x720;
     a scenario may ask for more via `viewport` (loop-band needs 840 for the reason
     above).
   - Batch run lessons worth carrying: a scenario's `until` gate must never wait
     for its own first step (an `open` that starts playback deadlocks a
     `until: 'playing'` gate); a multi-tune file's row in its parent's listing is a
     **song folder**, so `clickRow` navigates instead of playing and a preload
     waits forever; `clickRow` cannot find `..` (App.js unshifts it client-side, so
     it is not in any listing) — the shim special-cases it by exact text; the
     **Favorites page is virtualized** (measured 33 rows in the DOM with the nsfe
     group scrolled out of frame), so a clip that demonstrates favouriting sets
     `clearFavorites: true` and must not rely on accumulated dev-user state — and
     note that clearing has to go through `handleToggleFavorite`, because `faves` is
     seeded from `localStorage`, so a server-only clear leaves the client believing
     the favourites still exist and the next heart click *removes* instead of adds;
     opening a sub-tune leaves the browse route (its href is
     `/?play=…&subtune=N`), so showing two directories needs the new
     `__cpRec.navigate()` step; the trace sampler must record every field the
     registered assertions read; and a virtualized listing is not a stable
     assertion target — prefer trace marks over live DOM.
   Worth capturing in the clips, per the original note: a song folder expanding
   into sub-songs, the time-slider loop band, Repeat One toggling without a jump,
   and per-sub-tune favouriting. The page deliberately says *feature-only* — no
   master build, no A/B recording — with each clip's "Before:" line describing
   what master did instead, and every clip publishing the numbers that verify its
   claim. The page is hosted **separately** from the site (decision 1 in
   `dev/record/README.md`), not added to `public/`.
   - **Page weight is no longer the constraint; per-clip duration is governed by a
     120 s cap and a 200 MB upload-dir budget** (`scenarios.check.mjs`). Raised
     2026-10-06 from 9 s → 20 → 30 → 35 → 120 s across this session, because the
     clips are `preload="none"` with posters: a reader fetches nothing until they
     click, so a heavy page costs them nothing they did not ask for. Current weight
     **59 MB of 200 MB** across 30 media files, reported on every check. Note the
     per-clip *duration* cap is now a guard against a scenario that silently waits on
     something that never happens, not a size proxy — it used to be the latter, which
     is why it was raised five times. Longest clips are now `xmp-learned-band`
     (32.5 s) and `midi-cc102` (29.6 s), and both are long *for watchability* rather
     than because the behaviour needs the time: `xmp-learned-band` holds 10.5 s of
     music before its seek and ~7.7 s of loop after the wrap, and the same behaviour
     proved in 22 s was hard to follow. `loop-band` is no longer the longest
     (10.3 s); its assertions are still VGM-specific (`curLoop`, intro 342 / loop
     800) while MDX is now a viable fixture for the same claim (its checkbox is not
     occluded; its band starts at 69 s, so it would need a seek).
   - **Build and re-record are both selective, which is what makes the polish phase
     workable** (2026-10-06). A prose or CSS edit costs ~90 ms:
     `build-site.mjs` caches the only two video-derived facts (dimensions, poster
     frame) on the clip's size+mtime+seek time, verified to reproduce `index.html`
     and all 14 jpgs byte-for-byte against a cold build with the cache and posters
     deleted — so the cache skips work rather than degrading it. `shoot.mjs` takes
     named repeatable `--clip <id>` args, resolves every id *before* recording (a
     typo in the last position must not cost a 15 s take), and does not stop at the
     first failure: `shoot: 13/14 passed`, then the failed ids. A bare
     `shoot.mjs` is an error rather than an implicit full re-shoot; `--all` is the
     explicit way to ask for that.
   - **Playback delivery: the Range bug is established; the stall fix is confirmed
     only in outcome** (2026-10-05). Both bugs were invisible to file-level checks:
     `ffprobe` called every clip valid, every codec was `probably` playable, and
     14/14 played in automation. Keep in mind for any future page that the *page's
     requests* are a separate artefact from the files, and that "I changed it and it
     works" is not the same claim as "I know why it works" — see the correction
     above and in `FINDINGS.md`.
4. Known unsupported formats (don't add to `FORMATS` without a player/parser):
   plain `.usf` sets (only `.miniusf` is supported), PSF/PSX (`psflib` is reused
   only by the USF loader; no PSX core), and PSM (`libxmp-lite` = it/mod/s3m/xm;
   the files here are the MASI variant, which needs full libxmp).
4. **Audio engine roadmap** (separate from the feature; see "Building the real
   chip-core"). Ordered by impact × risk:
   - **Done:** emscripten build of GME/libvgm/libxmp/N64/V2M/MDX/fluidlite; YM2612
     fixed by pruning GME's OPN objects so the GME↔libvgm `ym*_write` clash
     cannot happen (a duplicate-symbol tripwire now fails the build on any
     strong-symbol collision; `--allow-multiple-definition` stays only as
     belt-and-braces). No core override is involved -- GPGX was never broken.
   - **(1) SID — fork builds; `setTempo` done, `seek` still WIP.** Built from
     `mmontag/libsidplayfp` (`montag-dev-2.14`, recursive) by
     `scripts/build-libsidplayfp.sh`; verified rendering, sub-tunes, sub-tune
     switching, voice mask, voice groups, and tempo. Matt pushed `mmontag/resid`
     and pointed the submodule at it, so the clone and build are reproducible
     (requires `xa65` for the 6502 driver `.bin` files). **`seek()` is WIP and tune-dependent**: Cybernoid II and
      Monty-on-the-Run resume (with a brief dip), Cybernoid and Bionic Commando
      stay silent, and a seek-before-play hangs for every tune tested (see "SID"
      above). Seek-to-0 is reliable. Prod uses the same fork and behaves the
      same, so this is faithful, not our regression; an upstream fix is still
      needed for the slider / `?t=` links to be trustworthy on SID. Also pin the
      fork branch to a commit for reproducible builds.
    - **(2) Newer GME (upstream ≥0.6.4) + newer libxmp, and prune GME.**
     Upstream 0.6.4 already has `gme_disable_echo`/`seek_scaled` (confirmed
     via Matt's change notes and live probes of his core — stop chasing the
     fork question; if our stuff works with 0.6.4, that is far enough).
     `fluid_synth_get_active_voice_count`
     has neither a call site nor an export today. The prune half is done:
     our GME build compiles no VGM/GYM/HES/KSS (see "libvgm YM2612 core").
   - **(3) Per-engine wasm modules (isolation epic).**
     One Emscripten `Module` per engine (own linear memory/FS) instead of one
     flat blob with global C symbols. Matches the existing per-extension player
     design (`Sequencer.players.find(canPlay)`, libvgm `SetDeviceOptions(FCC_*)`,
     soundfonts via `_tp_*`) and contains the C-global "virus" at a module
     boundary. Caveats: each module owns its heap/FS, so soundfont loading and
     the shared visualizer (`_cqt_*`) need a plan (MIDI's soundfont FS moves with
     the MIDI module). Prefer static per-engine modules over Emscripten
     `SIDE_MODULE`/`dlopen` (dynamic linking is high-risk: memory growth, GOT,
     async init, and the audio callback wants synchronous calls).
   - **(4) libADLMIDI (MIDI OPL3) — done (Nuked core).** Enabled and playing;
     the `~DosBoxOPL3` abort is avoided by building Nuked instead (see
     "libADLMIDI" above). Isolation (step 3) would still shrink the blob and
     contain its OPL cores, but is no longer required to ship OPL3 MIDI.
   - **(5) N64 seek freeze — done.** `N64Player.seekMs` now timeslices
      `_n64_seek_ms` in idle callbacks like GMEPlayer (pre-existing bug,
      unrelated to the feature; committed separately).
   - **(6) MDX loop region, native Repeat One, seek accuracy — done.**
      `mdxmini` records exact loop points and loops natively via
      `mdx_set_max_loop`; the fade end is now latched and `position_ms`
      accumulates microseconds so seeks are frame-accurate. All overlay-only
      (vendored tree + `build-chip-core.js`); see "MDX (mdxmini)".

   **Traps / learnings:**
   - All three YM2612 cores must stay compiled, and the reason is the **link**,
     not the quality ranking. `2612intf.h` enables
     `EC_YM2612_{GPGX,GENS,NUKED}` itself, so `devDefList_YM2612` always names
     all three; the `SNDEMU_YM2612_*` flags only decide which source files are
     compiled. Turning one off leaves its `devDef` referencing symbols with no
     object behind it, and the link fails. `SNDDEV_YM2612` is defined
     unconditionally, so the *device* registers regardless -- it is the core
     list that goes empty. Earlier notes here said "disabling GPGX alone drops
     the device" and to "force `FCC_GENS` per-device"; both were wrong, and
     **the force was deleted.** Do not reintroduce it (see
     "libvgm YM2612 core" above).
   - `--allow-multiple-definition` is luck, not safety: it once silently kept
     GME's MAME `ym2612_write` over libvgm's and hung YM2612 playback (see
     "libvgm YM2612 core"). Fixed by pruning GME's OPN objects (below), and
     `scripts/build-chip-core.js` now runs a duplicate-symbol tripwire
     (`checkDuplicateSymbols`, over `emnm` of every linked archive) that fails
     the build loudly on any strong-symbol clash instead of shipping luck.
     `objcopy --prefix-symbols` remains the fallback when two copies are both
     genuinely needed.
   - The repo's vendored engines are **not** what prod uses. Upstream has no
     submodules, and both its and our `game-music-emu`/`libxmp` lack APIs the
     build exports. Prod's shipped `chip-core.*.wasm` contains the strings
     `sidplayfp`/`adlmidi`/`GPGX`/`Gens`/`MAME`/`FluidLite`/`OPN2`, proving it is
     built from forks/newer versions. Don't trust the README/vendored source;
     confirm empirically. Prod's wasm **exports are minified**, so compare
     embedded strings plus the JS glue's `_sid_init`/`_adl_init`/… names, not the
     wasm export table.
   - Build/allocator: `dlmalloc` (configurable) and `INITIAL_MEMORY=128MB` vs
     upstream's `emmalloc`/64MB. `-flto` makes duplicate-symbol collisions worse;
     drop it for archives you are trying to keep separate.
5. Before PR: the feature branch is already feature-only, so there is nothing to
   strip. Push `feature/subtunes-as-first-class` to our fork (`origin`) and open
   the PR against `mmontag:master` — never push to `upstream`, and never include
   `dev/overlay`. The diff is `git diff master..feature/subtunes-as-first-class`.

## Repeat One / looping model

The north star for this work (top roadmap item): **one intuitive Repeat One for
every format**, single files and sub-tunes alike, seamless on enable/disable,
with no jarring audio or visual artifacts. Guiding principle: *loop the region
the composer intended, as the game would play it*, using native engine looping
wherever possible and faking it only when there is no alternative.

### The two clocks

Keep these separate; use each for its own purpose:

- **Time playing** (`Player.getPositionMs`, absolute): includes completed loops.
  Drives engine/fade bookkeeping and end detection.
- **Playlist position** (`Player.getDisplayPositionMs`, single pass): what the
  slider head and the left time label follow. It folds/advances within the loop
  region (and into the fade when leaving). `Player` defaults it to
  `getPositionMs`; players that can loop override it.

Position/head flow: `AppFooter` polls `getDisplayPositionMs()` every 100 ms
(`TimeSlider`), so both the head and the label come from the player. Never derive
the displayed position in the component layer (the old `AppFooter` fold hack was
removed).

### The highlighted loop band

The band on the slider is the **last loop instance that is not within the fade**
— with the default intro + two passes + fade it is `I1 = [A+B, A+2B)`, where
`A = intro_length` and `B = loop_length`. Rationale: give the user as long as
possible to decide to stay, and keep the band from moving when repeat toggles.
`AppFooter` shows the band when the track defines a loop region, gated by the
Global Settings "Show Loop Area" toggle (default on; visual only — hiding the
band never changes playback or the head fold).

**Done — the band math used to be engine policy in a component.**
`AppFooter.js` had `const lastLoopInstance = 2`, which is libvgm's
`pCfg.loopCount = 2` (`libvgm-wrapper.cpp`) restated as a magic number in the
view layer. The computation now lives behind the player method
`getLoopBandMs()` returning `{ startMs, endMs }`, and `AppFooter` only maps ms
to the slider's 0..1. The base `Player` holds the generic implementation over
the shared `intro_length`/`loop_length` vocabulary (VGM maps its region into
those field names, so no override is needed today); engines whose loop
semantics differ override it. `VGMPlayer.getDisplayPositionMs` reads the same
hook instead of recomputing the band.

### Repeat One contract

- **Enable (any time):** loop the region natively/forever; no seek, no jump. The
  head cycles inside the band. If enabled after the region, finish the current
  pass first (via `restartAtEndPending` or the player's native equivalent),
  never jump the transport backward into the loop. If a fade is already running
  when repeat is enabled (enabled mid-fade), the audio finishes that fade and
  the song ends; the head must proceed through the fade region, not fold back
  into the band — VGM captures the fade start at enable time for this.
- **Disable (any time):** *play past* the loop region as if repeat was never on:
  finish the current pass, then the fade, then end/advance. The head must be
  **continuous across the toggle** (same display mapping before and after), then
  run the fade tail from the band end. Never jump.

### Code placement (what may know about what)

The engine-specific loop policy lives in the engine's own player class; only
polymorphic hooks reach the shared layers. Keep it that way — the layering is
the whole defense of the design.

| Layer | May know about engines? | Loop surface |
| ------ | ------------------------ | ------------ |
| `Sequencer.js` | no | none; only `setLooping(repeat === REPEAT_ONE)` (pre-existing) |
| `src/components/` | no | none; `getDisplayPositionMs()` ms -> slider 0..1 |
| `Player.js` (base) | no | `getLoopEndMs()`, `getDisplayPositionMs()` (defaults to `getPositionMs`), `isPlayingIndefinitely()` (defaults to `this.looping`) |
| `XxxPlayer.js` | yes, only itself | overrides the above |
| `src/bindings/*-wrapper.cpp` | yes, only itself | capability-neutral getters/setters; no policy |

Two rules that keep it honest:

- **The base class must not name a param or an engine.** Base
  `isPlayingIndefinitely()` deliberately returns only `this.looping`; the
  `indefinitePlayback` param is OR'd in by the players that have it. Don't
  promote that param into the base.
- **The metadata vocabulary is GME's and pre-existing** (`intro_length` /
  `loop_length`, read off `gme_info_t`). `VGMPlayer` maps libvgm's
  `loopStart`/`loopEnd` into those field names rather than inventing a schema,
  which is what lets one generic base method and one component read a single
  shape.

**TODO — `restartAtEndPending` is a half-landed mechanism.** The base honors it
in `processAudio` (only when the position reaches the duration), but no engine
currently leaves it set: `VGMPlayer`/`MDXPlayer`/`MIDIPlayer` all clear it in
`setLooping` (native/JS-wrap looping would fight the late `seekMs(0)`), and
`GMEPlayer` restarts the track itself in its `playIndefinitely` block, making
it partly redundant. Either wire it to a player that actually needs the
"finish the song, then restart" behavior, or drop it from the base until one
does. "Who consumes this?" is a fair review question and "nobody yet" is a
weak answer.

### Repeat One test matrix

Every permutation below must be jump-free (head continuous at the toggle
moment) and must not truncate the audio arc. Reference numbers are for
`catalog/arcade-capcom/Ghosts'N_Goblins_(Arcade)/16 Hurry Up!.vgz` — A = 342,
B = 800, band = [1142, 1942), two-pass duration = 6442, libvgm fade = 4 s +
0.5 s silence. Toggle positions: **pre** = abs ≤ A+B (lead-in/first pass),
**band** = fold region while looping, **tail** = abs > A+2B (fade running).

| # | Transition | Toggled at | Expected | Verified |
| - | ---------- | ---------- | -------- | -------- |
| 1 | Off→All | any | No-op for a single track: count and head untouched | ✓ tail |
| 2 | All→Off | any | Same code path as #1 | via #1 |
| 3 | Off→One | pre | Fold takes over at the next band entry; no jump | ✓ |
| 4 | Off→One | tail | Fade already running: audio finishes it and ends; capture rides the head on the tail (no fold-back) | ✓ |
| 5 | All→One | tail | Same code path as #4 | via #4 |
| 6 | One→Off/One→All | pre, curLoop < 2 | Count re-derived `max(2, curLoop+1)`; continuous; plays out pass + fade | ✓ curLoop 3 |
| 7 | One→Off/One→All | deep, curLoop ≥ 2 | `durationExtended`: pass finishes, full fade + silence, ends at extended abs; display lands at 100 % (two-pass duration) | ✓ curLoop 9 → 12843 |
| 8 | Repeat One from start | — | Head cycles in band across deep loops (abs 67541 → disp 1941 over 83 loops) | ✓ |
| 9 | Repeat off from start | — | Head live through intro + 2 passes, then tail from bandEnd to 100 % | ✓ |

Cross-cutting checks (all with Skip Silence 0 *and* None — the end detector is
only armed when `silenceDuration >= 0`, and both arms must end the song):

- Indefinite Playback on/off mirrors #3–#7 through the `setParameter` path
  (`syncFadeTailCapture` + `applyLoopCount(wasLooping)` are shared).
- Seek during a captured tail drops `fadeTailStartMs` (backward seek also
  cancels libvgm's fade); a seek backward after #7 leaves `durationExtended`
  set — benign, cleared on next load, engine still ends the song.
- Song end/advance: engine ends (render 0) under looping/#4/#7; sequencer
  advances and the next entry starts with fresh state.
- Engine keeps looping through the fade (`curLoop` increments); a short loop
  plays several iterations inside the 4 s fade (Hurry Up! ≈ 5), a long loop
  gets cut mid-iteration (`03 Survival.vgz`). Files with no loop region
  (`07 Easy Holiday.vgz`) end after a single pass even with indef on.

### VGM (libvgm) — the working baseline

- Native loop count: repeat-on = `_lvgm_set_loop_count(ctx, 0)` (0 = forever);
  repeat-off = `max(2, curLoop+1)` so the current pass finishes and libvgm fades
  at the next boundary — but only when actually *leaving* a looping state
  (`applyLoopCount(wasLooping)`). The engine keeps looping through the fade
  (curLoop keeps incrementing; a short loop plays several iterations inside the
  fade), so re-deriving the count on a no-op transition (e.g. the Off→All
  repeat toggle mid-tail) moves the configured fade start past the fade that is
  already running and the head folds back into the band. `setLooping` clears the
  base `restartAtEndPending`
  (libvgm loops natively; the base late-repeat `seekMs(0)` would fight it).
- Leaving repeat one after more than the default loop count sets
  `durationExtended`: the position is already past the load-time duration, so
  the base end detector (re-armed now that looping is off) would end the song
  instantly, before the re-scheduled fade starts. `isPlayingIndefinitely()`
  covers the flag so the current pass, the fade, and the trailing silence play
  out and the engine's own end (render 0) ends the song. The playlist clock is
  untouched — the display tail runs from the band end for exactly fade +
  silence, landing at the two-pass duration (= 100%) when the song ends.
- The display mapping in `VGMPlayer.getDisplayPositionMs`: phase
  `(abs - A) mod B` mapped as `bandStart + phase`; before the first body
  (`abs <= A+B`) show the real lead-in; with repeat off and `abs >= fadeStart`
  (from `_lvgm_get_fade_start_ms`), run the fade tail `bandEnd + (abs -
  fadeStart)`. Using the **same** mapping while looping and leaving is what
  makes the toggle jump-free. The display is NOT a pure function of the
  absolute position: `fadeTailStartMs` is captured at enable time when looping
  is switched on mid-fade (the loop count change makes the fade-start getter
  meaningless), and rides the tail until the song ends/seek/loadData clears
  it.
- New wrapper exports (`libvgm-wrapper.cpp` + `build-chip-core.js`):
  `_lvgm_get_cur_loop` (`GetCurLoop`) and `_lvgm_get_fade_start_ms`
  (`GetTotalPlayTicks(loopCount)`).
  **A third export, `_lvgm_get_playlist_position_ms` (`GetCurTime(0)`), was
  tried and removed 2026-10-07.** The idea was to let the engine report the
  folded position and have the head follow it. It lost twice: `GetCurTime(0)`
  reports the phase **from A**, so within the first body it sits at I0 rather
  than the highlighted band (that mismatch made the head loop in the wrong
  place), and re-anchoring it in JS is exactly what `getDisplayPositionMs`
  already does from `getPositionMs`. So the wrapper function was dead --
  defined, kept alive, called by nothing but one devtools snapshot field --
  and shipping it unreferenced in the PR was worse than deleting it. Keep this
  in mind before re-adding an engine-side position getter: the band math won.
- Verified via the t3 preview + `window.__cpDev`: the full test matrix above is
  green on the current build (Hurry Up!.vgz), the song ends/advances normally
  in every case, and the next context entry starts with fresh state. Caveats:
  fade is libvgm's default 4 s + 0.5 s silence (could shorten on exit); the
  "Indefinite Playback" setting is left as-is (internally repeat-on and it both
  map to loop count 0).

### MDX (mdxmini) — native loop with an exact region

- **Native loop.** mdxmini already loops the song's built-in infinite loop
  (a per-track backward jump executed on `MDX_DATA_END`) and `mdx_set_max_loop`
  caps how many times it plays before fading; **0 = forever**. So MDX has the
  same lever as libvgm with no wrapper to write. `MDXPlayer` now defaults to
  **two passes** (`DEFAULT_LOOP_COUNT = 2`) — the library default is three, but
  two matches libvgm and the app's `getLoopBandMs` model, so MDX reuses the
  generic band/fold.
- **Exact region, no guessing.** The parser records the engine's `elapsed_time`
  when the song as a whole completes its 1st and 2nd loop (min
  `infinite_loop_times` across tracks still playing). New getters
  `mdx_get_loop_start_ms` / `mdx_get_loop_length_ms` expose intro/loop in ms
  (valid only immediately after `mdx_get_length`, which is what runs the parse
  and then resets playback state). `_readLoopRegion` reads them once at load and
  maps them onto `metadata.intro_length`/`loop_length`, exactly as
  `VGMPlayer` maps libvgm. An earlier idea — deriving the region from
  `get_length(k)` differences plus a fade estimate — was abandoned: the fade
  length depends on the end tempo, so the intro would be off by many seconds.
- **Player.** `MDXPlayer` mirrors `VGMPlayer`: `setLooping` drives
  `_mdx_set_max_loop` (0 while repeating, else `max(2, curLoop+1)` when actually
  leaving so the current pass finishes and the engine fades), `getDisplayPositionMs`
  folds the head into the band and runs the fade tail on exit, and
  `isPlayingIndefinitely()` covers `durationExtended`. Feature-detected: a core
  without the loop getters still loops natively (`_mdx_set_max_loop` is an
  upstream export) but shows the blind-loop UI instead of a band.
- **Two engine bugs this surfaced (both fixed in `mdxmini/`, overlay-only).**
  (1) The fade end only returned `FALSE` without latching, so `master_volume`
  kept decrementing past 0; a seek that advanced frames into/through a fade then
  drove it negative and the `== 0` end test never fired again — the song looped
  forever. Now the fade end latches `all_track_finished` and reinit clears
  `fade_out`. (2) `position_ms` accumulated `frame_microsec / 1000`, discarding
  up to a third of each frame; seeks therefore overshot by seconds and raced the
  engine past loop boundaries, starting the fade early. A `position_us`
  microsecond accumulator makes seeks (and the display) frame-accurate.
- Verified via `window.__cpDev` on `catalog/mdx/G2MST6.MDX` (A = 34 603,
  B = 34 603, band = [69 206, 103 809], two-pass duration = 107 000): boundary
  crossings keep the engine's loop counter incrementing with `fade_out` 0 (no
  stop/reload), the head folds in the band, enable during the lead-in and
  disable at depth are both jump-free, a deep leave fades and ends/advances, and
  the leave-then-seek sequence that used to hang now ends.

### Per-format loop capability (what "loop the intended region" means for each)

- **libvgm (VGM/VGZ/GYM/S98/DRO):** native region + loop count — the baseline.
- **GME (NSF/NSFE/SPC/GBS/AY/…):** no loop region in practice for this catalog:
  NSF has no loop field, the vendored NSFE parser ignores the NSFe `loop`
  chunk, and the SPCs are `[n]` (non-looping) rips — probed via chip-core in
  the live app, `intro_length`/`loop_length` stay -1. The driver loops
  internally, so Repeat One never restarts: the track just keeps rendering
  past `play_length` (restarting there would cut a seamless loop with a hard
  restart; `restartTrack()` is only for `track_ended` one-shots). Blind-loop
  UI: indefinite with no band, once past the track length, parks the slider
  head at the end (it rides the first pass normally), lets the elapsed time
  climb unbounded, and labels the duration "Looping". The predicate is player
  policy (`Player.isBlindLoop`); AppFooter/TimeSlider only render it. The
  past-the-end term is the scoping: an engine that keeps its own clock
  bounded -- a known band, a native loop (XMP), a JS wrap (MIDI with a
  region), or a stop + reload (MIDI without one, V2M) -- never dwells there,
  while SID free-runs past its listed length and so *can* dwell until its
  tail detector restarts it. The exception is a genuine
  one-shot: it restarts in-buffer, which resets `getPositionMs()`, so the head
  *and* the elapsed label drop back to zero each cycle rather than
  accumulating. Drivers that loop internally never take that path, so for them
  the label really does climb. Toggling repeat off
   restores the clamped head/duration (and the pending JS fade ends the song,
   since the position is already past the length). Repeat-off plays to the
   natural end + JS fade. Real per-track regions would need GME-side work
   (roadmap) — NSFe `loop` chunk support and/or a native loop API.
- **N64/USF:** whole-track model like GME, loop inferred from the `fade` tag
  (`song_loops`) + the indefinite flag. Under Repeat One the engine flag is
  OR'd from Repeat One and the setting (so looping tracks free-run past
  `durationMs` instead of fading and reloading per cycle), and a SID-style
  `detectSongEnd` tail restart (default on) re-runs one-shots whose content has
  ended in-buffer via seek-to-0. Non-looping tracks (`fade` explicitly 0) still
  end via the engine and reload per cycle.
- **SID:** no loop API at all; end only via client-side HVSC lengths. Under
  Repeat One the driver free-runs past the HVSC length and a `detectSongEnd`
  toggle (default on) restarts tails that go quiet *and* static for a full
  `END_WINDOW_SEC` window, tripping from one window before the HVSC length (the listed end is
  approximate; anything earlier stays gated so quiet intros can't false-fire)
  (probed: bodies 0.03-0.16 mean-abs, tails ≤0.0012) — pure JS, no wasm change.
- **MIDI:** CC 102/103 region (N64; start left implicit at 0, count ignored)
  and CC 110/111 (HMI Descent loop track), honored for every file whose
  markers exist — not just the SoundFont MIDI path. Parsed at load time in
  `midi-helpers` (`findLoopRange` + two-pass `getLoopedEvents`, same shape as
  a two-pass libvgm track), so no catalog work was needed. Repeat One wraps
  the JS event loop to the second-pass start with ringing-note cutoff and
  silent state restore (no panic); the head folds into the band via the
  shared `getLoopBandMs`, with no fade tail (past the band the song ends).
  Lone CC111 (RPG Maker: loop to song end) expands the same way. Verified on
  the catalog set (Mario Kart 64 *03 - 3 Raceways, Wario Stadium* [0, 72062],
  Descent Game01 [100, 200194]) via
  `dev/test-midi-loops.js` (in `dev/run-tests.sh`), which also *builds* minimal
  SMFs for the edge shapes so they do not need a catalog file. **Format 2 (async
  patterns, no shared timeline) gets no band at all** — the expansion is skipped
  there, and the "end of the first iteration" latch used to fall through to the
  end of the song, so the UI would highlight the whole file as the loop region;
  `getLoopedEvents` now reports a band only when it expanded the loop, which is
  what "no band" means to the player (`midi-helpers.js`, `expandLoop`). Two
  DEV-region tripwires watch for the case: `scripts/build-music.js` counts
  format-2 SMFs in the run summary (this catalog has 7, all Day of the Tentacle
  / RPG Maker, none carrying markers) and `midi-helpers.js` warns on playback. The piano roll parses
  the same expanded list (`MIDIFile.getPlaybackEvents`, shared with the
  audio engine), so it stays populated through the second pass and across
  Repeat-One wraps instead of ending at the first loop point. Post-loop
  content with no notes (controller cleanup, converter track padding like
  Gyrocopter's END_OF_TRACK a full loop past the loop end) attaches at the
  loop end instead of inflating the duration with dead air; a composed
  ending with notes keeps its exact timing.
- **MDX:** native infinite loop + exact region (see the MDX subsection above);
  seamless, with a slider band.
- **XMP (MOD/XM/IT/S3M):** native loop count (`xmp_play_buffer`'s loop
  param: 0 = forever, N = stop after N scan-end passes). Repeat One sets 0,
  repeat-off restores 1 (today's single pass); leaving deep sets
  `max(1, curLoop+1)` from the engine's `loop_count` so the current pass
  finishes, like VGM's `applyLoopCount`. The engine clock is positional, so
  it wraps into the loop on its own — no fold, no blind parking; the head
  truthfully sweeps intro + loop and jumps back per pass. The band is
  *learned*, not probed: every order's first-visit frame time is recorded
  (`learnLoopFromOrder`, ~25 lines, no new exports/rebuild/parser), and the
  first backward order jump resolves the loop start exactly, tempo changes
  included. It marks the repeating span [loopStart, trackEnd) from the first
  loop end on (single-pass duration never rescales; learning also fires the
  one `playerStateUpdate` that re-renders the footer, since the band appears
  mid-song); any seek freezes learning for the song only in the one case
  that matters (a backward jump onto an order the linear flow never
  visited, whose true start is unknowable — that visit is skipped so a
  loop-end time can never become a loop start), while first-visit times are
  absolute and survive seeks, so seeking then looping normally still learns
  correctly; a from-the-start loop learns nothing (full-span highlight says
  nothing), and files without a backward jump keep today's UI.
  **Known limitation, and the obvious future polish:** learning needs the
  engine's *first* backward order jump, so the band cannot exist during the
  first pass — on TECHTRIS that is ~80s in, which makes the feature look
  broken for as long as a listener waits. Confirmed in-app 2026-10-03 by
  driving the real UI: jump `11->1`, `intro_length` 3940, band
  `[3940, 80700]`, rendered as `Slider-loop` from 4.9% to 100% of the slider.
  **Polish: resolve the loop region at load instead of learning it.** libxmp
  knows the module's restart order, so a new wrapper export (the restart
  position/order) would let the first pass resolve the loop start exactly —
  the band would exist from the first frame and `learnLoopFromOrder` would
  degrade to a fallback for files the export cannot describe. This needs a
  wrapper export plus a `build-chip-core.js` `EXPORTED_FUNCTIONS` entry, so it
  is new capability rather than a fix; it was deliberately left out of the
  sub-tunes PR to keep that diff reviewable.
  Catalog loop census: only TECHTRIS.MOD (11→1), 01-Title.xm (13→1), Bgm01.xm
  (43→10) and zuma.it (23→0) loop (single-outer-loop each; IT effects are
  numeric, B=2 — an ASCII decode misses them); everything else plays straight
  through. Verified in-app via `__cpDev` on Bgm01 (native wrap past the
  scan end, leave-deep arms count 3 at depth 2) and TECHTRIS (band
  [3940, 80700] learned live), plus a fake-core harness
  (`dev/test-xmp-loops.js`, in `dev/run-tests.sh`).
- **V2M:** no loop points in the format (fixed-length synth render); stays
  stop + reload, the lone tier-3 engine.

**Where Repeat One actually works today (audit, 2026-09).** GME, VGM, SID, N64,
MDX, MIDI, and XMP are seamless. Everything else falls through the engine's own end -> `stop()` ->
`Sequencer.advanceSong` (which leaves `currIdx` alone under `REPEAT_ONE`) ->
re-fetch + reload, i.e. a stop, a network fetch, a decode gap, and a jump to
0:00. This is the behavior prod has today, so the *floor* for a format we have
not converted is "no worse than prod" — but the user-facing promise of the
feature only holds for the engines above.

| Player | Repeat One mechanism | Seamless? |
| ------ | -------------------- | --------- |
| `GMEPlayer` | in-buffer `restartTrack()` | yes |
| `VGMPlayer` | native libvgm loop count | yes |
| `SIDPlayer` | free-run past HVSC length + `detectSongEnd` tail restart | yes |
| `N64Player` | engine indefinite flag OR'd from Repeat One + `detectSongEnd` tail restart | yes |
| `MDXPlayer` | native `mdx_set_max_loop(0)` + exact band | yes |
| `MIDIPlayer` | JS event-loop wrap to second-pass start + shared band fold | yes |
| `XMPPlayer` | native libxmp loop count (0 = forever); positional clock wraps on its own, no band | yes |
| `V2MPlayer` | engine end -> stop -> reload | no |

The fallback ladder to apply per engine, in order: **native region loop ->
in-buffer restart -> stop + reload**. Tier 1 is done (VGM, MDX, XMP-native
loop count), tier 2 is done
(GME, N64, SID-tail-restart). Tier 3 is the stop + reload, which V2M is the last
player still on, and it also
re-fetches the whole file per cycle — for a sub-tune that is the entire
multi-song NSF, every loop.

### Dev tooling

`window.__cpDev` (dev-only; `dev/shims/devtools.js`, staged as the untracked
`src/chip-player-devtools.js` by `apply.sh` and injected via the dev webpack
entry; deleted by `remove.sh`): `snapshot()`, `setRepeat()`, `cycleRepeat()`,
`seek()`, `play()`/`pause()`, `click(selectorOrText)` (real DOM click on a UI
control), `setParam(id, value)` (through `App.handleParamChange`),
`waitUntil(fn, timeoutMs)` (poll the snapshot until a condition holds),
`startRecord()`/`stopRecord()` (non-blocking), and `runTimeline(events, opts)`
for timed/conditional scripts. The snapshot exposes player state plus VGM
looping fields (`curLoop`, `fadeStartMs`, `fadeTailStartMs`). Use it from the
t3 preview to script enable/disable
timing and spy on player state instead of listening.

The Settings tab has a dev-only **End Detector (dev)** section at the bottom
(all in `DEV-BEGIN/DEV-END` regions): live sliders for the tail detector's
thresholds (`quietMean`, `staticRange`, `windowSec`, `tapStep`) plus a
position/trip/window-means readout. The detector itself is `EndDetector`
(`src/players/EndDetector.js`), a shared module SID and N64 instantiate as
`this.endDetector`; GME gets the equivalent inside its engine, so it uses
none. Values layer as module defaults <- the importing player's constructor
`tuning` override (unspecified fields fall back to the default) <- the dev
store `setTuning`, and `getTuning()` is the one place they are merged, so
`getState` reports the values actually in force. Sliders apply instantly;
Reset clears back to the player/default values. The panel appears only when
the active player exposes a detector (`player.endDetector`, i.e. a player
that uses the module); with none it renders nothing (a `console.debug` only).

Testing gotchas learned the hard way:

- `preview_evaluate` fails intermittently **at the transport level** — the call
  reports failure without reaching the page, and the same expression then
  succeeds unchanged. Always retry, and read page state (`__cpRec._run`,
  `__cpRec.result()`) to find out whether a "failed" call actually landed.
  Correlates with calling it right after `preview_navigate`, while the app is
  still fetching. See `dev/record/FINDINGS.md`.
- Script a whole scenario (play → wait → toggle → record) inside ONE
  `evaluate` call; the preview host drops tabs between calls and evaluate
  times out at 15 s, so never rely on state surviving across calls for a
  6-second test track.
- **An assertion passing says nothing about the file that gets published.** The
  clip recorder's page-side verdict is green for the app's behaviour, but the
  published mp4 is produced by ffmpeg afterwards — and a mis-detected sync mark
  shipped clips 3.5 s out of sync with their own audio with every verdict green
  (the mark was white; the capture *starts* on a blank page; the detector locked
  onto the page load). Any pipeline stage that can silently produce a wrong file
  needs its own post-condition: here the capture-size assertion, the first-frame
  check on the output, and hue-based mark detection. Generalises past the
  recorder: verify the artefact, not just the state.
- The tab can serve a stale bundle after edits: force `?r=N`, and confirm the
  served build with `curl mms-1:8080/static/js/bundle.js | grep -c <newSymbol>`.
- Parameter toggles made right after `playSong`/`playContext` are overwritten
  by `resolveParamValues` when the async load finishes — pin the setting first
  (`userContext.settings['vgm.indefinitePlayback'] = true`) or apply it after
  the load's `playerStateUpdate`.
- The preview throttles background timers (~½ speed), so seek near a boundary
  to observe short windows.
- **Prefer driving the real UI over devtools internals** when the question is
  what a listener sees (the loop band, the footer, the repeat button). Two
  silent traps, both of which look like a working call: `__cpDev.setRepeat`
  takes the *numeric* `REPEAT_ONE` (2), so `setRepeat('one')` no-ops without
  error; and a loose `text=` locator can click the wrong row (a `text=TECHTRIS.MOD`
  click landed on `THALAMUS.MOD`, and every order-stream conclusion drawn from
  it was void). Click rows by `href` and verify `sequencer.currSongPath` before
  trusting player state. Always assert the effect (`player.looping`,
  `sequencer.repeat`) rather than assuming the call worked.
- Players are `auto-bind`ed, so instrumenting a prototype method is a no-op: the
  instance carries its own bound copy and shadows the prototype. A patched
  `learnLoopFromOrder` therefore looks "never called" while running fine. Sample
  player fields (`_lastPos`, `_orderFirstSeen`) instead of patching.

### Pitfalls that cost real time on 2026-10-03 (read before engine work)

The recurring theme was **asserting engine/version behaviour from reading source
instead of measuring it**, and three separate conclusions were overturned that
way. Cheap to state, expensive to learn:

- **Measure engine behaviour; do not derive it.** The playback-speed desync was
  "obvious" from `Tick2Second` vs `Sample2Second` — and the opposite was true in
  the other tree. Prod at 2x scales position 1.98x, ours does not, with a
  byte-identical getter. Reasoning from source produced three wrong answers in a
  row here; measuring took minutes and settled each one.
- **Never reason about prod (or anyone's build) from our tree.** Our own note
  asserted prod used this repo's vendored libvgm, on a tie-breaker that did not
  hold. It does not. We also proved master *cannot* be built against our vendored
  trees (`_gme_disable_echo`, `_xmp_seek_time_frame` are listed but absent from
  them), so "it works locally" is not evidence about a reviewer's build.
- **Make the harness non-destructive BEFORE running a negative control.** This is
  the expensive one. A negative control that ran the *pre-fix* builder, after the
  new test had dropped a column on the real `server/catalog.db`, silently reset
  `subtune_count` for all 6788 rows. `dev/test-build.js` now snapshots and
  restores the database. If a test touches live state, add the guard in the same
  commit as the test — not after it has cost you a rebuild.
- **Check the premise before defending a design.** Hours went into restoring an
  at-load XMP band that never existed: every version of that code set the band on
  a backward order jump, and it is not persisted. `git log -S` over the real
  history settles "did this ever work?" in one command.
- **A wrong band is worse than a late one.** Two XMP shortcuts were rejected on
  this basis (see the `xxo_info` note): both would have produced a plausible but
  incorrect region. Prefer nothing over something false.
- **Re-verify claims inherited from notes.** "mdxmini `position_us` overflow is
  unreachable" was wrong — it wraps at 35.8 min and a review bot found it
  independently.

## Conventions & cautions

- Comment style: explain *why*, in Matt's voice; avoid over-commenting.
- SQL: match the existing formatting (indentation, trailing comments, prepared
  statement style). Add prepared statements to `dbStatements`, destructure in
  `server/index.js`.
- Don't add comments the codebase wouldn't have; don't reformat unrelated code.
- Templates literals: **do not put backticks inside SQL template strings**
  (broke `build-music.js` twice via SQL comments using backticks).
- Verify with `curl` against `mms-1:8080/api/...` (either name works from the
  shell; `mms-1` is the one that also works in the preview tab).
- Dev shims stage **untracked, gitignored** modules rather than patching tracked
  files. `dev/apply.sh` writes `server/middleware/auth.dev.js`,
  `src/chip-player-devtools.js`, `src/chip-player-record.js`,
  `src/chip-core.js`, `src/config/firebaseConfig.js`
  and `server/.env.local`; `server/index.js` loads the auth module via
  `DEV_AUTH_MODULE`, and the dev webpack config prepends the devtools entry.
  `dev/remove.sh` deletes them. No `*.dev-backup`, no `--revert` for these. The
  remaining in-place patch is `dev/patch-server.js` (skia-canvas), which is
  reversible and preserved by `remove.sh --revert`. Before a PR, run
  `./dev/remove.sh` and double-check `git diff` / `git status`.
- The client uses React 16, react-router-dom v5, react-virtualized, lodash,
  auto-bind. Match those.
