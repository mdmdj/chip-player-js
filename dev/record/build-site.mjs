// DEV-ONLY: build the static PR communication page (dev/record/README.md §9).
//
//   node dev/record/build-site.mjs [--out site] [--allow-failed]
//                                    [--text-only] [--clips id,id]
//
// Reads the clip registry, the recorded proof JSON, and the prose in site.mjs,
// and emits a self-contained upload directory: relative URLs only, no external
// requests, no framework. The maintainer uploads that directory to a web server
// and links it from the PR description.
//
// A clip is published only if it has all three: a muxed mp4, a proof JSON whose
// verdict passed, and prose. --allow-failed overrides the verdict gate (the clip
// still shows as unverified, loudly) because the point of the gate is to stop a
// broken take shipping by accident, not to make it impossible to look at one.
//
// Selective by default. Assembling the page is ~50ms; the two facts the HTML
// cannot state without looking at the encoded file -- its real dimensions and its
// poster frame -- cost an ffprobe and an ffmpeg pass per clip (measured: 1.6s and
// 4.2s for the 14 clips). Almost every change in the polish phase is to prose, a
// `watch` bullet or site.css, and none of those can move a poster, so both are
// cached against the clip's identity and reused when the clip was not
// re-recorded: re-running this after a one-word prose fix goes from 5.5s to
// ~0.1s. Poster encoding is deterministic -- the same input bytes give a
// byte-identical jpg -- so a reused poster is exactly the one a re-encode would
// produce. `--text-only` and `--clips` force the assumption instead of caching it.
//
// Snippets are extracted from the working tree at build time so they cannot
// drift from the code they describe: a line range that no longer exists fails the
// build rather than rendering an empty <pre>.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarios } from './scenarios.mjs';
import { prose, snippets, header, limitations } from './site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, 'dev/record/.work');

const argv = process.argv.slice(2);
const outDir = path.join(ROOT, argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'site');
const allowFailed = argv.includes('--allow-failed');
// Never touch ffmpeg/ffprobe at all. For iterating on prose and CSS, where the
// existing posters are already right for the clips on disk.
const textOnly = argv.includes('--text-only');
// Derive media facts for these ids only; every other clip takes them from the
// cache. For after re-recording one clip, where the other thirteen are known.
const onlyClips = (() => {
  const i = argv.indexOf('--clips');
  if (i === -1) return null;
  const ids = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error('--clips needs a comma-separated list of clip ids');
  return new Set(ids);
})();

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

// ---------------------------------------------------------------- snippets --
function extractSnippet(sn) {
  const file = path.join(ROOT, sn.file);
  if (!exists(file)) throw new Error(`snippet ${sn.id}: missing file ${sn.file}`);
  const lines = read(file).split('\n');
  const [from, to] = sn.lines;
  if (from < 1 || to > lines.length) {
    throw new Error(`snippet ${sn.id}: ${sn.file}:${from}-${to} is outside the file (${lines.length} lines)`);
  }
  const body = lines.slice(from - 1, to).join('\n');
  // Fail rather than render an empty block: a drifted range is a bug in the
  // registry, not something to paper over on the page.
  if (body.trim().length < 12) throw new Error(`snippet ${sn.id}: ${sn.file}:${from}-${to} extracted nothing`);
  return { ...sn, body, ref: `${sn.file}:${from}-${to}` };
}

let snippetError = null;
let snippetsOut = [];
try {
  snippetsOut = snippets.map(extractSnippet);
} catch (e) {
  snippetError = e.message;
}

