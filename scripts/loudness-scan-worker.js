/**
 * One catalog-scan worker: a process with its own wasm core.
 *
 * The parent owns the database and the watchdog. A file that hangs inside a
 * single C call cannot be interrupted from JavaScript, so the parent kills this
 * process instead; the worker itself only needs to report one result per job.
 */
const fs = require('fs');
const path = require('path');
const { loadChipCore } = require('./loudness-node-require');
const { createLoudnessAnalyzer } = require('../src/loudness-analysis');

const CATALOG_ROOT = path.resolve(__dirname, '..', 'catalog');
const SAMPLE_RATE = 48000;

let analyzerPromise = null;
function getAnalyzer() {
  if (!analyzerPromise) {
    analyzerPromise = loadChipCore().then(core => createLoudnessAnalyzer(core, SAMPLE_RATE));
  }
  return analyzerPromise;
}

process.on('message', async (message) => {
  if (!message || message.type !== 'analyze') return;
  const { id, filepath, options } = message;
  try {
    const fullPath = path.resolve(CATALOG_ROOT, filepath);
    if (!fullPath.startsWith(CATALOG_ROOT + path.sep)) {
      throw new Error('path escapes the catalog');
    }
    const buffer = fs.readFileSync(fullPath);
    const analyze = await getAnalyzer();
    const result = await analyze(buffer, filepath, {
      subtune: 0,
      allSubtunes: true,
      maxSubtunes: options.maxSubtunes || 64,
      maxRenderSeconds: options.maxRenderSeconds || 600,
      wallBudgetMs: options.wallBudgetMs || 120000,
    });
    process.send({ type: 'result', id, result });
  } catch (e) {
    process.send({
      type: 'error',
      id,
      message: e && e.message ? e.message : String(e),
    });
  }
});
