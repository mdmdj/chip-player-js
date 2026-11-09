// DEV-ONLY patch: the client's dev-only affordances.
//
// `src/components/UserProvider.js` is a *feature* file, so `dev/kit` cannot carry
// its dev delta and a worktree created from the kit runs upstream's copy -- which
// means no fake user, and therefore no favorites, in the preview. This file is the
// delivery: `dev/apply.sh` turns any base (upstream's file or the feature
// branch's) into the dev form, `--revert` turns it back.
//
// The dev user is injected through the same state the real one uses (`setUser`),
// so nothing else in the component has to know about it. The anchors exist in
// both bases; note the patch deliberately does NOT touch `lastUid`, which is a
// feature-specific addition, not something upstream has.
//
// The values come from `REACT_APP_DEV_USER`, set by `config/webpack.config.dev.js`
// (which travels in the kit), so the two halves are delivered by different
// mechanisms and meet in the bundle.
'use strict';

const fs = require('fs');
const path = require('path');
const { runPatches } = require('./patch-lib.js');

const file =
  process.env.PATCH_CLIENT_FILE ||
  path.join(__dirname, '..', 'src', 'components', 'UserProvider.js');

const FIREBASE_EFFECT =
  `  useEffect(() => {\n` +
  `    // Initialize Firebase\n` +
  `    const firebaseApp = firebaseInitializeApp(firebaseConfig);\n`;

const FIREBASE_BODY =
  `    // Initialize Firebase\n` +
  `    const firebaseApp = firebaseInitializeApp(firebaseConfig);\n`;

const PATCHES = [
  {
    name: 'dev-user',
    required: true,
    find: FIREBASE_EFFECT,
    replace:
      `  // Local dev: the dev webpack config injects REACT_APP_DEV_USER so favorites\n` +
      `  // work without a real Firebase project (which never signs anyone in).\n` +
      `  useEffect(() => {\n` +
      `    if (!process.env.REACT_APP_DEV_USER) return;\n` +
      `    const devUser = JSON.parse(process.env.REACT_APP_DEV_USER);\n` +
      `    setUser({ ...devUser, getIdToken: async () => 'dev-token' });\n` +
      `    setLoadingUser(false);\n` +
      `  }, []);\n` +
      `\n` +
      FIREBASE_EFFECT,
  },
  {
    // Must run after `dev-user`: its find is the tail of that patch's replace.
    name: 'skip-firebase-when-dev-user',
    required: true,
    find: FIREBASE_BODY,
    replace:
      `    // Local dev: the injected dev user is already signed in, and the mocked\n` +
      `    // project never fires onAuthStateChanged with a user (null would clear it).\n` +
      `    if (process.env.REACT_APP_DEV_USER) return;\n` +
      FIREBASE_BODY,
  },
];

const revert = process.argv.includes('--revert');

// If the file already delivers a dev user -- as an overlay's own DEV regions do --
// our patch would set it twice, and its anchor is likely gone anyway (the regions
// sit exactly where the anchor would be). Nothing to do, and saying so is part of
// the contract: `apply.sh` must succeed in every worktree, kit-based or not.
if (!revert) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(PATCHES[0].replace) && /REACT_APP_DEV_USER|DEV_USER/.test(src)) {
    console.log('[dev] UserProvider.js already delivers a dev user; no patch needed.');
    process.exit(0);
  }
}

const { changed, applied, errors } = runPatches({ file, patches: PATCHES, revert });

const verb = revert ? 'Reverted' : 'Applied';
if (applied.length) {
  console.log(`[dev] ${verb} ${path.relative(path.join(__dirname, '..'), file)} patches: ${applied.join(', ')}`);
}
if (errors.length) {
  console.error(
    `[dev] ERROR: could not ${revert ? 'revert' : 'apply'} required client patch(es): ${errors.join(', ')}.\n` +
      `      The anchor was not found in ${path.relative(path.join(__dirname, '..'), file)} -- the component\n` +
      `      may have changed. Fix the anchor in dev/patch-client.js.`
  );
  process.exit(1);
}
if (!changed && !applied.length) console.log('[dev] UserProvider.js: nothing to do.');