// ------------------------------------------------------------------- clips --
const clipRows = [];
const skipped = [];
for (const s of scenarios) {
  const prose_ = prose[s.id];
  if (!prose_) continue; // no prose yet: not part of the page yet
  // `ready: false` withholds a clip whose take is on disk and whose verdict passed,
  // which is the case that needs a gate: the mp4 and the proof are both still there,
  // so every other check below would publish it. `scenarios.check.mjs` uses the same
  // flag to warn "not recorded yet", so setting it is the single switch for
  // withdrawing a clip from the page while keeping its definition.
  if (s.ready === false) { skipped.push(`${s.id}: ready:false (withdrawn from the page)`); continue; }
  const mp4 = path.join(outDir, 'clips', `${s.id}.mp4`);
  const proofPath = path.join(WORK, `${s.id}.proof.json`);
  if (!exists(mp4)) { skipped.push(`${s.id}: no clip recorded`); continue; }
  if (!exists(proofPath)) { skipped.push(`${s.id}: no proof json`); continue; }
  const proof = JSON.parse(read(proofPath));
  const failed = Object.entries(proof.verdict).filter(([, v]) => !v.pass).map(([k, v]) => `${k}${v.detail ? ` — ${v.detail}` : ''}`);
  if (failed.length && !allowFailed) { skipped.push(`${s.id}: verdict failed (${failed.join('; ')})`); continue; }
  clipRows.push({ s, proof, failed, mp4: `clips/${s.id}.mp4` });
}

// ------------------------------------------------------------------- media --
//
// The two facts the HTML needs from the *encoded* file rather than from the proof
// JSON: its real dimensions and its poster frame. Both are cached against the
// clip's identity, so a build that changes no video re-derives none of them.
//
// The cache key is size + mtime + the poster's seek time. mtime is load-bearing
// on its own: re-recording a clip can produce a byte-identical file (the encoder
// is deterministic), and a size-only key would then keep serving the old poster
// for a new take. Keying on the seek time too means editing a scenario's marks
// re-frames its poster instead of quietly leaving the previous frame.
//
// Nothing here trusts the cache blindly: the hit also requires the poster to still
// be on disk, so a deleted one is re-framed rather than assumed. And that repair
// happens even under --text-only -- a missing poster is damage, not a cost
// decision, and the flags exist to skip *avoidable* work. Otherwise --text-only
// after `rm site/posters/*` would bless a page of broken images.

// Clip dimensions come from ffprobe, not from the video element's own metadata: with
// preload="none" the element has no intrinsic size until it is asked to play, so
// `width:100%; height:auto` would collapse every clip row to nothing and then jump.
// The width/height attributes reserve the box up front, which is what they are for.
// Collected here, before the HTML is assembled -- clipHtml reads it, so declaring it
// further down is a temporal-dead-zone ReferenceError.
const cachePath = path.join(outDir, '.buildcache.json');
let cache = {};
try { cache = JSON.parse(read(cachePath)); } catch { /* first build, or unreadable: derive everything */ }

const dims = new Map();
const reencoded = [];
const repaired = [];
const deferred = [];

fs.mkdirSync(path.join(outDir, 'posters'), { recursive: true });
for (const { s, mp4 } of clipRows) {
  const src = path.join(outDir, mp4);
  const dst = path.join(outDir, 'posters', `${s.id}.jpg`);
  // A mark a little past the midpoint: past the loading, before the end. The
  // published clip starts *after* the sync mark, so a poster from t=0 is a black
  // frame with a spinner.
  const markTimes = (s.marks || []).map((m) => m.t).filter((t) => Number.isFinite(t));
  const at = markTimes.length ? markTimes[Math.floor(markTimes.length / 2)] / 1000 : 1;
  const st = fs.statSync(src);
  const key = `${st.size}:${Math.round(st.mtimeMs)}:${at}`;

  const hit = cache[s.id];
  const posterExists = exists(dst);
  if (hit && hit.key === key && posterExists) {
    if (hit.dims) dims.set(s.id, hit.dims);
    continue;
  }

  const mustRepair = !posterExists;
  if (!mustRepair && (textOnly || (onlyClips && !onlyClips.has(s.id)))) {
    // Asked not to spend time here. Keep whatever dims the last full build
    // found, so the layout stays reserved, and leave the existing poster alone:
    // it is still a real frame of the clip that is on disk.
    if (hit && hit.key === key && hit.dims) dims.set(s.id, hit.dims);
    deferred.push(s.id);
    continue;
  }
  if (mustRepair) repaired.push(s.id);

  let d = null;
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
      'stream=width,height', '-of', 'csv=p=0', src], { encoding: 'utf8' }).trim();
    const [w, h] = out.split(',').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) { d = { w, h }; dims.set(s.id, d); }
  } catch { /* leave it out; the poster still renders */ }

  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', src, '-frames:v', '1',
      '-vf', 'scale=900:-1', '-q:v', '4', dst], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.warn(`poster failed for ${s.id}: ${String(e.message).split('\n')[0]}`);
  }

  cache[s.id] = { key, dims: d };
  reencoded.push(s.id);
}

