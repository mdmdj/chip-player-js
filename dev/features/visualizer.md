# Visualizer feature — Butterchurn (MilkDrop) prototype

Status: **working prototype on `dev/overlay-visualizer`**, promoted to its own
`feature/visualizer` and **stacked additively on the sub-tunes feature**, not yet
shippable. Target: `feature/visualizer` = `943209291` (parent
`feature/subtunes-as-first-class` = `992f0996b`). Worktree:
`dev-overlay-visualizer`, ports **WDS 3301 / API 8301**. (`dev/overlay-visualizer`
was cut from `dev/kit` one dev commit behind `dev/overlay-subtunes`; it was
fast-forwarded to pick up the `dev/overlay` → `dev/overlay-subtunes` rename,
which `dev/test-client-seams.js` needs.)

## What exists

A third renderer next to the Spectrogram and the MIDI piano roll:

| File | Role |
| --- | --- |
| `src/butterchurn/ButterchurnVisualizer.js` | Butterchurn component: WebGL2 canvas, audio tap, preset transport, rAF loop, mesh/resolution application |
| `src/components/Visualizer.js` | Renderer selector + up-front MilkDrop controls; paused spectrogram while MilkDrop is on |
| `src/components/Settings.js` | **MilkDrop** section (mesh + resolution), visible only when active |
| `src/components/UserProvider.js` | Persisted defaults |
| `src/index.css` | `.MilkDrop*`, `.Visualizer-preset-name` |

The module directory is named after the **library** (`src/butterchurn/`) because
that is the dependency boundary; "MilkDrop" stays the user-facing renderer label
(and the `MilkDrop*` CSS classes / `milkdrop*` setting keys). Do not rename those
to Butterchurn — users pick "MilkDrop".

`src/components/Visualizer.js` still has no visualizer *registry*: it is a
hard-coded dispatch plus a renderer radio. The MIDI path is unchanged (piano
roll wins for MIDI; the renderer selector is `!isMidi` only).

## Why Butterchurn

- **MilkDrop3** (`milkdrop2077/MilkDrop3`) is a Windows DirectX/HLSL application,
  not a library; "Linux" is Wine (`linux/README.md`), and the repo declares **no
  license** (`license: null`). Not embeddable, and its presets are not
  redistributable by default.
- **projectM** is the portable reimplementation and *does* have an official
  Emscripten/WebGL2 build (`docs/emscripten.rst`, emsdk 3.1.53, static lib,
  `-sFULL_ES2/3`, `OES_texture_float`), with a C API (`projectm_create`,
  `projectm_pcm_add_float`, `projectm_opengl_render_frame`,
  `projectm_load_preset_data`). It is feasible but a separate wasm module +
  binding + preset pipeline, LGPL-2.1, and ships no presets. Estimated weeks.
- **Butterchurn** (`jberg/butterchurn`, **MIT**) is a JS/WebGL2 MilkDrop (1/2)
  implementation. It runs in the page, uses JSON presets, and needs only
  `createVisualizer` + `connectAudio` + `loadPreset` + `render`. This is the
  prototype.

## Butterchurn surface used

Enumerated from the live instance (v2.6.7):

`connectAudio`, `disconnectAudio`, `loadPreset(preset, blendSeconds)`,
`setRendererSize(w,h)`, `setInternalMeshSize(w,h)`, `setOutputAA(bool)`,
`render()`, `launchSongTitleAnim(text)`, `toDataURL()`, `warpBufferToDataURL()`.

Not available: mash-ups / double presets, a beat-detection API, preset
rating/favorites. Don't design around them.

## Controls

Up front (`.Visualizer-options`, local state like the spectrogram controls):
previous / next / random, `Auto` (20 s rotation) and `Blend` (0–10 s) in the
transport row, then the preset name + `(n/100)` beneath it.

The transport is styled like the footer's three-button group: pure CSS triangles
(no bar), **33.78×19 px** (16:9, matching the glyph frame), **8 px** gap (`var(--charW1)`), and the
shuffle glyph only for Random. The "Preset:" text label is replaced by the glyph.

