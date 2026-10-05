# Recorder bring-up notes

Measured findings, in the order they cost a take. Kept next to README.md because
they are the "measured, not assumed" half of §3 there — and several contradict
what the tool schemas suggest.

**Read this first: the video half is no longer the host's tab recorder.** The rest
is kept because the reasoning still applies to the parts that did not change (the
audio mirror, settings pinning, the verdicts), and because "we tried it and here
is what actually happens" is the only thing that stopped each of these being
re-litigated.

## The video half is Playwright; the host tab recorder is for previews

- **The host recorder captures at 1x CSS pixels and upscales.** Its output is
  1350x1350 for a 900x900 viewport (DPR 1.5), and compared 1:1 against a native
  Chromium render at the same DPR the glyph edges are visibly smeared — it
  matches a *1x render blown up 1.5x*, not a DPR-aware render. `preview_recording_start`
  exposes no quality, scale or codec option, so it cannot be fixed from its side.
- **Playwright is DPR-correct.** `deviceScaleFactor` gives hard glyph edges — but
  by supersampling, not by a bigger frame: output is CSS resolution (720 CSS px at
  dsf 2 → 720x720, not 1440x1440). And `recordVideo.size` must be set to exactly
  the viewport, because unset only stays 1:1 while the frame fits inside 800x800.
  See the size section below.
- **The host recorder loses takes over 50 MiB** — the transfer fails and the file
  stays on the desktop (measured: a 56 s take vanished).
- **Tool-call latency made the window impossible to bound.** With the recorder
  running host-side, every `preview_evaluate` inside the window risks the
  intermittent transport failure below. All of it disappears when the take runs
  inside one node process.
- **Frame rate.** The host recorder is a low-rate VFR screencast: it declares
  `r_frame_rate=1/1` (an idle keepalive) while carrying 15-30 fps of change-driven
  frames, and ffmpeg's default CFR output resamples to the declared rate and
  *discards the rest* — a take with 60 real frames muxed to 5, which is what made
  the first `songfolder` clip look like a slideshow while the capture was fine.
  Playwright records a constant 25 fps. `mux.sh` still passes `-fps_mode
  passthrough` so a VFR input survives.

## A green verdict does not mean the published file is right

The most expensive lesson here, and it generalises past this project.

`__cpRec`'s verdict asserts **app** behaviour: the right song is loaded, the
head folded into the band, the loop count incremented. It knows nothing about
what ffmpeg does next. So when the sync mark was detected on the wrong frame —
the mark was white, the capture starts on a blank page, and the detector
happily locked onto the page load — every assertion still passed and the
published clip was 3.5 s out of sync with its own audio. Nothing in the harness
was red; the artefact was wrong.

The fix is not a better assertion, it is a **post-condition per pipeline stage**,
each one cheap and each one about the *output*, not the state:

| stage | post-condition |
| --- | --- |
| capture | the frame is exactly the viewport size (kills the padded-frame failure) |
| mark detection | green, by hue — a signature nothing else in the app can produce |
| trim | the *first* published frame is not the mark |
| verdict | kept, but understood as "the app did the thing", not "the file is right" |

Read it as: assert on the artefact, not just on the state you manipulated.

## recordVideo.size: never the dsf product, and unset is not "1:1" either

Two separate mistakes live in this one setting, and the first round of notes
("Do NOT set recordVideo.size: it pads the frame") only described the first. Both
were found by measurement (`dev/record/vidgeom.mjs` for the geometry,
`vidcap.mjs` for the pixels), because the docs settle neither: Playwright says
only that an unset size is "the viewport scaled down to fit in 800x800", which
does not say what an explicit larger value does.

**Mistake 1 — `size: viewport * deviceScaleFactor`.** Playwright's screencast
frame is then *padded* to that size: the app occupies ~57% of the picture, the
rest is page backdrop, and a full-viewport colour mark stops being detectable
because it only lights a third of the frame — `find-flash.sh` reported "no flash"
for takes that had one.

**Mistake 2 — assuming unset means 1:1.** It does, *right up to 800*. Past that
the default scales the **viewport** down to fit, which resamples an
already-supersampled page and softens the glyph edges `deviceScaleFactor` exists to
protect. Widening the viewport alone would have silently resampled every clip:

