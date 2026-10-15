/*
 * Native MDX loop-region harness (dev-only).
 *
 * Reads MDX paths from stdin, one per line, and prints, tab-separated:
 *
 *     <path>  <intro_ms>  <loop_ms>  <length_s>
 *
 * intro_ms / loop_ms are exactly what mdx_get_loop_start_ms and
 * mdx_get_loop_length_ms return -- the values MDXPlayer maps onto
 * metadata.intro_length / loop_length, i.e. the slider band. length_s is
 * mdx_get_length() (the parsed song length, before the fade).
 *
 * This exists because the JS harnesses in dev/ cannot reach the C: they fake
 * the region getters. Running the real mdxmini as a normal Linux binary is the
 * only way to exercise the loop-region recording (mdxmini/src/mdxmml_ym2151.c).
 *
 * Forks per file, so a malformed MDX cannot abort a whole corpus run.
 *
 * Build:  make -C dev/mdx-native region
 * Run:    find catalog/mdx -iname '*.MDX' | dev/mdx-native/region
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include "mdxmini.h"

static void one(const char *path) {
  /* mdx_open wants a directory to look for the PDX samples in; they are
   * optional for the region (it comes from the MML data), so a miss is fine. */
  char dir[4096];
  strcpy(dir, path);
  char *slash = strrchr(dir, '/');
  if (slash) *slash = 0; else strcpy(dir, ".");

  t_mdxmini d;
  memset(&d, 0, sizeof d);
  if (mdx_open(&d, (char *)path, dir) != 0) {
    printf("%s\tOPEN_FAIL\t0\t0\n", path);
    return;
  }
  int len = mdx_get_length(&d);
  int intro = mdx_get_loop_start_ms(&d);
  int loop = mdx_get_loop_length_ms(&d);
  printf("%s\t%d\t%d\t%d\n", path, intro, loop, len);
  mdx_close(&d);
}

int main(void) {
  char path[4096];
  mdx_set_rate(48000);
  while (fgets(path, sizeof path, stdin)) {
    size_t n = strlen(path);
    while (n && (path[n-1] == '\n' || path[n-1] == '\r')) path[--n] = 0;
    if (!n) continue;
    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) { one(path); fflush(stdout); _exit(0); }
    int st = 0;
    waitpid(pid, &st, 0);
    if (WIFSIGNALED(st)) { printf("%s\tCRASH\t0\t0\n", path); fflush(stdout); }
  }
  return 0;
}
