// DEV-ONLY patch: inject a fake user so favorites work without Firebase.
//
// `UserProvider` gates the favorites UI on the Firebase `user`, which never
// becomes non-null with the placeholder config. This seeds a dev user with a
// `getIdToken()` so the heart button and the favorites API calls work. The
// server auth bypass accepts any bearer token and resolves the dev user.
//
// Reversible: `node dev/patch-user-provider.js --revert` removes the dev user.
// `dev/remove.sh` uses this so it never has to restore a stale snapshot.
'use strict';

const fs = require('fs');

const file = require('path').join(__dirname, '..', 'src', 'components', 'UserProvider.js');
const MARKER = 'DEV-ONLY: a fake user so favorites work';

const patches = [
  {
    from:
      `const UserProvider = ({ children }) => {\n` +
      `  // Use authState hook for user state\n` +
      `  // const [authUser, userLoading] = useAuthState(firebase.auth());\n` +
      `  const [user, setUser] = useState(null); // Local state for user data`,
    to:
      `// DEV-ONLY: a fake user so favorites work without Firebase (applied by dev/apply.sh).\n` +
      `const DEV_USER = process.env.NODE_ENV === 'development' ? {\n` +
      `  uid: 'dev-user',\n` +
      `  displayName: 'Dev User',\n` +
      `  email: 'dev@example.com',\n` +
      `  getIdToken: async () => 'dev-token',\n` +
      `} : null;\n` +
      `\n` +
      `const UserProvider = ({ children }) => {\n` +
      `  // Use authState hook for user state\n` +
      `  // const [authUser, userLoading] = useAuthState(firebase.auth());\n` +
      `  const [user, setUser] = useState(DEV_USER); // Local state for user data`,
  },
  {
    from: `  const [loadingUser, setLoadingUser] = useState(true); // Manage loading state`,
    to: `  const [loadingUser, setLoadingUser] = useState(!DEV_USER); // Manage loading state`,
  },
  {
    from:
      `  useEffect(() => {\n` +
      `    // Initialize Firebase\n` +
      `    const firebaseApp = firebaseInitializeApp(firebaseConfig);`,
    to:
      `  useEffect(() => {\n` +
      `    // DEV-ONLY: skip Firebase when a dev user is injected.\n` +
      `    if (DEV_USER) return;\n` +
      `    // Initialize Firebase\n` +
      `    const firebaseApp = firebaseInitializeApp(firebaseConfig);`,
  },
];

const src = fs.readFileSync(file, 'utf8');

if (process.argv.includes('--revert')) {
  if (!src.includes(MARKER)) {
    console.log('[dev] UserProvider.js already unpatched.');
  } else {
    let out = src;
    for (const { from, to } of patches) {
      if (!out.includes(to)) {
        console.warn('[dev] Could not find UserProvider patch target; skipping revert.');
        process.exit(0);
      }
      out = out.replace(to, from);
    }
    fs.writeFileSync(file, out);
    console.log('[dev] Reverted UserProvider.js dev user.');
  }
} else if (src.includes(MARKER)) {
  console.log('[dev] UserProvider.js already patched for a dev user.');
} else {
  let patched = src;
  for (const { from, to } of patches) {
    if (!patched.includes(from)) {
      console.warn('[dev] Could not find UserProvider patch target; skipping patch.');
      process.exit(0);
    }
    patched = patched.replace(from, to);
  }
  fs.writeFileSync(file, patched);
  console.log('[dev] Patched UserProvider.js with a dev user.');
}
