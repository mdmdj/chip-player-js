// DEV-ONLY authentication bypass.
//
// Staged to an untracked, gitignored `server/middleware/auth.dev.js` by
// `dev/apply.sh`, which sets `DEV_AUTH_MODULE=./middleware/auth.dev.js` in
// `server/.env.local`. `server/index.js` requires that module instead of
// `./middleware/auth.js`, so the real middleware is never touched and there is
// nothing to revert. `dev/remove.sh` deletes the staged file (and .env.local).
//
// This bypass:
//   - never loads Firebase Admin or a service account file,
//   - treats every request as a fixed dev user (`DEV_USER_ID`),
//   - still forwards the bearer token in the `Authorization` header to the
//     real Firebase identity when `DEV_AUTH_MODE=proxy` (used for the dev
//     auth shim in `dev/dev-auth-shim.js`).
//
// Set `DEV_AUTH_MODE=bypass` (default) for a fixed user, or
// `DEV_AUTH_MODE=proxy` to derive the user id from a `x-dev-uid` header.
const DEV_USER_ID = process.env.DEV_USER_ID || 'dev-user';
const DEV_AUTH_MODE = process.env.DEV_AUTH_MODE || 'bypass';

function resolveUserId(req) {
  if (DEV_AUTH_MODE === 'proxy') {
    return req.headers['x-dev-uid'] || DEV_USER_ID;
  }
  return DEV_USER_ID;
}

const requireAuth = async (req, res, next) => {
  req.userId = resolveUserId(req);
  next();
};

const optionalAuth = async (req, res, next) => {
  req.userId = req.headers.authorization ? resolveUserId(req) : null;
  next();
};

module.exports = { requireAuth, optionalAuth };
