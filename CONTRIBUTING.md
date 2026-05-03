# Contributing

## Branching Strategy

All feature branches merge directly into `master`:

```
feat/* ──► master
```

- **master**: main integration branch. PRs use squash merge for
  linear history. CI must pass. Resolve all review threads before
  merging.

Always branch from and target `master` for feature work.

## Branch Names

Use lowercase with hyphens: `<type>/<short-description>`.

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
