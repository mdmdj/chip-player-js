/**
 * Persistent loudness cache.
 *
 * A scan costs between a fraction of a second and a few seconds of CPU, so a
 * measured track must survive a reload. IndexedDB is large enough for a catalog
 * and is available in workers as well as on the page. If IndexedDB is not
 * available (private browsing modes differ), fall back to an in-memory map and
 * simply rescan next session.
 */

const DB_NAME = 'chip-player-loudness';
const DB_VERSION = 1;
const TRACKS = 'tracks';

const memory = new Map();
let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Could not open loudness cache'));
    request.onblocked = () => reject(new Error('Loudness cache upgrade blocked'));
  }).catch(err => {
    console.warn('Loudness cache unavailable; using an in-memory cache.', err);
    return null;
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getCachedTrack(filepath) {
  const db = await openDb();
  if (!db) return memory.get(filepath);
  try {
    const store = db.transaction(TRACKS, 'readonly').objectStore(TRACKS);
    return await requestToPromise(store.get(filepath));
  } catch (e) {
    return memory.get(filepath);
  }
}

export async function putCachedTrack(filepath, measurement) {
  const db = await openDb();
  if (!db) {
    memory.set(filepath, measurement);
    return;
  }
  try {
    const tx = db.transaction(TRACKS, 'readwrite');
    tx.objectStore(TRACKS).put(measurement, filepath);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    memory.set(filepath, measurement);
  }
}