// Posters exist because the video elements use preload="none" (see clipHtml). With
// preload="metadata" the page asked the server for all 14 clips on load -- measured
// 35.4 MB, every request answered with the whole file, because a browser's metadata
// probe is an open-ended `Range: bytes=0-` and the moov is at the front (faststart)
// so the browser cancels after a few KB but the server has already streamed the lot.
// On HTTP/1.1's six-connections-per-host limit, eight of the fourteen requests queue,
// and clicking play on a queued element can stall: exactly the "inconsistent, some
// clips never start" report. preload="none" plus a poster fetches nothing until a
// click, and gives the page a first frame to show instead of a black box.
// ------------------------------------------------------------------- pages --
// What the clip is playing. Most scenarios pin one fixture; the navigation clips
// (songfolder, favorite-subtune) open several rows by name instead, so for those
// fall back to the rows the script actually clicks rather than printing "—", which
// reads as "we lost track" rather than "this clip is about more than one file".
function fixtureLabel(s) {
  if (s.fixture) return s.fixture;
  if (s.preload) return `${s.preload.dir}/${s.preload.name}`;
  const opens = (s.steps || []).map((st) => st.open).filter(Boolean);
  if (opens.length === 1) return `${opens[0].dir}/${opens[0].name}`;
  if (opens.length > 1) return `${opens.length} rows, opened by name`;
  return '—';
}

