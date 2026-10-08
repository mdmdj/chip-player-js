#!/usr/bin/env bash
#
# Build the C/C++ subprojects with Emscripten so that
# scripts/build-chip-core.js can link them into chip-core.wasm.
#
# The large engines are sibling checkouts, as README.md describes --
# ../libvgm, ../libxmp, ../FluidLite, ../game-music-emu (clone them first).
# libADLMIDI, psflib and lazyusf2 remain vendored in-repo and are built here.
# Each subproject is built to the exact static library path build-chip-core.js
# expects.
#
# Requires: emcc/emmake/emcmake on PATH (Arch: `pacman -S emscripten`) and
# cmake. libsidplayfp (SID) is a sibling too; build it separately with
# scripts/build-libsidplayfp.sh, or skip it with CHIP_NO_SID=1.
#
# Usage:
#   ./scripts/build-subprojects.sh              # all but SID
#   CHIP_NO_SID=1 ./scripts/build-subprojects.sh
#   ./scripts/build-subprojects.sh gme libxmp   # only named subprojects
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Emscripten lives in /usr/lib/emscripten on Arch, added to PATH by
# /etc/profile.d/emscripten.sh (which non-login shells skip).
if ! command -v emcc >/dev/null 2>&1 && [ -d /usr/lib/emscripten ]; then
  export PATH="$PATH:/usr/lib/emscripten"
fi
if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Install Emscripten (Arch: pacman -S emscripten)." >&2
  exit 1
fi
if ! command -v cmake >/dev/null 2>&1; then
  echo "error: cmake not found. Install cmake." >&2
  exit 1
fi

EMCMAKE_FLAGS=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="-Oz -flto -DNDEBUG" -DCMAKE_CXX_FLAGS="-Oz -flto -DNDEBUG")

# Emscripten's bundled static zlib (FindZLIB can't discover it on its own).
EM_SYSROOT=$(emcc -sUSE_ZLIB=1 --show-ports >/dev/null 2>&1; emcc -E -x c /dev/null -v 2>&1 | sed -n 's/.*--sysroot=\([^ ]*\).*/\1/p' | head -1)
EM_ZLIB_LIB="$EM_SYSROOT/lib/wasm32-emscripten/libz.a"
EM_ZLIB_INC="$EM_SYSROOT/include"

# Force a clean cmake cache: the source trees carry stale absolute paths from
# the maintainer's machine (and an old emsdk include dir).
# CMAKE_POLICY_VERSION_MINIMUM=3.5 lets these old projects configure under
# CMake >= 4 (which dropped compatibility with cmake_minimum_required < 3.5).
configure() {
  local dir="$1"; shift
  rm -rf "$dir/build"
  mkdir -p "$dir/build"
  ( cd "$dir/build" && emcmake cmake "${EMCMAKE_FLAGS[@]}" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "$@" .. )
}

# Only build the requested subprojects (default: everything in the loop below,
# i.e. all but libsidplayfp, which has its own script).
want() {
  [ "${#SELECTED[@]}" -eq 0 ] && return 0
  local name="$1"
  for arg in "${SELECTED[@]}"; do [ "$arg" = "$name" ] && return 0; done
  return 1
}
SELECTED=("$@")

build_gme() {
  echo "== game-music-emu =="
  # Pruned to the formats our app routes to GME (NSF/NSFE/SPC/AY/GBS, plus
  # SAP/SGC which stay compilable but unrouted): VGM/GYM/HES/KSS are OFF
  # because libvgm owns all OPN/OPL emulation, and leaving their sources in
  # silently duplicates FM symbols at link time (libgme.a winning over
  # libvgm's cores -- see --allow-multiple-definition). NSF's VRC7 (ym2413.c)
  # is unconditional in gme/CMakeLists.txt so pruning is safe; the linker
  # will name anything else it still needs.
  configure ../game-music-emu \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_UBSAN=OFF \
    -DUSE_GME_SGC=ON \
    -DUSE_GME_VGM=OFF \
    -DUSE_GME_GYM=OFF \
    -DUSE_GME_HES=OFF \
    -DUSE_GME_KSS=OFF \
    -DZLIB_LIBRARY="$EM_ZLIB_LIB" -DZLIB_INCLUDE_DIR="$EM_ZLIB_INC"
  ( cd ../game-music-emu/build && emmake make -j"$(nproc)" )
  echo "   -> game-music-emu/build/gme/libgme.a"
}

