import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import debounce from 'lodash/debounce';
import { getAuth, onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider } from 'firebase/auth';
import { initializeApp as firebaseInitializeApp } from 'firebase/app';
import firebaseConfig from '../config/firebaseConfig';
import { API_BASE, CATALOG_PREFIX } from '../config';
import { pathJoin, songRef } from '../util';
import { getWithAuth, postWithAuth } from '../util';

const UserContext = createContext({
  user: null,
  loadingUser: true,
  faves: [],
  favesContext: [],
  showPlayerSettings: false,
  showVisualizer: false,
  handleLogin: () => {},
  handleLogout: () => {},
  handleToggleFavorite: () => {},
  settings: {},
  updateSettings: () => {},
  replaceSettings: () => {},
});

const DEFAULT_SETTINGS = {
  showPlayerSettings: false,
  showVisualizer: false,
  theme: 'msdos',
  silenceDuration: -1,
  showLoopArea: true,
};


const UserProvider = ({ children }) => {
  // Use authState hook for user state
  // const [authUser, userLoading] = useAuthState(firebase.auth());
  const [user, setUser] = useState(null); // Local state for user data
  const [faves, setFaves] = useState(() => {
    // Restore favorites from localStorage.
    try {
      const faves = window.localStorage.getItem('faves');
      return faves ? JSON.parse(faves) : [];
    } catch (e) {
      console.error('Could not load faves from localStorage', e);
      return [];
    }
  });
  const [loadingUser, setLoadingUser] = useState(true); // Manage loading state
  // Monotonic token so stale favorites refreshes don't overwrite newer ones.
  const favesRefreshToken = useRef(0);
  const [settings, setSettings] = useState(() => {
    // Restore settings from localStorage.
    try {
      const settings = window.localStorage.getItem('settings');
      return settings ? JSON.parse(settings) : DEFAULT_SETTINGS;
    } catch (e) {
      console.error('Could not load settings from localStorage', e);
      return DEFAULT_SETTINGS;
    }
  });


  useEffect(() => {
    // Initialize Firebase
    const firebaseApp = firebaseInitializeApp(firebaseConfig);
    const auth = getAuth(firebaseApp);
    onAuthStateChanged(auth, async user => {
      // A user change invalidates any favorites refresh started for the old user.
      favesRefreshToken.current++;
      setUser(user);
      console.log('Firebase auth state changed, user:', user);
      setLoadingUser(false);
    });
  }, []);

  // Copy favorites to localStorage whenever they change, so they persist across page reloads.
  useEffect(() => {
    try {
      window.localStorage.setItem('faves', JSON.stringify(faves));
    } catch (e) {
      console.error('Could not save faves to localStorage', e);
    }
  }, [faves]);

  // Copy settings to localStorage whenever they change, so they persist across page reloads.
  useEffect(() => {
    try {
      window.localStorage.setItem('settings', JSON.stringify(settings));
    } catch (e) {
      console.error('Could not save settings to localStorage', e);
    }
  }, [settings]);

  useEffect(() => {
    if (!user) return;

    try {
      const token = ++favesRefreshToken.current;
      getWithAuth(user, `${API_BASE}/user/favorites`).then(favesRes => {
        if (token === favesRefreshToken.current) setFaves(favesRes.favorites);
      });

      getWithAuth(user, `${API_BASE}/user/settings`).then(settingsRes => {
        // Merge server settings with defaults to ensure all keys exist
        setSettings(prev => ({ ...prev, ...settingsRes }));
      });
    } catch (e) {
      console.error('Error fetching user data:', e);
    }
  }, [user]);


  const handleLogin = async () => {
    const auth = getAuth();
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      console.log('Firebase auth result:', result);
    } catch (error) {
      console.log('Firebase auth error:', error);
    }
  };

  const handleLogout = async () => {
    const auth = getAuth();
    try {
      await signOut(auth);
      favesRefreshToken.current++;
      setUser(null);
      setFaves([]);
    } catch (error) {
      console.log('Firebase logout error:', error);
    }
  };

  const handleToggleFavorite = async (path, subtune = 0, songId) => {
    if (user) {
      // Claim this toggle's generation, so the fallback refresh below cannot
      // drop a newer toggle's optimistic change.
      const generation = ++favesRefreshToken.current;
      const oldFaves = faves;
      const isFavorite = faves.find(fave => fave.path === path && (fave.subtune || 0) === subtune);

      const fave = {
        path,
        subtune,
        songId,
        href: pathJoin(CATALOG_PREFIX, encodeURIComponent(path)),
        mtime: Math.floor(Date.now() / 1000),
      };

      const newFaves = isFavorite
        ? faves.filter(fave => !(fave.path === path && (fave.subtune || 0) === subtune))
        : [...faves, fave];
      setFaves(newFaves);

      let addResult;
      try {
        if (isFavorite) {
          await removeFavorite(fave);
        } else {
          addResult = await addFavorite(fave);
        }
      } catch (e) {
        setFaves(oldFaves);
        console.log('Couldn\'t update favorites in Firebase.', e);
        return;
      }
      // The mutation is committed from here on, so a failed re-read must not
      // roll the optimistic state back -- that would show the song as un-favorited
      // until the next refresh, and a retry would then invert it.
      // The add response carries this entry already decorated (size, sub-tune
      // title, ...), so splice that one in optimistically to avoid a flicker.
      if (addResult && addResult.favorite) {
        setFaves(prev => {
          // A newer toggle may have removed this exact entry already; if so,
          // leave it out instead of re-adding a stale one.
          if (!prev.some(f => f.path === path && (f.subtune || 0) === subtune)) return prev;
          return [
            ...prev.filter(f => !(f.path === path && (f.subtune || 0) === subtune)),
            addResult.favorite,
          ];
        });
      }
      // Re-read the list for adds and apply it only if no newer toggle has
      // happened since. The splice above cannot restore favorites the server
      // already had when this toggle landed -- notably a star placed before the
      // initial GET finished, which this toggle invalidated. The generation guard
      // drops the response if a newer toggle happened meanwhile, so a stale
      // whole-list response can never undo a pending change. A server that
      // returns only { success } is covered by this same path.
      if (!isFavorite) {
        try {
          const refreshed = await getWithAuth(user, `${API_BASE}/user/favorites`);
          if (refreshed && generation === favesRefreshToken.current) setFaves(refreshed.favorites);
        } catch (e) {
          console.log('Couldn\'t refresh favorites after updating Firebase.', e);
        }
      }
    }
  };

  const addFavorite = useCallback(async (fave) => {
    return postWithAuth(user, `${API_BASE}/user/favorites/add`, fave);
  }, [user]);

  const removeFavorite = useCallback(async (fave) => {
    return postWithAuth(user, `${API_BASE}/user/favorites/remove`, fave);
  }, [user]);

  const saveSettings = useMemo(() => {
    return debounce((user, newSettings) => {
      if (!user) return;
      postWithAuth(user, `${API_BASE}/user/settings`, newSettings)
        .then(res => {
          console.log('Saved settings to server:', res);
        })
        .catch(e => {
          console.log('Couldn\'t save settings to server.', e);
        });
    }, 1000);
  }, []);

  const updateSettings = useCallback((partialSettings) => {
    const newSettings = { ...settings, ...partialSettings };
    setSettings(newSettings);
    saveSettings(user, newSettings);
  }, [user, settings, saveSettings]);

  const replaceSettings = useCallback((newSettings) => {
    setSettings(newSettings);
    saveSettings(user, newSettings);
  }, [user, saveSettings]);

  // We need to derive a list of SongRefs to use as the play context. Old
  // favorites have no subtune and resolve to the parent file (sub-tune 0).
  const favesContext = useMemo(() => {
    return faves.map(fave => songRef(fave.path, fave.subtune));
  }, [faves]);

  return (
    <UserContext.Provider
      value={{
        user,
        loadingUser,
        faves,
        favesContext,
        handleLogin,
        handleLogout,
        handleToggleFavorite,
        settings,
        updateSettings,
        replaceSettings,
      }}>
      {children}
    </UserContext.Provider>
  );
};

export { UserContext, UserProvider };
