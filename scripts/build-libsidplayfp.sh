#!/usr/bin/env bash
#
# Build libsidplayfp (the SID core) with Emscripten so that
# scripts/build-chip-core.js can link it into chip-core.wasm.
#
# It is not vendored in this repo, so this clones mmontag/libsidplayfp (branch
# montag-dev-2.14) recursively into ../libsidplayfp by default. That fork is
# based on the last release with the classic ReSIDBuilder the wrapper uses (3.x
# dropped it for residfp) and adds the fast seek()/setTempo() the wrapper calls;
# build-chip-core.js probes for seek() and defines SIDPLAYFP_HAVE_SEEK. The
# fork's reSID changes live in a submodule (mmontag/resid), so --recursive is
# required. Building from git also means the 6502 driver .bin files are
# assembled from source, which needs xa65 (Arch: pacman -S xa).
#
# Usage:
#   ./scripts/build-libsidplayfp.sh                 # clone (if needed) + build
#   ./scripts/build-libsidplayfp.sh /path/to/source # build an existing tree
#
# Output: ../libsidplayfp/src/.libs/libsidplayfp.a
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH=montag-dev-2.14
# Pin the branch tip so builds are reproducible; this also fixes the reSID
# submodule (its gitlink) without needing to name it separately.
COMMIT=f3766acbdee478385d702500084e556777fef2a6
REPO=https://github.com/mmontag/libsidplayfp.git

SRC="${1:-$ROOT/../libsidplayfp}"

# Emscripten lives in /usr/lib/emscripten on Arch, added to PATH by
# /etc/profile.d/emscripten.sh (which non-login shells skip).
if ! command -v emcc >/dev/null 2>&1 && [ -d /usr/lib/emscripten ]; then
  export PATH="$PATH:/usr/lib/emscripten"
fi
if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten (Arch: pacman -S emscripten)." >&2
  exit 1
fi

if [ ! -f "$SRC/configure" ]; then
  # Release tarballs ship ./configure; a git checkout needs autoreconf.
  if [ -e "$SRC" ] && [ -n "$(ls -A "$SRC" 2>/dev/null || true)" ]; then
    echo "Running autoreconf in existing $SRC..."
    (cd "$SRC" && autoreconf -i)
  else
    echo "Cloning mmontag/libsidplayfp ($BRANCH @ $COMMIT)..."
    rm -rf "$SRC"
    git clone --recursive -b "$BRANCH" "$REPO" "$SRC"
    (cd "$SRC" && git checkout "$COMMIT" && git submodule update --init --recursive)
    (cd "$SRC" && autoreconf -i)
  fi
fi

echo "== libsidplayfp (mmontag fork, $BRANCH) =="
cd "$SRC"

# The fork assembles the 6502 drivers from source (the old official tarball
# shipped them prebuilt). If they exist, keep them newer than their .a65
# sources so make never rebuilds them; otherwise xa is required.
for b in src/psiddrv.bin src/sidtune/sidplayer1.bin src/sidtune/sidplayer2.bin; do
  if [ -f "$b" ]; then
    touch "$b"
  elif ! command -v xa >/dev/null 2>&1; then
    echo "error: xa (6502 assembler) required to build $b. Arch: pacman -S xa" >&2
    exit 1
  fi
done

emconfigure ./configure \
  --host=wasm32-unknown-emscripten \
  --disable-shared --enable-static --disable-debug \
  --without-exsid --without-gcrypt \
  --with-simd=sse4 \
  CXXFLAGS="-Oz -flto -msimd128" \
  CFLAGS="-Oz -flto -msimd128" \
  LDFLAGS="-Oz -flto -msimd128"
emmake make -j"$(nproc)"

echo "   -> $SRC/src/.libs/libsidplayfp.a"
echo
echo "Done. Next: CHIP_SID=1 npm run build-chip-core"
