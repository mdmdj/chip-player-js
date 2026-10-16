/*
  viogsf's VBA-M core marks hot functions with __attribute__((regparm(n))), an
  i386-only calling convention. Newer clang rejects it outright on wasm (older
  emsdk evidently tolerated it), and we do not patch sibling repos, so this header
  is force-included on that build to define the attribute away.

  Dev-only, and under dev/ so it can never reach the PR. See the viogsf section of
  scripts/build-subprojects.sh.
*/
#ifndef CP_EMSCRIPTEN_REGPARM_COMPAT_H
#define CP_EMSCRIPTEN_REGPARM_COMPAT_H

#define regparm(x)

#endif
