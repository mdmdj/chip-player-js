// DEV-ONLY patch: make SIDPlayer a silent no-op when the core was built
// without libsidplayfp (no _sid_* exports).
//
// The real SID player needs the libsidplayfp wasm module, which isn't vendored.
// Without it, every SID load throws and the sequencer auto-advances noisily.
// This makes SID files play one second of silence and end cleanly, so mixed
// contexts keep working during dev. Reversible: `--revert`.
'use strict';

const fs = require('fs');

const file = require('path').join(__dirname, '..', 'src', 'players', 'SIDPlayer.js');
const MARKER = 'DEV-ONLY: silent SID fallback';

const original = `  loadData(data, filepath, persistedSettings, subtune = 0) {
    if (!this.initialized) {
      this.core._sid_init(this.sampleRate);
      this.initialized = true;
    }
`;
const replacement = `  loadData(data, filepath, persistedSettings, subtune = 0) {
    // DEV-ONLY: silent SID fallback when the core lacks libsidplayfp.
    if (typeof this.core._sid_init !== 'function') {
      this.silent = true;
      this.metadata = { title: pathe.basename(filepath) };
      this.subtuneDurations = [1000];
      this.resume();
      this.emit('playerStateUpdate', { ...this.getBasePlayerState(), isStopped: false });
      return;
    }
    if (!this.initialized) {
      this.core._sid_init(this.sampleRate);
      this.initialized = true;
    }
`;

const processOriginal = `  processAudioInner(channels) {
    if (this.paused) {`;
const processReplacement = `  processAudioInner(channels) {
    // DEV-ONLY: silent SID fallback.
    if (this.silent) {
      channels[0].fill(0);
      channels[1].fill(0);
      return;
    }
    if (this.paused) {`;

// Guard the remaining core calls so nothing touches missing exports.
const guardPairs = [
  [`  getPositionMs() {\n    return this.core._sid_get_position_ms();`,
   `  getPositionMs() {\n    // DEV-ONLY: silent SID fallback.\n    if (this.silent) return 0;\n    return this.core._sid_get_position_ms();`],
  [`  getDurationMs() {\n    return this.subtuneDurations[this.getSubtune()];`,
   `  getDurationMs() {\n    // DEV-ONLY: silent SID fallback.\n    if (this.silent) return 1000;\n    return this.subtuneDurations[this.getSubtune()];`],
  [`  getNumSubtunes() {\n    return this.core._sid_get_num_subtunes();`,
   `  getNumSubtunes() {\n    // DEV-ONLY: silent SID fallback.\n    if (this.silent) return 1;\n    return this.core._sid_get_num_subtunes();`],
  [`  getSubtune() {\n    return this.core._sid_get_subtune();`,
   `  getSubtune() {\n    // DEV-ONLY: silent SID fallback.\n    if (this.silent) return 0;\n    return this.core._sid_get_subtune();`],
  [`  setTempo(val) {\n    this.core._sid_set_speed(val);`,
   `  setTempo(val) {\n    // DEV-ONLY: silent SID fallback.\n    if (this.silent) { this.speed = val; return; }\n    this.core._sid_set_speed(val);`],
  [`  stop() {\n    this.suspend();\n    this.core._sid_stop();`,
   `  stop() {\n    this.suspend();\n    // DEV-ONLY: silent SID fallback.\n    if (this.silent) { this.emit('playerStateUpdate', { isStopped: true }); return; }\n    this.core._sid_stop();`],
];

const src = fs.readFileSync(file, 'utf8');

if (process.argv.includes('--revert')) {
  if (!src.includes(MARKER) && !src.includes('this.silent')) {
    console.log('[dev] SIDPlayer.js already unpatched.');
  } else {
    let out = src
      .replace(replacement, original)
      .replace(processReplacement, processOriginal);
    for (const [orig, patched] of guardPairs) out = out.replace(patched, orig);
    fs.writeFileSync(file, out);
    console.log('[dev] Reverted SIDPlayer.js silent fallback.');
  }
} else if (src.includes(MARKER)) {
  console.log('[dev] SIDPlayer.js already patched for silent SID.');
} else {
  if (!src.includes(original) || !src.includes(processOriginal)) {
    console.warn('[dev] Could not find SIDPlayer patch target; skipping patch.');
    process.exit(0);
  }
  let out = src
    .replace(original, replacement)
    .replace(processOriginal, processReplacement);
  for (const [orig, patched] of guardPairs) out = out.replace(orig, patched);
  fs.writeFileSync(file, out);
  console.log('[dev] Patched SIDPlayer.js with a silent fallback.');
}