The Visualizer On/Off switch lives in the header (`AppHeader.js`), aligned with
the "Chip Player JS" title line. The **Renderer** selector is window-right
anchored at the tab row's vertical position, so it reads as part of that row
rather than a line of its own between the header and the tabs. Neither is in
`.Visualizer-options`, so the panel holds only renderer-specific controls, sits
above the absolute piano-keys overlay, and leaves the keys at full height; the
spectrogram remains 448×800.

### Preset glyph (chosen)

**Nested hex** — concept 01 in `dev/features/visualizer-glyphs.html`; the sheet's
generator is `dev/features/visualizer-glyphs.js` (both dev-only history). The app
renders it in a 96×54 viewBox at **39.11×22 px** (16:9, matching the 22 px row):
a 16:9 frame, two concentric hexagons, base rotated **8°**, a ghost at **24°**
with offset **(−16, −4)**, scale **1.4**, opacity **0.3**, and the base+ghost
ensemble optically centred by **translate(12, 4)** — the base itself is
off-centre. The glyph group is clipped just inside the frame (`1.25`, `93.5×51.5`)
so shapes cannot overdraw and darken the border; the ghost may still clip at the
frame/viewBox edge, which is intentional. Strokes are
`vector-effect: non-scaling-stroke`, 1 px; the frame is 35 % opacity.

In Settings (persisted), visible only when the visualizer is on and the renderer
is MilkDrop on a non-MIDI song:

- **Mesh:** 32×24 / 48×36 / 64×48 / 96×72 → `setInternalMeshSize`
- **Resolution:** 50 / 100 / 150 / 200 % → `setRendererSize(base × scale)`

The canvas fills the available visualizer area: 448 px wide and the remaining
height after the options row (measured with a `ResizeObserver`; ~454 px at an
800 px viewport, not a fixed 800). The target handed to Butterchurn is exactly
`CSS size × resolution` — the same number is used for `createVisualizer()`, for
`setRendererSize()`, and for the canvas backing store. 50% → 224×227 inside a
448×454 CSS box; 150% → the reverse. Butterchurn's `setRendererSize` updates its
viewport/render target but not the canvas element, so the backing store must be
set too — otherwise a scale below 1 renders into the bottom-left quadrant of the
canvas. Filling the flex area also keeps the render centred in the visible area
instead of 800 px tall and clipped by the footer. Mesh is the main performance
lever.

## Settings keys (`DEFAULT_SETTINGS`)

```js
visualizerRenderer: 'spectrogram', // 'spectrogram' | 'milkdrop'
milkdropMesh: '48x36',             // 'WxH'
milkdropResolution: 1,             // 0.5 | 1 | 1.5 | 2
```

`showVisualizer` remains the on/off switch. `updateSettings` merges, so old saved
settings without these keys fall back through `||`.

## Verified (2026-10-19, live app)

- Non-MIDI song + MilkDrop: 448×800 WebGL2 canvas, no error; a manual
  `visualizer.render()` + `gl.readPixels` gave **358,086 / 358,400 non-black
  pixels** (sum 53,067,335). `drawImage`/`toDataURL` read black because
  Butterchurn does **not** set `preserveDrawingBuffer` — use `readPixels` right
  after a render to prove output.
- **First-frame caution:** a manual `render()` + `readPixels` can read black for
  the first frame or two after mount (preset shaders/textures still settling).
  Sample again once the rAF loop has run — the same preset then reads ~358k
  non-black. A browser check must wait/retry, or it reports a false failure.
- rAF loop armed; 100 presets; preset advanced with `▶` (`(2/100)` → `(3/100)`).
- Mesh 64×48 + resolution 150 % applied live: `renderer.width/height = 672×1200`,
  `mesh_width/height = 64/48`, `texsizeX/Y = 1344×2400`.
