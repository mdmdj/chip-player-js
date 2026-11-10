// DEV-ONLY: render a curated set of whole-app 60 fps MilkDrop clips.
//
//   node dev/record/clip-batch.mjs [--seconds 30] [--force] [--jobs 3]
//
// Each clip is one track/preset combination from the local demo catalog. Each
// worker gets its own proto60 --work directory, so frames/audio cannot collide;
// --jobs > 1 trades memory and CPU for wall time. A failed take is recorded in
// the manifest and the batch continues, so one bad preset does not discard the
// rest.
//
// The output is not meant to be committed: .work/proto60 is gitignored. The
// gallery (index.html) and manifest.json are written beside the clips for
// review, and the script itself is the reproducible recipe.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, 'dev/record/.work/proto60');
const CLIPS = path.join(WORK, 'clips');
const PROTO = path.join(ROOT, 'dev/record/proto60.mjs');
const require = createRequire(import.meta.url);
const PRESET_NAMES = Object.keys(require('butterchurn-presets').getPresets());

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const SECONDS = Number(arg('seconds', '30'));
const THEME = arg('theme', 'winamp');
const JOBS = Math.max(1, Number(arg('jobs', '1')));
const FORCE = argv.includes('--force');
const ONLY = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--only') ONLY.push(argv[++i]);
}

// One preset per track, chosen to span the visualizer's range rather than to
// repeat variants of the same look: organic (Desert Rose, Songflower), fire,
// neon, geometric (cubes, reaction diffusion), space and paint.
const COMBOS = [
  { slug: 'icecap', song: 'Yxw_FUQY', title: 'IceCap Zone Act 1', game: 'Sonic the Hedgehog 3', preset: 0 },
  { slug: 'aquatic', song: '9BBFyT6b', title: 'Aquatic Ambiance', game: 'Donkey Kong Country', preset: 5 },
  { slug: 'go-straight', song: 'f-lxtjVr', title: 'Go Straight', game: 'Streets of Rage 2', preset: 25 },
  { slug: 'stardust', song: 'BkacT5W2', title: 'Stardust Memories', game: 'Jester / Protracker', preset: 97 },
  { slug: 'monty', song: 'tPo_CwOM', title: 'Monty on the Run', game: 'C64 arrangement / XM', preset: 57 },
  { slug: 'dodonpachi', song: 'j5FrNjVz', title: 'Stage 1 & 4 BGM', game: 'DoDonPachi', preset: 16 },
  { slug: 'guile', song: '6QaDUOXj', title: 'Guile', game: 'Street Fighter II', preset: 47 },
  { slug: 'outrun', song: 'LONp2_I2', title: 'Magical Sound Shower', game: 'OutRun', preset: 92 },
  { slug: 'brinstar', song: '3rBxMC0C', title: 'Brinstar', game: 'Super Metroid', preset: 68 },
  { slug: 'megalovania', song: '4hrcdygn', title: 'Megalovania', game: 'Undertale', preset: 98 },
];

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
    child.on('error', (e) => {
      console.error(e);
      resolve(1);
    });
  });
}

