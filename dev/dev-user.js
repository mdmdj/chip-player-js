// DEV-ONLY: one stable dev-user id per worktree.
//
// A single hard-coded `dev-user` made every overlay the same account: settings,
// favorites and (because the client mirrors them) the browser's localStorage
// were shared by identity even though each worktree has its own users.db. A
// copied/backed-up DB, a reused browser origin or a stale client pointed at the
// wrong API then carried one feature's settings into another. Derive the id from
// the checked-out branch (the target), so `dev/overlay-visualizer` and
// `dev/overlay-themes` are different users by construction.
//
// The same helper is required by the server auth shim, the dev webpack config
// and dev/seed-dbs.js; the uid must agree or the client writes to a user the
// server never reads. A detached worktree falls back to its directory name.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

function devUserId(root) {
  const worktree = path.resolve(root || path.join(__dirname, '..'));
  let ref = '';
  try {
    ref = execFileSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    // Not a git checkout (tests, an export): fall back to the directory name.
  }

  let name = ref && ref !== 'HEAD' ? ref : path.basename(worktree);
  name = name
    .replace(/^dev\/overlay-/, '')
    .replace(/^dev\//, '')
    .replace(/^feature\//, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `dev-user-${name || 'local'}`;
}

module.exports = { devUserId };