| viewport | dsf | recordVideo.size | output | scale | app fills frame |
| --- | --- | --- | --- | --- | --- |
| 720 | 2 | unset | 720x720 | 1.000 | yes |
| 800 | 2 | unset | 800x720 | 1.000 | yes |
| 900 | 2 | unset | 800x640 | **0.889** | yes (resampled) |
| 900 | 2 | **900x720** | 900x720 | 1.000 | yes |
| 900 | 2 | 1350 | 1350x1350 | — | **no (padded)** |
| 900 | 1.5 | unset | 800x800 | 0.889 | yes (resampled) |
| 640 | 2 | unset | 640x640 | 1.000 | yes |

So the rule is **size == viewport exactly**: that bypasses the 800 cap without
padding. `vidcap.mjs` verifies it by painting the page a known colour and reading
the corners back out of the *encode*, because the padded case still reports the
requested dimensions — only pixels give it away. An earlier version of that probe
used an ffmpeg corner-crop filter that silently produced no bytes when it failed,
and the empty output read as "padded"; the failure was in the probe, not the frame.

**Also measured: `deviceScaleFactor` buys antialiasing, not resolution.** Frame
sizes are CSS resolution, not device resolution — 720 CSS px at dsf 2 yields a
720x720 frame, not 1440x1440. The crispness comes from supersampling, so dsf must
be held *constant* when comparing framings, or the comparison is not measuring the
thing it claims to.

Chosen: **900 CSS px wide at dsf 2, size set to 900x720.** Width was the short
axis — at 720 px the browse list column measured 239 px and truncated names to
"Castlevania III - Dracula's…", at 900 px it is 419 px. Both dimensions are even,
so yuv420p has no chroma-sampling problem, and 5:4 needs no padding. 900 px is
well above the app's 500 px breakpoints (which hide the mtime column, the footer
art and the shuffle/repeat buttons), so the whole UI stays in frame, and
`shoot.mjs` asserts the capture is exactly the viewport size so either failure
cannot come back silently.

## A selector that matches nothing cannot fail an assertion

Three clips shipped **green** while not doing the thing they claimed, all in the
same clip. Read this before writing a step that clicks something.

| the selector | what it actually did |
| --- | --- |
| `button[title*="avorite"]` | matched **nothing** — `FavoriteButton` renders no `title` attribute |
| `button.FavoriteButton` | matched the **first** one in the DOM: the browse list's per-row heart, not the footer's. The clip favourited "Prelude" while claiming "Epitaph" |
| `a[href="/favorites"]` | matched **nothing** — the nav link is `to={{pathname, ...search}}` and `search` carries the driver's `?r=<cache-buster>`, so the href is `/favorites?r=…`. The take never left `/browse` |

All three verdicts passed, because the assertions were `document.body.textContent`
searches for "Epitaph", "Akumajou Densetsu" and a `subtune=1` href — **all true of
the browse page too**. Two compounding reasons:

1. A selector that matches nothing is not an error, it is a no-op. Nothing tells
   you, so the clip looks fine until you watch it.
2. `document.body.textContent` is not a scoped query. The **footer keeps showing
   the playing song** on every route, so any text assertion about the current song
   passes anywhere in the app.

What actually caught them: asserting the **page**, not the content —
`/favorites/.test(location.pathname)` and `.BrowseList`-scoped queries — plus
checking the app's own state after the click (`.AppFooter button.FavoriteButton.isFavorite`).
Two related traps in the same family:

- **A synthetic click bypasses occlusion.** `Show Loop Area` was clicked while
  *behind* the footer (`elementFromPoint` at its centre returned a transport
  button), and the band assertions were green. Nothing in the panel scrolls, so
  the fix was a taller capture (900x840) plus an assertion that the checkbox is
  the topmost element at its own centre. If a clip claims "the viewer sees this
  control being clicked", assert the control is *reachable*.
- **A sampling window that ends at the event hides the event.** The SID restart
  looked like it left the engine silent because the first watch window ended
  exactly on the restart; instrumenting the instance calls showed
  `playSubtune` firing every ~10.4 s with position → 0 and audio returning. Windows
  must outlast what they demonstrate.

The general form is the one already in this file: **assert on the artefact, not on
the state you manipulated.**

## A page served without Range support looks like a broken encode

Symptom, and it is worth stating precisely because the obvious hypothesis is
wrong: on the page every clip shows its **first frame** and the controls, pressing
play does nothing, and **the same file opened in a new tab plays perfectly**. That
reads exactly like an encoding problem, and the clips were fine.

