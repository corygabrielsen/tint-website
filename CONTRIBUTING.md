# Contributing

## Branching Strategy

All topic branches merge directly into `master`:

```
<type>/* ──► master
```

- **master**: main integration branch. PRs use squash merge for
  linear history. CI must pass. Resolve all review threads before
  merging.

Always branch from and target `master`.

## Branch Names

Format: `<type>/<short-description>`. The description is lowercase ASCII letters, digits, and hyphens. The full allowlist regex:

```
^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)/[a-z0-9-]+$
```

This regex is the authoritative rule. The pre-commit hook enforces it locally (in inverted form, via `no-commit-to-branch --pattern`); the GitHub Repository Ruleset enforces it server-side at branch-creation time.

Conventional Commits types:

- `build/` — build system changes
- `chore/` — maintenance tasks
- `ci/` — continuous integration changes
- `docs/` — documentation
- `feat/` — new functionality
- `fix/` — bug fixes
- `perf/` — performance improvements
- `refactor/` — code restructuring without behavior change
- `revert/` — reverts
- `style/` — formatting and style changes
- `test/` — adding or updating tests

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