- Settings section hides on Spectrogram, returns on MilkDrop.
- Renderer choice persists across reload.
- MIDI still shows the piano roll, no MilkDrop canvas, no renderer selector.
- `dev/check-promotable-refs.js` and `dev/test-client-seams.js` (22/0) green.
- `./dev/run-tests.sh` on the clean tree (2026-10-22): **25 passed, 1 skipped,
  2 failed** — `test-midi-loops` (the known sample-catalog Gyrocopter check) and
  `test-overlay-discovery` (the kit is stale for some dev docs after a concurrent
  session moved `dev/overlay-subtunes`; not this feature. Fix from the canonical
  overlay with `dev/kit.sh capture`, which is a publish act).

## Environment fallout / gotchas

- **Resolved (2026-10-22): the dependencies are pinned, not vendored.**
  `butterchurn@2.6.7` and `butterchurn-presets@2.4.7` are exact `dependencies` in
  `package.json`, and `package-lock.json` carries them. `npm install` restored
  **webpack 5.106.0** to match the lock, so `npm ci` reproduces the tree and the
  visualizer builds. Do not use `--no-save` for these. **Proven on a clean tree
  (2026-10-22):** `npm ci --ignore-scripts` installed 1699 packages in ~1 min,
  `npm rebuild better-sqlite3` rebuilt the root native module, both manifests
  were byte-identical afterwards, and the dev build compiled (`webpack 5.106.0`);
  the canvas rendered (358,400/358,400 non-black pixels on a later frame).
- The first, experimental install did use `--no-save` and drifted webpack to
  5.112; a killed reify also left `node_modules` partially written
  (`html-webpack-plugin/lib/loader.js` missing, babel ESM errors) until the write
  completed. That is why the deps are pinned now; the general trap lives in
  `AGENTS.md`.
- A concurrent `dev/overlay-replaygain` session (`t3-89a4b1fa`, ports 3302/8302)
  repeatedly killed this tree's dev server. Use `readlink /proc/<pid>/cwd` before
  killing a port owner.

## Topology (resolved 2026-10-23)

The visualizer is its **own branch, stacked additively on the sub-tunes feature**:

    feature/subtunes-as-first-class  992f0996b
            └── feature/visualizer   943209291   (8 files: the visualizer)
                    └── dev/overlay-visualizer   (feature + dev kit)

The visualizer was promoted to `feature/visualizer`; `feature/subtunes-as-first-class`
was restored to `992f0996b` and force-pushed (the visualizer must not be on it).
`./dev/overlay.sh visualizer plan` is clean ("Nothing to promote").

**The PR base.** The sub-tunes work is upstream **PR mmontag/chip-player-js#253**,
opened from the squash branch `pr/subtunes-as-first-class` (`a6cb63fe0`). That
squash is tree-identical to `feature/subtunes-as-first-class` (`992f0996b`), so
`git diff pr/subtunes-as-first-class..feature/visualizer` is exactly the 8
visualizer files. The eighth is `src/players/midi/midi-helpers.js` — a one-line
dev-doc comment cleanup; it is intentionally kept with the stack. **No PR has
been opened yet (2026-10-23).** While #253 is open, the visualizer PR will target
that squash branch (in our fork); after #253 merges upstream, rebase
`feature/visualizer` onto `master`, retarget the PR, and re-verify the diff is
still only the visualizer. The stack is deliberate: auto mode and the
song-folder behavior build on sub-tunes concepts (songdir), so do not rebase it
off master before #253 lands.

An off-`master` variant was tried and reverted on the way here: the visualizer UI
was developed against the sub-tunes tree, and the intended topology is a stack,
not a fork off master. Do not rebase the branch onto master without adapting
`Visualizer.js`/`Settings.js` (it uses `usesTrackLoops`, `showLoopArea`, and the
sub-tunes `UserProvider` defaults).

## Next steps to make it shippable

Dependency hygiene and topology are done. Remaining order: **browser check ->
lazy-load -> theater/optional.**

