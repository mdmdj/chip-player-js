// DEV-ONLY patch: the dev-only deltas to `server/index.js`.
//
// This file is the one home for the *dev-environment* deltas to
// `server/index.js`: a dev auth bypass, per-target ports, a dev-only HTML
// injection, and no-cache in dev. They cannot be sentinel regions -- promotion
// would have to *add* them rather than strip them -- so instead the committed
// file carries none of these and `dev/apply.sh` applies them here, idempotently
// and reversibly with `--revert`. (The file keeps two unrelated, catalog-only dev
// deltas committed -- the HVSC csdbid guard and the NES-fixture chart exclusion
// -- which a worktree without that catalog does not need.)
//
// The payoff is that a worktree created from `dev/kit` (which deliberately does
// not carry `server/index.js`) becomes runnable by the same documented sequence:
// `dev/apply.sh` patches whatever base it has (upstream's file or the feature
// branch's) into the dev form.
//
// `--revert` restores the plain form, so a promote sees a clean tree (the file
// still differs from the feature branch only by these patches). A `required`
// patch that cannot be applied is an error rather than a silent skip: without
// the auth seam the server cannot boot at all, and a quiet skip would look like
// success.
//
// PATCH_SERVER_FILE overrides the target path (used by the test).
'use strict';

const path = require('path');
const { runPatches } = require('./patch-lib.js');

const file = process.env.PATCH_SERVER_FILE || path.join(__dirname, '..', 'server', 'index.js');

// The dev deltas, as exact find/replace pairs. Order matters only where two
// patches touch neighbouring text; none here do.
const PATCHES = [
  {
    name: 'auth-module',
    required: true,
    find: `const { requireAuth, optionalAuth } = require('./middleware/auth.js');`,
    replace:
      `// Local dev: load the auth bypass from an untracked module when configured.\n` +
      `let authModule = process.env.DEV_AUTH_MODULE || './middleware/auth.js';\n` +
      `const { requireAuth, optionalAuth } = require(authModule);`,
  },
  {
    name: 'api-port',
    required: true,
    find: `const port = process.env.PORT || 8080;`,
    replace:
      `// API_PORT is this server; WDS_PORT is the webpack dev server it proxies to.\n` +
      `// PORT stays the fallback for each, so existing invocations are unchanged.\n` +
      `const port = parseInt(process.env.API_PORT ?? process.env.PORT, 10) || 8080;`,
  },
  {
    name: 'wds-port',
    required: true,
    find: `const WDS_PORT = 3000; // Port where Webpack Dev Server runs`,
    replace: `const WDS_PORT = parseInt(process.env.WDS_PORT, 10) || 3000; // Port where Webpack Dev Server runs`,
  },
  {
    name: 'mutable-final-html',
    required: true,
    find: `  const finalHtml = html\n`,
    replace: `  let finalHtml = html\n`,
  },
  {
    name: 'api-port-injection',
    required: true,
    find:
      `    .replace(/__NOSCRIPT_CONTENT__/g, noscriptContent || defaultNoscript);\n` +
      `\n` +
      `  res.send(finalHtml);`,
    replace:
      `    .replace(/__NOSCRIPT_CONTENT__/g, noscriptContent || defaultNoscript);\n` +
      `\n` +
      `  // Local dev: tell the client which port this server is on, so a second dev\n` +
      `  // tree is reachable without rebuilding the bundle. Production never takes\n` +
      `  // this branch, so the line is inert there.\n` +
      `  if (isDev) {\n` +
      `    finalHtml = finalHtml.replace(\n` +
      `      '</head>',\n` +
      `      \`<script>window.__devApiPort=\${port};</script></head>\`\n` +
      `    );\n` +
      `  }\n` +
      `\n` +
      `  res.send(finalHtml);`,
  },
  {
    name: 'dev-no-cache',
    required: true,
    find:
      `const cache1Hour = (req, res, next) => {\n` +
      `  res.header('Cache-Control', 'public, max-age=3600');\n`,
    replace:
      `const cache1Hour = (req, res, next) => {\n` +
      `  res.header('Cache-Control', 'public, max-age=3600');\n` +
      `  // Local dev: never cache, or code and catalog changes are masked.\n` +
      `  if (isDev) res.removeHeader('Cache-Control');\n`,
  },
  {
    // Optional: skia-canvas is a declared dependency, but /preview is not needed
    // in dev and the build can be slow or fail, so make the require tolerant.
    name: 'skia-canvas-optional',
    required: false,
    find: `const { Canvas, loadImage } = require('skia-canvas');`,
    replace:
      `// DEV-ONLY: skia-canvas made optional for local dev\n` +
      `let Canvas, loadImage;\n` +
      `try {\n` +
      `  ({ Canvas, loadImage } = require('skia-canvas'));\n` +
      `} catch (e) {\n` +
      `  console.warn('[dev] skia-canvas unavailable; /preview disabled.');\n` +
      `}`,
  },
];

const revert = process.argv.includes('--revert');
const { changed, applied, errors } = runPatches({ file, patches: PATCHES, revert });

const verb = revert ? 'Reverted' : 'Applied';
if (applied.length) {
  console.log(`[dev] ${verb} server/index.js patches: ${applied.join(', ')}`);
}
if (errors.length) {
  console.error(
    `[dev] ERROR: could not ${revert ? 'revert' : 'apply'} required server/index.js patch(es): ` +
      `${errors.join(', ')}.\n` +
      `      The anchor was not found in ${path.relative(path.join(__dirname, '..'), file)} -- ` +
      `upstream may have changed those lines. Fix the anchor in dev/patch-server.js.`
  );
  process.exit(1);
}
if (!changed && !applied.length) console.log('[dev] server/index.js: nothing to do.');
