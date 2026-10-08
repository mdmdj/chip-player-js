const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Provenance for the external audio engines.
//
// Every engine the core links is either vendored in-repo or a sibling checkout,
// and the two need different identities:
//
//   in-repo  -> a tree hash (git rev-parse HEAD:<dir>) works even though the
//               directory has no .git of its own. Content-addressed, so it
//               cannot silently go stale.
//   sibling  -> a commit, plus recursive submodule state. libsidplayfp is a
//               fork (mmontag/libsidplayfp) whose reSID core is a second fork
//               (mmontag/resid) on its own branch, reached through two
//               submodules; a shallow or non-recursive clone gets the wrong
//               core, so the branch is recorded too, not just the hash.
//
// `tier` records how much the identity is worth:
//   authoritative - specified by the upstream maintainer
//   verified      - content-matched against upstream history
//   base+patches  - matches no upstream blob; our local edits explain it
//   assumed       - nothing better available
//
// Deliberately whitelisted, never scraped: commit/tree hashes only, no `git log`
// output (author names and emails), no remote URLs (a clone URL can embed a
// credential), and no absolute paths (they leak a build user's home directory).

const ROOT = path.resolve(__dirname, '..');

const ENGINES = [
  { name: 'libvgm', sibling: '../libvgm', tier: 'verified', repo: 'ValleyBell/libvgm' },
  { name: 'libxmp', sibling: '../libxmp', tier: 'verified', repo: 'libxmp/libxmp' },
  { name: 'game-music-emu', sibling: '../game-music-emu', tier: 'base+patches', repo: 'mmontag/game-music-emu' },
  { name: 'fluidlite', sibling: '../FluidLite', tier: 'verified', repo: 'divideconcept/FluidLite' },
  { name: 'libADLMIDI', dir: 'libADLMIDI', tier: 'verified', note: 'upstream CMakeLists blob matched' },
  {
    name: 'libsidplayfp',
    sibling: '../libsidplayfp',
    tier: 'authoritative',
    repo: 'mmontag/libsidplayfp',
  },
];

const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch (e) {
    return null;
  }
};

// Submodules, deepest first, as "<short hash> <path> (<describe>)". The
// describe string is where the fork branch shows up, which is the part a bare
// hash loses.
const submodules = (dir) => {
  const out = git(dir, ['submodule', 'status', '--recursive']);
  if (!out) return null;
  const mods = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    mods[m[2]] = { revision: m[1].slice(0, 12), describe: (m[3] || '').trim() || null };
  }
  return Object.keys(mods).length ? mods : null;
};

function engineInfo(engine) {
  if (engine.sibling) {
    const dir = path.resolve(ROOT, engine.sibling);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      return { name: engine.name, tier: engine.tier, repo: engine.repo, source: 'sibling', present: false };
    }
    return {
      name: engine.name,
      tier: engine.tier,
      repo: engine.repo,
      source: 'sibling',
      revision: (git(dir, ['rev-parse', 'HEAD']) || '').slice(0, 12) || null,
      submodules: submodules(dir),
    };
  }

  const tree = git(ROOT, ['rev-parse', `HEAD:${engine.dir}`]);
  return {
    name: engine.name,
    tier: engine.tier,
    source: 'in-repo',
    tree: tree ? tree.slice(0, 12) : null,
    present: fs.existsSync(path.join(ROOT, engine.dir)),
    note: engine.note || null,
  };
}

function buildInfo() {
  return {
    // Kept on one line by JSON.stringify at the injection site so it survives
    // minification and stays greppable in the shipped bundle.
    builtAt: new Date().toISOString(),
    node: process.version,
    engines: ENGINES.map(engineInfo),
  };
}

module.exports = { buildInfo, engineInfo, ENGINES };