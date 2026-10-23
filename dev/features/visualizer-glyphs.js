const fs = require('fs');
const path = require('path');

const frame = '<rect class="frame" x="0.75" y="0.75" width="94.5" height="52.5"/>';
// A single feedback ghost; per-item rotations are applied in inner().
const GHOST = { x: -8, y: -2, s: 1.3, o: 0.3 };

const hexPoly = (cx, cy, r) => {
  const h = Math.sqrt(3) * r;
  const pts = [
    [cx + r, cy], [cx + r / 2, cy + h / 2], [cx - r / 2, cy + h / 2],
    [cx - r, cy], [cx - r / 2, cy - h / 2], [cx + r / 2, cy - h / 2],
  ];
  return `<polygon points="${pts.map(p => p.map(n => +n.toFixed(2)).join(',')).join(' ')}"/>`;
};

const tessellatedHex = () => {
  const r = 8.5;
  const rings = [[], [], []];
  for (let q = -2; q <= 2; q++) {
    for (let s = -2; s <= 2; s++) {
      const d = Math.max(Math.abs(q), Math.abs(s), Math.abs(q + s));
      if (d > 2) continue;
      const cx = 48 + 1.5 * r * q;
      const cy = 27 + Math.sqrt(3) * r * (s + q / 2);
      rings[d].push(hexPoly(cx, cy, r));
    }
  }
  const op = [1, 0.55, 0.28];
  return rings.map((ring, i) => `<g opacity="${op[i]}">${ring.join('')}</g>`).join('');
};

