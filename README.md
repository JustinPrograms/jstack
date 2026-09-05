# JustinStack

JustinStack is a local-first skill pack for carrying ticket-shaped engineering work across compaction, agent changes, and new sessions. Its shared bundle lets Claude Code, IBM Bob, and OpenAI Codex resume the latest successfully persisted local checkpoint. It improves recovery around usage limits, but an abrupt cutoff can happen before a final save, so unsaved reasoning or progress is never promised.

The project contains no telemetry, analytics, cloud storage, or network synchronization. It never intentionally performs remote mutations. Its own Git calls are local and read-only, and its state commands never launch user-supplied programs. Validation commands run through the host agent or terminal; JustinStack records only an explicit, fingerprint-bound success attestation.

The workflow separation is an original implementation inspired by the public shape of gstack. No gstack setup script or source code is used, and no material code or wording was copied.

## Included workflows

- `story` turns supplied story text and local repository evidence into a scoped implementation plan. It does not edit application code.
- `plan-eng-review` reviews that plan interactively, one material decision at a time, and records an explicit approval gate. It does not edit application code.
- `justinstack-review` reports findings against the ticket, approved plan, repository conventions, and local diff. It is report-only; checkpoint writes and fixes each require separate authorization.
- `resume-story` validates the latest successfully persisted state against Git, presents a compact recovery summary, and continues from the saved next action when still safe.

Invocation is platform-specific; the slash spelling is not portable:

| Skill | Claude Code | Bob IDE | Bob Shell | OpenAI Codex |
| --- | --- | --- | --- | --- |
| `story` | `/story` | `/story` | type `$`, select `story`, or use `/skills` | `$story` or `/skills` |
| `plan-eng-review` | `/plan-eng-review` | `/plan-eng-review` | type `$`, select `plan-eng-review`, or use `/skills` | `$plan-eng-review` or `/skills` |
| `justinstack-review` | `/justinstack-review` | `/justinstack-review` | type `$`, select `justinstack-review`, or use `/skills` | `$justinstack-review` or `/skills` |
| `resume-story` | `/resume-story` | `/resume-story` | type `$`, select `resume-story`, or use `/skills` | `$resume-story` or `/skills` |

Each platform can also select a skill automatically from its description, subject to that product's approval and invocation settings. The deliberately namespaced `justinstack-review` avoids the built-in `/review` commands in Claude Code, Bob, and Codex.

Later Phase 2 slices remain deliberately unscaffolded: `implement`, `verify`, `address-review`, and `learn`.

Canonical, platform-neutral skill content lives only here:

```text
skills/<skill-name>/
  SKILL.md
  references/          # optional documentation
  scripts/             # optional executable helpers
  assets/              # optional templates and resources
```

The canonical skills use the common Agent Skills subset: portable Markdown instructions plus required `name` and `description` frontmatter. The installer accepts the standard optional `license`, `compatibility`, `metadata`, and experimental `allowed-tools` fields, but JustinStack does not rely on optional fields having identical enforcement semantics across products. The `adapters/claude`, `adapters/bob`, and `adapters/codex` modules contain platform paths, configuration proposals, invocation guidance, and validation reminders without duplicating shared workflow behavior.

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

Every story has one six-file bundle beneath the resolved JustinStack runtime home (shown here at its default):

```text
~/.justin-stack/workspaces/<workspace-id>/stories/<story-id>/
  context.md
  decisions.md
  progress.md
  checks.md
  handoff.md
  state.json
```

`context.md` is the canonical snapshot: strict YAML metadata plus the established Markdown sections for objective, acceptance criteria, non-goals, plan, progress, files, decisions, assumptions, checks, reviews, blockers, and approvals. The engine deterministically projects the other Markdown views and writes `state.json` last with content hashes. Projection drift or an interrupted partial bundle update is detectable and never silently becomes canonical.

Metadata records a one-way identifier derived from the canonical repository root, branch, base branch, HEAD, dirty state, bounded changed-file counts, timestamps, ticket status, and a content-sensitive worktree fingerprint. It does not store the absolute repository path, changed filenames, file contents, or diffs. A successful historical check is marked stale whenever the relevant Git fingerprint changes.

Each bundle file is replaced atomically using a same-directory temporary file, flush, and rename. Compare-and-swap checks, path containment, final-file link checks, a per-story coordinator lock, and the last-written manifest make partial or conflicting updates detectable. Only the coordinating agent may update the canonical bundle.

