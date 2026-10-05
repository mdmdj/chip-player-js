// DEV-ONLY: build the static PR communication page (dev/record/README.md §9).
//
//   node dev/record/build-site.mjs [--out site] [--allow-failed]
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
// Snippets are extracted from the working tree at build time so they cannot
// drift from the code they describe: a line range that no longer exists fails the
// build rather than rendering an empty <pre>.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarios } from './scenarios.mjs';
import { prose, snippets, header, limitations } from './site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, 'dev/record/.work');

const argv = process.argv.slice(2);
const outDir = path.join(ROOT, argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'site');
const allowFailed = argv.includes('--allow-failed');

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
  const mp4 = path.join(outDir, 'clips', `${s.id}.mp4`);
  const proofPath = path.join(WORK, `${s.id}.proof.json`);
  if (!exists(mp4)) { skipped.push(`${s.id}: no clip recorded`); continue; }
  if (!exists(proofPath)) { skipped.push(`${s.id}: no proof json`); continue; }
  const proof = JSON.parse(read(proofPath));
  const failed = Object.entries(proof.verdict).filter(([, v]) => !v.pass).map(([k, v]) => `${k}${v.detail ? ` — ${v.detail}` : ''}`);
  if (failed.length && !allowFailed) { skipped.push(`${s.id}: verdict failed (${failed.join('; ')})`); continue; }
  clipRows.push({ s, proof, failed, mp4: `clips/${s.id}.mp4` });
}

// ------------------------------------------------------------------- pages --
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
    ['loop band', proof.final && proof.final.band ? `${proof.final.band.startMs}–${proof.final.band.endMs} ms` : null],
    ['tempo', proof.final && proof.final.tempo],
  ].filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<span><em>${esc(k)}</em> ${esc(String(v))}</span>`).join('\n            ');
  return `      <article class="clip" id="${esc(s.id)}">
        <div class="clip-media">
          <video controls preload="metadata" playsinline src="${esc(mp4)}"></video>
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
            <p class="src">fixture: <code>${esc(s.fixture || (s.preload && `${s.preload.dir}/${s.preload.name}`) || '—')}</code>${s.harness ? ` · harness: <code>${esc(s.harness)}</code>` : ''}</p>
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
    <p class="section-note">The same short script on every engine, so the mechanisms can be compared. The point of this section is to show where the change reaches and where it stops.</p>
${deepClips.map(clipHtml).join('\n')}
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
fs.writeFileSync(path.join(outDir, 'index.html'), html);

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
if (skipped.length) {
  console.log(`not published (${skipped.length}):`);
  for (const s of skipped) console.log(`  - ${s}`);
}
if (snippetError) console.log(`snippet error: ${snippetError}`);
if (allowFailed && clipRows.some((c) => c.failed.length)) console.log('WARNING: --allow-failed published unverified clips');
process.exit(snippetError && !allowFailed ? 1 : 0);