// DEV-ONLY prototype: deterministic 60 fps MilkDrop clip with synced audio.
//
//   node dev/record/proto60.mjs [--song Yxw_FUQY] [--seconds 8] [--preset 0]
//
// Why this exists
// ---------------
// shoot.mjs uses Playwright's recordVideo, which is a variable-rate ~25 fps
// screencast. mux.sh can make the container CFR, but it cannot invent the
// missing frames. This prototype takes the other route: record the app's real
// audio once, then render each video frame by hand at exactly 1/60 s and mux
// the same PCM back in. Frame N always covers [N/60, (N+1)/60) and frame 0 is
// sample 0, so A/V sync is a construction property rather than something a
// flash has to be found and trimmed after the fact.
//
// Butterchurn accepts `render({ audioLevels, elapsedTime })`. `audioLevels` is
// the same three 1024-byte time-domain arrays an AnalyserNode would supply, and
// elapsedTime is a delta in seconds. That lets us run the visualizer faster (or
// slower) than real time without changing what it sees. The canvas has no
// preserveDrawingBuffer, so each frame is read back with gl.readPixels inside
// the same task as render(), then encoded as JPEG for ffmpeg. The browser never
// captures video, so there is no screencast clock involved.
//
// Audio still has to come from the running app: chiptune formats are not
// decodable with decodeAudioData, and rendering the engine offline is a much
// larger change. We therefore record one real-time opus take from the app's
// gain node, decode it to a canonical 48 kHz PCM WAV, and use exactly that PCM
// for both the audio mux and the analyzer windows. The first sample of the take
// is frame 0.
//
// This is a prototype, not the clip pipeline yet: it captures the MilkDrop
// canvas only (the useful content for these clips), and it needs a dev-only
// `window.__cpMilkdrop` hook in src/butterchurn/ButterchurnVisualizer.js. That
// hook is inside a DEV-BEGIN/DEV-END region and is stripped from the PR.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.RECORD_BASE || 'http://mms-1:8301';
const OUT = path.join(ROOT, 'dev/record/.work/proto60');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const SONG = arg('song', 'Yxw_FUQY'); // IceCap Zone Act 1 (Sonic 3, VGM)
const SECONDS = Number(arg('seconds', '8'));
const PRESET = Number(arg('preset', '0'));
const OUT_NAME = arg('out', 'icecap-60fps.mp4');
const WIDTH = 720;
const HEIGHT = 720;
const FPS = 60;
const RATE = 48000;
const WINDOW = 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})\n${r.stderr || ''}`);
  }
  return r.stdout;
}

function ffprobe(file, select, entries, countFrames = false) {
  const out = run('ffprobe', ['-v', 'error', ...(countFrames ? ['-count_frames'] : []),
    '-select_streams', select, '-show_entries', `stream=${entries}`, '-of', 'json', file]);
  return JSON.parse(out).streams?.[0] || {};
}

// ffmpeg's WAV is pcm_s16le and may contain LIST/fact chunks, so walk the
// chunks rather than assuming a 44-byte header.
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = b.subarray(body, body + size);
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data chunk');
  if (fmt.bits !== 16) throw new Error(`expected pcm_s16le, got ${fmt.bits}-bit`);
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
    right[i] = fmt.channels > 1
      ? data.readInt16LE((i * 2 + 1) * fmt.channels) / 32768
      : left[i];
  }
  return { rate: fmt.rate, channels: fmt.channels, left, right, frames };
}

const toByte = (x) => Math.max(0, Math.min(255, Math.round(128 + x * 127)));

// AnalyserNode semantics: the window ends at the current playback time. At
// frame 0 there is no past, so the window is zero-padded; every later window is
// the 1024 samples immediately before t = frame / 60.
function levelsAt(pcm, frame) {
  const end = Math.round((frame * pcm.rate) / FPS);
  const start = end - WINDOW;
  const mono = new Array(WINDOW);
  const l = new Array(WINDOW);
  const r = new Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) {
    const idx = start + i;
    let a = 0;
    let bb = 0;
    if (idx >= 0 && idx < pcm.frames) {
      a = pcm.left[idx];
      bb = pcm.right[idx];
    }
    mono[i] = toByte((a + bb) / 2);
    l[i] = toByte(a);
    r[i] = toByte(bb);
  }
  return { timeByteArray: mono, timeByteArrayL: l, timeByteArrayR: r };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const framesDir = path.join(OUT, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  for (const f of ['take.webm', 'take.wav', 'summary.json', OUT_NAME]) {
    fs.rmSync(path.join(OUT, f), { force: true });
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      // Keep the WebGL context alive for readPixels and make software WebGL a
      // predictable fallback in a headless host without a GPU.
      '--use-angle=swiftshader',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[page]', m.text().slice(0, 300));
  });

  try {
    const target = new URL(`/?play=${SONG}`, BASE);
    target.searchParams.set('r', String(Date.now()));
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__cpRec && !!window.__cpDev, null, { timeout: 30000 });
    await page.evaluate(() => window.__cpRec.pinDefaults({
      showVisualizer: true,
      showPlayerSettings: false,
      theme: 'msdos',
    }));

    // Turn the visualizer on (it may be off from persisted settings), then pick
    // MilkDrop. The lazy chunk is what creates the Butterchurn instance.
    await page.evaluate(() => {
      const on = document.querySelector('#vis-on');
      if (on && !on.checked) on.click();
    });
    await page.waitForSelector('#visualizer-renderer', { timeout: 15000 });
    await page.selectOption('#visualizer-renderer', 'milkdrop');
    await page.waitForFunction(() => window.__cpMilkdrop?.visualizer, null, { timeout: 45000 });

    // Force a square backing store. The component's ResizeObserver calls
    // setRendererSize, which resizes Butterchurn's targets and the canvas. Wait
    // for that to settle before loading a preset so shader uniforms see the
    // final dimensions.
    await page.evaluate(({ w, h }) => {
      const comp = window.__cpMilkdrop;
      const canvas = comp.canvasRef.current;
      const wrap = canvas.closest('.MilkDrop');
      wrap.style.width = `${w}px`;
      wrap.style.height = `${h}px`;
      wrap.style.minHeight = `${h}px`;
      wrap.style.flex = '0 0 auto';
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // The stylesheet gives this canvas margin-left: 1px so it does not sit on
      // the border. At an exact 720px target that rounds the resize-observer
      // width to 719, so drop the margin for the recorder.
      canvas.style.marginLeft = '0px';
    }, { w: WIDTH, h: HEIGHT });
    await sleep(600);
    const dims = await page.evaluate(() => {
      const c = window.__cpMilkdrop.canvasRef.current;
      const gl = c.getContext('webgl2');
      return { css: [c.clientWidth, c.clientHeight], buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight] };
    });
    if (dims.buffer[0] !== WIDTH || dims.buffer[1] !== HEIGHT) {
      throw new Error(`canvas is ${dims.buffer.join('x')}, expected ${WIDTH}x${HEIGHT}`);
    }

    // Park the normal rAF loop. Presets auto-cycle every 20 s and the loop would
    // otherwise interleave its own render() calls (and real-time audio samples)
    // with the deterministic ones.
    await page.evaluate((preset) => {
      const comp = window.__cpMilkdrop;
      comp.stop();
      comp.loadPresetAt(preset, 0);
    }, PRESET);
    await sleep(300);

    // Seek to the top so the audio take starts at the song's beginning, then
    // record its real output. Recording is the only real-time part of this
    // prototype; the video afterward is completely decoupled from the clock.
    const audio = await page.evaluate(async (durationMs) => {
      const app = window.ChipPlayer;
      const ctx = app.audioCtx;
      await ctx.resume();
      window.__cpDev.seek(0);
      window.__cpDev.play();
      await new Promise((r) => setTimeout(r, 250));

      const dest = ctx.createMediaStreamDestination();
      app.gainNode.connect(dest);
      const chunks = [];
      const rec = new MediaRecorder(dest.stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 192000,
      });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((resolve) => { rec.onstop = resolve; });
      rec.start(100);
      await new Promise((r) => setTimeout(r, durationMs));
      rec.stop();
      await stopped;
      app.gainNode.disconnect(dest);
      window.__cpDev.pause();

      const blob = new Blob(chunks, { type: rec.mimeType });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      return { b64: btoa(bin), bytes: buf.length, mime: rec.mimeType };
    }, Math.round(SECONDS * 1000));

    if (!audio.bytes) throw new Error('audio take is empty');
    const webm = path.join(OUT, 'take.webm');
    const wav = path.join(OUT, 'take.wav');
    fs.writeFileSync(webm, Buffer.from(audio.b64, 'base64'));
    run('ffmpeg', ['-y', '-v', 'error', '-i', webm, '-vn', '-ac', '2', '-ar', String(RATE),
      '-c:a', 'pcm_s16le', wav]);
    const pcm = readWav(wav);
    const duration = pcm.frames / pcm.rate;
    const frameCount = Math.min(Math.floor(duration * FPS), Math.round(SECONDS * FPS));
    if (frameCount < FPS) throw new Error(`only ${frameCount} frames of audio decoded`);
    console.log(`audio ${audio.bytes} bytes -> ${pcm.frames} samples (${duration.toFixed(3)}s); rendering ${frameCount} frames`);

    // Fresh visualizer clock. loadPreset() does not reset time, and the opening
    // rAF loop already advanced it; force every value the render equations read.
    await page.evaluate(() => {
      const v = window.__cpMilkdrop.visualizer;
      v.time = 0;
      v.presetTime = 0;
      v.frameNum = 0;
      v.fps = 60;
      v.blending = false;
      v.timeHist = [0];
      v.lastTime = performance.now();
    });

    const started = Date.now();
    for (let frame = 0; frame < frameCount; frame++) {
      const levels = levelsAt(pcm, frame);
      const dataUrl = await page.evaluate(async ({ lev }) => {
        const comp = window.__cpMilkdrop;
        const v = comp.visualizer;
        const canvas = comp.canvasRef.current;
        const gl = canvas.getContext('webgl2');
        v.fps = 60;
        v.render({ audioLevels: lev, elapsedTime: 1 / 60 });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        if (!window.__cpFrameBuf || window.__cpFrameBuf.length !== w * h * 4) {
          window.__cpFrameBuf = new Uint8Array(w * h * 4);
          window.__cpFrameCanvas = document.createElement('canvas');
          window.__cpFrameCanvas.width = w;
          window.__cpFrameCanvas.height = h;
          window.__cpFrameCtx = window.__cpFrameCanvas.getContext('2d');
          window.__cpFrameImg = window.__cpFrameCtx.createImageData(w, h);
        }
        const buf = window.__cpFrameBuf;
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const img = window.__cpFrameImg;
        const dst = img.data;
        const stride = w * 4;
        for (let y = 0; y < h; y++) {
          const src = (h - 1 - y) * stride;
          const out = y * stride;
          dst.set(buf.subarray(src, src + stride), out);
          for (let x = out + 3; x < out + stride; x += 4) dst[x] = 255;
        }
        window.__cpFrameCtx.putImageData(img, 0, 0);
        return window.__cpFrameCanvas.toDataURL('image/jpeg', 0.92);
      }, { lev: levels });
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      fs.writeFileSync(path.join(framesDir, `frame${String(frame).padStart(6, '0')}.jpg`),
        Buffer.from(b64, 'base64'));
      if (frame % 30 === 0 || frame === frameCount - 1) {
        const elapsed = (Date.now() - started) / 1000;
        console.log(`frame ${frame + 1}/${frameCount} (${elapsed.toFixed(1)}s)`);
      }
    }

    const mp4 = path.join(OUT, OUT_NAME);
    const clipSeconds = frameCount / FPS;
    run('ffmpeg', [
      '-y', '-v', 'error',
      '-framerate', String(FPS), '-i', path.join(framesDir, 'frame%06d.jpg'),
      '-i', wav,
      '-t', clipSeconds.toFixed(6),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-threads', '1', '-r', String(FPS), '-g', String(FPS * 2),
      '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE),
      '-movflags', '+faststart',
      mp4,
    ]);

    const probe = {
      video: ffprobe(mp4, 'v:0', 'width,height,avg_frame_rate,r_frame_rate,duration,nb_frames'),
      audio: ffprobe(mp4, 'a:0', 'sample_rate,channels,start_time,duration'),
      counted: ffprobe(mp4, 'v:0', 'nb_read_frames', true),
    };
    const counted = Number(probe.counted.nb_read_frames);
    const failures = [];
    if (counted !== frameCount) failures.push(`decoded ${counted} frames, expected ${frameCount}`);
    if (probe.video.avg_frame_rate !== '60/1') failures.push(`avg_frame_rate ${probe.video.avg_frame_rate}`);
    if (probe.video.r_frame_rate !== '60/1') failures.push(`r_frame_rate ${probe.video.r_frame_rate}`);
    const vd = Number(probe.video.duration);
    const expected = frameCount / FPS;
    if (Math.abs(vd - expected) > 0.002) failures.push(`video duration ${vd}, expected ${expected}`);
    if (Math.abs(Number(probe.audio.start_time || 0)) > 0.001) failures.push(`audio starts at ${probe.audio.start_time}`);
    if (Math.abs(Number(probe.audio.duration) - expected) > 0.03) failures.push(`audio duration ${probe.audio.duration}, expected ${expected}`);

    const summary = {
      song: SONG,
      preset: PRESET,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      frames: frameCount,
      duration: expected,
      audioSamples: pcm.frames,
      audioRate: pcm.rate,
      audioBytes: audio.bytes,
      video: probe.video,
      audio: probe.audio,
      countedFrames: counted,
      sync: 'frame N uses PCM window ending at N/60; audio file starts at sample 0',
      failures,
      pass: failures.length === 0,
      output: mp4,
    };
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
