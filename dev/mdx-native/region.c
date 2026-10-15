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
 * mdx_get_length() in seconds -- the parse's length under the same fade gate
 * playback uses (the joint-section grid; see --length-check).
 *
 * With --length-check <limit> it prints the length claim directly:
 *
 *     <path>  <len_ms>  <ended_ms>  <delta_ms>
 *
 * len_ms is mdx_get_length() under that limit, and ended_ms is where the engine
 * actually stops when rendered from the start under the same limit; the two
 * must agree, and delta_ms is their gap.
 *
 * With --play <ms> it renders that much audio first and appends fields:
 *
 *     <limit>  <played_ms>  <ended_ms>  <engine_min>
 *     <section_end_ms>  <fade_onset_ms>
 *
 * limit is the joint-section count MDXPlayer passes -- max(2, sections
 * completed + 1) -- and section_end_ms is the boundary it names
 * (intro + limit * loop). fade_onset_ms is where the fade becomes audible: the
 * same window is rendered twice, once with the limit applied and once with it
 * lifted, and the two block levels are compared. mdxmini schedules identical
 * events either way, so their ratio is the engine's gain, which steps down
 * (one YM2151 volume step, ~0.75 dB) the moment the fade starts. The fade must
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
#include <math.h>
#include <unistd.h>
#include <sys/wait.h>
#include "mdxmini.h"

static int play_ms = 0;
static int limit_arg = 0;
static int len_check_limit = 0;

/* One rendered block (mdx_calc_sample's 1024 samples): its position on the
 * engine clock and its RMS. The fade is a gain on every sample, so the RMS
 * ratio between two otherwise-identical renders is that gain. */
typedef struct { int ms; double lvl; } blk;

static void push(blk **a, int *n, int *cap, int ms, double lvl) {
  if (*n == *cap) { *cap = *cap ? *cap * 2 : 4096; *a = realloc(*a, sizeof(blk) * *cap); }
  (*a)[*n].ms = ms; (*a)[*n].lvl = lvl; (*n)++;
}

/* Render until the engine clock reaches to_ms, appending every block. `limit`
 * is handed to mdx_set_max_loop first (0 = loop forever). Returns nonzero if
 * the engine stalled -- it has ended, its clock no longer advances. */
static int render(t_mdxmini *d, blk **arr, int *n, int *cap, long to_ms, int limit) {
  short buf[2048];   /* mdx_calc_sample writes all channels: 1024 stereo frames */
  int stalled = 0;
  mdx_set_max_loop(d, limit);
  while (d->mdx && d->mdx->elapsed_time < to_ms * 1000) {
    long pre = d->mdx->elapsed_time;
    int i;
    double s = 0;
    mdx_calc_sample(d, buf, 1024);
    for (i = 0; i < 1024; i++) s += (double)buf[i] * buf[i];
    push(arr, n, cap, (int)(d->mdx->elapsed_time / 1000), sqrt(s / 1024.0));
    if (d->mdx->elapsed_time == pre) { if (++stalled > 2000) return 1; }
    else stalled = 0;
  }
  return 0;
}

/* The audible fade onset, or -1 if none begins within the window. The fade run
 * has already recorded its blocks; only the no-fade reference is rendered here.
 * Both renders schedule the same events, so at any block the ratio of the fade
 * level to the reference level is the engine's gain, which starts at 1 and
 * steps down by one YM2151 volume step (0.75 dB, ~0.917) when the fade begins.
 * The onset is the first block the ratio falls below 0.96 -- solidly inside
 * that first step, so the resolution is one block (~20 ms at 48 kHz). */
static int fade_onset_ms(const char *path, const char *dir, blk *fb, int fn, long bound) {
  t_mdxmini r;
  blk *rb = NULL;
  int rn = 0, rcap = 0, i;
  memset(&r, 0, sizeof r);
  if (mdx_open(&r, (char *)path, (char *)dir) != 0) return -1;
  mdx_get_length(&r);
  render(&r, &rb, &rn, &rcap, bound, 0);
  int onset = -1;
  for (i = 0; i < fn && i < rn; i++) {
    if (rb[i].ms != fb[i].ms) break;   /* the fade run ended: the clocks diverge */
    if (rb[i].lvl < 5.0) continue;     /* reference near silence: ratio meaningless */
    if (fb[i].lvl / rb[i].lvl < 0.96) { onset = fb[i].ms; break; }
  }
  free(rb);
  mdx_close(&r);
  return onset;
}

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

