/*
 * MDX track classifier (dev-only) -- triage for the loop-region bug.
 *
 * Walks every track's MML command stream with mdxtools' command-length table
 * (the same walker mdxdump uses) and reports, tab-separated:
 *
 *     <path>  <looping_tracks>  <substantial_one_shots>  <stub_tracks>
 *
 * The terminating command tells a track's fate: 0xF1 0x00 is a plain
 * performance end (a one-shot that never loops), 0xF1 nn is a loop-back. A
 * "stub" is a channel that is only an end command. A file with both a looping
 * track and a substantial one-shot is a candidate for the bug the region fix
 * addresses: the one-shot used to hold the song-wide loop minimum at 0 until it
 * ended, so its dropout was misread as the first loop.
 *
 * This is the tool that found the 4,706 candidates in the corpus; pair it with
 * region.c to see which actually changed. It needs a mdxtools checkout
 * (GPL-3.0, github.com/vampirefrog/mdxtools) for mdx.c/tools.c/mdx.h:
 *
 *     git clone --depth 1 https://github.com/vampirefrog/mdxtools /tmp/mdxtools
 *     make -C dev/mdx-native scan-tracks MDXTOOLS_DIR=/tmp/mdxtools
 *     find dev/mdx-corpus -iname '*.mdx' | dev/mdx-native/scan-tracks
 *
 * mdxtools defines its own mdx.h/tools.h, so this target is built without
 * -Imdxmini/src to avoid the mdx.h name clash with mdxmini's.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "mdx.h"

static uint8_t *slurp(const char *path, int *len) {
  FILE *fp = fopen(path, "rb");
  if (!fp) return NULL;
  fseek(fp, 0, SEEK_END);
  long n = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  if (n <= 0) { fclose(fp); return NULL; }
  uint8_t *b = malloc(n);
  if (fread(b, 1, n, fp) != (size_t)n) { fclose(fp); free(b); return NULL; }
  fclose(fp);
  *len = (int)n;
  return b;
}

int main(void) {
  char path[4096];
  while (fgets(path, sizeof path, stdin)) {
    size_t n = strlen(path);
    while (n && (path[n-1] == '\n' || path[n-1] == '\r')) path[--n] = 0;
    if (!n) continue;

    int len = 0;
    uint8_t *b = slurp(path, &len);
    if (!b) continue;
    struct mdx_file f;
    memset(&f, 0, sizeof f);
    if (mdx_file_load(&f, b, len) != 0) { free(b); continue; }

    int looping = 0, one_shots = 0, stubs = 0;
    for (int i = 0; i < f.num_tracks; i++) {
      struct mdx_track *t = &f.tracks[i];
      if (t->data_len <= 0) continue;
      int j = 0, cmds = 0, end = -1;
      while (j < t->data_len) {
        int l = mdx_cmd_len(t->data, j, t->data_len - j);
        if (l <= 0) break;
        uint8_t c = t->data[j];
        cmds++;
        if (c == 0xf1) { end = (j + 1 < t->data_len && t->data[j+1] == 0) ? 0 : 1; break; }
        j += l;
      }
      if (end == 1) looping++;
      else if (end == 0) { if (cmds > 1) one_shots++; else stubs++; }
    }
    free(b);
    if (looping > 0 && one_shots > 0)
      printf("%s\t%d\t%d\t%d\n", path, looping, one_shots, stubs);
  }
  return 0;
}
