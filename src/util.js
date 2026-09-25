import pathe from 'pathe';

import { API_BASE, CATALOG_PREFIX } from './config';
import axios from 'redaxios';

const MULTI_SLASH_REGEX = /\/{2,}/g;

/**
 * A playable song is identified by a file path and an optional sub-tune index.
 * A file containing multiple songs (NSF/NSFE/SID) exposes one SongRef per
 * sub-song; a single-song file is just a SongRef with subtune 0. This is the
 * common currency for play contexts, favorites, and share links.
 *
 * @typedef {{ path: string, subtune: number }} SongRef
 */

/**
 * Normalize anything that names a song into a SongRef.
 * Accepts a path string, an existing SongRef, or a browse/search item.
 */
export function songRef(pathOrRef, subtune = 0) {
  if (pathOrRef == null) return null;
  if (typeof pathOrRef === 'object') {
    return {
      path: pathOrRef.path,
      subtune: pathOrRef.subtune || 0,
    };
  }
  return { path: pathOrRef, subtune: subtune || 0 };
}

/**
 * Stable identity for a SongRef, usable as an object key or for === comparisons.
 * NUL is used as the separator because it cannot appear in a path.
 */
export function songRefKey(pathOrRef, subtune = 0) {
  const ref = songRef(pathOrRef, subtune);
  if (!ref) return null;
  return `${ref.path}\u0000${ref.subtune}`;
}

export function songRefsEqual(a, b) {
  return songRefKey(a) === songRefKey(b);
}

/**
 * Whether two ordered lists of songs are the same, for comparing a live play
 * context to a stored one. Sequencer copies its context, so identity won't do.
 */
export function songRefListsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((ref, i) => songRefsEqual(ref, b[i]));
}

export function updateQueryString(newParams) {
  const searchParams = new URLSearchParams(window.location.search);
  Object.entries(newParams).forEach(([key, value]) => {
    if (value === undefined) {
      searchParams.delete(key);
    } else {
      searchParams.set(key, value);
    }
  });
  const stateUrl = '?' + searchParams.toString().replace(/%20/g, '+');
  window.history.replaceState(null, '', stateUrl);
}

export function unlockAudioContext(context) {
  // https://hackernoon.com/unlocking-web-audio-the-smarter-way-8858218c0e09
  console.log('AudioContext initial state is %s.', context.state);
  if (context.state === 'suspended') {
    const events = ['touchstart', 'touchend', 'mousedown', 'mouseup'];
    const unlock = () => context.resume()
      .then(() => events.forEach(event => document.body.removeEventListener(event, unlock)));
    events.forEach(event => document.body.addEventListener(event, unlock, false));
  }
}

export function titlesFromMetadata(metadata) {
  if (metadata.formatted) {
    return metadata.formatted;
  }

  const title = allOrNone(metadata.artist, ' - ') + metadata.title;
  const subtitle = [metadata.game, metadata.system].filter(x => x).join(' - ') +
    allOrNone(' (', metadata.copyright, ')');
  return { title, subtitle };
}

export function allOrNone(...args) {
  let str = '';
  for (let i = 0; i < args.length; i++) {
    if (!args[i]) return '';
    str += args[i];
  }
  return str;
}

// Preserves leading and trailing slashes.
export function pathJoin(...parts) {
  const sep = '/';
  const last = parts.length - 1;
  return parts
    .map((part, i) => {
      if (i !== 0 && part.startsWith(sep)) part = part.slice(1);
      if (i !== last && part.endsWith(sep)) part = part.slice(0, -1);
      return part;
    })
    .join(sep);
}

export function getFilepathFromUrl(url) {
  if (!url) return null;
  return url.replace(CATALOG_PREFIX, '/').replace(MULTI_SLASH_REGEX, '/');
}

export function getUrlFromFilepath(filepath) {
  if (!filepath) return null;
  // in case it's already encoded
  try { filepath = decodeURIComponent(filepath); } catch {}
  return pathJoin(CATALOG_PREFIX, encodeURIComponent(filepath));
}

export function getMetadataUrlForFilepath(filepath, subtune = null) {
  // XXX: any time we convert from path to URL, we must encode
  filepath = filepath.replace('%25', '%').replace('%23', '#');
  const subtuneParam = subtune != null ? `&subtune=${subtune}` : '';
  return `${API_BASE}/metadata?path=${encodeURIComponent(filepath)}${subtuneParam}`;
}

export function getMetadataUrlForCatalogUrl(url) {
  const filepath = getFilepathFromUrl(url);
  return getMetadataUrlForFilepath(filepath);
}

export function ensureEmscFileWithUrl(emscRuntime, filename, url) {
  if (emscRuntime.FS.analyzePath(filename).exists) {
    console.debug(`${filename} exists in Emscripten file system.`);
    return Promise.resolve(filename);
  } else {
    console.log(`Downloading ${filename}...`);
    return fetch(url)
      .then(response => {
        // Because fetch doesn't reject on 404
        if (!response.ok) throw Error(`HTTP ${response.status} while fetching ${filename}`);
        return response;
      })
      .then(response => response.arrayBuffer())
      .then(buffer => {
        const arr = new Uint8Array(buffer);
        return ensureEmscFileWithData(emscRuntime, filename, arr, true);
      });
  }
}

export function ensureEmscFileWithData(emscRuntime, filename, uint8Array, forceWrite = false) {
  if (!forceWrite && emscRuntime.FS.analyzePath(filename).exists) {
    console.debug(`${filename} exists in Emscripten file system.`);
    return Promise.resolve(filename);
  } else {
    console.debug(`Writing ${filename} to Emscripten file system...`);
    const dir = pathe.dirname(filename);
    emscRuntime.FS.mkdirTree(dir);
    emscRuntime.FS.writeFile(filename, uint8Array);
    return new Promise((resolve, reject) => {
      emscRuntime.FS.syncfs(false, (err) => {
        if (err) {
          console.error('Error synchronizing to indexeddb.', err);
          reject(err);
        } else {
          console.debug(`Synchronized ${filename} to indexeddb.`);
          resolve(filename);
        }
      });
    });
  }
}

export function remap(number, fromLeft, fromRight, toLeft, toRight) {
  return toLeft + (number - fromLeft) / (fromRight - fromLeft) * (toRight - toLeft)
}

export function remap01(number, toLeft, toRight) {
  return remap(number, 0, 1, toLeft, toRight);
}

export const getWithAuth = async (user, path) => {
  if (!user) return;

  const token = await user.getIdToken();
  return axios.get(path, {
    headers: { 'Authorization': `Bearer ${token}`, },
  }).then(res => res.data);
}

export const postWithAuth = async (user, path, json) => {
  if (!user) return;

  const token = await user.getIdToken();
  return axios.post(path, json, {
    headers: { 'Authorization': `Bearer ${token}`, },
  }).then(res => res.data);
}

export const postWithOptionalAuth = async (user, path, json) => {
  const headers = {};
  if (user) {
    const token = await user.getIdToken();
    headers['Authorization'] = `Bearer ${token}`;
  }
  return axios.post(path, json, { headers }).then(res => res.data);
}

export const vectorToArray = (vec) => {
  return new Array(vec.size()).fill(0).map((_, id) => vec.get(id))
}
