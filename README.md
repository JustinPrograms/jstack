# story-stack

`story-stack` is a local-first Claude Code skill pack for carrying Jira-style engineering work across compaction, usage limits, and new sessions. Version 0.2 includes the Phase 1 planning-to-recovery foundation plus the first Phase 2 vertical slice: an interactive `/plan-eng-review` workflow with an atomic plan-approval gate.

This is an original implementation inspired by workflow separation, not a copy of another skill pack. It has no telemetry, analytics, cloud persistence, or network synchronization. The runtime has no third-party dependencies and invokes only local, read-only Git operations.

## What is included

- `/story`: explains and plans supplied story text without editing application code.
- `/plan-eng-review`: challenges scope, architecture, failure handling, tests, and delivery one decision at a time, then finalizes an explicitly approved plan without editing application code.
- `/review`: reports on a local diff without applying fixes.
- `/resume-story`: validates and reconciles a saved checkpoint before continuing.
- A versioned Markdown checkpoint engine with strict metadata, privacy guards, atomic writes, and coordinator-only locking.
- Content-sensitive local Git snapshots and four-way recovery status: current, stale but reconcilable, different branch, or missing required information.
- A dry-run-first installer and hash-verified uninstaller.

Still planned for later Phase 2 slices, but deliberately not scaffolded here:

- `/implement`: execute an approved plan within its gates.
- `/verify`: run and record risk-appropriate validation.
- `/address-review`: apply approved review corrections and re-check them.
- `/learn`: maintain private, local lessons without mixing them into the generic framework.

## Requirements and development

- Node.js 20 or newer
- Git available on `PATH`

```text
npm install
npm test
```

On Windows systems that block PowerShell script shims, use `npm.cmd install` and `npm.cmd test`. The build output is generated under `dist/` and is intentionally ignored by Git.

Run the development CLI after building:

```text
npm run build
node dist/src/cli.js doctor
node dist/src/cli.js help
```

The test suite uses Node's built-in test runner and disposable local Git repositories. It never configures a remote and never changes the current repository's index or history.

## Checkpoint model

Each ticket is stored at:

```text
~/.story-stack/state/<project-slug>/<ticket-key>/context.md
```

The YAML frontmatter is engine-owned. It records schema and ticket identity, the canonical repository path, current and base branches, HEAD, dirty state, bounded changed-file summaries, untracked counts, timestamps, the worktree fingerprint, and validation freshness. The Markdown body is a concise current snapshot with objective, criteria, plan, progress, decisions, tests, review state, blockers, and approval gates.

The fingerprint hashes branch and HEAD data, raw Git status, staged and unstaged binary diffs, and the contents of untracked files. Only the digest is saved; diffs and file contents are never put in the checkpoint. Untracked filenames are omitted by default and represented by a count.

Checkpoint updates use a same-directory temporary file, file flush, atomic rename, compare-and-swap check, and a coordinator lock. A lock older than 30 minutes is removed only when its recorded process can be proven absent. An unchanged body and repository snapshot do not rewrite the file or advance `updated_at`.

## CLI usage

Identifiers reject path syntax before normalization. Project labels normalize to lowercase kebab-case; Jira-style ticket keys normalize to uppercase.

```text
story-stack doctor
story-stack state init --project sample-app --ticket DEMO-101 --repo . --base-branch main --objective "Add a local preference"
story-stack state path --project sample-app --ticket DEMO-101 --repo .
story-stack state show --project sample-app --ticket DEMO-101 --repo .
story-stack state validate --project sample-app --ticket DEMO-101 --repo .
story-stack state snapshot --project sample-app --ticket DEMO-101 --repo .
story-stack state recovery --project sample-app --ticket DEMO-101 --repo .
story-stack state approve-plan --project sample-app --ticket DEMO-101 --repo . --body-file <reviewed-body.md> --confirm-user-approved
story-stack state complete --project sample-app --ticket DEMO-101 --repo .
```