Cause: `serve.sh` used `python3 -m http.server`, which has no Range support at
all. Every media request got a full-file `200` with no `Accept-Ranges`, so
`video.seekable` came back **empty** — measured `0.00-0.00` against `0.00-14.04`
for a correct server. With no seekable range the element cannot stream
progressively and waits on bytes it will never be allowed to ask for. A new tab
works because it is a plain progressive download with no `seekable` requirement,
and by then the file is local.

Measured, same page, two servers:

| | `python3 -m http.server` | `express.static` |
| --- | --- | --- |
| response to `Range: bytes=100-200` | `200`, range ignored | `206 Partial Content` |
| `video.seekable` | **`0.00-0.00`** | `0.00-14.04` |
| `currentTime` advances on play | see note | yes |

**Faststart was never the problem** — it controls *where the index sits* and does
nothing about a server that ignores `Range`. Every clip already had `moov` ahead
of `mdat` at offset 36 when this was diagnosed. Two real checks, because "the flag
is in the command" proves nothing: `mux.sh` passes `-movflags +faststart`, and
every published file was verified to have `moov` before `mdat`.

Fix: `serve.mjs` — `express.static`, a dependency this repo already ships
(`server/package.json`). Node has **no** built-in static file server (`node:http`
is a socket API; there is no `serve` in stdlib), so "use the built-in" was not an
option, but hand-rolling the header parsing was still the wrong call when a
dependency we already have does it correctly. `serve.sh` is now a wrapper.
`vidcheck.mjs` reproduces this (reports readyState / networkState / error /
buffered / seekable and whether `currentTime` actually moves).

Caveat that survives the fix: the Range half was a **local preview** bug. The
uploaded page depends on the real host supporting ranges — worth confirming there,
not assuming.

## `preload="metadata"` on 14 videos is not free, and it fails *intermittently*

**Confirmed fixed** (2026-10-05): after `preload="none"` the user reports playback
is consistent. The file-level checks never showed this one — see "what made it
invisible" below.

### The plain version, because the technical one does not explain "inconsistent"

The page has 14 videos on it. `preload="metadata"` told the browser to fetch each
one as soon as the page loaded — before you touched anything. Measured: **35 MB,
all 14 files, on every page load.**

A browser will only run about **6 downloads at a time** to the same site. That
limit is not a bug; it is decades-old HTTP/1.1 behaviour, there so one page
cannot hog the network from every other tab. So of our 14 videos, **8 sat in a
queue** waiting for a free slot.

Now the part that makes it feel random: whether a given clip worked when you
clicked it depended on whether it happened to have a free slot *at that moment*,
and that depended on how fast the link was and how big the files were (`songfolder`
is 17 s and 5.3 MB; `share-link` was 0.2 MB). Slow link or big file → you clicked
and it sat there. Fast link → it had already finished fetching and started
instantly. **Same page, same clips, different results — which is exactly the
"works sometimes" report**, and why clearing the cache and hard-reloading changed
nothing: the cache was never the problem, the queue was.

The fix is one attribute: **`preload="none"`** — fetch nothing until a click.
Measured after: **0 MB on load**, and all 14 still play (from `readyState=0`,
i.e. genuinely nothing preloaded). Two consequences to handle, both done:

- No first frame to show, so `build-site.mjs` generates a **poster** per clip
  (1.8 MB for all 14, ~120 KB each). A side benefit: the page reads better than
  black boxes.
- A `preload="none"` element has **no intrinsic size until it is asked to play**,
  so `width:100%; height:auto` collapsed every row to nothing and then jumped.
  Fixed with explicit `width`/`height` attributes from `ffprobe`, which is what
  those attributes are for.

Also changed: `express.static`'s default is `max-age=0`, i.e. "revalidate before
every use", so every visit re-pulled all 35 MB anyway. Now the HTML revalidates
(rebuilds show up) and the media is cached for an hour.

### The technical version

A browser's metadata probe is an **open-ended** `Range: bytes=0-`. Because
faststart puts the `moov` atom first, the browser only *needs* the first few KB —
and then cancels the request. But the server has already committed to writing the
whole file, so every one of those probes became a full-file `206`:

```
load finished in 6447 ms, 14 mp4 responses, 35.43 MB transferred
songfolder.mp4   206   5538612 B   bytes 0-5538611/5538612   <- whole file
```

14 whole files, competing for 6 connection slots.

### What made it invisible

