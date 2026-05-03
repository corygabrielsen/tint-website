#!/bin/bash
# Validate the current branch name against the Conventional Commits
# pattern documented in CONTRIBUTING.md.
#
# Pattern: <type>/<short-description>
#   - <type> is one of the 11 Conventional Commits types
#   - <short-description> is lowercase ASCII with hyphens
#
# `master` is allowed (the no-commit-to-branch hook gates direct
# commits there separately).
#
# Branch name comes from the BRANCH env var if set, else from
# `git rev-parse --abbrev-ref HEAD`. CI sets BRANCH to the PR's
# head ref so the same script validates locally and remotely.
#
# Exit codes:
#   0 - Valid
#   1 - Invalid

set -o errexit
set -o nounset
set -o pipefail

BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

if [ "$BRANCH" = "master" ]; then
    exit 0
fi

if [[ "$BRANCH" =~ ^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)/[a-z0-9-]+$ ]]; then
    exit 0
fi

{
    echo "Branch name validation failed: '$BRANCH'"
    echo ""
    echo "Expected: <type>/<short-description>"
    echo ""
    echo "Where <type> is one of:"
    echo "  build, chore, ci, docs, feat, fix, perf, refactor,"
    echo "  revert, style, test"
    echo ""
    echo "And <short-description> is lowercase ASCII with hyphens."
    echo ""
    echo "See CONTRIBUTING.md for details."
} >&2
exit 1
