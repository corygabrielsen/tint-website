# Contributing

## Commit Messages

**Subject line:**

1. Use the imperative mood ("Add", not "Added")
2. Write it as a natural, sentence-like command
3. Capitalize it, no trailing period
4. Limit to 50 characters (42 to allow room for ` (#NNNN)` PR suffix)

**Body** (separated from subject by a blank line):

1. Explain what and why, not how
2. Markdown is welcome — use code blocks, tables, headers freely
3. Body length is unconstrained

The subject-line rule is enforced by the `commit-msg` pre-commit
hook (see `scripts/validate-commit-message.sh`).