Everything a file-level check would ask came back clean: `ffprobe` reported every
clip as valid H.264 High / AAC-LC, `canPlayType` said `probably` for every codec,
and `vidall.mjs` played 14/14 with `readyState=4` and no media errors. Automation
passed *because* headless Chromium has no connection pressure and a null audio
sink. The bug lived in the gap between "the file is fine" and "the page asks for
14 of them at once" — which is why it had to be reproduced in a real browser
before it was found, and why the user's confirmation, not the test suite, is what
closed it.

The general lesson, and the reason the delivery checks are separate tools:
**assert on the artefact, not on the state you manipulated** — here the artefact
is "what the page fetches, and when", which `vidleak.mjs` measures.

## The sync mark must be green, not white

A white mark is indistinguishable from the two other full-frame whites in a
recording: the blank page the capture starts on (Playwright starts recording at
context creation, before navigation), and the occasional blank frame the screencast
emits mid-clip. With a white mark, `find-flash.sh` locked onto the **page load**,
trimmed ~3.5 s early, and published a clip whose video was 3.5 s out of sync with
its audio — while every assertion still passed, because the page-side verdict
knows nothing about the mux.

Green is unique by construction: the app is blue (high U) and yellow (high V) on
near-black, so a frame that is bright with *both* U and V low cannot be app
content; a blank page is neutral (U = V = 128). Measured signatures: blank page
`Y=235 U=128 V=128`, app frame `Y=35 U=163 V=122`, mark `Y>140 U<90 V<90`.
`find-flash.sh` therefore tests hue, not luma.

### Which sections still apply

The video half moved from the host tab recorder to Playwright (`shoot.mjs`), so
part of this log is historical. Nothing is deleted — "we tried it and here is what
actually happens" is what stops each of these being re-litigated — but do not
follow a section marked historical.

| Section | Status |
| --- | --- |
| The video half is Playwright | **current** |
| A green verdict does not mean the published file is right | **current** (read this before trusting any check) |
| `recordVideo.size`: never the dsf product, unset is not 1:1 either | **current** (framing) |
| A selector that matches nothing cannot fail an assertion | **current** (read before writing a step that clicks) |
| A page served without Range support looks like a broken encode | **current** (preview) |
| `preload="metadata"` on 14 videos is not free, and it fails *intermittently* | **current** (page delivery) — plain-language version first; confirmed fixed by the user |
| The sync mark must be green | **current** (sync) |
| Two clocks, and the audio offset | **current** |
| Load the song *inside* the recorded window | **current** |
| Trim with filters, not with `-ss` | **current** |
| Assertions must not pass vacuously | **current** |
| Settings pinning must write the server copy too | **current** |
| Staging | **current** |
| The 15 s evaluate budget | preview-only (no longer a clip constraint) |
| `preview_evaluate` failures / `awaitPromise` / stray recording | preview-only |
| The preview tab cannot reach the host's loopback | still true for the *preview* tab; Playwright can use loopback, but `upload-server.mjs` binds `0.0.0.0` anyway |
| Recording is agent-side and cannot be triggered from the page | **historical** — both halves now run inside `shoot.mjs` |
| Frame rate is dictated by the page | **historical** — Playwright records a constant 25 fps |
| Keep the take next to an evaluate; do not schedule it away | **historical** — the take is one node process |
| The tab recorder cannot record audio | **historical** as a host-recorder fact, **current** as a conclusion: Playwright's `recordVideo` is silent too, so the audio mirror stays |
| The flash may be a single frame | **current** (`find-flash.sh` accepts a one-frame run) |
| A take can be "finished" before the verdict exists | **current** (the `pending` race) |
| A scenario's `until` gate must not wait for its own first step | **current** (dead-gate class) |
| A scenario cannot show two directories without an explicit navigate | **current** |
| Two more things the batch run proved about the harness | **current** (sampler + virtualized DOM) |
| Fixtures and assertions are design, not plumbing | **current** — read before "fixing" a failing verdict |

## A take can be "finished" before the verdict exists

