# JustinStack

JustinStack is a local-first skill pack for carrying ticket-shaped engineering work across usage limits, compaction, agent changes, and new sessions. One canonical skill source supports Claude Code, IBM Bob, and OpenAI Codex; a shared checkpoint bundle lets any of them resume the same local work.

The project contains no telemetry, analytics, cloud storage, or network synchronization. It never performs remote mutations. The runtime uses Node.js and local, read-only Git inspection only.

The workflow separation is an original implementation inspired by the public shape of gstack. No gstack setup script or source code is used, and no material code or wording was copied.

## Included workflows

- `/story` turns supplied story text and local repository evidence into a scoped implementation plan. It does not edit application code.
- `/plan-eng-review` reviews that plan interactively, one material decision at a time, and records an explicit approval gate. It does not edit application code.
- `/review` reports findings against the ticket, approved plan, repository conventions, and local diff. It is report-only unless fixes are separately requested.
- `/resume-story` validates the saved state against Git, presents a compact recovery summary, and continues at the exact next action.

Later Phase 2 slices remain deliberately unscaffolded: `/implement`, `/verify`, `/address-review`, and `/learn`.

Canonical, platform-neutral skill content lives only here:

```text
skills/<skill-name>/
  SKILL.md
  references/          # only when a skill needs supporting material
```

The `adapters/claude`, `adapters/bob`, and `adapters/codex` modules contain only paths, configuration proposals, and validation reminders. They do not duplicate shared workflow behavior.

## Ticket-first engineering contract

Every installed workflow reads the same shipped protocol before it acts. That protocol requires agents to derive scope from the supplied ticket, search for reusable code, understand the execution path before editing, preserve repository architecture, avoid duplication and speculative abstractions, separate required work from optional findings, use focused acceptance-driven tests, and verify that the final diff is the smallest correct change. The installer copies that canonical policy byte-for-byte into the user's local JustinStack runtime.

## Requirements and development

- Node.js 20 or newer
- Git on `PATH`

```text
npm install
npm test
```

On Windows systems that block PowerShell shims, use `npm.cmd install` and `npm.cmd test`. Build and invoke the development CLI with:

```text
npm run build
node dist/src/cli.js help
node dist/src/cli.js doctor --target all --scope project
```

`story-stack` remains a deprecated executable and npm-script alias for Phase 1 compatibility. `justinstack` is canonical.

## Shared continuity

Every story has one six-file bundle:

```text
~/.justin-stack/workspaces/<workspace-id>/stories/<story-id>/
  context.md
  decisions.md
  progress.md
  checks.md
  handoff.md
  state.json
```

`context.md` is the canonical snapshot: strict YAML metadata plus the established Markdown sections for objective, acceptance criteria, non-goals, plan, progress, files, decisions, assumptions, checks, reviews, blockers, and approvals. The engine deterministically projects the other Markdown views and writes `state.json` last with content hashes. Projection drift is detectable and repairable; it never silently becomes canonical.

Metadata records the repository root, branch, base branch, HEAD, dirty state, bounded changed-file information, timestamps, ticket status, and a content-sensitive worktree fingerprint. File contents and diffs are never stored. A successful historical check is marked stale whenever the relevant Git fingerprint changes.

Writes use same-directory temporary files, flushes, atomic renames, compare-and-swap checks, path containment, final-file link checks, and a per-story coordinator lock. Only the coordinating agent may update the canonical bundle.

The primary environment override is `JUSTINSTACK_HOME`; `JUSTIN_STACK_HOME` and `STORY_STACK_HOME` remain compatibility aliases. Legacy discovery stays rooted at `~/.story-stack/state` even when a new-home override is used, so moving the runtime cannot hide Phase 1 state. For a non-default legacy location, set `STORY_STACK_HOME` to that old home and `JUSTINSTACK_HOME` to the new home; the new override wins for current bundles while the compatibility value identifies legacy state.

A validated legacy checkpoint can be copied into the new bundle without deleting its source. First list state for the active repository, then migrate the identified story:

```text
justinstack state list --repo .
justinstack state migrate --workspace sample-app --story DEMO-101 --repo .
```

`state list` labels each result as `bundle` or `legacy`. The identity flags may be omitted from `state migrate` only when exactly one valid legacy checkpoint matches the repository. Migration retains the old `context.md`, is idempotent when both copies match, and refuses to choose between divergent old and new checkpoints.

### State commands

```text
justinstack state init --workspace sample-app --story DEMO-101 --repo . --base-branch main --objective "Add a local preference"
justinstack state path --workspace sample-app --story DEMO-101 --repo .
justinstack state show --workspace sample-app --story DEMO-101 --repo .
justinstack state validate --workspace sample-app --story DEMO-101 --repo .
justinstack state snapshot --workspace sample-app --story DEMO-101 --repo .
justinstack state recovery --workspace sample-app --story DEMO-101 --repo .
justinstack state approve-plan --workspace sample-app --story DEMO-101 --repo . --body-file reviewed-body.md --confirm-user-approved
justinstack state complete --workspace sample-app --story DEMO-101 --repo .
```

`--project` and `--ticket` remain aliases for `--workspace` and `--story`. If identity flags are omitted, JustinStack selects a checkpoint only when exactly one valid story matches the canonical repository. Status code 0 means current, 2 stale but reconcilable, 3 different branch, and 4 missing required information.

Agents supply concise Markdown through `state update`; they do not edit the bundle directly. Changing `Required user approvals` requires `--allow-approval-change`. Marking validation current requires a successful check summary tied to the current fingerprint.