`state path` returns the intended safe path when an explicit identity is supplied, even before a checkpoint exists. Other state commands require an existing checkpoint. When project and ticket are omitted, the CLI selects only if exactly one valid checkpoint matches the canonical repository; it never guesses among multiple tickets.

Claude supplies meaningful Markdown through the engine rather than directly editing `context.md`:

```text
story-stack state update --project sample-app --ticket DEMO-101 --repo . --body-file <temporary-body.md>
story-stack state update --project sample-app --ticket DEMO-101 --repo . --section "Exact next action" --body-file <temporary-section.md>
```

Changing `Required user approvals` needs `--allow-approval-change`. Use `--mark-validated` only in the same update that records a successful validation summary for the current repository fingerprint, or on a snapshot whose existing validation section already records that success. Completion requires current validation, an `in-review` status, recorded acceptance criteria and plan, and no pending feedback, blockers, or approvals.

`state approve-plan` is intentionally narrower than a normal update. It accepts a complete checkpoint body only after the coordinating agent has received explicit approval for the reviewed plan. It refuses stale or cross-branch state, incomplete objectives or criteria, unresolved blockers, draft plan text, and any removal or replacement of existing approval gates. Success moves an eligible ticket to `ready`; it does not authorize implementation by itself.

The `/plan-eng-review` flow is interactive for material choices. It first challenges scope and reuse, then reviews architecture, correctness, test coverage, and delivery risks. Each unresolved issue is presented separately with evidence, impact, an opinionated recommendation, and concrete tradeoffs. Accepted decisions are saved as a concise current snapshot so a later session can resume at the next open decision without replaying the review.

All read and mutation commands support `--json`. `state validate` and `state recovery` return exit code 0 for current, 2 for stale but reconcilable, 3 for a branch mismatch, and 4 for missing required information.

## Installation

Build first, then inspect the install plan. Installation is a dry run unless `--apply` is present.

```text
npm run build
node dist/src/cli.js install --dry-run
node dist/src/cli.js install --apply
```

The plan lists every absolute target. Runtime, policy, launcher, manifest, and private state live below `~/.story-stack/`; only the four implemented skill files are placed below `~/.claude/skills/`. The installer does not change `PATH`, shell profiles, Git configuration, Claude settings, or hooks. It uses no symlinks and needs no administrator access.

Any existing target is a collision, including an identical file. Apply refuses all collisions before writing anything. An intentional replacement additionally requires the literal confirmation option shown by the collision report; uninstalling the prior manifest first is safer.

The installed portable invocation is:

```text
node <absolute-home-path>/.story-stack/bin/story-stack.js doctor
```

The installer also creates an extensionless executable launcher for macOS/Linux and a `.cmd` launcher for Windows. Add the bin directory to `PATH` manually only if desired.

Uninstall is also a dry run by default:

```text
node dist/src/cli.js uninstall --dry-run
node dist/src/cli.js uninstall --apply
```

Uninstall reads the generated manifest and removes only allowlisted files whose hashes still match. Modified or unlisted files, all ticket state, and non-empty directories are preserved. A partial refusal keeps the manifest for inspection and retry.

## Privacy and operational limits

Checkpoint validation blocks URLs, fenced source bodies, several high-confidence credential patterns, oversized bodies, malformed metadata, and missing or reordered sections. It cannot reliably recognize every personal name, proprietary phrase, or secret format, so the skills also require paraphrasing and local review of checkpoint content.

Phase 1 fingerprints the outer Git worktree. Repeated content changes to tracked and ordinary untracked files are detected, but changes made concurrently during the narrow snapshot window can still race, and further edits inside an already-dirty nested submodule may not change the outer fingerprint. Non-UTF-8 Git filenames on Unix are not represented losslessly in human summaries. Branch comparisons use local refs only; no remote refresh is attempted.

Installation and replacement must be run from a built source checkout; the installed runtime is not a self-updater. Its launcher can operate checkpoints and perform manifest-based uninstall, but it does not retain a second copy of the skill sources for reinstalling itself.

The installer is intentionally not run by the test suite against the real home directory. Tests use isolated temporary targets, and normal development never stages, commits, or publishes project changes.