The batch run's first hard failure was a bare `Cannot convert undefined or null to
object`, thrown by the *driver* one layer away from the cause.

The shim's `finish()` cleared `dev._run` on its **first line**, and `result()`
keys "is it done?" off `dev._run`. So the moment finishing began, `result()`
answered `pending: false` — while the take was still finalizing and uploading its
audio. The driver's poll loop exited on that answer and read a result object with
no `verdict` on it, and `Object.entries(result.verdict)` threw.

It looked flaky because it depends on a race: only when the upload outlives the
driver's next poll (~400 ms) does the poll see the gap. Two smaller fixes came out
of chasing it, and both are worth keeping on their own:

- **Surface a page-side failure as itself.** A page error is stored as
  `{ error }` with no `verdict`; reading `result.verdict` first turned it into a
  TypeError. `shoot.mjs` now checks `result.error` first, and prints a stack when
  `SHOOT_TRACE=1`.
- **Add the missing state, don't race around it.** `dev._finishing` keeps
  `result()` honest for the whole of `finish()`, cleared on both exit paths and
  reset in `run()` and `abort()`.

The general rule is the one from the section above: the producer and the consumer
of a result need an explicit handshake, and "not started" / "done" / "in progress"
are three states, not two.

## A scenario's `until` gate must not wait for its own first step

`until: 'playing'` means "arm the steps once a song is playing". Three
scenarios declared it *and* had `open` as their first step — the open is what
starts playback — so the gate could only go true after a step ran, and steps only
ran after the gate went true. All three recorded a 10 s dead take and reported
`GATE TIMEOUT: until="playing" never became true`.

`songfolder` and `labels`, which have the same shape, were already ungated —
which is why the first two clips ever worked. Rule: **if a scenario has no
preload, its gate cannot be about playback.** The driver's own waits (for
`.BrowseList-row`, then a settle) already establish page readiness.

Two more variants of the same mistake, found by the batch run:

- **`until: 'playing'` with no preload and no `open`** (`blind-loop`,
  `gme-looping-driver`): nothing in the scenario could ever start playback. Fixed
  by adding a preload.
- **A song *folder* row is not a playable row.** `Monty_on_the_Run.sid` holds 19
  sub-tunes, so in the `sid/` listing its row is `type: "songfolder"`: clicking it
  *navigates*, and `preload` then waits forever. The browse page has to **be** the
  folder and the preload has to name a sub-tune. `clickRow` already treats a
  song-folder row as a legitimate click — it is — which is exactly why the failure
  was a silent timeout instead of an error.

## A scenario cannot show two directories without an explicit navigate

`clickRow` clicks the row's anchor, and a sub-tune row's href is
`/?play=<id>&subtune=N`. So opening one leaves the browse route entirely and the
listing rows unmount. A second `open` in a different directory then fails with
`row not rendered (scrolled out?)` — an error that reads like a virtualization
problem and is actually about the *previous* navigation.

`__cpRec.navigate()` was added for this: push state and fire `popstate`, which is
what react-router v5 listens for. A plain `location.href =` would reload the
document and destroy the run — the trace, the audio recorder and the pending
assertions all live in the page.

## Two more things the batch run proved about the harness

- **The trace sampler must record what the assertions read.** `vgm-native`'s
  `no-reload` failed because it wanted `s.durationMs`, which `snap()` has but the
  sampler did not record — an assertion reaching for an unsampled field sees
  `undefined` and fails for the wrong reason. The sampler now carries the union of
  what the registry's assertions use (`dur`, `b`, `sub` alongside `p`/`d`).
- **A virtualized listing is not a stable assertion target.** `labels`' first
  assertion looked for a track name in `document.body.textContent`, but by the end
  of the take the DOM held a different window of rows. The durable evidence is the
  trace mark (`opened Good Morning [Introduction] #0`), which is also *better*
  evidence: it proves the label came from the file, not from a counter. Prefer
  marks and trace over live DOM for anything the take navigates away from.

## Fixtures and assertions are design, not plumbing

Recording the rest of the registry turned up several scenarios whose *fixture or
assertion contradicts its own claim* — the pipeline recorded them faithfully and
the verdict correctly failed. These are listed as open work in README.md rather
than fixed by loosening the assertion: a passing verdict that does not verify the
stated claim is worse than a failing one, because it is trusted. The specific trap
is an assertion written against a plausible-sounding state that the engine parks at
exactly (`s.positionMs > s.durationMs` for a blind loop, where the head is
*supposed* to sit at the duration) — "fixing" it means inventing a tautology.

## The 15 s evaluate budget is real, and it is the binding constraint

`preview_evaluate` times out at **15000 ms** (measured: a promise polling for
20 s comes back `Preview automation evaluate timed out after 15000ms`). This bound
the *old* design; the Playwright pipeline has no such limit because nothing waits
on a tool call. Kept because preview work still hits it.

Consequences while the host recorder was in use:

- **A clip's wall time must be ≲ 10 s**, leaving headroom for load, MediaRecorder
  finalize and the blob upload inside the same call.
