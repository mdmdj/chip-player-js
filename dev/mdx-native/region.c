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
 * mdx_get_length() in seconds -- the parse's length under the per-track fade
 * gate, which is short of the section end when per > 1.
 *
 * With --play <ms> it renders that much audio first and appends fields:
 *
 *     <per_section>  <limit>  <played_ms>  <ended_ms>  <engine_min>
 *     <section_end_ms>  <fade_onset_ms>
 *
 * per_section is mdx_get_loops_per_section() and, without --sections, limit is
 * mdx_get_section_loop_limit(): the pair the counter-gated engine used to need
 * when Repeat One was switched off (the engine's limit counted per-track
 * repeats, while the band counts joint sections).
 *
 * With --sections the limit is instead the joint-section count MDXPlayer now
 * passes -- max(2, sections completed + 1) -- and section_end_ms is the
 * boundary it names (intro + limit * loop). fade_onset_ms is the elapsed time at
 * which mdxmini actually starts its fade, read from the engine. The fade must
 * begin on section_end_ms: gated on the per-track minimum it instead begins on
 * the slowest track's own grid, overshooting the section end by up to one tick.
 *
 * This exists because the JS harnesses in dev/ cannot reach the C: they fake
 * the region getters. Running the real mdxmini as a normal Linux binary is the
 * only way to exercise the loop-region recording (mdxmini/src/mdxmml_ym2151.c).
 *
 * Forks per file, so a malformed MDX cannot abort a whole corpus run.
 *
 * Build:  make -C dev/mdx-native region
 * Run:    find catalog/mdx -iname '*.MDX' | dev/mdx-native/region
 *         printf '%s\n' catalog/mdx/FACE04.MDX | dev/mdx-native/region --play 296485
 */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include "mdxmini.h"

static int play_ms = 0;
static int limit_arg = 0;
static int sections = 0;   /* --sections: leave the engine a joint-section limit */

/* mdxmini has no fade accessor; the onset is only needed here, so the getter
 * lives in a DEV region of mdxmml_ym2151.c and is declared locally. */
int mdx_parse_mml_get_fade_out(void* in_self);

static int engine_min_loops(t_mdxmini *d) {
  /* The quantity the fade gate itself uses: the smallest loop counter among
   * live tracks (mdxmml_ym2151.c, the fade test). Printed so a check can see
   * the unit its limit is in rather than infer it. */
  int i, min = -1;
  if (!d->mdx) return -1;
  for (i = 0; i < d->mdx->tracks; i++) {
    if (d->mdx->track[i].waiting_sync == 1) continue;
    if (d->mdx->track[i].counter < 0) continue;
    if (min < 0 || d->mdx->track[i].infinite_loop_times < min)
      min = d->mdx->track[i].infinite_loop_times;
  }
  return min;
}

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
    printf("%s\tOPEN_FAIL\t0\t0\t0\t0\t0\t0\t0\t0\t0\n", path);
    return;
  }
  int len = mdx_get_length(&d);
  int intro = mdx_get_loop_start_ms(&d);
  int loop = mdx_get_loop_length_ms(&d);
  int per = 0, limit = 0, played = 0, ended = 0, engine_min = 0;
  int section_end = 0, fade_onset = -1;

  /* Measured at parse time, so it is readable without playback: this is the
     column a corpus-wide "how many files have per > 1" scan reads. */
  per = mdx_get_loops_per_section(&d);

  if (play_ms > 0) {
    /* The same call the player makes, so the track counters advance the way
     * they do in the app; the engine's own clock decides when to stop.
     *
     * Loop forever first: a section-2 position is usually *past* the parsed
     * length (the parse gates on per-track loops, so its figure is short of the
     * section end when per > 1), and under Repeat One the player is in exactly
     * that state -- with the default limit the engine would fade, end, and stop
     * advancing the clock. */
    short buf[2048];
    long last = -1;
    int stalled = 0;
    mdx_set_max_loop(&d, 0);
    while (d.mdx && d.mdx->elapsed_time < (long)play_ms * 1000) {
      last = d.mdx->elapsed_time;
      mdx_calc_sample(&d, buf, 1024);
      if (d.mdx->elapsed_time == last && ++stalled > 1000) break;   /* engine ended */
    }
    played = d.mdx ? (int)(d.mdx->elapsed_time / 1000) : 0;
    engine_min = engine_min_loops(&d);

    /* The limit to hand the engine, and the section boundary it should land on.
     * --sections uses the joint-section count MDXPlayer passes now; the default
     * keeps the old counter projection for comparison. */
    if (loop > 0 && intro >= 0) {
      int cur = played >= intro ? (played - intro) / loop : 0;
      if (sections) {
        limit = cur + 1;
        if (limit < 2) limit = 2;              /* the two-pass floor, in sections */
        section_end = intro + limit * loop;
      } else {
        limit = mdx_get_section_loop_limit(&d);
        section_end = intro + (cur + 1) * loop;  /* the next boundary */
      }
    }

    /* Now do to the engine what the player does when Repeat One is switched
     * off -- hand it a limit and let it finish the section and fade -- and
     * report where the fade actually begins and when the engine stops. The
     * onset is the claim under test: it must be section_end, not the next tick
     * of the slowest track's own counter. --limit overrides what is applied,
     * which is the negative control. */
    if (limit > 0) {
      int apply = limit_arg > 0 ? limit_arg : limit;
      /* Render past the boundary the limit names -- with the gate on the joint
         section the fade is a whole section away, not the next tick, so a
         played+900ms window would miss it. */
      long bound = section_end > 0 ? section_end + 20000 : played + 900;
      mdx_set_max_loop(&d, apply);
      stalled = 0;
      while (d.mdx) {
        if (fade_onset < 0 && mdx_parse_mml_get_fade_out(d.self) > 0)
          fade_onset = (int)(d.mdx->elapsed_time / 1000);
        long pre = d.mdx->elapsed_time;
        mdx_calc_sample(&d, buf, 1024);
        if (d.mdx->elapsed_time == pre) { if (++stalled > 2000) break; }
        else stalled = 0;
        if (d.mdx->elapsed_time > bound * 1000) break;   /* hard bound */
      }
      ended = d.mdx ? (int)(d.mdx->elapsed_time / 1000) : 0;
    }
  }

  printf("%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n", path, intro, loop, len, per, limit, played, ended, engine_min, section_end, fade_onset);
  mdx_close(&d);
}

int main(int argc, char **argv) {
  char path[4096];
  int i;
  mdx_set_rate(48000);
  for (i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--play")) play_ms = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--limit")) limit_arg = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--sections")) sections = 1;
    else { fprintf(stderr, "region: unknown argument %s\n", argv[i]); return 2; }
  }
  while (fgets(path, sizeof path, stdin)) {
    size_t n = strlen(path);
    while (n && (path[n-1] == '\n' || path[n-1] == '\r')) path[--n] = 0;
    if (!n) continue;
    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) { one(path); fflush(stdout); _exit(0); }
    int st = 0;
    waitpid(pid, &st, 0);
    if (WIFSIGNALED(st)) { printf("%s\tCRASH\t0\t0\t0\t0\t0\t0\t0\t0\t0\n", path); fflush(stdout); }
  }
  return 0;
}