build_libADLMIDI() {
  echo "== libADLMIDI (static, no LTO, Nuked OPL3 core) =="
  # Built separately WITHOUT -flto: global link-time optimization corrupts the
  # C++ object model across libADLMIDI's translation units, aborting in
  # ~DosBoxOPL3 during adl_setBank. We use the Nuked core instead, whose
  # destructor doesn't trip that abort; DOSBox stays compiled out. Compiled with
  # the same flags as build-chip-core.js so headers/layout agree.
  local abs="$PWD/libADLMIDI"
  local out="$abs/build"
  mkdir -p "$out"
  local sources="chips/nuked_opl3.cpp chips/nuked/nukedopl3.c \
    chips/nuked_opl3_v174.cpp chips/nuked/nukedopl3_174.c \
    wopl/wopl_file.c inst_db.cpp adlmidi.cpp adlmidi_load.cpp \
    adlmidi_midiplay.cpp adlmidi_opl3.cpp adlmidi_private.cpp"
  local objs
  objs=$(echo "$sources" | xargs -n1 basename | sed 's/\.\(cpp\|c\)/.o/g')
  ( cd "$abs" \
    && rm -f ./*.o \
    && em++ -c -Oz \
         -I"$abs/include" \
         -DBWMIDI_DISABLE_XMI_SUPPORT -DBWMIDI_DISABLE_MUS_SUPPORT \
         -DADLMIDI_DISABLE_MIDI_SEQUENCER \
         -DADLMIDI_DISABLE_DOSBOX_EMULATOR -DADLMIDI_DISABLE_JAVA_EMULATOR \
         -DADLMIDI_DISABLE_OPAL_EMULATOR \
         $(for f in $sources; do echo "src/$f"; done) \
    && rm -f build/libADLMIDI.a \
    && emar rcs build/libADLMIDI.a $objs \
    && rm -f ./*.o )
  echo "   -> libADLMIDI/build/libADLMIDI.a"
}

build_libxmp() {
  echo "== libxmp (lite, static) =="
  # Upstream libxmp builds the lite library from CMake (OUTPUT_NAME xmp-lite ->
  # libxmp-lite.a on non-MSVC). The old in-repo tree instead shipped a separate
  # lite/ subproject with a hand-compiled source list, and that layout no longer
  # exists upstream, so the CMake target is the only recipe that works here.
  configure ../libxmp -DBUILD_LITE=ON -DBUILD_STATIC=ON
  ( cd ../libxmp/build && emmake make -j"$(nproc)" )
  echo "   -> libxmp/build/libxmp-lite.a"
}

build_libvgm() {
  echo "== libvgm =="
  # libvgm's utils use zlib (for vgz). Point CMake at Emscripten's bundled
  # static zlib, which FindZLIB can't discover on its own.
  local sysroot
  sysroot=$(emcc -sUSE_ZLIB=1 --show-ports >/dev/null 2>&1; emcc -E -x c /dev/null -v 2>&1 | sed -n 's/.*--sysroot=\([^ ]*\).*/\1/p' | head -1)
  local zlibLib="$sysroot/lib/wasm32-emscripten/libz.a"
  local zlibInc="$sysroot/include"
  # All three YM2612 cores stay ON, and the reason is a link constraint, not a
  # quality ranking. 2612intf.h enables EC_YM2612_{GPGX,GENS,NUKED} itself, so
  # devDefList_YM2612 always names all three; these flags decide which source
  # files are COMPILED. Turning one off leaves its devDef referencing symbols
  # with no object behind it, so the link fails rather than degrading.
  #
  # Core selection: devDefList_YM2612 lists MAME/GPGX FIRST (2612intf.c:109),
  # so GPGX is what actually runs. An earlier version of this comment claimed
  # Gens was picked first and that GPGX was the cause of YM2612 VGMs freezing at
  # position 0. Both were wrong. GPGX was never broken: the freeze came from
  # GME and libvgm both exporting MAME ym*_write, and --allow-multiple-definition
  # keeping GME's copy for a libvgm FM_OPN. That is fixed by pruning GME's OPN
  # objects (USE_GME_VGM/GYM/HES/KSS=OFF above); no per-device core override
  # exists in the wrapper and none is needed. See AGENTS.md.
  # Iconv_LIBRARY=c: CMake's FindIconv detects iconv built into libc but then
  # fails its find_library(c) check; satisfy it so libvgm uses real charset
  # conversion (musl iconv supports UTF-16LE/CP1252/CP932).
  configure ../libvgm -DBUILD_LIBEMU=ON -DBUILD_LIBPLAYER=ON \
    -DBUILD_PLAYER=OFF -DBUILD_VGM2WAV=OFF -DBUILD_TESTS=OFF -DUSE_SANITIZERS=OFF \
    -DSNDEMU_YM2612_GENS=ON -DSNDEMU_YM2612_GPGX=ON -DSNDEMU_YM2612_NUKED=ON \
    -DIconv_LIBRARY=c \
    -DZLIB_LIBRARY="$zlibLib" -DZLIB_INCLUDE_DIR="$zlibInc"
  ( cd ../libvgm/build && emmake make -j"$(nproc)" )
  echo "   -> libvgm/build/bin/libvgm-{emu,utils,player}.a"
}

build_fluidlite() {
  echo "== fluidlite (static) =="
  # README clones FluidLite (capital L); build-chip-core.js links
  # ../FluidLite/build/libfluidlite.a. Its generated headers (fluidlite/
  # version.h) land in the build dir, which tinyplayer.c's include needs.
  configure ../FluidLite -DBUILD_STATIC=ON -DBUILD_SHARED=OFF
  ( cd ../FluidLite/build && emmake make -j"$(nproc)" fluidlite-static )
  echo "   -> FluidLite/build/libfluidlite.a"
}

build_psflib() {
  echo "== psflib =="
  ( cd psflib && emmake make -f Emscripten.Makefile libpsflib.a )
  echo "   -> psflib/libpsflib.a"
}

build_lazyusf2() {
  echo "== lazyusf2 =="
  configure lazyusf2
  ( cd lazyusf2/build && emmake make -j"$(nproc)" )
  echo "   -> lazyusf2/build/liblazyusf2.a"
}

for name in gme libADLMIDI libxmp libvgm fluidlite psflib lazyusf2; do
  want "$name" && "build_$name"
done

echo
echo "Done. Next: npm run build-chip-core"
