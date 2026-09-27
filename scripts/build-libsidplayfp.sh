#!/usr/bin/env bash
#
# Build libsidplayfp (the SID core) with Emscripten so that
# scripts/build-chip-core.js can link it into chip-core.wasm.
#
# It is not vendored in this repo, so this fetches the official v2.9.0 release
# tarball into ../libsidplayfp by default. v2.9.0 is deliberate: it is the last
# official release with the classic ReSIDBuilder the wrapper uses (3.x dropped
# it for residfp), and the release tarball ships the generated 6502 driver .bin
# files, so no xa65 cross-assembler is needed.
#
# mmontag/libsidplayfp is NOT used: it pins reSID submodule commits that were
# never pushed to the public reSID repo, so it cannot be cloned reproducibly.
# Its fast seek()/setTempo() calls are compiled out of the wrapper by
# build-chip-core.js when they are absent (see SIDPLAYFP_HAVE_SEEK there).
#
# Usage:
#   ./scripts/build-libsidplayfp.sh                 # fetch (if needed) + build
#   ./scripts/build-libsidplayfp.sh /path/to/source # build an existing tree
#
# Output: ../libsidplayfp/src/.libs/libsidplayfp.a
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=2.9.0
TARBALL="libsidplayfp-${VERSION}.tar.gz"
URL="https://github.com/libsidplayfp/libsidplayfp/releases/download/v${VERSION}/${TARBALL}"

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
  if [ -e "$SRC" ] && [ -n "$(ls -A "$SRC" 2>/dev/null || true)" ]; then
    echo "error: $SRC exists but has no ./configure (a git clone needs autoreconf)." >&2
    echo "       Delete it to fetch the release tarball, or run autoreconf there first." >&2
    exit 1
  fi
  echo "Fetching libsidplayfp $VERSION..."
  rm -rf "$SRC"
  mkdir -p "$SRC"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$tmp/$TARBALL" "$URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$tmp/$TARBALL" "$URL"
  else
    echo "error: curl or wget is required to fetch $URL" >&2
    exit 1
  fi
  tar xzf "$tmp/$TARBALL" -C "$SRC" --strip-components=1
  rm -rf "$tmp"
  trap - EXIT
fi

echo "== libsidplayfp $VERSION =="
cd "$SRC"

# The release tarball ships the generated 6502 driver .bin files. Keep them
# newer than their .a65 sources so make never tries to rebuild them with xa65.
touch src/psiddrv.bin src/sidtune/sidplayer1.bin src/sidtune/sidplayer2.bin

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