const items = [
  { name: "Nested hex", note: "Recursive feedback: a preset inside a preset. Closest to the placeholder, but clearly a glyph.", rot: 8, trailRot: 16, ghost: { x: -16, y: -4, s: 1.4, o: 0.3 }, center: [12, 4], mark: '<polygon points="68,27 58,44.3 38,44.3 28,27 38,9.7 58,9.7"/><polygon points="58,27 53,35.7 43,35.7 38,27 43,18.3 53,18.3"/>' },
  { name: "Warped grid", note: "Warp/zoom: the simulation mesh the shaders bend. Reads at 18 px.", mark: '<path d="M24,8 V46 M48,8 Q36,27 48,46 M72,8 V46"/><path d="M12,18 H84 M12,36 H84"/>' },
  { name: "Möbius ribbon", note: "Endless loop: two passes that never quite close.", mark: '<ellipse cx="38" cy="27" rx="18" ry="9" transform="rotate(-28 38 27)"/><ellipse cx="58" cy="27" rx="18" ry="9" transform="rotate(28 58 27)"/>' },
  { name: "Radial burst", note: "Beat-reactive spokes; the FFT's angular cousin. Strong at small size.", mark: '<line x1="48" y1="27" x2="48" y2="9"/><line x1="48" y1="27" x2="65" y2="13"/><line x1="48" y1="27" x2="69" y2="27"/><line x1="48" y1="27" x2="65" y2="41"/><line x1="48" y1="27" x2="48" y2="45"/><line x1="48" y1="27" x2="31" y2="41"/><line x1="48" y1="27" x2="27" y2="27"/><line x1="48" y1="27" x2="31" y2="13"/><circle class="fill" cx="48" cy="27" r="3"/>' },
  { name: "Prism", note: "Composite shader: one source split into rays.", mark: '<polygon points="48,12 70,42 26,42"/><line x1="48" y1="27" x2="84" y2="20"/><line x1="48" y1="27" x2="84" y2="27"/><line x1="48" y1="27" x2="84" y2="34"/>' },
  { name: "Torus", note: "Zoom/warp ring; the classic tunnel.", mark: '<ellipse cx="48" cy="27" rx="24" ry="13"/><ellipse cx="48" cy="27" rx="10" ry="5"/><path d="M28,20 Q48,6 68,20"/>' },
  { name: "Kaleidoscope", note: "Mirror presets; six-fold symmetry. Equal width/height, with an offset rotation on the base and trail.", rot: 8, trailRot: 14, ghost: { x: -16, y: -4, s: 1.4, o: 0.3 }, center: [11, 4], mark: '<polygon points="62,27 55,41 41,41 34,27 41,13 55,13"/><line x1="62" y1="27" x2="34" y2="27"/><line x1="55" y1="41" x2="41" y2="13"/><line x1="41" y1="41" x2="55" y2="13"/>' },
  { name: "Golden spiral", note: "Zoom/warp growth at φ; motion that never repeats.", mark: '<path d="M48,27 a2,2 0 0 1 4,0 a6,6 0 0 1 -12,0 a10,10 0 0 1 20,0 a14,14 0 0 1 -28,0 a18,18 0 0 1 36,0"/>' },
  { name: "Lattice", note: "The simulation mesh: nodes and triangles.", mark: '<path d="M28,16 H68 M38,32 H58 M28,16 L38,32 L48,16 L58,32 L68,16 M28,16 L48,46 L68,16"/><circle class="fill" cx="28" cy="16" r="2"/><circle class="fill" cx="48" cy="16" r="2"/><circle class="fill" cx="68" cy="16" r="2"/><circle class="fill" cx="38" cy="32" r="2"/><circle class="fill" cx="58" cy="32" r="2"/><circle class="fill" cx="48" cy="46" r="2"/>' },
  { name: "Double frame", note: "Double-preset/mashup: two frames overlapping.", mark: '<rect x="22" y="14" width="48" height="27" transform="rotate(-12 46 27.5)"/><rect x="30" y="20" width="48" height="27" transform="rotate(10 54 33.5)"/>' },
  { name: "Phase waves", note: "Audio-reactive waveforms, phase-shifted.", mark: '<path d="M12,20 Q24,10 36,20 T60,20 T84,20"/><path d="M12,30 Q24,20 36,30 T60,30 T84,30"/><path d="M12,40 Q24,30 36,40 T60,40 T84,40"/>' },
  { name: "Vector field", note: "Motion-vector grid; a direction per cell.", mark: '<path d="M22,18 H34 M34,18 l-4,-3 M34,18 l-4,3"/><path d="M50,16 V28 M50,16 l-3,4 M50,16 l3,4"/><path d="M66,20 l8,6 M74,26 l-5,-1 M74,26 l-1,-5"/><path d="M20,38 l10,-4 M30,34 l-5,-1 M30,34 l-1,5"/><path d="M42,36 H56 M56,36 l-4,-3 M56,36 l-4,3"/><path d="M66,40 l6,-8 M72,32 l-5,0 M72,32 l2,5"/>' },
  { name: "Fractal triangle", note: "Self-similar recursion; fractal presets.", mark: '<polygon points="48,10 76,44 20,44"/><polygon points="34,27 62,27 48,44"/><polygon points="27,44 41,44 34,34"/>' },
  { name: "Pulse rings", note: "Beat rings; concentric energy.", mark: '<circle cx="48" cy="27" r="6"/><circle cx="48" cy="27" r="12"/><circle cx="48" cy="27" r="18"/>' },
  { name: "Tessellated hex", note: "One hex, tessellating outward; each ring dimmer. A pattern mark rather than a single object.", mark: tessellatedHex() },
  { name: "Off-centre tunnel", noTrail: true, note: "A round tunnel receding off-frame to the lower left, a bolt shooting out of it and off the top, and an L of attached tiles in the opposite corner.", mark: '<ellipse cx="24" cy="40" rx="20" ry="14"/><ellipse cx="22" cy="39" rx="14" ry="10" opacity="0.8"/><ellipse cx="20" cy="38" rx="9" ry="6.5" opacity="0.6"/><ellipse cx="18" cy="37" rx="5" ry="3.5" opacity="0.4"/><circle class="fill" cx="17" cy="36.5" r="1.5"/><path d="M30,36 L38,30 L34,28 L46,20 L42,18 L54,10 L50,8 L62,2 L60,0"/><path d="M46,20 L54,17 L50,14"/><rect x="74" y="8" width="8" height="8"/><rect x="82" y="8" width="8" height="8"/><rect x="74" y="16" width="8" height="8"/>' },
];