- Long waits are impossible inside one evaluate. The workaround is the one the
  PixiJS project already uses: `startRecord()` / `stopRecord()` are
  fire-and-forget, and the *recording* is continuous because the tab recorder
  runs in the host, not in the page. The page only needs to schedule its events
  and return promptly.
- So `__cpRec.record()` must not `await` the scenario body. It should:
  1. start audio + flash, and remember `t0`,
  2. schedule the scenario on timers (`setTimeout` per step) so nothing blocks,
  3. return a handle immediately,
  and the agent then: `preview_evaluate(start)` → wait → `preview_evaluate(finish)`.
  The finish call returns the verdict, trace and uploaded audio path.

This also makes the flow resilient to the preview dropping tabs between calls,
which AGENTS.md warns about: state lives in the page, not in the tool call.

## Recording is agent-side and cannot be triggered from the page

`preview_recording_start` / `_stop` are host tools. The PixiJS project's
`T.video.upload()` equivalent for *video* does not exist here; only the audio
half is page-side. Consequences:

- video and audio start at different instants (two separate tool calls), which
  is exactly why the flash calibration mark exists (§3 of README.md),
- `preview_recording_stop` returns an attachment path; the mux step needs both
  that path and the page-uploaded audio path, so the agent must remember to pass
  both to `mux.sh`.

## A stray recording costs real disk

A failed evaluate left a tab recorder running; the next `preview_recording_stop`
produced a **46 MB** attachment. Always pair start/stop, and if an evaluate
fails, stop the recording before retrying or the next take inherits the padding.

## The preview tab cannot reach the host's loopback

`fetch('http://127.0.0.1:3999/...')` from the page fails with `Failed to fetch`,
while `fetch('http://mms-1:3999/...')` returns 200 — and `mms-1` is this box's
Tailscale name. So the recorder receiver must bind `0.0.0.0` (not `127.0.0.1`)
and the page must address it by `window.location.hostname`, exactly the way
`src/config/index.js` derives `API_BASE`. A loopback-only receiver passes every
curl smoke test and then fails every real recording, with an error that looks
like a network outage rather than a bind-address mistake.

## Frame rate is dictated by the page, not by the recorder

Measured on the same take machinery:

| clip | page state | fps | frames |
| ---- | ---------- | --- | ------ |
| `loop-band` (VGM playing) | visualiser + playhead animating | **29.8** | 165 in 5.5 s |
| `songfolder` (navigation only) | static list, nothing playing | **1.0** | 5 in 5 s |

The host recorder is a low-rate screencast: it emits roughly one frame a second
plus extras where the page changes, and it follows the page up to ~30 fps when
the page genuinely animates. `preview_recording_start` has no rate option.

`__cpRec.heartbeat` (a 24 px patch toggling `background-color` on a 66 ms
`setInterval`, verified running during a take via `getElementById('__cpRecBeat')`
and its computed background) did **not** lift a static page above ~1 fps.

What did produce 30 fps: `loop-band`, where the spectrum visualiser was painting.
The obvious hypothesis — "a clip that ends with playback will animate and record
at 30 fps" — was then tested on `songfolder` (re-recorded with a sub-tune
playing for the last 3 s of the take) and **it is false**: still 6 frames in 5.3 s.
The visualiser apparently only paints under whatever condition held in the
`loop-band` session, which has not been identified. So the honest statement is:
*frame rate varies per clip between ~1 and ~30 fps, and the clip that demonstrates
looping happens to be the smooth one.* Both are watchable; neither is a
presentational risk worth more budget right now, and the page carries the
explanation in text beside every clip anyway.

An earlier measurement suggesting the heartbeat worked (995 frames / 65 s) was a
stale recorder that had been running since before the heartbeat existed — the
same stale-session trap as below, and the reason every take now checks that
`startedAt` moved.

Keep the good property anyway: `songfolder` ends by playing a sub-tune because it
demonstrates one more thing than the navigation alone, not because of the frame
rate.

## Two clocks, and the audio offset is not a function of the video clock

`mux.sh` originally computed `audio_skip = flashVideoSec*1000 - audioStartToFlashMs`,
which folds the video clock into the audio offset. It is accidentally correct
when the audio mirror starts at the flash (`audioStartToFlashMs == 0`, the usual
case, skip 0) and badly wrong otherwise: with a 26 s dead-air pre-roll it asked
`atrim` to skip 26 s of a 3 s track. The correct relation is
`audio_skip = audioStartToFlashMs / 1000` — the published video starts at the
flash, so the audio must start there too. `mux.sh` now refuses outright if the
skip exceeds the audio duration, because the symptom otherwise is a silent clip.

