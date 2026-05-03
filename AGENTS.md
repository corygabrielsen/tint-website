# AGENTS.md

Canonical conventions for agents (and humans) contributing to this
repo. `CONTRIBUTING.md` points here for the full rules.

## Purpose

Companion site for [`tint`](https://github.com/corygabrielsen/tint),
the terminal-color tool. Will eventually be deployed at `tint.sh`;
the site code itself is not in this repo yet — only the project's
operational conventions and CI scaffolding.

## Branching

All work goes through PRs. Direct push to `master` is blocked
server-side by a Repository Ruleset.

Branch names must match this regex:

```
^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)/[a-z0-9-]+$
```

Enforced locally by `no-commit-to-branch --pattern` (in inverted
form) and server-side by a "Restrict creations" ruleset.

The 11 prefixes are the Conventional Commits types. There is no
`spike/` extension — exploratory work that lands uses
`chore: explore X`.

## Commits

- Subject ≤ 50 chars when the squash-merge `(#NNNN)` suffix is
  already appended; ≤ 42 when it isn't yet, leaving 8 chars of
  headroom.
- Imperative mood ("Add", not "Added"). No trailing period.
- Body is unconstrained — any wrap, any length, markdown welcome.
- Enforced by the `commit-msg` pre-commit hook (see
  `scripts/validate-commit-message.sh`).
- Don't skip hooks (`--no-verify`).

## Pull requests

- One focused change per PR. Defer noticed-but-unflagged cleanups
  to follow-up PRs.
- Squash-merge only. master has linear history; force-push and
  deletion are blocked; required signatures (web-UI squash merges
  sign automatically).
- PR title becomes the merged commit subject (with `(#NNN)`
  appended), so it follows the same 50/42 rule. Validated by the
  `CI: PR Title` workflow.
- Set a label, assign yourself (`gh pr create --assignee @me`),
  mark ready for review.

## Labels

Auto-applied by `.github/labeler.yml` on PR open/edit/sync:

| Label            | Glob                                         |
| ---------------- | -------------------------------------------- |
| `documentation`  | `docs/**`, `**/*.md`                         |
| `github actions` | `.github/workflows/**`, `.github/actions/**` |

Other labels are applied manually:

- `bug`, `duplicate`, `enhancement`, `good first issue`,
  `help wanted`, `invalid`, `question`, `wontfix` — GitHub defaults
- `refactor` — code restructuring without behavior change

## Files

| File                                     | Purpose                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `.github/workflows/ci-pr-validation.yml` | PR title validator (CI)                                  |
| `.github/workflows/ci-label-pr.yml`      | Auto-labeler (CI)                                        |
| `.github/labeler.yml`                    | Label-glob rules                                         |
| `.pre-commit-config.yaml`                | Local hooks (branch name, commit message, hygiene)       |
| `scripts/validate-commit-message.sh`     | Commit-subject validator (shared by hook and any caller) |

## Local setup

```sh
pre-commit install
```

`default_install_hook_types: [pre-commit, commit-msg]` in the
config means a single `pre-commit install` activates both hook
stages.