1. **Dependency/build hygiene — done and proven (2026-10-22).** Exact deps in
   `package.json` + lock, webpack back at 5.106.0, and a clean
   `npm ci --ignore-scripts` + `npm rebuild better-sqlite3` reproduces the tree
   with byte-identical manifests.
2. Lazy-load the module + presets (dynamic `import()`, like
   `localFilesSubtunes`) — the preset pack is several MB in the bundle.
3. Decide the setting surface: `visualizerRenderer` is persisted, but Auto/Blend
   are local; promote them if they should stick.
4. Theater/fullscreen: `activeTheaterMode` in `App.js` is `isMidi`-gated and must
   be generalized before MilkDrop can go full-screen.
5. A small preset pack (100 bundled) or a curated subset; texture packs need
   `loadExtraImages`.
6. **Test (browser, not node).** A `dev/record/check-milkdrop.mjs` +
   `dev/tests.manifest` entry asserting: the canvas paints (`readPixels` right
   after `render()`, not `toDataURL` — Butterchurn has no
   `preserveDrawingBuffer`), `▶` changes the preset, mesh/resolution reach the
   renderer (`renderer.width/height`, `mesh_width/height`), and the visualizer
   hides on Spectrogram. Headless WebGL2 needs SwiftShader.
7. Optional: input gain node before `connectAudio` for a "reactivity" control;
   `launchSongTitleAnim()` for the song title on preset changes;
   `toDataURL()` for "save frame".

## Layout and build hygiene (recommendations)

- **Treat `src/butterchurn/` as the module boundary**, the way `src/piano-roll/`
  already is (component + config/constants + helpers). `src/components/
  Visualizer.js` should stay a thin dispatcher, not accumulate renderer logic.
- **If a third renderer lands, replace the conditionals with a small descriptor
  registry** (`{ id, label, supports(song), Component }`) in `src/visualizers/`.
  Two renderers are fine as branches; three is where the switch should become
  data.
- **Namespace settings before they multiply.** `visualizerRenderer` +
  `milkdrop*` is fine for two renderers; a third wants
  `visualizer: { renderer, milkdrop: { mesh, resolution } }` (with a migration
  fallback for saved settings).
- **Lazy-load the optional renderer and its presets.** A dynamic
  `import('../butterchurn/ButterchurnVisualizer')` (with
  `React.lazy`/`Suspense`) puts
  Butterchurn + the preset pack in their own chunk instead of the main bundle.
  Import presets *inside* the module so they land in that chunk. Verify with a
  bundle report (`webpack --json` / the dev build's chunk list), not by eye.
- **Dependencies belong in `package.json` + the lockfile.** `--no-save` is a dev
  convenience; a feature that ships must not depend on it. Add
  `butterchurn`/`butterchurn-presets`, reconcile the webpack pin, and prove a
  clean `npm ci` still builds.
- **One optional area, one chunk.** Avoid a shared barrel (`src/visualizers/
  index.js`) that re-exports heavy renderers, or the main bundle pulls them back
  in. Export the descriptors (cheap) separately from the components (lazy).
- **Test the seam, not the library.** Node harnesses cannot reach WebGL; put the
  browser assertions in `dev/record/check-*.mjs` + `dev/tests.manifest`, and
  keep non-WebGL logic (preset wrapping, mesh parsing) pure so it *can* be
  node-tested.
- **Keep engines isolated.** If projectM is ever pursued, it is a separate wasm
  module with its own GL context — never folded into `chip-core`. Same rule the
  audio engines already follow.
- **Record provenance.** `butterchurn` / `butterchurn-presets` are MIT; preset
  packs and texture packs have their own licenses and must be checked before
  bundling.

## Not done / not attempted

- No changes to `App.js` (the visualizer props were sufficient).
- **No PR opened yet (2026-10-23).** The branch is pushed; the PR plan (base and
  post-#253 retarget) is in "Topology".
- No browser-level check yet; that is the next step.
- No MilkDrop3 or projectM integration (see the research above).