function clipHtml({ s, proof, failed, mp4 }) {
  const bullets = s.watch.map((w) => `<li>${esc(w)}</li>`).join('\n            ');
  const before = prose[s.id].before
    ? `<p class="before"><strong>Before:</strong> ${esc(prose[s.id].before)}</p>`
    : '';
  const checks = Object.entries(proof.verdict).map(([k, v]) =>
    `<tr class="${v.pass ? 'ok' : 'bad'}"><td>${esc(k)}</td><td>${v.pass ? 'pass' : `FAIL — ${esc(String(v.detail || ''))}`}</td></tr>`).join('\n              ');
  const marks = (proof.marks || []).filter((m) => m.label !== 'start' && m.label !== 'clip start')
    .map((m) => `<li><code>${(m.t / 1000).toFixed(2)}s</code> ${esc(m.label)}</li>`).join('\n                ');
  const nums = [
    ['engine', proof.final && proof.final.player],
    ['position', proof.final && proof.final.positionMs != null ? `${Math.round(proof.final.positionMs)} ms` : null],
    ['display', proof.final && proof.final.displayMs != null ? `${Math.round(proof.final.displayMs)} ms` : null],
    ['duration', proof.final && proof.final.durationMs != null ? `${Math.round(proof.final.durationMs)} ms` : null],
    // Rounded: the band comes from the engine in fractional ms, and this is a
    // number a reader compares against the marks on the slider, not raw telemetry.
    ['loop band', proof.final && proof.final.band ? `${Math.round(proof.final.band.startMs)}–${Math.round(proof.final.band.endMs)} ms` : null],
    ['tempo', proof.final && proof.final.tempo],
  ].filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<span><em>${esc(k)}</em> ${esc(String(v))}</span>`).join('\n            ');
  const d = dims.get(s.id);
  return `      <article class="clip" id="${esc(s.id)}">
        <div class="clip-media">
          <video${d ? ` width="${d.w}" height="${d.h}"` : ''} controls preload="none" playsinline poster="posters/${esc(s.id)}.jpg" src="${esc(mp4)}"></video>
        </div>
        <div class="clip-text">
          <h3>${esc(prose[s.id].title || s.title)}</h3>
          ${before}
          <ul class="watch">
            ${bullets}
          </ul>
          <div class="numbers">${nums}</div>
          <details>
            <summary>proof${failed.length ? ' — FAILED' : ''}</summary>
            <table class="verdict">
              <tbody>
              ${checks}
              </tbody>
            </table>
            <p class="marks-title">what the clip did, on its own clock</p>
            <ul class="marks">
                ${marks}
            </ul>
            <p class="src"><span class="clip-id">clip id: <code>${esc(s.id)}</code></span> · fixture: <code>${esc(fixtureLabel(s))}</code>${s.harness ? ` · harness: <code>${esc(s.harness)}</code>` : ''}</p>
            <p class="src">recorded with <code>node dev/record/shoot.mjs --clip ${esc(s.id)}</code></p>
          </details>
        </div>
      </article>`;
}

function snippetHtml(sn) {
  return `      <article class="snippet" id="${esc(sn.id)}">
        <h3>${esc(sn.title)}</h3>
        <p>${sn.why}</p>
        <p class="src"><code>${esc(sn.ref)}</code></p>
        <pre><code>${esc(sn.body)}</code></pre>
      </article>`;
}

const mainClips = clipRows.filter((c) => c.s.section === 'main');
const deepClips = clipRows.filter((c) => c.s.section === 'deep');
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The per-format section is grouped by *mechanism*, not by format. That ordering is
// the argument: there are only so many ways the app can keep a song going, they have
// genuinely different costs, and a reader who sees all of VGM, all of MDX and all of
// MIDI together has to infer that. The four groups also run cheapest-to-dearest, so
// the section ends on the fallback and the reader finishes knowing what happens when
// nothing better is available.
//
// `note` is optional per group and renders as a subheading under the title; it
// carries the detail that does not belong in a heading but a reader needs in order
// to place the group.
const DEEP_GROUPS = [
  { key: 'native', title: 'Native loops at load', note: null },
  { key: 'indefinite', title: 'Indefinite playback looping', note: 'Now with consistent song-ending silence detection, following GME' },
  { key: 'learned', title: 'Learned loops', note: null },
  {
    key: 'floor',
    title: 'The default: repeat the whole song',
    // The point of this group is forward-looking, and it is why the clip is here
    // even though the format is unchanged from master: with nothing to implement,
    // the Sequencer's own Repeat One stands -- it never advances currIdx, so it
    // replays the file. A new format inherits that for free, so "add a format" and
    // "make it loop well" are separate pieces of work.
    note: 'No loop points and no loop API here, so Repeat One falls back to what it always did: play the song, then start it again. A format added tomorrow gets this for free.',
  },
];
// Grouped by declaration order above, not by registry order, so adding a clip never
// reshuffles the page. A group with no clips is skipped rather than rendered empty.
const deepByGroup = DEEP_GROUPS
  .map((g) => ({ ...g, clips: deepClips.filter((c) => c.s.group === g.key) }))
  .filter((g) => g.clips.length);
const ungrouped = deepClips.filter((c) => !DEEP_GROUPS.some((g) => g.key === c.s.group));
// Loud, because the failure is invisible: a clip with an unrecognised group drops out
// of the page's section ordering with no error anywhere, and the page still looks
// finished. scenarios.check.mjs rejects unknown groups at the source, so reaching
// here means the two lists disagree.
if (ungrouped.length) {
  console.warn(`WARNING: ${ungrouped.length} deep clip(s) have no known group and are not rendered in a subheading: ${ungrouped.map((c) => c.s.id).join(', ')}`);
}

const deepHtml = deepByGroup.map((g) => `    <h3 class="group-title">${esc(g.title)}<span class="group-count">${g.clips.length}</span></h3>
${g.note ? `    <p class="group-note">${esc(g.note)}</p>` : ''}
${g.clips.map(clipHtml).join('\n')}`).join('\n\n');


const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(header.title)}</title>
<style>${read(path.join(ROOT, 'dev/record/site.css'))}</style>
</head>
<body>
  <header>
    <h1>${esc(header.title)}</h1>
    <p class="lede">${header.lede}</p>
    <p class="meta">${esc(header.pr)} · recorded from the feature branch, not from master</p>
  </header>

  <nav>
    <a href="#main">One clip per change</a>
    <a href="#deep">Per format</a>
    <a href="#snippets">Code</a>
    <a href="#limits">Limits</a>
  </nav>

  <section id="main">
    <h2>What changed</h2>
    <p class="section-note">${count(mainClips.length, 'clip', 'clips')}, one per user-visible change. Every clip carries its own audio, and every claim below it is checked by the numbers in its <em>proof</em> block — the recordings are evidence, not decoration.</p>
${mainClips.map(clipHtml).join('\n')}
  </section>

  <section id="deep">
    <h2>Per format and per variant</h2>
    <p class="section-note">The same short script on every engine, grouped by <em>how</em> the loop works rather than by format — because there are only so many mechanisms, and knowing which one a format gets is the useful part. The point of this section is to show where the change reaches and where it stops.</p>
${deepHtml}
  </section>

  <section id="snippets">
    <h2>What video cannot show</h2>
    <p class="section-note">Data model, engine exports and the emulator-parity checks. Each block is extracted from the tree at build time, with the file and line range it came from.</p>
${snippetsOut.map(snippetHtml).join('\n')}
  </section>

  <section id="limits">
    <h2>Known limits</h2>
    <ul>
${limitations.map((l) => `      <li>${l}</li>`).join('\n')}
    </ul>
  </section>

  <footer>
    <p>Every clip was recorded from the dev build of the feature branch. <em>Before</em> lines describe master, from the diff — no clip was recorded from master.</p>
  </footer>
</body>
</html>
`;

fs.mkdirSync(path.join(outDir, 'clips'), { recursive: true });
// Only rewrite when the bytes actually differ. serve.mjs sends the HTML with
// `no-cache`, so a fresh mtime means the browser revalidates and gets a new ETag
// for an identical page; skipping the write keeps a no-op build a genuine no-op,
// which is what makes "did that change anything?" answerable during polish.
const htmlPath = path.join(outDir, 'index.html');
if (!exists(htmlPath) || read(htmlPath) !== html) fs.writeFileSync(htmlPath, html);

// Drop cache entries for clips that are no longer published, so the file cannot
// grow a record of takes that were removed from the page.
let cacheChanged = false;
for (const id of Object.keys(cache)) {
  if (!clipRows.some((c) => c.s.id === id)) { delete cache[id]; cacheChanged = true; }
}
if (cacheChanged || reencoded.length) {
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1));
}