## The flash may be a single frame

`find-flash.sh` required a run of ≥ 2 frames to reject noise, and rejected a real
flash captured as one frame (150 ms of white on an otherwise idle page), reporting
"no flash" for a take that had one at 20.96 s. One frame is now accepted, and the
threshold is `max(200, 3 × the clip's median luma)` so a bright frame still has to
be an outlier for *this* recording. Verified on both shapes: 1 frame / 0 ms and
4 frames / 107 ms.

## Keep the take next to an evaluate; do not schedule it away

`run()` accepts `delayMs` so the take can be scheduled *before* the host
recorder starts (which would remove every evaluate from the recorded window —
an attractive idea, since evaluates fail there). It does not work: the take
produced a **correct-looking video with no sync flash in it at all** (max YAVG
31.6 across the whole 25 s file, against 235 for the flash in a working take), so
the clip cannot be trimmed to the audio and `mux.sh` correctly refuses it.

The cause is unproven — plausibly the tab recorder emits screencast frames only
while the page is doing something, and an evaluate right after
`preview_recording_start` provokes a repaint — but the conclusion is the same
either way: **start the recorder, then kick the take immediately**, and accept
that one evaluate has to happen inside the window (retrying it, since the reply
can be lost while the call lands).

## `preview_evaluate` failures are transient; retry, and let the page settle

Bisected on 2026-10-05 after the `songfolder` take refused to arm five times
with the *same* expression that later succeeded unchanged. What it is not:

- not expression length (1800-char expressions pass),
- not the payload shape (every bisected fragment passes: `open` steps with
  parentheses in the name, assertions containing escaped quotes and regexes,
  `delayMs`, all three together),
- not `awaitPromise` alone (though that fails far more often -- see above),
- not the recorder streaming (the same call fails with no recorder running).

What it correlates with: calling `preview_evaluate` immediately after
`preview_navigate`. `preview_wait_for('.BrowseList-row')` returns as soon as the
list exists, but the app is still fetching `/api/browse`, fetching metadata and
mounting the visualiser; an evaluate landing in that window fails at the
transport level without reaching the page.

Protocol, therefore: **retry, and verify.** After a failed evaluate, read
`__cpRec._pending`/`__cpRec._run`/`__cpRec._result` — the call may still have
landed even though the reply was lost. `abort()` makes a re-kick safe. Budget
three attempts per call, and never conclude anything about the page from one
failure. (This is the same advice AGENTS.md gives for the preview tab, now with
the mechanism attached.)

## Never pass `awaitPromise` to `preview_evaluate`

Measured 2026-10-05: `preview_evaluate` with `awaitPromise: true` fails
intermittently with `Preview automation evaluate failed on client ...` — five
times in a row on calls whose promises provably resolved. The same code run
without `awaitPromise` (fire the promise, stash the result on `window`, read it
back in a later synchronous evaluate) has not failed once.

The proof that it is the transport and not the page: `__cpRec.run()` returns a
promise that resolves in microseconds, and reading a flag set by its `.then()`
in a separate synchronous call shows `state: "resolved"` with the expected
payload. `pinDefaults()` and `preload()` *did* survive `awaitPromise` often
enough to look reliable, which is what made this look like a scenario bug (it
was: `until: 'hasPlayer'` on a clip that plays no song really did arm nothing —
but that was a second, separate fault).

Protocol, now baked into `plan.sh`:

```js
// 1. kick (synchronous evaluate -- no awaitPromise)
window.__cpRec.abort();
window.__cpRec.run({ name, preload, steps, until, assert });
// 2. poll (synchronous evaluate, repeat until it is not { pending: true })
window.__cpRec.result()
// 3. preview_recording_stop
```

`run()` finishes the take itself on a page-side timer, so the poll is a small
read and the heavy work (MediaRecorder finalize, uploads, assertions) never
depends on a tool call landing.

## The tab recorder cannot record audio, and no setting would change that

Verified three ways, then confirmed moot:

- every recording returns `mimeType: video/mp4;codecs=avc1` (AVC only, no
  `mp4a`), and all 18 attachments on disk have exactly one stream, `h264`;
- `preview_recording_start` takes only `{ tabId }` -- there is no audio flag, and
  no other recording tool exists in the catalog (`browser.*` has perf trace, CPU
  profile and screenshots, nothing that writes video);
