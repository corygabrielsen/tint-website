#!/bin/bash
# Validate commit message follows the 50/72 rule.
#
# Rules enforced:
#   1. Subject line ≤50 characters
#   2. Body wrapped at 72 characters
#      - Exempt: code blocks, tables, URLs, indented code, blockquotes
#
# Options:
#   --no-pr-suffix   Use 50-char limit (no room reserved for PR suffix)
#
# Usage:
#   validate-commit-message.sh <file>   # Read from file (strips # comments)
#   validate-commit-message.sh -        # Read from stdin (no comment stripping)
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

# Split into subject and body
# Use printf to avoid echo interpreting dash-prefixed messages as flags
SUBJECT=$(printf '%s\n' "$COMMIT_MSG" | head -n1)
BODY=$(printf '%s\n' "$COMMIT_MSG" | tail -n +3)  # Skip subject and blank line

subject_errors=()
body_errors=()

# === SUBJECT LINE CHECK ===
MAX_SUBJECT=50

# Infer suffix width from recent PR numbers in commit history.
# Walk backwards to find the highest " (#N)" suffix, count its digits,
# and reserve that many (plus one if all digits are 9, anticipating rollover).
# Suffix is " (#" + digits + ")" so total overhead = 4 + digit_count.
# Falls back to 40 if no history or not in a git repo.
MAX_SUBJECT_WITH_SUFFIX=40
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
    _latest_pr=$(git log --oneline -50 2>/dev/null \
        | sed -n 's/.* (#\([0-9]\{1,\}\))$/\1/p' \
        | head -1)
    if [ -n "$_latest_pr" ]; then
        _digits=${#_latest_pr}
        # If all nines (9, 99, 999...), next PR rolls over to one more digit
        _all_nines=$(printf '%0*d' "$_digits" 0 | tr '0' '9')
        if [ "$_latest_pr" = "$_all_nines" ]; then
            _digits=$((_digits + 1))
        fi
        MAX_SUBJECT_WITH_SUFFIX=$((MAX_SUBJECT - 4 - _digits))
    fi
fi

subject_len=${#SUBJECT}

if [ -z "$SUBJECT" ]; then
    subject_errors+=("Subject line cannot be empty")
    max_len=$MAX_SUBJECT_WITH_SUFFIX  # Default for output
elif [[ "$SUBJECT" =~ \ \(#[0-9]+\)$ ]]; then
    # Already has PR suffix
    max_len=$MAX_SUBJECT
    if [ "$subject_len" -gt "$max_len" ]; then
        overage=$((subject_len - max_len))
        subject_errors+=("Subject: $subject_len chars, limit $max_len ($overage over)")
    fi
else
    # No PR suffix yet
    if $NO_PR_SUFFIX; then
        max_len=$MAX_SUBJECT
    else
        max_len=$MAX_SUBJECT_WITH_SUFFIX
    fi
    if [ "$subject_len" -gt "$max_len" ]; then
        overage=$((subject_len - max_len))
        if $NO_PR_SUFFIX; then
            subject_errors+=("Subject: $subject_len chars, limit $max_len ($overage over)")
        else
            subject_errors+=("Subject: $subject_len chars, limit $max_len (room for PR suffix) ($overage over)")
        fi
    fi
fi

# === BODY LINE CHECK ===
# "Wrap the body at 72 characters"
# Exempt: code blocks, tables, URLs, indented code, blockquotes
if [ -n "$BODY" ]; then
    line_num=0
    in_code_block=false

    while IFS= read -r line || [ -n "$line" ]; do
        line_num=$((line_num + 1))
        line_len=${#line}

        # Track code block state
        if [[ "$line" =~ ^\`\`\` ]]; then
            if $in_code_block; then in_code_block=false; else in_code_block=true; fi
            continue
        fi

        # Skip exempt lines
        $in_code_block && continue
        [[ "$line" =~ ^[[:space:]]*\| ]] && continue      # Markdown table
        [[ "$line" =~ https?:// ]] && continue            # Contains URL
        [[ "$line" =~ ^[[:space:]]{4} ]] && continue      # Indented code
        [[ "$line" =~ ^$'\t' ]] && continue               # Tab-indented code
        [[ "$line" =~ ^\> ]] && continue                  # Blockquote

        if [ "$line_len" -gt 72 ]; then
            body_errors+=("Line $line_num: $line_len chars")
        fi
    done <<< "$BODY"
fi

# === OUTPUT ===
if [ ${#subject_errors[@]} -eq 0 ] && [ ${#body_errors[@]} -eq 0 ]; then
    echo "Commit message OK (subject: $subject_len/$max_len chars)"
    exit 0
fi

echo "Commit message validation failed (50/72 rule):"
echo ""

if [ ${#subject_errors[@]} -gt 0 ]; then
    for err in "${subject_errors[@]}"; do
        echo "  $err"
    done
    echo "  Text: $SUBJECT"
    echo ""
fi

if [ ${#body_errors[@]} -gt 0 ]; then
    echo "  Body lines exceeding 72 chars:"
    for err in "${body_errors[@]}"; do
        echo "    $err"
    done
    echo ""
fi

exit 1
