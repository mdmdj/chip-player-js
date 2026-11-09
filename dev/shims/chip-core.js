// DEV-ONLY stub of the Emscripten `chip-core` module.
//
// Installed to `src/chip-core.js` by `dev/apply.sh` and removed by
// `dev/remove.sh`. `src/chip-core.js` is gitignored, so this file is the
// tracked source of truth for the stub.
//
// It implements just enough of the Emscripten module surface for the app to
// boot and browse. All `_*` exported C functions are stubbed via a Proxy and
// return 0. No audio is produced. Replace with a real GME/SID build when you
// need playback.
/*eslint-disable*/

const HEAP_SIZE = 64 * 1024 * 1024;

function normalize(path) {
  if (!path) return '/';
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

function createFs() {
  const files = new Map(); // path -> Uint8Array
  const dirs = new Set(['/']);

  const ensureDirs = (path) => {
    const parts = normalize(path).split('/').filter(Boolean);
    let acc = '';
    dirs.add('/');
    for (const part of parts) {
      acc += '/' + part;
      dirs.add(acc);
    }
  };

  return {
    filesystems: { IDBFS: { idbfs: true }, MEMFS: {} },
    mkdir(path) {
      ensureDirs(path);
    },
    mkdirTree(path) {
      ensureDirs(path);
    },
    mount() {},
    unmount() {},
    writeFile(path, data) {
      const p = normalize(path);
      ensureDirs(p.slice(0, p.lastIndexOf('/')) || '/');
      files.set(p, data instanceof Uint8Array ? data : new Uint8Array(data));
    },
    readFile(path, opts) {
      const data = files.get(normalize(path));
      if (!data) throw new Error(`ENOENT: ${path}`);
      if (opts && opts.encoding === 'utf8') {
        return new TextDecoder().decode(data);
      }
      return data;
    },
    readdir(path) {
      const p = normalize(path);
      if (!dirs.has(p)) throw new Error(`ENOENT: ${path}`);
      const names = ['.', '..'];
      for (const dir of dirs) {
        if (dir === p || !dir.startsWith(p === '/' ? '/' : p + '/')) continue;
        const rest = dir.slice(p === '/' ? 1 : p.length + 1);
        if (rest && !rest.includes('/')) names.push(rest);
      }
      for (const file of files.keys()) {
        if (!file.startsWith(p === '/' ? '/' : p + '/')) continue;
        const rest = file.slice(p === '/' ? 1 : p.length + 1);
        if (rest && !rest.includes('/')) names.push(rest);
      }
      return [...new Set(names)];
    },
    stat(path) {
      const p = normalize(path);
      const data = files.get(p);
      if (data) {
        return { size: data.byteLength, mtime: new Date().toISOString() };
      }
      if (dirs.has(p)) {
        return { size: 0, mtime: new Date().toISOString() };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    unlink(path) {
      files.delete(normalize(path));
    },
    analyzePath(path) {
      const p = normalize(path);
      return { exists: files.has(p) || dirs.has(p) };
    },
    syncfs(_populate, cb) {
      if (cb) cb(null);
    },
  };
}

async function CHIP_CORE() {
  const heapBuffer = new ArrayBuffer(HEAP_SIZE);
  const HEAPU8 = new Uint8Array(heapBuffer);
  const HEAPF32 = new Float32Array(heapBuffer);
  const view = new DataView(heapBuffer);
  let heapTop = 16;

  const FS = createFs();

  const impl = {
    FS,
    HEAPU8,
    HEAPF32,
    _malloc(size) {
      const ptr = (heapTop + 7) & ~7;
      heapTop = ptr + Math.max(1, size | 0);
      return ptr;
    },
    _free() {},
    getValue(ptr, type) {
      switch (type) {
        case 'i8':
        case 'u8': return view.getUint8(ptr);
        case 'i16': return view.getInt16(ptr, true);
        case 'u16': return view.getUint16(ptr, true);
        case 'i32':
        case 'u32':
        case '*':
        case 'i8*': return view.getInt32(ptr, true);
        case 'float': return view.getFloat32(ptr, true);
        case 'double': return view.getFloat64(ptr, true);
        default: return view.getInt32(ptr, true);
      }
    },
    setValue(ptr, value, type) {
      switch (type) {
        case 'i8':
        case 'u8': view.setUint8(ptr, value); break;
        case 'i16': view.setInt16(ptr, value, true); break;
        case 'u16': view.setUint16(ptr, value, true); break;
        case 'i32':
        case 'u32':
        case '*':
        case 'i8*': view.setInt32(ptr, value, true); break;
        case 'float': view.setFloat32(ptr, value, true); break;
        case 'double': view.setFloat64(ptr, value, true); break;
        default: view.setInt32(ptr, value, true);
      }
    },
    UTF8ToString(ptr) {
      let end = ptr;
      while (HEAPU8[end] !== 0) end++;
      return new TextDecoder().decode(HEAPU8.subarray(ptr, end));
    },
    stringToNewUTF8(str) {
      const bytes = new TextEncoder().encode(str + '\0');
      const ptr = impl._malloc(bytes.length);
      HEAPU8.set(bytes, ptr);
      return ptr;
    },
    ccall() { return 0; },
    cwrap() { return () => 0; },
  };

  // Any exported C function we didn't implement resolves to a no-op returning 0.
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('_')) return () => 0;
      return undefined;
    },
  });
}

export default CHIP_CORE;
