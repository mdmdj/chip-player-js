# PR communication page — design and plan

A static web page with short screen recordings that illustrate
`master..feature/subtunes-as-first-class` for the upstream maintainer, plus code
snippets for the parts video cannot show.

Everything in `dev/record/**` is inside `dev/**`, which `dev/promote-paths.txt`
already excludes, so **none of this reaches the PR**. The rendered site is a
build artifact and is gitignored.

Two documents:

- **this file** — scope, decisions, how the recorder works, the repository
  layout, how to record one clip, the clip inventory, the page structure, and the
  milestone table in §10.
- **`FINDINGS.md`** — the measured gotchas, in the order they were found, with a
  table at the top marking each section current or historical. Read it before
  changing the recorder: every item there cost a take, and several are
  counter-intuitive — `recordVideo.size` *pads* the frame, a white sync mark is
  indistinguishable from the page load the capture starts on (which silently
  desynced published clips), `-fps_mode passthrough` is mandatory, and ffmpeg's
  default CFR output discarded 55 of 60 real frames.

Quick start:

```sh
node dev/record/shoot.mjs --clip loop-band              # record one clip
node dev/record/shoot.mjs --clip a --clip b            # record a few, one invocation
node dev/record/shoot.mjs --all                         # re-record everything (~3.5 min)
./dev/record/plan.sh <clip-id>        # the scenario as data: steps + assertions
./dev/record/build-site.mjs           # registry + proofs -> site/
./dev/record/serve.sh                 # look at site/ in a browser (express; needs Range)
```

`shoot.mjs` takes **named** args, so which clips you are re-recording is visible on
the command line — which is the whole point of a selective re-shoot:

| invocation | does |
| --- | --- |
| `--clip <id>` | that one clip. Repeatable; order is honoured |
| `--all` | every clip in the registry |
| `--keep` | keep the raw webm + the take directory (for diagnosing a capture) |
| `--headed` | show the browser |

There is **no default to all**: no clip ids at all is an error, because a bare
`shoot.mjs` that quietly recorded 14 clips would be a 3.5-minute surprise. A bad id
is refused *before* any take runs, and every error lists the valid ids — a typo in
the last position should not cost the 15 s take that preceded it. `--all` combined
with `--clip` is rejected rather than silently resolved, and duplicate ids are
collapsed.

A failed clip does not stop the batch. Each take gets a fresh browser context, so
one red verdict leaves nothing behind for the next clip to trip over, and the run
ends with `shoot: 13/14 passed` plus the failed ids and exit 1.

Both halves are **selective**, because in the polish phase nearly every change
touches one clip or one sentence rather than all of them:

| you changed | command | cost |
| --- | --- | --- |
| prose in `site.mjs`, a `watch` bullet, `site.css` | `node dev/record/build-site.mjs` | ~0.1 s |
| one clip's scenario, or re-recorded one clip | `node dev/record/shoot.mjs --clip <id>` then `build-site.mjs` | ~15 s + ~0.1 s |
| two or three clips | `node dev/record/shoot.mjs --clip a --clip b` then `build-site.mjs` | ~15 s each |
| the app, so any verdict could have moved | `node dev/record/shoot.mjs --all` then `build-site.mjs` | ~3.5 min |
| nothing (checking the page is current) | `node dev/record/build-site.mjs` | ~0.1 s, says so |

The re-record loop's cost is dominated by the take itself (~15 s), so the lever is
recording fewer clips rather than recording them faster — hence naming them.

Recording was always per-clip (each take starts its own browser, so takes are
independent). The page build was **not**: it re-derived both
video-derived facts for all 14 clips on every run — an `ffprobe` per clip and a
poster frame per clip, 1.6 s and 4.2 s — so a one-word prose fix cost 5.5 s, 95 %
of it spent re-deriving posters that could not have changed. Both are now cached
on the clip's identity, which makes a prose-only rebuild a 59× no-op.

Cache rules, since a stale poster is the failure mode worth being careful about:

- Keyed on **size + mtime + the poster's seek time**. mtime matters on its own:
  re-recording can produce a byte-identical mp4 (the encoder is deterministic), and
  a size-only key would keep serving the previous take's poster. Editing a
  scenario's marks re-frames its poster rather than leaving the old frame.
- **Byte-identical output.** A cached poster is exactly the one a re-encode would
  produce, and dimensions come from the same cached `ffprobe`. Verified: warm build
  over unchanged inputs reproduces `index.html` and all 14 jpgs byte-for-byte
  against a cold build with the cache and posters deleted.
- A **deleted** poster is re-framed even under `--text-only`. The flags suppress
  avoidable work; a missing poster is damage, not a cost decision, and
  `--text-only` must not bless a page of broken images.
- A **re-recorded** clip's dimensions are not inherited from the old file, so a
  deferred clip renders without a reserved box rather than with the previous
  take's. A scenario can change `viewport` (`loop-band` is 900x840), so the old
  number can be wrong. The clip is named in the report either way.

The build reports what it actually did, so "nothing to do" is visible rather than
assumed:

```
site: site/index.html — 14 clip(s) published (6 main, 8 per-format), 7 snippet(s)
media: 0 clip(s) re-probed + re-framed, 14 reused from cache
```

Flags, for when you would rather force the behaviour than trust the cache:

```sh
node dev/record/build-site.mjs --text-only        # never run ffmpeg/ffprobe
node dev/record/build-site.mjs --clips loop-band  # derive media facts for these only
```

