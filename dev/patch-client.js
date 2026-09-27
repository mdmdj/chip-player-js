// DEV-ONLY patch: point the client `API_BASE`/catalog URLs at the local server.
//
// `src/config/index.js` already does this when NODE_ENV === 'development', so
// this file only exists as a placeholder for future overrides. No-op for now.
'use strict';

console.log('[dev] No client config patch required (dev URLs are built in).');
