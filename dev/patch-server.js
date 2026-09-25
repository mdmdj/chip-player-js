// DEV-ONLY patch: make skia-canvas optional for the server.
//
// `server/index.js` uses skia-canvas only to render Open Graph preview images
// for `/preview`. In dev we don't need that and skia-canvas may be slow or
// impossible to build. `dev/apply.sh` wraps the require in a try/catch.
'use strict';

const fs = require('fs');

const file = require('path').join(__dirname, '..', 'server', 'index.js');
const original =
  `const { Canvas, loadImage } = require('skia-canvas');`;
const replacement =
  `// DEV-ONLY: skia-canvas made optional (applied by dev/apply.sh)\n` +
  `let Canvas, loadImage;\n` +
  `try {\n` +
  `  ({ Canvas, loadImage } = require('skia-canvas'));\n` +
  `} catch (e) {\n` +
  `  console.warn('[dev] skia-canvas unavailable; /preview disabled.');\n` +
  `}`;

const src = fs.readFileSync(file, 'utf8');
if (src.includes(replacement)) {
  console.log('[dev] server/index.js already patched for optional skia-canvas.');
} else if (src.includes(original)) {
  fs.writeFileSync(file, src.replace(original, replacement));
  console.log('[dev] Patched server/index.js for optional skia-canvas.');
} else {
  console.warn('[dev] Could not find skia-canvas require; skipping patch.');
}