function probe(file) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'error',
      '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=width,height,avg_frame_rate,duration,nb_read_frames',
      '-of', 'json', file], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      try {
        resolve(JSON.parse(out).streams?.[0] || {});
      } catch {
        resolve({});
      }
    });
  });
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function main() {
  fs.mkdirSync(CLIPS, { recursive: true });
  const selected = ONLY.length ? COMBOS.filter((c) => ONLY.includes(c.slug)) : COMBOS;
  if (!selected.length) throw new Error(`no combo matches --only ${ONLY.join(',')}`);
  const results = [];
  const expectedFrames = Math.round(SECONDS * 60);
  const renderCombo = async (c, index, total) => {
    const name = `${c.slug}-p${c.preset}-60fps.mp4`;
    const out = path.join(CLIPS, name);
    const presetName = PRESET_NAMES[c.preset] || `preset ${c.preset}`;
    console.log(`\n[${index}/${total}] ${c.title} / ${presetName}`);
    let ok = fs.existsSync(out) && fs.statSync(out).size > 0;
    if (!ok || FORCE) {
      const worker = path.join(WORK, 'workers', c.slug);
      const code = await run(process.execPath, [
        PROTO, '--whole', '--seconds', String(SECONDS), '--theme', THEME,
        '--work', worker, '--out', out,
        '--song', c.song, '--preset', String(c.preset),
      ]);
      ok = code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
    } else {
      console.log(`  exists, skipping (${name})`);
    }
    const v = ok ? await probe(out) : {};
    const result = {
      ...c,
      presetName,
      output: path.relative(WORK, out),
      seconds: SECONDS,
      pass: ok && v.avg_frame_rate === '60/1' && Number(v.nb_read_frames) === expectedFrames,
      width: Number(v.width) || null,
      height: Number(v.height) || null,
      frames: Number(v.nb_read_frames) || null,
      duration: Number(v.duration) || null,
      bytes: ok ? fs.statSync(out).size : null,
    };
    if (!result.pass) console.error(`  FAILED: ${name}`);
    results.push(result);
  };

  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const i = next++;
      await renderCombo(selected[i], i + 1, selected.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, selected.length) }, worker));

  // A `--only` run should still rebuild the full gallery from the clips already
  // on disk, so adding one missing combo does not hide the other ten.
  for (const c of COMBOS) {
    if (results.some((r) => r.slug === c.slug)) continue;
    const name = `${c.slug}-p${c.preset}-60fps.mp4`;
    const out = path.join(CLIPS, name);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) continue;
    const v = await probe(out);
    results.push({
      ...c,
      presetName: PRESET_NAMES[c.preset] || `preset ${c.preset}`,
      output: path.relative(WORK, out),
      seconds: SECONDS,
      pass: v.avg_frame_rate === '60/1' && Number(v.nb_read_frames) === expectedFrames,
      width: Number(v.width) || null,
      height: Number(v.height) || null,
      frames: Number(v.nb_read_frames) || null,
      duration: Number(v.duration) || null,
      bytes: fs.statSync(out).size,
    });
  }
  results.sort((a, b) => COMBOS.findIndex((c) => c.slug === a.slug) - COMBOS.findIndex((c) => c.slug === b.slug));

  const passed = results.filter((r) => r.pass);
  const manifest = { generated: new Date().toISOString(), seconds: SECONDS, clips: results };
  fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const cards = results.map((r) => {
    const label = `${r.title} — ${r.game}`;
    const meta = `${r.presetName} · ${r.frames || '?'} frames · ${(r.duration || 0).toFixed(3)} s`;
    if (!r.pass) {
      return `<article class="card fail"><h2>${htmlEscape(label)}</h2><p>${htmlEscape(meta)}</p><p>FAILED</p></article>`;
    }
    return `<article class="card">
  <video controls preload="metadata" width="900" height="720" src="${htmlEscape(r.output)}"></video>
  <h2>${htmlEscape(label)}</h2>
  <p>${htmlEscape(meta)}</p>
</article>`;
  }).join('\n');

  fs.writeFileSync(path.join(WORK, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>MilkDrop track × preset clips</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #080a14; color: #d8e0ff; font: 14px/1.4 ui-monospace, monospace; }
  h1 { font-size: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 18px; }
  .card { border: 1px solid #2a3560; background: #0c1020; padding: 10px; }
  .card video { display: block; width: 100%; height: auto; background: #000; }
  .card h2 { margin: 10px 0 2px; font-size: 15px; }
  .card p { margin: 2px 0; color: #8f9bc4; font-size: 12px; }
  .card.fail { border-color: #6b2020; }
</style>
<h1>MilkDrop track × preset clips — ${passed.length}/${results.length} passed</h1>
<p>${SECONDS}s whole app, ${htmlEscape(THEME)} theme, 60 fps CFR, 48 kHz stereo. Frame N uses the PCM window ending at N/60.</p>
<div class="grid">
${cards}
</div>`);

  console.log(`\n${passed.length}/${results.length} clips passed; gallery: ${path.join(WORK, 'index.html')}`);
  if (passed.length !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
