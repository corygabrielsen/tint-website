# Contributing

For project conventions — branching strategy, branch naming,
commit messages, PR rules, labels — see
[`AGENTS.md`](./AGENTS.md). It's the canonical source of truth.

## Quickstart for external contributors

1. Fork the repo.
2. Branch off `master` using a Conventional Commits prefix
   (`feat/`, `fix/`, `docs/`, etc.). Branch names must match the
   regex documented in `AGENTS.md`.
3. Open a PR. CI will validate the title; the auto-labeler will
   tag the PR by changed files.
4. Merge via squash-merge from the GitHub UI.
