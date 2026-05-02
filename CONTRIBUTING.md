# Contributing

## Commit Messages

**Subject line:**

1. Use the imperative mood ("Add", not "Added")
2. Write it as a natural, sentence-like command
3. Capitalize it, no trailing period
4. Limit to 50 characters (42 to allow room for ` (#NNNN)` PR suffix)

**Body** (separated from subject by a blank line):

1. Explain what and why, not how
2. Hard-wrap prose at 72 characters
3. Markdown is welcome — fenced code blocks, tables, URL-bearing
   lines, indented code, and blockquotes are exempt from the
   72-character wrap

Both rules are enforced by the `commit-msg` pre-commit hook
(see `scripts/validate-commit-message.sh`).
