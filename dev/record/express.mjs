// DEV-ONLY: re-export express, resolved from server/node_modules.
//
//   import express from './express.mjs';
//
// express is a *server*/package.json dependency, not a root one, and this file
// lives in dev/record/ -- so a bare `import express from 'express'` searches
// dev/record/node_modules, dev/node_modules, node_modules, and stops there. It
// never walks into server/node_modules, and the import throws
// ERR_MODULE_NOT_FOUND ("Cannot find package 'express'"). The old comment in
// serve.mjs ("express is already a dependency of this repo") was true about the
// repo and wrong about resolution.
//
// Resolving from a base inside server/ is what makes the bare specifier find it,
// which keeps the repo's package.json untouched (it must stay unmodified; see
// AGENTS.md) and needs no install or symlink.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'server', 'package.json'));

export default require('express');