const manifest = {
  generated: new Date().toISOString(),
  clips: clipRows.map(({ s, proof, failed }) => ({
    id: s.id, section: s.section, title: prose[s.id].title || s.title,
    fixture: s.fixture || (s.preload && `${s.preload.dir}/${s.preload.name}`) || null,
    harness: s.harness || null,
    verified: failed.length === 0,
    failed,
    verdict: proof.verdict,
    marks: proof.marks,
    final: proof.final,
  })),
  snippets: snippetsOut.map((s) => ({ id: s.id, ref: s.ref })),
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

// ------------------------------------------------------------------ report --
console.log(`site: ${path.relative(ROOT, outDir)}/index.html — ${clipRows.length} clip(s) published (${mainClips.length} main, ${deepClips.length} per-format), ${snippetsOut.length} snippet(s)`);
// Say what the media pass actually did. A build that silently reuses a stale
// poster is the failure mode worth being loud about, so the reused count is
// reported next to the derived one -- and a deferred or repaired clip is named,
// never hidden.
console.log(`media: ${reencoded.length} clip(s) re-probed + re-framed, ${clipRows.length - reencoded.length - deferred.length} reused from cache`
  + `${repaired.length ? `, ${repaired.length} poster(s) missing and re-framed anyway (${repaired.join(', ')})` : ''}`
  + `${deferred.length ? `, ${deferred.length} deferred (${deferred.join(', ')})` : ''}`);
if (skipped.length) {
  console.log(`not published (${skipped.length}):`);
  for (const s of skipped) console.log(`  - ${s}`);
}
if (snippetError) console.log(`snippet error: ${snippetError}`);
if (allowFailed && clipRows.some((c) => c.failed.length)) console.log('WARNING: --allow-failed published unverified clips');
process.exit(snippetError && !allowFailed ? 1 : 0);