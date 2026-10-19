/**
 * Load the browser player modules under Node for the catalog scanner.
 *
 * The app's source is ESM/JSX and imports extensionless paths and image assets,
 * so a tiny Babel require hook is the smallest way to reuse the exact renderer
 * and player classes the browser uses. This is build-time tooling, not a server
 * runtime dependency.
 */
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const SRC = path.resolve(__dirname, '..', 'src');

global.window = global;
global.self = global;
global.window.requestIdleCallback = global.window.requestIdleCallback || ((cb) => setTimeout(() => cb({
  didTimeout: false,
  timeRemaining: () => 0,
}), 0));
global.window.cancelIdleCallback = global.window.cancelIdleCallback || ((id) => clearTimeout(id));

const originalJs = require.extensions['.js'];
require.extensions['.js'] = function (mod, filename) {
  if (!filename.startsWith(SRC + path.sep)) return originalJs(mod, filename);
  const source = fs.readFileSync(filename, 'utf8');
  const out = babel.transformSync(source, {
    filename,
    presets: [
      ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
      '@babel/preset-react',
    ],
    sourceMaps: false,
    babelrc: false,
    configFile: false,
  });
  return mod._compile(out.code, filename);
};
require.extensions['.png'] = (mod) => { mod.exports = 'image'; };
require.extensions['.jpg'] = (mod) => { mod.exports = 'image'; };
require.extensions['.jpeg'] = (mod) => { mod.exports = 'image'; };
require.extensions['.svg'] = (mod) => { mod.exports = 'image'; };

async function loadChipCore() {
  const jsPath = path.resolve(__dirname, '..', 'src', 'chip-core.js');
  const wasmPath = path.resolve(__dirname, '..', 'src', 'chip-core.wasm');
  if (!fs.existsSync(jsPath) || !fs.existsSync(wasmPath)) {
    throw new Error('No chip-core build (src/chip-core.js and .wasm)');
  }
  if (fs.statSync(wasmPath).size < 100000) {
    throw new Error('src/chip-core.wasm is the dev stub, not a real build');
  }
  const { pathToFileURL } = require('url');
  const { default: ChipCore } = await import(pathToFileURL(jsPath).href);
  const wasm = fs.readFileSync(wasmPath);
  const core = await ChipCore({
    print: (msg) => console.debug(msg),
    printErr: (msg) => {
      // fluidlite warns for every channel before a MIDI track picks a bank;
      // it is noise during a scan of non-MIDI files.
      if (!/^fluidsynth: warning/.test(msg)) console.error(msg);
    },
    instantiateWasm(imports, success) {
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports);
      success(instance);
      return instance.exports;
    },
  });
  // IDBFS only needs IndexedDB to persist across page loads. The scanner reads
  // companion files into it and then renders; a no-op syncfs keeps the same
  // filesystem semantics in memory without pulling IndexedDB into Node.
  if (core.FS && typeof core.FS.syncfs === 'function') {
    core.FS.syncfs = (populate, callback) => {
      if (typeof callback === 'function') callback(null);
    };
  }
  return core;
}

module.exports = { loadChipCore };