- the host has no audio output device at all: `/proc/asound` does not exist,
  `/dev/snd` holds only `timer`, `pactl` fails with "Connection refused", there
  is no `aplay`. The preview tab does not even expose `navigator.mediaDevices`
  (`getDisplayMedia` and `enumerateDevices` are both undefined).

So the app's sound exists only as a Web Audio graph inside the renderer process,
and there is no system-level signal for any recorder to tap. The in-page
`MediaStreamAudioDestinationNode` mirror is not a workaround for a missing
setting -- it is the only route, and it is the more portable one (identical
output on a box with a sound card). Measured content: mean -16.8 dB, peak -5.0
dB, unchanged by the aac transcode.

## Load the song *inside* the recorded window, not before it

The first version preloaded the fixture in an evaluate *before*
`preview_recording_start`. Each tool round trip costs seconds, the pinned
settings have Repeat One OFF, and `16 Hurry Up!.vgz` is 6.4 s long -- so the song
ended during the round trip, the sequencer advanced to `17 Player Out.vgz`, and
the take recorded the wrong song while every scenario assertion still "passed"
against the new song's (null) band.

Two fixes, both kept:

- `__cpRec.run()` loads, *then* flashes, *then* arms the steps. The load is inside
  the recorded window but before the flash, so trimming to the flash removes it.
  No race is possible, and audio and video share an origin by construction.
- `finish()` adds a built-in `expected-song-still-playing` assertion from the
  preloaded path. A take of the wrong song is the one failure the page cannot
  detect by looking at it, so it is not optional.

## Trim with filters, not with `-ss`

The first mux put `-ss` *after* the inputs, which makes them output options, not
input seeks: the audio got trimmed twice and the result was 3.55 s of video
against 5.65 s of audio. Input `-ss` is the other trap -- it is keyframe-snapped,
and with `-c:v copy` that can discard up to a GOP (most of a second at 30 fps),
which is precisely the desync the flash exists to eliminate. `trim`/`atrim` +
`setpts` decode, so the cut lands on the exact frame and the exact sample. A 7 s
clip re-encodes in well under a second.

`find-flash.sh` reports the **last** frame of the mark's run, not the first: the
mark is ~150 ms, so trimming to its first frame leaves the rest in the clip. And
even that is not enough — `trim=start=` keeps frames *at or after* that PTS, so
the mark's own last frame survived into the published clip. `mux.sh` therefore
starts the trim a frame and a half later (`flash_sec + 0.06`, ≈25 fps captures).

Two more mux traps, both measured:

- **`tpad=stop_mode=clone:stop_duration=2` *lengthened* the video past the audio**
  (6.24 s against 4.26 s) instead of covering a tail gap. It exists to hide a
  fraction of a second of end-of-stream; 0.4 s is enough.
- **Do not re-run `find-flash.sh` over the *output* to verify the trim.** Playwright's
  screencast emits the occasional full-white blank frame mid-clip (one 40 ms frame
  at t=2.04 s of `loop-band`), so "is there a bright frame anywhere" fires on the
  artefact instead of on a bad trim. What matters is the *first* published frame:
  it must not be the mark. `mux.sh` checks that and prints the value.

## Assertions must not be able to pass vacuously

`every()` over an empty array is true, so `head-folds-into-band` "passed" while
the song was being ended by the silence detector and no sample had a loop count.
Every assertion that filters or slices the trace now constrains its length, and
`scenarios.check.mjs` warns about any that does not.

Related: the pinned `silenceDuration` is **-1** ("Insert Silence: None", the app's
own default), not 0. The base end detector is only armed when
`silenceDuration >= 0`, so pinning 0 armed it and let a looping clip be ended by
a silence heuristic instead of by the behaviour under test.

## Settings pinning must write the server copy too

`UserProvider` boots with `{...localSettings, ...serverSettings}` — the server
wins. A `pinDefaults()` that only touched `localStorage` was silently undone on
the next navigation. It now POSTs `/user/settings` with the dev user's token
(importing `API_BASE` from `./config` rather than guessing the host) and then
calls `replaceSettings` so stale pinned player params are dropped rather than
merged. Verified: `localStorage` and `/api/user/settings` both come back as the
clean object.

## Staging

`dev/shims/recorder.js` → `src/chip-player-record.js` (untracked, gitignored),
picked up by the dev webpack entry next to the devtools shim. `dev/apply.sh`
copies it, `dev/remove.sh` deletes it. ESLint runs on the staged copy, so the
shim must be lint-clean: `no-restricted-globals` rejects bare `location` (use
`window.location`), and unused vars are errors.