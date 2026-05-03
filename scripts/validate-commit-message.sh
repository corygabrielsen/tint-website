#!/bin/bash
# Validate commit message subject line.
#
# Rules:
#   - Subject ≤ 50 characters when the subject already ends in
#     " (#N)" (the squash-merge form).
#   - Subject ≤ 42 characters when there is no PR suffix yet,
#     leaving 8 characters of headroom for GitHub to append the
#     " (#NNNN)" suffix on squash merge.
#   - Pass --no-pr-suffix to use the 50-char limit even without a
#     suffix (used by the local commit-msg hook, which sees the
#     pre-squash subject).
#   - Body is unconstrained.
#
# Usage:
#   validate-commit-message.sh [--no-pr-suffix] <file>   # File input (strips # comments)
#   validate-commit-message.sh [--no-pr-suffix] -        # stdin (no comment stripping)
#
# Exit codes:
#   0 - Valid
#   1 - Invalid

set -o errexit
set -o nounset
set -o pipefail

NO_PR_SUFFIX=false
while [ $# -gt 1 ]; do
    case "$1" in
        --no-pr-suffix) NO_PR_SUFFIX=true; shift ;;
        *) break ;;
    esac
done

if [ $# -lt 1 ]; then
    echo "Usage: $0 [--no-pr-suffix] <commit-msg-file|->" >&2
    exit 1
fi

INPUT="$1"

# Read commit message
if [ "$INPUT" = "-" ]; then
    COMMIT_MSG=$(cat)
elif [ -f "$INPUT" ]; then
    # Strip comment lines (git's default commit template has them)
    COMMIT_MSG=$(grep -v '^#' "$INPUT" || true)
else
    echo "Error: File not found: $INPUT" >&2
    exit 1
fi

# Subject is the first line. printf avoids `echo` interpreting
# dash-prefixed messages as flags.
SUBJECT=$(printf '%s\n' "$COMMIT_MSG" | head -n1)
subject_len=${#SUBJECT}

MAX_WITH_SUFFIX=50
MAX_NO_SUFFIX=42

if [ -z "$SUBJECT" ]; then
    {
        echo "Commit message validation failed: subject is empty"
        echo ""
        echo "See CONTRIBUTING.md for commit message guidelines."
    } >&2
    exit 1
elif [[ "$SUBJECT" =~ \ \(#[0-9]+\)$ ]]; then
    max_len=$MAX_WITH_SUFFIX
elif $NO_PR_SUFFIX; then
    max_len=$MAX_WITH_SUFFIX
else
    max_len=$MAX_NO_SUFFIX
fi

if [ "$subject_len" -gt "$max_len" ]; then
    overage=$((subject_len - max_len))
    {
        echo "Commit message validation failed: subject too long"
        echo ""
        echo "  $subject_len chars, limit $max_len ($overage over)"
        echo "  Text: $SUBJECT"
        echo ""
        echo "See CONTRIBUTING.md for commit message guidelines."
    } >&2
    exit 1
fi

echo "Commit message OK (subject: $subject_len/$max_len chars)"
exit 0
