# Contributing to JStack

Thanks for helping improve JStack. Changes should stay small, portable, and easy to review across Claude Code, Codex, and IBM Bob.

## Before you start

- Search existing issues and pull requests before proposing duplicate work.
- Open an issue first for major workflow, architecture, or compatibility changes.
- Keep platform-specific behavior out of the canonical skills unless the behavior cannot be expressed portably.
- Never include credentials, customer data, internal URLs, or private prompts in issues, fixtures, or logs.

## Development setup

JStack requires Node.js 20 or newer for repository checks. The shipped skills themselves are Markdown and do not require Node.js at runtime.

```sh
git clone https://github.com/JustinPrograms/jstack.git
cd jstack
npm test
```

## Use JStack to improve JStack

When your agent host has JStack installed, use the relevant workflow:

```text
$jstack-plan Describe the change.
$jstack-implement Continue with the approved plan.
$jstack-test Add focused regression and edge-case tests.
$jstack-review Review the resulting local change set.
```

Small, precise changes may not need every phase. The repository's `AGENTS.md` contains additional instructions for coding agents working in this repository.

## Pull requests

- Create a focused branch from the latest `main`.
- Add or update tests when behavior changes.
- Run `npm test` and any narrower relevant checks.
- Keep unrelated cleanup out of the pull request.
- Complete the pull request template with a short summary and the checks you ran.
- Address review feedback with additional commits; GitHub squashes the branch when the pull request is merged.

By contributing, you agree that your contribution is licensed under the repository's [AGPL-3.0-or-later license](LICENSE).
