#!/usr/bin/env bash
#
# Build the vendored C/C++ subprojects with Emscripten so that
# scripts/build-chip-core.js can link them into chip-core.wasm.
#
# All sources are vendored in this repo (the README's "clone side-by-side"
# instructions are out of date). Each subproject is built to the exact static
# library path build-chip-core.js expects.
#
# Requires: emcc/emmake/emcmake on PATH (Arch: `pacman -S emscripten`) and
# cmake. libsidplayfp (SID) is NOT vendored; build it separately with
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

# Force a clean cmake cache: the vendored trees carry stale absolute paths from
# the maintainer's machine (and an old emsdk include dir).
# CMAKE_POLICY_VERSION_MINIMUM=3.5 lets these old projects configure under
# CMake >= 4 (which dropped compatibility with cmake_minimum_required < 3.5).
configure() {
  local dir="$1"; shift
  rm -rf "$dir/build"
  mkdir -p "$dir/build"
  ( cd "$dir/build" && emcmake cmake "${EMCMAKE_FLAGS[@]}" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "$@" .. )
}

# Only build the requested subprojects (default: all but libsidplayfp).
want() {
  [ "$#" -eq 0 ] && return 0
  local name="$1"
  for arg in "${SELECTED[@]}"; do [ "$arg" = "$name" ] && return 0; done
  return 1
}
SELECTED=("$@")

build_gme() {
  echo "== game-music-emu =="
  # Full GME chip set (default). VGM/GYM are also present here even though
  # libvgm normally handles them: disabling them leaves NSF's VRC7 (ym2413,
  # Z80) undefined, because GME's CMake gates those shared sources behind the
  # VGM/GYM block. The resulting duplicate FM symbols are tolerated at link
  # time with --allow-multiple-definition (see build-chip-core.js).
  configure game-music-emu \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_UBSAN=OFF \
    -DUSE_GME_SGC=ON \
    -DZLIB_LIBRARY="$EM_ZLIB_LIB" -DZLIB_INCLUDE_DIR="$EM_ZLIB_INC"
  ( cd game-music-emu/build && emmake make -j"$(nproc)" )
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
  # libxmp/lite ships only its own format.c (it/mod/s3m/xm) + loader subset;
  # the rest of the sources/header come from the parent libxmp/ tree. Compile
  # from libxmp/src but substitute the lite format.c, matching `make dist`.
  local abs="$PWD/libxmp"
  local out="$abs/build"
  mkdir -p "$out"
  local common="src/period.c src/player.c src/read_event.c src/misc.c src/dataio.c \
    src/lfo.c src/scan.c src/control.c src/filter.c src/effects.c src/mixer.c \
    src/mix_all.c src/load_helpers.c src/load.c src/filetype.c src/hio.c \
    src/smix.c src/memio.c src/loaders/common.c src/loaders/itsex.c \
    src/loaders/sample.c src/loaders/xm_load.c \
    src/loaders/s3m_load.c src/loaders/it_load.c src/virtual.c"
  # emcc -c writes each object as basename.o in the cwd.
  local objs
  objs=$(echo "$common" | xargs -n1 basename | sed 's/\.c/.o/g')
  objs="$objs lite_format.o lite_mod_load.o"
  ( cd "$abs" \
    && rm -f ./*.o \
    && emcc -c -Oz -flto -DLIBXMP_CORE_PLAYER -DLIBXMP_NO_PROWIZARD -DLIBXMP_NO_DEPACKERS \
         -I"$abs/include" -I"$abs/src" -I"$abs/src/loaders" $common \
    && emcc -c -Oz -flto -DLIBXMP_CORE_PLAYER -DLIBXMP_NO_PROWIZARD -DLIBXMP_NO_DEPACKERS \
         -I"$abs/include" -I"$abs/src" -I"$abs/src/loaders" \
         -o lite_format.o lite/src/format.c \
    && emcc -c -Oz -flto -DLIBXMP_CORE_PLAYER -DLIBXMP_NO_PROWIZARD -DLIBXMP_NO_DEPACKERS \
         -I"$abs/include" -I"$abs/src" -I"$abs/src/loaders" \
         -o lite_mod_load.o lite/src/loaders/mod_load.c \
    && emar rcs build/libxmp-lite.a $objs lite_format.o \
    && rm -f ./*.o )
  mkdir -p libxmp/build
  [ "$out/libxmp-lite.a" != "$PWD/libxmp/build/libxmp-lite.a" ] && cp -f "$out/libxmp-lite.a" libxmp/build/libxmp-lite.a
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
  # Add the dedicated Gens YM2612 core ahead of the GPGX default. GPGX must stay
  # ON: libvgm only registers the YM2612 device when one of the YM2612 cores is
  # enabled, and the GPGX core (fmopn.c) is what leaves YM2612 VGMs (e.g. the
  # gym set) stuck at position 0 under Emscripten. With both built, libvgm picks
  # the first matching core, which is Gens.
  # Iconv_LIBRARY=c: CMake's FindIconv detects iconv built into libc but then
  # fails its find_library(c) check; satisfy it so libvgm uses real charset
  # conversion (musl iconv supports UTF-16LE/CP1252/CP932).
  configure libvgm -DBUILD_LIBEMU=ON -DBUILD_LIBPLAYER=ON \
    -DBUILD_PLAYER=OFF -DBUILD_VGM2WAV=OFF -DBUILD_TESTS=OFF -DUSE_SANITIZERS=OFF \
    -DSNDEMU_YM2612_GENS=ON -DSNDEMU_YM2612_GPGX=ON \
    -DIconv_LIBRARY=c \
    -DZLIB_LIBRARY="$zlibLib" -DZLIB_INCLUDE_DIR="$zlibInc"
  ( cd libvgm/build && emmake make -j"$(nproc)" )
  echo "   -> libvgm/build/bin/libvgm-{emu,utils,player}.a"
}

build_fluidlite() {
  echo "== fluidlite (static; bundles libogg/libvorbis) =="
  # NOTE: expected output path is ../FluidLite/build (capital L), but the
  # vendored source dir is lowercase fluidlite/. Bridge the case difference.
  configure fluidlite -DBUILD_STATIC=ON -DBUILD_SHARED=OFF
  ( cd fluidlite/build && emmake make -j"$(nproc)" fluidlite-static )
  mkdir -p FluidLite
  cp -f fluidlite/build/libfluidlite.a FluidLite/build/libfluidlite.a 2>/dev/null || {
    mkdir -p FluidLite/build && cp -f fluidlite/build/libfluidlite.a FluidLite/build/libfluidlite.a; }
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