The primary environment override is `JUSTINSTACK_HOME`; `JUSTIN_STACK_HOME` and `STORY_STACK_HOME` remain compatibility aliases. Installed skills resolve the same environment chain instead of hard-coding `~/.justin-stack`. A checkpoint state root inside the active repository is rejected so local state cannot be committed accidentally. Legacy discovery stays rooted at `~/.story-stack/state` even when a new-home override is used, so moving the runtime cannot hide Phase 1 state. For a non-default legacy location, set `STORY_STACK_HOME` to that old home and `JUSTINSTACK_HOME` to the new home; the new override wins for current bundles while the compatibility value identifies legacy state.

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
# Capture currentSnapshot.worktreeFingerprint from `state validate --json`, then run the check externally.
npm test
justinstack state record-validation --workspace sample-app --story DEMO-101 --repo . --body-file validation-summary.md --expected-fingerprint <pre-check-sha256> --confirm-validation-succeeded
justinstack state recovery --workspace sample-app --story DEMO-101 --repo .
justinstack state approve-plan --workspace sample-app --story DEMO-101 --repo . --body-file reviewed-body.md --confirm-user-approved
justinstack state complete --workspace sample-app --story DEMO-101 --repo .
```

`--project` and `--ticket` remain aliases for `--workspace` and `--story`. If identity flags are omitted, JustinStack selects a checkpoint only when exactly one valid story matches the canonical repository. Status code 0 means current, 2 stale but reconcilable, 3 different branch, and 4 missing required information.

Agents supply concise Markdown through `state update`; they do not edit the bundle directly. Changing `Required user approvals` requires `--allow-approval-change`. Generic updates cannot replace plan fields after approval or mutate completed state. Before an external check, capture `currentSnapshot.worktreeFingerprint` from `state validate --json`. After directly observing success, `state record-validation` requires that fingerprint plus `--confirm-validation-succeeded`, rechecks it under the story lock, and binds the concise attestation to it. JustinStack does not execute the check, and this is an explicit coordinator attestation rather than cryptographic proof. Editing the validation section or reapproving changed plan content clears the binding.

## Installation

Installation is always a dry run unless `--apply` is explicit. In project scope, an omitted `--project-root` resolves the enclosing Git top-level even when the command starts in a nested directory; outside Git it falls back to the current directory. An explicit project root remains authoritative. Global destinations use each platform's documented user-level root rather than assuming every product stores skills with its configuration.

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
| Claude Code | `<repo>/.claude/skills/` | `<CLAUDE_CONFIG_DIR or ~/.claude>/skills/` |
| IBM Bob | `.bob/skills/` | `~/.bob/skills/` |
| OpenAI Codex | `<repo>/.agents/skills/` | `~/.agents/skills/` |

The plan prints every absolute target operation. A byte-identical file is `UNCHANGED` and is not rewritten; if it predates the manifest, it is left unowned so uninstall cannot later claim and remove it. For a different unmanaged file, preflight reports safe metadata and hashes only—never its contents or a diff—and replacement still requires both `--apply` and `--confirm-overwrite JUSTINSTACK`. Directories, links, unsafe parents, and invalid manifests are refused. Replaced or removed managed files receive a durable local backup beneath the resolved JustinStack home before mutation; each backup appears in preflight with its exact source and destination. The aggregate manifest records each target's actual destination root and independent target/scope ownership, so sequential installs and custom-root uninstalls do not guess paths.

Install and uninstall use an exclusive lock with dead-owner recovery plus a durable transaction journal. A retry can finish or reconcile an interrupted transaction without claiming a coincidentally identical user-owned file. If recovery changes the state described by a supplied preflight plan, that apply stops as stale so the user can review a fresh plan before new installation work. Every applied transaction target is reverified immediately before and after manifest commit, and executable modes are established on temporary files before atomic rename. The lock coordinates JustinStack processes; it cannot prevent an unrelated process from racing a final filesystem check, so a detected conflict can require manual recovery rather than being silently accepted as a successful install.

When an upgrade removes a canonical file, an unchanged installer-owned copy is shown as `REMOVE`; a locally modified copy is `PRESERVE`, remains manifest-owned, and is reported as obsolete by `doctor`. The installer never deletes an obsolete file merely because its name disappeared from the new package.

Even with `--apply`, the CLI emits the complete proposed-install preflight before acquiring its lock or starting new installation writes. Recovery of a previously interrupted journal is a separate prerequisite and can deliberately invalidate that plan as described above. In JSON apply mode a normal successful apply emits two newline-delimited records: the preflight record, then the result record.

The installer also creates portable `justinstack` and legacy `story-stack` launchers below `<resolved-JustinStack-home>/bin/`. It does not alter `PATH`; add that directory manually if wanted. Installed skills do not depend on that choice: they resolve the same runtime-home environment chain and invoke `bin/justinstack.js` with Node using a separate path argument, including when the home contains spaces. No administrator permission, Bash, Docker, or global package is required. The supported source package layout recursively includes regular files under `references/`, `scripts/`, and `assets/`; installer-controlled source and destination symlinks are rejected deliberately even where an agent product itself can discover symlinked skill folders.

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

Doctor is read-only. It checks canonical skill and shared-runtime existence, type, hashes, executable modes where applicable, and manifest ownership completeness; it also reports stale or obsolete managed files and prints adapter reminders plus proposal-only paths.

- Claude Code: project skills live under `.claude/skills`; every personal `~/.claude` location moves beneath `CLAUDE_CONFIG_DIR` when that variable is set. The adapter proposes additions to the appropriate `CLAUDE.md`, settings, permission denials, and `PreToolUse` hooks for both Bash and PowerShell. The installer never edits those files. Claude's `allowed-tools` can pre-approve tools while a skill is active; it is not a portable restriction mechanism.
- IBM Bob: project and global skills live under `.bob/skills` and `~/.bob/skills`. Bob IDE documents skill use in Advanced mode and direct `/skill-name` invocation. In Bob Shell, type `$` and select the skill from the picker (which inserts its `$skill-name` reference), or use `/skills`. The adapter labels those interfaces separately and proposes the documented rule and lifecycle-hook shapes without applying them.
- OpenAI Codex: repository and user skills live under `.agents/skills` and `~/.agents/skills`. Project instructions use `AGENTS.md`; global instructions and rules use the active Codex configuration home (`CODEX_HOME`, default `~/.codex`). Codex invokes skills with `$skill-name` or `/skills`, not a portable custom slash command. Proposed `.rules` files govern commands requested outside the sandbox and remain experimental.

Primary references used by the adapters: [Claude Code skills](https://code.claude.com/docs/en/skills), [Claude Code directory and `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/claude-directory), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [IBM Bob IDE skills](https://bob.ibm.com/docs/ide/features/skills), [IBM Bob Shell skills](https://bob.ibm.com/docs/shell/features/skills), [IBM Bob Shell interaction and `$` picker](https://bob.ibm.com/docs/shell/getting-started/start-bobshell-interactive), [IBM Bob lifecycle hooks](https://bob.ibm.com/docs/ide/configuration/lifecycle-hooks), [OpenAI Codex skills](https://learn.chatgpt.com/docs/build-skills), [Codex `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules), and the [Agent Skills specification](https://agentskills.io/specification).

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

Adapters propose platform-specific rules or hooks as defense in depth, but never apply them. When a user applies a proposal and the hook process starts and receives its payload before the platform timeout, the JustinStack CLI returns blocking exit code 2 for a matched refusal, malformed payload, oversized input, or internal error. A missing `node` executable, launch failure, platform timeout, disabled hook, non-shell tool, MCP call, or direct API integration occurs outside that guarantee. Codex rules apply to outside-sandbox command approval, not every possible tool or remote integration. The local classifier can be tested without executing a command:

```text
justinstack safety check --command "git status --short"
justinstack safety check --command "git push origin feature"
```

The classifier normalizes common executable suffixes and shell wrappers and detects direct Git, GitHub/GitLab CLI, HTTP-client, Jira, and PowerShell mutation forms. It still cannot interpret arbitrary user-defined aliases or every future tool/API, so shared skill instructions and user authorization remain the primary boundary.

## Privacy and limitations

Checkpoint validation rejects URLs, fenced source bodies, several high-confidence credential patterns, oversized content, malformed metadata, and missing or reordered sections. Automatically captured metadata stores a repository hash and changed-file counts rather than absolute paths or filenames. It still cannot identify every name, secret format, or proprietary phrase in agent-authored prose, so agents must paraphrase and users should inspect checkpoint text before sharing it.

Git fingerprints detect staged, unstaged, and ordinary untracked content without saving those contents or names. A narrow concurrent-change race remains possible, nested submodule changes can be less precise, and non-UTF-8 filenames may not render losslessly. Branch checks use local refs. Read-only remote retrieval is allowed by policy but never performed automatically by the checkpoint engine or installer.

The test suite uses disposable local directories and repositories, including paths with spaces. It never configures a remote or changes this repository's index or history. Real installation is not run during development tests.
