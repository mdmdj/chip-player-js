#!/usr/bin/env bash
#
# DEV-ONLY: show what would be promoted from dev/overlay to
# feature/subtunes-as-first-class. This script CANNOT promote: it has no write
# path at all. That is deliberate -- promotion writes commits to the reviewable
# PR branch, so it must be asked for, not reached for. See
# dev/promote-apply.sh for the (armed) writer.
#
# The feature branch is the reviewable PR and must contain ONLY feature work.
# dev/overlay stacks dev tooling and audio/engine work on top. When you finish a
# chunk of feature work on the overlay branch, look at the plan here and decide.
#
# How it decides what is feature:
#   * Whole dev/engine AREAS are listed in dev/promote-paths.txt and skipped
#     (directories, build scripts, bindings, vendored trees, and the 1-2 seam
#     files whose dev delta cannot be an additive region).
#   * Dev code inside any other (feature) file is wrapped in additive sentinel
#     regions `// DEV-BEGIN ... // DEV-END`; promotion STRIPS them, which
#     restores prod behavior exactly.
#
# Usage:
#   ./dev/promote.sh      # the only mode: show the plan
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dev/promote-plan.sh
source "$DIR/promote-plan.sh"

[ ${#plan[@]} -eq 0 ] && exit 0

echo
echo "To promote, arm the writer and run it (you have to want this):"
echo "  touch dev/.promote-armed"
echo "  ./dev/promote-apply.sh"