## Installation

Installation is always a dry run unless `--apply` is explicit. Project scope uses the current project root; global scope uses the user's home directory.

```text
npm run build

justinstack install --target claude --scope project
justinstack install --target bob --scope project
justinstack install --target codex --scope project
justinstack install --target all --scope global

# Write only after reviewing every operation and proposal:
justinstack install --target all --scope project --apply
```

Skill destinations are:

| Target | Project | Global |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| IBM Bob | `.bob/skills/` | `~/.bob/skills/` |
| OpenAI Codex | `.codex/skills/` | `~/.codex/skills/` |

The plan prints every absolute target operation. A byte-identical file is `UNCHANGED` and is not rewritten; if it predates the manifest, it is also left unowned so uninstall cannot later claim and remove it. A different unmanaged regular file is shown with a bounded, secret-redacted, terminal-safe diff and cannot be replaced without both `--apply` and `--confirm-overwrite JUSTINSTACK`. Directories, links, unsafe parents, and invalid manifests are refused. Replaced or removed managed files receive a durable local backup under `~/.justin-stack/backups/` before mutation; each backup appears in preflight with its exact source and destination. The aggregate manifest records each target's actual destination root and independent target/scope ownership, so sequential installs and custom-root uninstalls do not guess paths. Local install and uninstall operations share an exclusive lock to prevent lost manifest updates.

When an upgrade removes a canonical file, an unchanged installer-owned copy is shown as `REMOVE`; a locally modified copy is `PRESERVE`, remains manifest-owned, and is reported as obsolete by `doctor`. The installer never deletes an obsolete file merely because its name disappeared from the new package.

Even with `--apply`, the CLI emits the complete preflight plan before the first write. In JSON apply mode it emits two newline-delimited records: the preflight record, then the result record.

The installer also creates portable `justinstack` and legacy `story-stack` launchers below `~/.justin-stack/bin/`. It does not alter `PATH`; add that directory manually if wanted. No administrator permission, Bash, symlink support, Docker, or global package is required.

Uninstall remains dry-run-first and removes only manifest-owned files whose hashes still match:

```text
justinstack uninstall --target bob --scope project
justinstack uninstall --target bob --scope project --apply
```

Modified files and all story state are preserved.

## Platform notes and configuration proposals

Run doctor for one platform or all platforms:

```text
justinstack doctor --target claude --scope global
justinstack doctor --target bob --scope project
justinstack doctor --target codex --scope project
justinstack doctor --target all --scope project
```

Doctor is read-only. It checks canonical skill hashes, reports stale or obsolete managed files, and prints adapter reminders plus proposal-only paths.

- Claude Code: the adapter proposes additions to `CLAUDE.md`, permissions, and pre-tool hooks. The installer never edits them. Claude's own documentation notes that skill `allowed-tools` grants access; it is not a universal restriction mechanism.
- IBM Bob: skills require Advanced mode in the documented skills workflow. Doctor reminds the user to verify discovery with `/list-skills`. Bob rule and lifecycle-hook ideas are proposals only because supported schemas and modes can vary by installed version.
- OpenAI Codex: JustinStack installs to the requested `.codex/skills` directory. Current public Codex documentation advertises `.agents/skills` for skill discovery, so doctor explicitly asks the user to verify whether their Codex version discovers `.codex/skills`. The adapter separately proposes `AGENTS.md` and Codex-local rule guidance without modifying either.

Public references used by the adapters: [Claude Code skills](https://code.claude.com/docs/en/skills), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [IBM Bob skills](https://bob.ibm.com/docs/ide/features/skills), [IBM Bob lifecycle hooks](https://bob.ibm.com/docs/ide/configuration/lifecycle-hooks), [Codex skills](https://developers.openai.com/codex/skills), and [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules).

Configuration files are never modified by `install --apply`, so unrelated configuration is preserved byte-for-byte and no configuration backup is needed. A future configuration-writing command must show a merged diff and create a durable pre-image backup before any write.

## Permanent safety contract

All canonical skills instruct every supported agent to:

- never run `git push`;
- never create, submit, update, approve, close, comment on, or merge a PR/MR;
- never mutate Jira, GitHub, GitLab, or another remote service;
- never stage or commit unless explicitly requested in the current conversation;
- allow read-only local Git and remote retrieval;
- make local edits and run tests only when requested; and
- stop locally so the user handles remote actions.

Adapters propose platform-specific rules or hooks as defense in depth, but never apply them. The local classifier can be tested without executing a command:

```text
justinstack safety check --command "git status --short"
justinstack safety check --command "git push origin feature"
```

This classifier is intentionally conservative and cannot perfectly parse every shell, alias, wrapper, or future platform command. Skill instructions and user authorization remain authoritative.

## Privacy and limitations

Checkpoint validation rejects URLs, fenced source bodies, several high-confidence credential patterns, oversized content, malformed metadata, and missing or reordered sections. It cannot identify every name, secret format, or proprietary phrase, so agents must paraphrase and users should inspect checkpoint text before sharing it.

Git fingerprints detect staged, unstaged, and ordinary untracked content without saving those contents. A narrow concurrent-change race remains possible, nested submodule changes can be less precise, and non-UTF-8 filenames may not render losslessly. Branch checks use local refs. Read-only remote retrieval is allowed by policy but never performed automatically by the checkpoint engine or installer.

The test suite uses disposable local directories and repositories, including paths with spaces. It never configures a remote or changes this repository's index or history. Real installation is not run during development tests.