/* The length mdx_get_length() reports must be the length the engine plays under
 * the same finite limit: both gate the fade on the quantity loop_gate_value
 * returns. A joint section that is several repeats of the longest track (per >
 * 1) used to be measured on the raw per-track minimum, which turns a section's
 * worth early, so the parse reported a figure short of the section end and the
 * app armed its end detector there and stopped the song mid-fade.
 *
 * Renders from the start with the limit so the engine's own clock says when it
 * ends; len is truncated to whole seconds, so a small positive delta is
 * expected -- the bug is a delta of whole sections. */
static void length_check(const char *path, const char *dir, int limit) {
  t_mdxmini d;
  blk *b = NULL;
  int n = 0, cap = 0;
  memset(&d, 0, sizeof d);
  if (mdx_open(&d, (char *)path, (char *)dir) != 0) {
    printf("%s\tOPEN_FAIL\t0\t0\n", path);
    return;
  }
  mdx_set_max_loop(&d, limit);
  int len = mdx_get_length(&d) * 1000;
  render(&d, &b, &n, &cap, len + 120000, limit);
  int ended = d.mdx ? (int)(d.mdx->elapsed_time / 1000) : 0;
  printf("%s\t%d\t%d\t%d\n", path, len, ended, ended - len);
  free(b);
  mdx_close(&d);
}

static void one(const char *path) {
  /* mdx_open wants a directory to look for the PDX samples in; they are
   * optional for the region (it comes from the MML data), so a miss is fine. */
  char dir[4096];
  strcpy(dir, path);
  char *slash = strrchr(dir, '/');
  if (slash) *slash = 0; else strcpy(dir, ".");

  if (len_check_limit > 0) { length_check(path, dir, len_check_limit); return; }

  t_mdxmini d;
  memset(&d, 0, sizeof d);
  if (mdx_open(&d, (char *)path, dir) != 0) {
    printf("%s\tOPEN_FAIL\t0\t0\t0\t0\t0\t0\t0\t0\n", path);
    return;
  }
  int len = mdx_get_length(&d);
  int intro = mdx_get_loop_start_ms(&d);
  int loop = mdx_get_loop_length_ms(&d);
  int limit = 0, played = 0, ended = 0, engine_min = 0;
  int section_end = 0, fade_onset = -1;

  if (play_ms > 0) {
    /* The same call the player makes, so the track counters advance the way
     * they do in the app; the engine's own clock decides when to stop.
     *
     * Loop forever first: under Repeat One the player is in exactly that state,
     * and a default limit would let the engine fade, end, and stop advancing
     * the clock before play_ms. */
    blk *fb = NULL;
    int fn = 0, fcap = 0;

    render(&d, &fb, &fn, &fcap, play_ms, 0);
    played = d.mdx ? (int)(d.mdx->elapsed_time / 1000) : 0;
    engine_min = engine_min_loops(&d);

    /* The limit to hand the engine: the joint-section count MDXPlayer passes,
     * max(2, sections completed + 1), and the boundary it names. */
    if (loop > 0 && intro >= 0) {
      int cur = played >= intro ? (played - intro) / loop : 0;
      limit = cur + 1;
      if (limit < 2) limit = 2;              /* the two-pass floor, in sections */
      section_end = intro + limit * loop;
    }

    /* Now do to the engine what the player does when Repeat One is switched
     * off -- hand it a limit and let it finish the section and fade -- and
     * report where the fade becomes audible and when the engine stops. The
     * onset is the claim under test: it must be section_end, not the next tick
     * of the slowest track's own counter. --limit overrides what is applied,
     * which is the negative control. */
    if (limit > 0) {
      int apply = limit_arg > 0 ? limit_arg : limit;
      /* Render past the boundary the limit names -- with the gate on the joint
         section the fade is a whole section away, not the next tick, so a
         played+900ms window would miss it. */
      long bound = section_end > 0 ? section_end + 20000 : played + 900;
      render(&d, &fb, &fn, &fcap, bound, apply);
      ended = d.mdx ? (int)(d.mdx->elapsed_time / 1000) : 0;
      fade_onset = fade_onset_ms(path, dir, fb, fn, bound);
    }
    free(fb);
  }

  printf("%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n", path, intro, loop, len, limit, played, ended, engine_min, section_end, fade_onset);
  mdx_close(&d);
}

int main(int argc, char **argv) {
  char path[4096];
  int i;
  mdx_set_rate(48000);
  for (i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--play")) play_ms = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--limit")) limit_arg = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--length-check")) len_check_limit = atoi(argv[++i]);
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
    if (WIFSIGNALED(st)) { printf("%s\tCRASH\t0\t0\t0\t0\t0\t0\t0\t0\n", path); fflush(stdout); }
  }
  return 0;
}