const inner = (it) => {
  const baseRot = it.rot || 0;
  const trailRot = baseRot + (it.trailRot || 0);
  const g = it.ghost || GHOST;
  const ghost = it.noTrail ? '' : `<g transform="translate(${g.x} ${g.y}) translate(48 27) rotate(${trailRot}) scale(${g.s}) translate(-48 -27)" opacity="${g.o}">${it.mark}</g>`;
  const base = `<g transform="rotate(${baseRot} 48 27)">${it.mark}</g>`;
  const [cx, cy] = it.center || [0, 0];
  // Centre the base+ghost ensemble, not the base shape alone.
  return frame + `<g transform="translate(${cx} ${cy})">${ghost}${base}</g>`;
};
const card = (it, i, current) => `
  <div class="card ${current ? 'current' : ''}">
    <div class="big"><svg viewBox="0 0 96 54">${inner(it)}</svg></div>
    <div class="small">
      <svg viewBox="0 0 96 54">${inner(it)}</svg>
      <span class="num">${current ? 'NOW' : String(i).padStart(2, '0')}</span>
      <span class="name">${it.name}</span>
    </div>
    <div class="note">${it.note}</div>
  </div>`;

const placeholder = { name: "Current placeholder", note: "16:9 rectangle with a hexagon inside. Neutral, but the hexagon alone does not say “preset”.", mark: '<polygon points="68,27 58,44.3 38,44.3 28,27 38,9.7 58,9.7"/>' };

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>MilkDrop preset glyph proposals</title>
<style>
:root { color-scheme: dark; }
body { margin:0; background:#0b0b0b; color:#e8e8e8; font-family: ui-monospace, "Courier New", monospace; font-size:13px; }
.wrap { max-width:1100px; margin:0 auto; padding:28px; }
h1 { font-size:18px; font-weight:600; color:#ffe600; letter-spacing:.02em; margin:0 0 6px; }
.sub { color:#9a9a9a; line-height:1.55; margin:0 0 22px; max-width:860px; }
.grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:14px; }
.card { border:1px solid #2a2a2a; background:#111; padding:12px; }
.card.current { border-color:#ffe600; }
.big svg { width:100%; height:auto; display:block; color:#ffe600; }
.small { display:flex; align-items:center; gap:10px; margin-top:10px; }
.small svg { width:39.11px; height:22px; color:#ffe600; flex:none; }
.num { color:#666; }
.name { color:#fff; font-weight:600; }
.note { color:#9a9a9a; margin-top:6px; line-height:1.45; font-size:12px; }
svg * { fill:none; stroke:currentColor; stroke-width:1.5; vector-effect:non-scaling-stroke; }
svg .frame { opacity:.35; }
svg .fill { fill:currentColor; stroke:none; }
@media (max-width:820px) { .grid { grid-template-columns:repeat(2, 1fr); } }
</style></head>
<body><div class="wrap">
<h1>MilkDrop preset glyph — proposals</h1>
<div class="sub">Each concept is drawn in the same 16:9 slot as the placeholder: large on top, then at the actual <b>39 × 22 px</b> size (the row is 22 px tall; the frame kisses its edges). A single trail instance is scaled <b>1.30×</b> and offset <b>(−8, −2)</b> viewBox units — roughly <b>3–5 px</b> behind at this size — at <b>30% intensity</b>. The brief is abstract/geometric — the visuals, not a photo icon. The current placeholder is first; 16 alternatives follow.</div>
<div class="grid">
${card(placeholder, 0, true)}
${items.map((it, i) => card(it, i + 1, false)).join('')}
</div></div></body></html>`;

const out = path.join(__dirname, 'visualizer-glyphs.html');
fs.writeFileSync(out, html);
console.log('wrote', out, html.length, 'bytes');
