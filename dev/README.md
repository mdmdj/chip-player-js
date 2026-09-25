# Dev shims

This directory exists so the app can run locally without a full chip-core
WebAssembly build, Firebase credentials, or a real music catalog. **It is all
removable.** Before opening a PR, run:

```sh
./dev/remove.sh
```

That undoes every change `dev/apply.sh` made. Then delete this directory (or
keep it out of the PR).

## Prerequisites

- `nvm` with the repo-pinned Node version: `nvm install && nvm use`
- `npm install` in the repo root and in `server/`

## Usage

```sh
./dev/apply.sh   # install shims, seed databases, build a tiny catalog
npm run dev      # webpack dev server (:3000) + API server (:8080)
```

To revert:

```sh
./dev/remove.sh
```

## What gets installed

| Shim | Target | Tracked? | Notes |
| --- | --- | --- | --- |
| `shims/chip-core.js` | `src/chip-core.js` | target gitignored | No-op Emscripten module + in-memory FS. No audio. |
| `shims/firebaseConfig.js` | `src/config/firebaseConfig.js` | target gitignored | Placeholder Firebase config. |
| `shims/server-auth.js` | `server/middleware/auth.js` | target tracked (backed up) | Fixed `dev-user`; no service account needed. |
| `patch-server.js` | `server/index.js` | target tracked (reversible) | Makes `skia-canvas` optional. |
| `patch-user-provider.js` | `src/components/UserProvider.js` | target tracked (reversible) | Injects a fake client `user`, so the favorites UI works without Firebase. |
| `seed-dbs.js` | `server/users.db`, `server/csdb.db` | gitignored | Creates `users`/`playlists`/`playbacks` schemas. |
| generated | `server/.env.local` | gitignored | Points server at local dirs. |
| generated | `catalog/`, `server/catalog.db` | gitignored | Built by `scripts/build-music.js`. |

## Auth modes

The bypass supports two modes via `DEV_AUTH_MODE`:

- `bypass` (default): every authenticated request uses `dev-user`.
- `proxy`: uses the `x-dev-uid` request header.

`optionalAuth` only sets a user when an `Authorization` header is present. To
make the client's favorite buttons work, `patch-user-provider.js` injects a
fake `user` (uid `dev-user`, `getIdToken() -> 'dev-token'`); the bypass ignores
the token. `DEV_AUTH_MODE=proxy` is unused by the client today but kept for a
future header-based shim.

## Test fixtures

Drop extra files into `catalog/` (NSF/NSFE/SID/MOD/etc.), then rebuild:

```sh
node scripts/build-music.js -f <subdir>
```

`game-music-emu/test.nsf` is a convenient multi-track NSF and is copied in
automatically for a starter fixture.

## Limitations

- No audio playback (stub core).
- No real login (placeholder Firebase config). A fake `dev-user` is injected so
  favorites can be added/removed and persist through the local API
  (`server/users.db`), which is seeded automatically.
- `/preview` images are disabled if skia-canvas is unavailable.
