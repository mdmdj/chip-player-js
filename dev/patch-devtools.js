// DEV-ONLY patch: install browser test hooks (window.__cpDev) in the app.
//
// Adds an import of the staged `src/chip-player-devtools.js` plus a guarded
// install call in App's constructor. Reversible:
//   node dev/patch-devtools.js --revert
// `dev/remove.sh` uses this; it also deletes the staged file.
'use strict';

const fs = require('fs');
const file = require('path').join(__dirname, '..', 'src', 'components', 'App.js');
const MARKER = 'DEV-ONLY (dev/patch-devtools.js)';

const patches = [
  {
    from: `import Dropzone from 'react-dropzone';\n`,
    to:
      `import Dropzone from 'react-dropzone';\n` +
      `// DEV-ONLY (dev/patch-devtools.js): staged browser test hooks; removed by dev/remove.sh\n` +
      `import { installDevTools } from '../chip-player-devtools';\n`,
  },
  {
    from: `    window.ChipPlayer = this;\n`,
    to:
      `    window.ChipPlayer = this;\n` +
      `    if (process.env.NODE_ENV === 'development') installDevTools(this); // DEV-ONLY (dev/patch-devtools.js)\n`,
  },
];

const src = fs.readFileSync(file, 'utf8');

if (process.argv.includes('--revert')) {
  if (!src.includes(MARKER)) {
    console.log('[dev] App.js already unpatched for devtools.');
  } else {
    let out = src;
    for (const { from, to } of patches) {
      if (!out.includes(to)) {
        console.warn('[dev] Could not find devtools patch target; skipping revert.');
        process.exit(0);
      }
      out = out.replace(to, from);
    }
    fs.writeFileSync(file, out);
    console.log('[dev] Reverted App.js devtools patch.');
  }
} else if (src.includes(MARKER)) {
  console.log('[dev] App.js already patched for devtools.');
} else {
  let patched = src;
  for (const { from, to } of patches) {
    if (!patched.includes(from)) {
      console.warn('[dev] Could not find devtools patch target; skipping patch.');
      process.exit(0);
    }
    patched = patched.replace(from, to);
  }
  fs.writeFileSync(file, patched);
  console.log('[dev] Patched App.js to install window.__cpDev.');
}
