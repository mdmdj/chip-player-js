# Real PR against upstream — plan (not submitted)

Target: `mmontag/chip-player-js` `master`, from our fork (`origin` = `mdmdj/chip-player-js`).
Head branch: **`pr/subtunes-as-first-class`** — the clean name, no `v2` (that one belongs
to practice PR #12 and is left alone). **Never push to `upstream`** (its push URL exists).

State when this was written (2026-10-16):

- `upstream/master` = `e90f505cc`; our `origin/master` = `8991472d7` → **9 behind, 0 ahead**.
- `feature/subtunes-as-first-class` = `535106512`, carrying upstream as of the *old*
  `8991472d7` (as a merge, not a rebase — keep it that way).
- `git diff upstream/master..feature` therefore reads **56 files, +4159/−2266**: the
  deletions are upstream's own 9 commits, not our content. After Phase 1 the same
  command must read the feature only (~49 files, small deletion count).
- No overlay-only paths in the diff (no `dev/`, `AGENTS.md`, `.nvmrc`, `package.json`),
  and `dev/check-promotable-refs.js` is green.

## Phase 1 — sync upstream, then prove the diff is the feature

1. `git fetch upstream` (done; re-run before starting).
2. In the feature worktree:
   `git -C ../chip-player-js-feature merge upstream/master`
   Resolve by hand where our feature and upstream both moved — expect
   `scripts/build-chip-core.js`, `server/index.js`, `src/index.js` (the three that held
   overlay deltas on 2026-10-07), plus `scripts/{metadata-parsers,build-music}.js` after
   upstream's 2026-09-26 split of the parsers.
   **Keep it a merge**, so the sub-tune commits keep their identity.
3. `./dev/rebase.sh` — bring the overlay on top, and let its tree check run (never
   rebase by hand).
4. Re-verify on the merged tree: `./dev/run-tests.sh`; `make -C dev/mdx-native check`;
   `node scripts/build-chip-core.js` (the core is gitignored, so this is ours, but it
   proves the merged sources still compile).
5. **Gate:** `git diff --stat upstream/master..feature` must now be the feature alone.
   Read the file list and confirm every entry is intended for review.

## Phase 2 — the review surface

6. `./dev/remove.sh` (drops the staged dev shims and reverts the in-place patch), then
   `git status --short` and `git diff --stat` must both be empty of tracked changes.
7. Publish the changelog site: `node dev/record/build-site.mjs` → host `site/` at a
   public URL (relative URLs only, Range-capable server) and put the link in the body.
   **Needs a decision: where to host it.**
8. Write `dev/upstream-pr-body.md` (separate from the practice `dev/pr-body.md`):
   feature summary; the clip-site link; a short "what to try"; a build note (our engine
   surface: which exports/APIs the wrapper needs, so his build is not a surprise); and
   the known, deliberate limitations — SID `seek()` is WIP in the fork and tune-dependent
   (same as prod), V2M's reported duration is wrong, N64's seek is synchronous, the Web
   MIDI wrap's ≤33 ms head slop, MDX long-loop files resolve no region at the app's
   measurement limit, and the seam's state-at-the-jump-target semantics. Tests are
   deliberately dev-only; offer a tracked `node --test` suite on request.

## Phase 3 — the squash branch (clean name)

9. `TREE=$(git rev-parse feature/subtunes-as-first-class^{tree})`
   `NEW=$(git commit-tree "$TREE" -p upstream/master -m "<dev/upstream-pr-body.md H1>")`
   `git branch -f pr/subtunes-as-first-class "$NEW"`
10. Assert `git diff --stat feature/subtunes-as-first-class pr/subtunes-as-first-class`
    is empty; `git push -u origin pr/subtunes-as-first-class`.

## Phase 4 — submit (STOP: needs an explicit go)

11. `gh pr create --repo mmontag/chip-player-js --base master \
      --head mdmdj:pr/subtunes-as-first-class \
      --title "<H1>" --body-file dev/upstream-pr-body.md`
12. Verify through the contents API that the head is the squash we built, then link and
    watch it in T3 and report.

## Phase 5 — after review

- Expect questions about the engine trees (see risks). Answer with the pins we build
  against (`src/chip-core.wasm.buildinfo.json` records them) and ask for his.
- If he reports a build break in the wrapper, the fix is a compat define or a
  feature-detect in JS, not a re-architecture.

## Risks

| risk | mitigation |
| --- | --- |
| upstream moved during review (already 9 commits) | Phase 1 merge; re-run before submitting; a small merge at the end is normal |
| his engines are not ours (documented, unverifiable from here) | engine surface kept minimal and documented in the body; ask for his pins; feature-detect in JS |
| SID seek WIP, V2M duration, N64 seek freeze, MIDI slop, MDX any-limit region | stated in the body as known; each has a written decision in our notes |
| no test runner upstream | offered, not imposed (dev harnesses stay out of the PR) |

## Guardrails

- Nothing under `dev/`, no `AGENTS.md`, no `.nvmrc`, no `package.json`/lock changes, no
  vendored engine *build* tooling: the PR is the feature plus the minimal engine surface.
- No push to `upstream`; the head branch lives in our fork.
- Practice PR #12 (`pr/subtunes-as-first-class-v2`) is untouched; delete its branch after
  the real PR is up, if we want the namespace clean.
