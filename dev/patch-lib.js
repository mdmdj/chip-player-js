// DEV-ONLY: the ordered find/replace patch engine shared by dev/patch-server.js
// and dev/patch-client.js.
//
// Both patch a *tracked* file whose dev-only deltas must never be committed, and
// both must be idempotent (`dev/apply.sh` may run twice) and reversible
// (`dev/remove.sh` restores the plain file so a promote sees a clean tree).
//
// Presence of the REPLACEMENT decides the state, in both directions. Probing for
// the find text instead is wrong when the find is a prefix or substring of the
// replace (dev-no-cache does exactly that): it reads as "already plain" on a
// patched file and would let a re-apply duplicate the inserted lines.
'use strict';

const fs = require('fs');

// patches: [{ name, find, replace, required? }] applied in order (reversed for
// revert, so overlapping patches unwind cleanly). Returns { changed, applied,
// errors }; `errors` holds required patches whose anchor was not found.
function runPatches({ file, patches, revert = false }) {
  let src = fs.readFileSync(file, 'utf8');
  const applied = [];
  const errors = [];
  let changed = false;

  const order = revert ? [...patches].reverse() : patches;
  for (const p of order) {
    const patched = src.includes(p.replace);
    if (revert) {
      if (!patched) { applied.push(`${p.name} (already plain)`); continue; }
      src = src.replace(p.replace, p.find);
      changed = true;
      applied.push(p.name);
    } else if (patched) {
      applied.push(`${p.name} (already patched)`);
    } else if (src.includes(p.find)) {
      src = src.replace(p.find, p.replace);
      changed = true;
      applied.push(p.name);
    } else if (p.required !== false) {
      errors.push(p.name);
    }
  }

  if (changed) fs.writeFileSync(file, src);
  return { changed, applied, errors };
}

module.exports = { runPatches };