Requires `playwright` installed without touching `package.json` (see the npm trap
in AGENTS.md §Dev environment — install it in one command with webpack pinned,
and check `better-sqlite3`'s ABI afterwards):

```sh
npm i --no-save --no-package-lock playwright@1.63.0 webpack@5.106.0
```

## Where the pipeline stands

For a handoff, the state is:

- **Pipeline proven and batch-proven.** `shoot.mjs` records, muxes, verifies and
  publishes one clip with audio, in sync, verdict-gated. All 14 registered clips
  are recorded, green and on the page (6 main, 8 per-format); `--all` re-records
  the registry in one invocation, and a failed clip does not stop the rest.
- **Not recorded, deliberately:** any A/B or master comparison. The page is
  feature-only and each clip's "Before:" line describes master instead.

Batch re-shoot, for when a change to the *app* may have moved any clip's verdict.
The ids come from the registry rather than a hand-copied list, which goes stale
silently and then re-records clips that were fine while missing new ones:

```sh
node dev/record/shoot.mjs --all
node dev/record/build-site.mjs   # re-frames only the clips whose mp4 changed
```

For a change you know is confined, name the clips — the common case in the polish
phase, and ~15 s per clip rather than ~3.5 min:

```sh
node dev/record/shoot.mjs --clip loop-band --clip repeat-toggle-smooth
node dev/record/build-site.mjs
```

`--clip` keeps the registry list and the command line in sync, and it means the
run shows which takes it did. A red verdict leaves the remaining takes alone
(fresh browser context per clip), so the summary is the only thing to read:
`shoot: 13/14 passed`.

### Curation pass (2026-10-05): 18 clips → 14, all green

The three red clips are resolved and four were removed on purpose. Both halves of
that are worth reading before adding a clip, because the failures were not
pipeline faults — the page was publishing **green verdicts over clips that never
did the thing they claimed.**

**Merged away** (each was a duplicate of a clip that already carried the claim):

| removed | folded into | why |
| --- | --- | --- |
| `subtune-is-a-song` | `songfolder` | same navigation, said less; its "no footer widget / no Tune N of M" claim is now a `watch` bullet and part of the `before` line |
| `labels` | `songfolder` | real labels are a parser detail, not a user-visible change worth 5 s of page |
| `share-link` | `songfolder` | not new — the format is unchanged, `/?play=…&subtune=N` either way — so it is a note, not a video |
| `show-loop-area` | `loop-band` | the band clip already shows the slider; the toggle belongs there with the band in view |

**Fixed, after measuring rather than reading:**

| clip | was | now |
| --- | --- | --- |
| `blind-loop` | `clip_5b.nsf`, a ~1.3 s test tone that *ends*, so position sawtoothed and the parked head never appeared | `nsfe/Akumajou Densetsu (VRC6).nsfe` sub-tune 3 — GME reports `play_length` 101000 ms, so a seek to `play_length − 1000` puts the parked head and the `Looping` label on screen. Audio verified at full level after the seek (RMS 0.099 vs 0.093), so it is the music and not a silent tail |
| `gme-looping-driver` | same tone; `no-restart` compared only first vs last sample, so it **passed on a sawtooth** | same fixture; monotonic no-reset over the whole trace, which can fail on the case it was written for |
| `sid-tail-restart` | `positionMs > 30000` on a 5 s take — and the real listed length is 350 000 ms, so the number meant nothing | `sid/Bionic_Commando.sid` sub-tune 2, played from 0, 13 s take: HVSC genuinely lists it at `0:03`, so the trip gate is 0 and the restart lands at ~10 s. Asserts the detector is armed, the position free-ran past the length, a restart happened in place, and the song ref never changed |

Registry bugs found and fixed by the batch run — `until` deadlocks, missing
preloads, invented fixture names, a song-folder row that navigates instead of
playing, and the absent `navigate` step — are written up in FINDINGS.md, as is the
class of failure that produced three green-but-wrong clips: **a selector that
matches nothing cannot fail an assertion.**

## 1. Scope

In scope — what the PR changes that a listener can see or hear:

- **Sub-songs as first-class songs** (song folders, sub-tune rows, per-sub-tune
  favorites/search/top-charts/share links/shuffle, sequencer-owned navigation).
- **Repeat One across formats** (loop band on the slider, jump-free toggling,
  per-engine mechanisms, blind-loop UI).
- The small visible fixes riding along (download filenames, visited-link colour,
  link-copy fallback).

Out of scope: dev overlay, `AGENTS.md`, engine build scripts/provenance stamping,
the real-wasm bring-up, and anything in `D` of the inventory below that is
data-model only.

## 2. Decisions (locked)

| # | Decision |
| - | -------- |
| 1 | The page is **not** in the PR. It is a self-contained directory the maintainer uploads to a web server and links from the PR description. All URLs relative; works from any sub-path. |
| 2 | **Every clip has audio.** Readable and understandable beats file size. |
| 3 | One format: **mp4, h264 + aac**, audio muxed (never a separate audio file). |
| 4 | **Feature-only clips.** No master build, no A/B recording. Each clip's on-page text states what master did instead. |
| 5 | **No text rendered inside the video.** Explanation lives on the page beside the clip. |
| 6 | Each clip carries a **collapsible proof block**: the scenario's verdict, key engine numbers, and the state trace. |
| 7 | Clips are **portrait or square** (the page is two-column: video left, prose right). Exact aspect to be chosen by screenshotting the app at 1:1 and 4:5 (M1). |
| 8 | **The catalog is never reprocessed.** Fixtures are pinned by explicit path in the scenario registry; nothing in this flow runs `build-music`. |

## 3. Recording architecture (measured, not assumed)

Verified on 2026-10-05 against `http://mms-1:8080` (the Tailscale name — the
preview tab cannot reach `localhost:8080`).

| piece | what it is | measured |
| ----- | ---------- | -------- |
| video | **Playwright** `recordVideo`, viewport 900x720 at dsf 2, `size` set to exactly 900x720 | vp8/webm, 900x720, constant 25 fps, DPR-correct (hard glyph edges). Written straight to disk: no transfer cap, and the whole take runs in one node process so no tool-call latency. `size` must equal the viewport: unset only stays 1:1 while the frame fits inside 800x800 (past that the viewport is resampled), and the dsf product pads the frame — see FINDINGS.md. |
| (rejected) | the host tab recorder, `preview_recording_start` | h264 mp4 but **captured at 1x CSS px and upscaled 1.5x** (visibly soft vs a native render), variable frame rate declaring `1/1`, no quality option, and takes over 50 MiB are lost in transfer. Fine for previewing, not for publishing. |
| audio | in-page `MediaRecorder` fed from the app's own bus: `ChipPlayer.gainNode.connect(audioCtx.createMediaStreamDestination())` | 48 KB opus for 3 s, works with no sound device present (there is none: no `/proc/asound`, no pulse) |
| driver | `shoot.mjs` in node, against `window.__cpRec` | the scenario registry is data; the page runs it on its own timers and returns a verdict. Single clicks reach every row we need: song folders and sub-tune rows are `<a>` elements |
| mux | `ffmpeg`, `mux.sh` | `-c:v libx264 -crf 14 -preset slow -c:a aac -b:a 128k -movflags +faststart`, plus **`-fps_mode passthrough`** (mandatory: without it ffmpeg resamples to the stream's declared `r_frame_rate=1/1` and discards most real frames) and filter-based `trim`/`atrim` to the mark. The video **is** re-encoded, not copied — see §Quality. |
| bytes out | tiny loopback receiver, `upload-server.mjs` | the page cannot write to disk; a 12 s opus track is ~200 KB |

### Why not the `mdm-test-playable-0` approach

That project records `canvas.captureStream()` — valid because PixiJS paints the
whole game to one canvas. This app is React DOM: the `<TUNES>` rows, the footer,
the slider band are DOM nodes with no canvas behind them, and
`navigator.mediaDevices.getDisplayMedia` is `undefined` in the preview tab, so a
page-driven tab capture is impossible too. **The agent-side tab recorder is the
video source.** The audio-mirror idea is exactly right and ports unchanged.

The audio half is not a convenience. The host has no audio output device at all
(`/proc/asound` absent, no pulse, no `aplay`), and the preview tab does not expose
`navigator.mediaDevices`, so the app's sound exists only inside the Web Audio
graph — there is no system-level signal any recorder could tap. See
FINDINGS.md for the three measurements.

### Audio/video sync

The two recordings start independently, so they are trimmed to a common mark
rather than offset after the fact: `__cpRec.run()` paints one full-viewport white
frame *after* the song has loaded and *before* any step is armed, and records
`Date.now()` for it. `find-flash.sh` locates that frame in the video (it is the
only high-luma frame; app frames measure YAVG 44-47, the flash 235) and
`mux.sh` trims both streams to it with `trim`/`atrim`. Audio therefore needs no
offset at all — it starts at the flash — and the load is trimmed out of the
published clip for free.

Two details that cost a take each, both now handled: the detector must report the
**last** frame of the white run (the flash is 4-5 frames long, so trimming to its
first frame leaves white frames in the clip), and the trim must use filters
rather than `-ss` (`-ss` after the inputs trims the output twice; `-ss` before
them is keyframe-snapped, which is the desync the flash exists to remove).

## 4. Repository layout

```
dev/record/
  README.md                  this file
  scenarios.mjs            the registry: every clip, fixture, script, verdict
  scenarios.check.mjs      registry validator (wired into dev/run-tests.sh)
  build-site.mjs           registry + manifest -> site/ (the upload dir)
  upload-server.mjs        loopback receiver for in-page audio blobs
  mux.sh                   video.mp4 + audio.webm -> clip mp4 (h264/aac)
  site.mjs                 page copy/prose (kept out of build-site.mjs)
dev/shims/recorder.js      staged to src/chip-player-record.js by dev/apply.sh;
                           exposes window.__cpRec.run(clipId)
site/                      BUILD OUTPUT, gitignored, uploaded as-is
  index.html
  assets/style.css
  clips/<id>.mp4
  proof/<id>.json
  manifest.json
```

`src/chip-player-record.js` joins the other untracked, gitignored shims
(`chip-core.js`, `chip-player-devtools.js`, `config/firebaseConfig.js`), so the
working tree stays clean and `dev/remove.sh` deletes it like the rest.

### The shim's actual surface (`dev/shims/recorder.js` → `src/chip-player-record.js`)

Everything hangs off `window.__cpRec`. The scenario itself is **data**
(`scenarios.mjs`), not code in the page: `shoot.mjs` passes the selected
scenario's `steps`/`until`/`assert` into `run()`, so adding a clip never touches
the shim.

| member | what it does |
| --- | --- |
| `run(spec)` | start the take: trace, heartbeat, audio mirror, sync mark, gate on `until`, schedule `steps`. Returns immediately. |
| `result()` | the finished verdict, or `{ pending }` — which stays true for the whole of `finish()`, upload included (see FINDINGS.md). |
| `abort()` | drop a stuck run; safe to call between takes. |
| `finish(assertions)` | stop the trace, finalize + upload the audio, evaluate each assertion as a JS expression over `(s, tr)`, return the proof. |
| `pinDefaults(settings)` | neutralise app state before a take (tempo, repeat, theme, visualizer, `silenceDuration`). |
| `where()` / `snap()` | the state assertions read: `ref`, `path`, `positionMs`, `displayMs`, `durationMs`, `band`, `looping`, `indefinite`, `subtune`, plus libvgm's `curLoop`/`fadeStartMs`. |
| `waitForSong(ms)` | poll until the engine is actually moving; used by `preload`. |
| `preload({dir, name, subtune})` | click a fixture by exact name and rewind — get to the clip's starting state *before* the window opens. |
| `clickRow({dir, name, subtune})` | resolve a row via the listing API, then click the DOM anchor whose name matches **exactly**. Never fuzzy-matches (AGENTS.md: a loose `text=` click voided a round of conclusions). |
| `navigate(path)` | client-side route change for a scenario that must show two directories; see FINDINGS.md for why a plain `location.href` cannot be used. |
| `clickSelector(sel)` / `dblclick(sel)` | activate a control by selector or visible text. |
| `flash(ms, color)` | the green sync mark. |
| `audio.start()/stop()/upload()` | the gain-node mirror: `ChipPlayer.gainNode.connect(createMediaStreamDestination())`, recorded with `MediaRecorder`, POSTed to `upload-server.mjs`. |

Step kinds understood by `runStep()`: `open`, `nav`, `play`, `dbl`, `seek`,
`repeat`, `tempo`, `param`, `eval`, plus `label`. Each is wrapped in `fire()`,
so a step that throws is recorded as a mark and fails the take rather than
aborting it silently.

`snap()` is also what the trace sampler records. **When an assertion on
`tr.samples` needs a field, add it to the sampler** — an unsampled field reads as
`undefined` and fails for the wrong reason.

## 5. How a clip is recorded

**One command per clip: `node dev/record/shoot.mjs --clip <clip-id>`.** It is
deterministic and needs no agent in the loop, which is why it is the only step
that must not be improvised. It:

1. starts `upload-server.mjs` (the page cannot write to disk),
2. launches Playwright: viewport 900x720 at `deviceScaleFactor` 2,
   **`recordVideo.size` set to exactly 900x720** (see FINDINGS.md — unset only
   stays 1:1 below the 800px frame cap, and the dsf product pads the frame),
   `--autoplay-policy=no-user-gesture-required`,
3. navigates to the scenario's `browse` (+ `?r=N` to defeat the bundle cache) and
   waits for `.BrowseList-row` and `window.__cpRec`,
4. `__cpRec.pinDefaults(<settings>)`, settles ~700 ms, then `__cpRec.run(<spec>)`:
   the page loads the fixture *inside* the recorded window, paints the sync mark,
   arms the steps and drives them on its own timers,
5. closes the context, which flushes the video to disk,
6. asserts the capture is exactly 720x720 (framing regression check),
7. `dev/record/find-flash.sh <video>` → `dev/record/mux.sh <video> <audio> site/clips/<id>.mp4 "$flash" <audioStartToFlashMs>`,
   which trims both streams to the mark and writes `site/proof/<id>.json`.

The clip is published only if the page-side verdict passed — including the
built-in `expected-song-still-playing` guard. `build-site.mjs` refuses to include
a failed clip unless `ALLOW_FAILED=1`.

`plan.sh <id>` still prints the scenario as data (steps + assertions) for
inspection, but it is not the run path any more. To re-shoot, keep
`site/proof/<id>.json` from the last take and diff the new one against it before
replacing the clip.

The earlier loop — `preview_resize` → `preview_navigate` → `preview_recording_start`
→ `__cpRec.run` → `__cpRec.finish` → `preview_recording_stop` → `mux.sh` — is
**historical**. It needed eight tool calls inside the recording window, every one
of which risked the intermittent `preview_evaluate` transport failure, and the
host recorder lost takes over 50 MiB. The pieces it used (`pinDefaults`, `run`,
`finish`, the mark, the verdicts) are unchanged; only the driver moved.

A clip whose verdict failed — including the built-in
`expected-song-still-playing` guard — is **not** published; that is the whole
point of collecting verdicts. `build-site.mjs` will refuse to include a failed
clip unless `ALLOW_FAILED=1`.

The plan is also emitted to a file so a re-shoot is mechanical: keep
`site/proof/<id>.json` from the last take and diff the new one against it before
replacing the clip.

### Quality

Measured, and the reasoning is recorded so nobody "improves" it:

- **Resolution passes through untouched.** No `scale` filter anywhere; the frame
  is 720x720 in and 720x720 out, because Playwright captures it 1:1.
- **`-crf 14 -preset slow`.** crf 20/veryfast was visibly soft on the bitmap font;
  crf 12 measures the same as 14, so 14 is the knee. Whole-frame SSIM is useless
  as a guard here — the spectrum analyser changes every frame, so a one-frame
  misalignment dominates the score — so sharpness was judged by eye on 1:1 crops,
  which is also the only instrument that matches the reader's own eyes on a
  scaled-down video.
- **No unsharp filter, deliberately.** Sharpening a bitmap font invents edges
  that were never rendered and rings on every glyph; the fix is a faithful
  capture, which is what moving off the upscaling host recorder was for.
- **The video is double-encoded** (vp8 from Playwright, then h264 for the
  browser) and there is no way around it: the first generation's ~2.3 s GOP makes a
  frame-accurate stream copy impossible, and cutting on exact frames is the whole
  point. Measured cost is SSIM 0.9956 and visually identical 1:1 strips, so it is
  not what makes the text soft.
- **Audio `-c:a aac -b:a 128k`**, or `copy` to pass the source opus through. The
  in-page mirror encodes at ~131k, so 160k was an upscale; 128k is right at the
  knee.

## 6. Determinism rules

- **Pin every setting before every run.** The stale-speed scare is the proof:
  `localStorage.settings.tempo = 2` (an in-app *Speed* slider value) made
  position advance at 1.99x in every browser we tried, which would have shipped
  a set of double-speed "seamless loop" videos. The audio graph itself was
  measured real-time (0.98 audio-s per wall-s), so this was purely app state.
- **Address rows by exact name, never by index or loose text.** `text=TECHTRIS.MOD`
  once hit `THALAMUS.MOD` and voided a whole round of conclusions (AGENTS.md).
  `clickRow` resolves the intended row through the listing API and matches the DOM
  label exactly; the built-in `expected-song-still-playing` guard then re-checks
  the path at the end of the take, so a wrong click fails the clip instead of
  quietly shipping.
- **One page context per clip.** `shoot.mjs` builds a fresh browser context and
  closes it after the take, so no state carries between clips. The old "one
  evaluate per scenario" rule belonged to the agent-driven loop.
- **Fixed viewport + fixed theme.** No responsive reflow between takes. 720 CSS px
  also sits above the app's 500 px breakpoints, which hide the mtime column, the
  footer art and the shuffle/repeat buttons — a clip about Repeat One needs them.
- **Fixtures pinned by path**, checked for existence at run time; a missing
  fixture fails the clip loudly instead of silently substituting.
- **Record, don't listen.** Every claim in the prose comes from a number the
  scenario asserted.

## 7. Clip inventory

Format columns: fixture (pinned), script, and the verdict that must hold.

### 7a. Main sections — the two classes of change

Not one flat list: the page splits this into **two top-level sections**, because the
two are separate pieces of work that ship together and are not even about the same
thing. Sub-tunes change what a *song is*; looping changes what Repeat One *does*. A
reader who only cares about one of them should not have to skip the other half, so
each is a `<section>` of its own with its own nav anchor. `scenarios.check.mjs`
rejects a `main` clip with no known group, because a clip that silently drops out of
both sections is the kind of thing that ships looking complete.

**Sub-tunes are Songs, First Class** (`group: 'subtunes'`) — a file containing many
songs browses as a folder of songs, each of which is an ordinary song.

| id | feature | fixture | script | verdict must show |
| -- | ------- | ------- | ------ | ----------------- |
| `songfolder` | A multi-song file browses as a folder (`<TUNES>` + count), and its rows are ordinary songs: real labels, no `Tune N of M` widget, share links unchanged | `nsfe/Akumajou Densetsu (VRC6).nsfe` (28 tunes) + `nsfe/Mega Man 2.nsfe` (22) | browse `/browse/nsfe`, into the folder, play `Mad Forest`, `..` back, into `Mega Man 2`, play `Stage Select` | `<TUNES>` + count; ends inside the *second* folder on sub-tune 3 of 22; both sub-tunes are separate songs |
| `favorite-subtune` | Favourite one sub-tune; Favorites groups it under a song-folder heading | same | play `Epitaph`, click the **footer** heart, open Favorites | the heart's `.isFavorite` flips; the Favorites page holds exactly one row, labelled `Epitaph`, under the folder heading |
| `shuffle-subtunes` | Shuffle Play shuffles *songs*: one entry per playable song, so a 13-file directory is a 100-song walk, and each song's own folder page highlights the row being played | `/browse/nsfe` (13 files, 352 playable songs) | Shuffle Play, then ×8: play 1.7 s, click the footer's folder path (guarded), hold the highlighted row 1.1 s, Next | `ctxLen` 100 over `ctxFiles` 13 — one entry per song, not per file; ≥6 distinct songs played, ≥3 of them past sub-tune 0; ≥5 songs observed with the highlighted row **visible** on their own folder page; no frame where a highlighted row sits on a page that is not the playing song's folder; ≥5 Next clicks; ends on a folder page showing the playing song; audible |

| `charts-subtunes` | The Top Charts page ranks **songs**: one file appears at several ranks, each a different sub-song; Shuffle Play on the page plays those rows, and each song highlights its own row | `/top` (the global chart) | Shuffle Play, then ×10: play, reveal the highlighted chart row, Next | the chart's own DOM carries ≥3 rows linking `?play=…&subtune=…`; ≥2 distinct **sub-songs** played; ≥3 distinct songs confirmed highlighted per tick — the row's text must name the playing file *and* its `subtune` parameter must match; the highlight was inside the scroll box for ≥15 ticks; ≥7 Next clicks; audible |

Ten songs, and that is measured: the chart is ~30% sub-song rows (30 of the top 100 on
this catalog), so "at least one sub-song was played" fails with (1−0.3)^n — 12% of
six-song takes. The first two takes here duly drew six and seven songs that were *all*
sub-tune 0 (vgz, MDX, MOD, MIDI, miniusf — every one a single-song file). Ten draws
puts it at ~3%.

Three things this clip needed that the shuffle clip did not:

- **`browse: '/top'`,** which `scenarios.check.mjs` now accepts alongside `/browse/*`
  and share links. `shoot.mjs`'s `waitForSelector('.BrowseList-row')` is satisfied
  because TopCharts renders that same row class, and `hlName`/`hlSub` read the row's
  own name anchor, which carries `/?play=<songId>&subtune=N`.
- **A reveal branch for non-virtualized lists.** `dev.revealPlayingSong` handles two
  cases now: a song folder (virtualized, so the row may not be rendered at all and the
  index comes from the app's own listing) and any other page (the row is rendered, so
  it is a plain scroll needing no index). The chart is 50 rows tall and ~20 fit, so
  without the scroll the highlight spends most of the take off screen.
- **No song-folder detour,** where the shuffle clip has one. That beat is only available
  when the drawn song is a multi-song file, which makes it a coin flip: a take drew
  `midi/Darkseed 2/MM001GM.MID`, a single-song MIDI, and the footer's path link pointed
  at its parent directory so the guarded click correctly refused. Charts and song folders
  being one model is already shown twice on the page; repeating it here would have made
  the take flaky to say something already said.

The pacing is deliberate and was corrected once: the reveal hold began at 400 ms,
which reads as a flicker rather than as "this song is highlighted in its folder". It
is 1100 ms now, and the play hold went 1500 → 1700 ms. That is the whole of the
"too fast" fix — 35 s of take instead of 27 s, ~13 MB instead of ~10 MB.

**Looping Improvements, Standardized to One** (`group: 'looping'`) — one Repeat One
for every format, loop region on the timeline, no jump at the toggle.

| id | feature | fixture | script | verdict must show |
| -- | ------- | ------- | ------ | ----------------- |
| `loop-band` | The shaded band on the slider, head folding inside it, and Settings → "Show Loop Area" toggling it without touching playback | `arcade-capcom/Ghosts'N_Goblins_(Arcade)/16 Hurry Up!.vgz` | Repeat One, untick the band, tick it again | `band = {start,end}` ms from `getLoopBandMs()`; `displayMs` inside the band across ≥2 loops; band absent from the DOM for a stretch and back at the end; the checkbox was genuinely clickable (topmost element at its own centre) |
| `repeat-toggle-smooth` | Enabling Repeat One mid-song: head continuous, no jump | same | play 6 s, toggle One | `displayMs` monotonic across the toggle (±1 tick) |
| `repeat-leave-fade` | Leaving a deep repeat plays the current pass + full fade, then ends | same | loop deep, toggle off | position keeps advancing; song ends after the fade; `durationExtended` set |
| `blind-loop` | No known region: head parks at the end, label reads `↻ Looping` | `nsfe/Akumajou Densetsu (VRC6).nsfe` sub-tune 3 (`play_length` 101000 ms) | Repeat One, seek to `play_length − 1000` | `isPlayingIndefinitely()` true, band null, `positionMs >= durationMs`, `Looping` in the DOM |

Three notes on `shuffle-subtunes`, all of them learned by measuring:

- **`reveal` exists because the list is virtualized.** It renders ~33 of up to 73
  rows, so the highlighted row for a shuffled sub-tune is often not in the DOM at all,
  and an assertion that a highlight *exists* is satisfied by a row the viewer cannot
  see. `dev.revealPlayingSongWhenReady()` scrolls it into view by matching the app's
  own listing against the **sequencer's** ref (`getSubtune()` disagrees on ~2 in 14
  nsfe songs, because GME reports the post-`plst` track) and writing `scrollTop`
  directly — `list.scrollToRow` is a no-op on this list, measured.
- **Every reveal is recorded as a mark** (`reveal: row 25 -> 194px`, or
  `no-op (…)`), because a reveal that found nothing looks exactly like one that
  worked. The first recorded take showed 3 of 8 folders with no highlight and the
  clip still passed every assertion, because the aggregate test used existence.
- **The aggregate assertion counts visible highlights, not rendered ones**, and it is
  per-tick rather than final: a song folder page is also on screen for the whole
  stretch between a Next click and the folder click after it, when it belongs to the
  song that just ended.
- **The folder click is guarded (`onlyIf: 'song-folder-link'`), and that guard is
  load-bearing.** A shuffled directory is full of one-second sound effects, and the
  sequencer advances by itself when one ends — measured 2 draws in 14 inside a
  1500 ms play hold. When that happens before the step runs, the footer's path link
  still belongs to the song that just ended, so the click navigates to *its* folder
  and the take shows a folder page whose highlight is not the song in the footer. The
  guard refuses the click instead, `runStep` marks the refusal
  (`skipped "song 4: …": the footer still links the previous song`), and `reveal`
  refuses too (`this page is not the playing song's folder`) so a skipped beat does
  not leave a stale scroll behind. Verified on both branches by polling through a
  cache miss: in the stale window the click reports `blocked: true` and the page does
  not move; once `/metadata` lands the same click is allowed. Navigating to the song
  that *is* playing would have been the tempting alternative and would have hidden
  the beat instead of accounting for it. The assertion
  `never-highlights-a-song-that-is-not-playing` forbids the frame outright rather than
  counting it.

The `songfolder` row carries the labels, the absent footer widget and the share-link
format as prose, because those are notes about the same navigation rather than
separate changes.

Removed, with their claims folded in: `subtune-is-a-song`, `labels`,
`share-link`, `show-loop-area`. `top-charts-subtunes` was planned and never cut.

### 7b. In-depth section — per-format / per variant

Grouped by **mechanism**, not by format, cheapest-to-dearest, so the section ends
on the fallback and the reader finishes knowing what happens when nothing better is
available. Each clip's proof prints its own `clip id` and the `--clip` command that
recorded it, so any row here can be matched to a file on disk and re-shot.

**Native loops at load** — the format declares a region, so the band is correct
from the first frame.

| id | engine / variant | fixture | verdict must show |
| -- | ---------------- | ------- | ----------------- |
| `vgm-native` | VGM/VGZ, libvgm loop count | `arcade-capcom/…/16 Hurry Up!.vgz` | `curLoop` climbs (measured 1→8), head cycling in band `[1142, 1942]` |
| `mdx-native` | MDX native loop; band from mdxmini's own loop points | `mdx/G2MST6.MDX` | band `[69206, 103809]`; the head folds back to the band start after the far edge |
| `midi-cc102` | MIDI CC 102/103 region (N64), opened from a share link | `…/Mario Kart 64/03 - 3 Raceways, Wario Stadium.mid` | band `[72062, 144125]`, the file's own SoundFont mounted, position wraps to the band start |

**Indefinite playback looping** — *now with consistent song-ending silence
detection, following GME.* No region to draw; the engine free-runs.

| id | engine / variant | fixture | verdict must show |
| -- | ---------------- | ------- | ----------------- |
| `gme-looping-driver` | NSF whose driver loops internally — must not be cut | `nsfe/Akumajou Densetsu (VRC6).nsfe` | position keeps climbing past `durationMs`; never rewinds |
| `sid-tail-restart` | SID has no loop API; free-runs, tail detector restarts | `sid/Bionic_Commando.sid` | passes the listed length, then restarts in place, same song |
| `n64-indefinite` | N64 engine indefinite flag; seek done **off screen** | `n64/Blast Corps/04 Time to Get Moving!.miniusf` | passes the reported 1:54 with 0 backward jumps |

**Learned loops** — nothing is declared up front; the region is found by listening.

| id | engine / variant | fixture | verdict must show |
| -- | ---------------- | ------- | ----------------- |
| `xmp-learned-band` | MOD/XM; band learned at the first backward order jump, so it appears mid-song | `mods/TECHTRIS.MOD` | no band early, band `[3960, 80700]` after the `11→1` jump — stated plainly as the known limitation |

**The default: repeat the whole song** — where no loop region exists or is needed,
Repeat One falls back to what it always did.

| id | engine / variant | fixture | verdict must show |
| -- | ---------------- | ------- | ----------------- |
| `sequencer-default-loop` | MIDI with **no** CC 102/103/110/111 in the byte stream, so no band can exist | `midi/DOOM/…/02 - At Doom's Gate (E1M1).mid` | no band; the song plays, the engine ends it, the Sequencer restarts the same file |
| `v2m-tier3` | **withdrawn** (`ready: false`) pending the V2M duration bug — see AGENTS.md | `v2m/apollo dvd copy 4.5.4kg.v2m` | — |

Two things the last group is asserting on purpose. **It is a default, not a
failure:** `Sequencer.advanceSong` never advances `currIdx` under `REPEAT_ONE`, so a
player with no `setLooping` override replays the whole file — which means a format
added tomorrow inherits working behaviour with nothing to implement. And **the clip
must be one whose mechanism is genuinely that**, which is why the V2M entry is
withheld: its reported duration does not match its engine, so it was showing the
blind-loop UI instead, and its take was too short to reach the reload it claimed.

Not built, and deliberately: `gme-one-shot` and `midi-cc111` are covered by
`dev/test-gme-loops.js` and `dev/test-midi-loops.js` rather than given page time.
## 8. Snippet appendix (no video)

Each snippet is generated from the working tree at build time (file + line
ranges), so it cannot drift from the code it describes.

| snippet | shows |
| ------- | ----- |
| `api-songfolder` | `curl` of the parent listing showing `type:"songfolder"`, and of the file showing `type:"file"` rows with `subtune` and `url = /?play=…&subtune=N` |
| `schema-subtune` | `subtune` / `subtune_fts` DDL and the `(song_id, subtune)` grouping in the top-charts query |
| `songref` | `songRef` / `songRefKey` / `songRefListsEqual` — why highlight and now-playing keys work |
| `handle-song-end` | the small `Player.handleSongEnd` diff: the player stops, the sequencer owns navigation |
| `parser-parity` | NSFE `plst` remap shown next to `Nsfe_Emu.cpp:34-46` — the "did you check the emulator" answer |
| `wasm-exports` | the new `_lvgm_get_*` / `_mdx_get_*` exports and `sid_set_subtune`'s `engine->load(currentTune)` (the hand-carried fix) |
| `mdxmini-fixes` | the fade-end latch and the `position_us` accumulator |
| `css-visited` | the `:where(a):visited` one-liner |

## 9. Page structure

Single `index.html`, two-column clip rows (video left at the chosen aspect,
prose right), no framework, no external requests — uploadable as a directory.

Two delivery requirements. The first is established; the second's *cost* is
measured but its role in the reported stalls is **not** — see the correction in
FINDINGS.md before repeating any story about it.

- **Serve with Range support** (established). Without it `video.seekable` is empty
  and clips show a first frame that will not play. `serve.mjs` is `express.static`.
- **`preload="none"`, with a poster per clip and explicit `width`/`height`**
  (correct on its merits, causal role unknown). `preload="metadata"` pulls all 14
  clips on page load — measured **35 MB** — which is the wrong default for a page.
  `preload="none"` measures 0 MB on load and all 14 clips still play. Posters are
  generated at build time; `width`/`height` are needed because a `preload="none"`
  element has no intrinsic size until it is played.

```
Header          what changed, in one paragraph, link to the PR
Nav             one anchor per top-level section
#subtunes        §7a, group 'subtunes' — the two classes of change are two
                  <section>s, not one flat list, so a reader who only cares
                  about one can stop reading
#looping         §7a, group 'looping'
  each clip      - "watch for" bullets
                  - "master did: ..." line
                  - <details> proof: verdict table + key numbers + trace link
#deep            §7b per-format clips, same shape, grouped by mechanism
#snippets        §8, each with file:line and a one-paragraph "why this can't be a video"
#limits          XMP's late band, V2M's tier-3 reload, format-2 MIDI has no band
```

Prose (`site.mjs`: `before`, `watch`, section notes) is inserted as **HTML**, not
escaped — it is authored by hand in this tree and written as markup. Escaping it was a
bug that no check caught: the build reported success and the page showed readers a
literal `&lt;em&gt;files&lt;/em&gt;`. Ids, labels, marks and verdict *details* — the
only values that could carry anything unexpected — are still escaped.

One piece of app iconography is borrowed: the Repeat One heading says
"Standardized to ⟲ One", where ⟲ is the app's own `src/images/repeat.png` inlined as a
data URI (200 bytes) by `build-site.mjs`, drawn as a CSS **mask** so it takes the
heading's colour, and sized in `em` so the same span works in the nav link. It is
`role="img" aria-label="Repeat"` rather than decoration, because there the glyph *is*
the word: without it the heading, the nav link, the page outline and find-in-page all
say "Standardized to One" (checked over CDP against the AX tree). An unknown
`{{glyph:…}}` name throws rather than rendering, because the quiet failure is a
heading with a gap in it.

## 10. Work plan

Each milestone ends with something observable, so the recorder design is proven
before any content work.

| # | milestone | done when | state |
| - | --------- | --------- | ----- |
| M0 | Fixture manifest | every path in §7 exists; committed as data; no catalog rebuild | done |
| M1 | Recorder design proven | one clip recorded end to end **with audio**, muxed and trimmed to the mark. Also: pick the framing. | **done** — `loop-band`, verdict green. Framing settled by measurement: Playwright, **900×720 CSS px at dsf 2**, `recordVideo.size` set to exactly the viewport → 900×720 at a constant 25 fps, DPR-correct. Widened from 720×720 on 2026-10-05 because the browse list truncated item names at 239 px (419 px at 900). The host tab recorder was rejected (1× capture upscaled 1.5×, VFR, 50 MiB transfer loss). |
| M2 | Shim additions | `__cpRec` staged by `dev/apply.sh`; `pinDefaults()` provably neutralises the stale `tempo: 2`; generic loop fields in `snap()` | **done** — `dev/shims/recorder.js`; pins both the localStorage and server copies; see FINDINGS.md for the three bugs it took |
| M3 | Registry + validator | every clip in `scenarios.mjs`; `scenarios.check.mjs` fails on a missing fixture, duplicate id, dead harness, assertion-free scenario or vacuous quantifier; wired into `dev/run-tests.sh` | **done** — 14 clips, validator green |
| M4 | Main sections | one clip per user-visible change, in two top-level sections by class of change, recorded, muxed, verified | **done, 8 clips** — `subtunes` 4: `songfolder`, `favorite-subtune`, `shuffle-subtunes`, `charts-subtunes`; `looping` 4: `loop-band`, `repeat-toggle-smooth`, `repeat-leave-fade`, `blind-loop`. Curated down from 10: `subtune-is-a-song`, `labels`, `share-link` and `show-loop-area` were merged into the clips they duplicated (see "Curation pass") |
| M5 | In-depth section | one clip per Repeat One mechanism, grouped by mechanism rather than format (§7b) | **done, 8 published of 9 registered** — `native` 3: `vgm-native`, `mdx-native`, `midi-cc102`; `indefinite` 3: `gme-looping-driver`, `sid-tail-restart`, `n64-indefinite`; `learned` 1: `xmp-learned-band`; `floor` 1: `sequencer-default-loop`. `v2m-tier3` is `ready: false` and withheld pending the V2M duration bug (AGENTS.md). Every clip asserts audibility, and every one was rebuilt where its text claimed more than its footage showed |
| M6 | Page | `build-site.mjs` emits `site/`; prose per clip; relative URLs only | **done** — `dev/record/build-site.mjs` + `site.mjs` + `site.css`; 7 snippets with build-time line ranges; 0 external requests; `preload="none"` + generated posters; `./dev/record/serve.sh` (now `serve.mjs`, express — a range-less server, or a preload that pulls 35 MB before you click, makes clips unplayable; see FINDINGS.md) |
| M7 | PR hand-off | decide with the maintainer whether anything of the page belongs in the PR (probably not) | not started |
| M8 | Page plays reliably | every clip starts on click, first try, in a real browser | **done** — two delivery bugs found and fixed (Range support, `preload`), both invisible to file-level checks; confirmed by the user after headless automation passed 14/14 |

## 11. Risks

| risk | mitigation |
| ---- | ---------- |
| Preview tab flake ("No active preview tab", `evaluate` timeout) | **no longer in the record path** — `shoot.mjs` drives its own browser and waits on node. Still bite when previewing the page |
| Background-tab throttling (~½ speed) | **resolved**: the capture browser is not throttled (measured rate 1.022 once `tempo: 2` was pinned), and the trace asserts the wall-clock ratio anyway |
| A/V drift | **replaced by the mark**: both streams are trimmed to the same frame/sample, so drift cannot accumulate. The residual risk is the *mark* being detected on the wrong frame — hence green + hue, and the first-frame check on the output |
| Clip looks wrong because state leaked in | `pinDefaults()` + a fresh browser context per clip; the verdict is the gate |
| Framing silently regresses (the padded-frame failure) | `shoot.mjs` throws unless the capture is exactly 720x720 |
| `--no-save` install breaks the dev env | see the npm trap in AGENTS.md; install playwright + pinned webpack in one command, then check the `better-sqlite3` ABI |
| Video grows large | accepted (decision 2); if a clip exceeds ~15 MB, shorten the scenario rather than re-encode harder |
| `dev/remove.sh` before the PR | the whole of `dev/record/` disappears with `dev/`; the uploaded `site/` dir is independent, so the PR hand-off is unaffected |

## 12. Wiring into the test scripts

The repo has harnesses per engine (`dev/test-vgm-loops.js`, `test-mdx-loops.js`,
`test-midi-loops.js`, `test-xmp-loops.js`, `test-end-detector.js`,
`test-subtunes-server.js`, `test-songrefs.js`, …) and no browser in CI. So:

- `dev/record/scenarios.mjs` **references** the harness that pins the behaviour it
  demonstrates (`harness: 'dev/test-vgm-loops.js'`), so the page and the tests
  cannot claim different things about the same engine.
- `dev/record/scenarios.check.mjs` runs in `dev/run-tests.sh` and fails when a
  scenario names a harness that no longer exists, points at a missing fixture, or
  has no verdict — the registry cannot rot silently.
- Browser execution stays out of `run-tests.sh` (no runner, no CI, gitignored
  catalog). The scenarios are proven by recording them, not by `run-tests.sh`;
  this matches the decision already taken not to ship tests in the PR.