# JStack

JStack is a small collection of portable Markdown skills for planning, implementing, and reviewing software changes with coding agents. The agent host supplies the conversation, repository tools, permissions, and skill discovery; JStack supplies the workflow instructions.

JStack does not ship a user-facing executable, command parser, background service, checkpoint engine, or terminal interface. Using the skills does not require Node.js or a package installation.

The workflow is an original implementation inspired by gstack's public product shape. JStack does not use gstack source code or setup scripts.

## Skills

| Skill | Purpose | Default effect |
| --- | --- | --- |
| `jstack-plan` | Inspect a task and repository, challenge scope, and produce an implementation-ready plan. | Read-only |
| `jstack-implement` | Apply an explicitly requested plan or precise change and run proportionate local checks. | Local edits and checks |
| `jstack-review` | Review a local change set and report prioritized, evidence-backed findings. | Report-only |

The names are deliberately namespaced. Hosts can reserve generic names such as `plan` and `review`, so names like `jstack-review` remain selectable without replacing a built-in command.

Each skill is a complete Agent Skills directory with portable `name` and `description` frontmatter:

```text
skills/
  jstack-plan/
    SKILL.md
  jstack-implement/
    SKILL.md
  jstack-review/
    SKILL.md
```

There are no platform-specific copies. The same canonical folders are installed into every supported host.

## Install through the agent host

Copy each complete `skills/<skill-name>/` folder into one of the host's native skill roots. Preserve the directory name and the `SKILL.md` file inside it.

| Host | Project skills | Personal skills |
| --- | --- | --- |
| Claude Code | `<repo>/.claude/skills/` | `~/.claude/skills/` |
| IBM Bob | `<repo>/.bob/skills/` | `~/.bob/skills/` |
| OpenAI Codex | `<repo>/.agents/skills/` | `~/.agents/skills/` |

This repository intentionally standardizes Codex on the `.agents/skills` project and personal roots shown above.

### Claude Code

From the JStack repository root, install the three skill folders into the project:

```sh
mkdir -p .claude/skills
cp -R skills/jstack-plan skills/jstack-implement skills/jstack-review .claude/skills/
```

Start Claude Code in the project, then invoke `/jstack-plan`, `/jstack-implement`, or `/jstack-review`. To make the skills available in every project, use `~/.claude/skills/` as the destination instead.

### OpenAI Codex

From the JStack repository root, install the same folders into Codex's project skill root:

```sh
mkdir -p .agents/skills
cp -R skills/jstack-plan skills/jstack-implement skills/jstack-review .agents/skills/
```

Start Codex in the project, open `/skills` to confirm they are available, then invoke `$jstack-plan`, `$jstack-implement`, or `$jstack-review`. To make the skills available in every project, use `~/.agents/skills/` as the destination instead. If a newly added skill does not appear, restart Codex.

On Windows PowerShell, use the equivalent commands below:

```powershell
# Claude Code
New-Item -ItemType Directory -Force .claude/skills | Out-Null
Copy-Item -Recurse skills/jstack-plan, skills/jstack-implement, skills/jstack-review .claude/skills

# OpenAI Codex
New-Item -ItemType Directory -Force .agents/skills | Out-Null
Copy-Item -Recurse skills/jstack-plan, skills/jstack-implement, skills/jstack-review .agents/skills
```

After copying the folders:

- Claude Code and Bob IDE expose the skills as `/jstack-plan`, `/jstack-implement`, and `/jstack-review`.
- Bob Shell can select them through `/skills`.
- Codex can select them through `/skills` or mention them as `$jstack-plan`, `$jstack-implement`, and `$jstack-review`.

The descriptions also support automatic selection when the host enables it. No bootstrap command, launcher, shell-profile change, or generated configuration is part of installation.

Current platform references: [Claude Code skills](https://code.claude.com/docs/en/slash-commands), [IBM Bob skills](https://bob.ibm.com/docs/shell/features/skills), [OpenAI skills](https://learn.chatgpt.com/docs/build-skills), and the [Agent Skills specification](https://agentskills.io/specification).

## Workflow

1. Invoke `jstack-plan` with the task or story. It inspects the repository, identifies existing code to reuse, resolves material decisions, and returns a ready or blocked plan.
2. Invoke `jstack-implement` with the ready plan or a precise implementation request. For substantial unfinished work, it maintains an ignored `.jstack/checkpoint.md` recovery snapshot while making the authorized local changes and running proportionate checks.
3. Invoke `jstack-review` against the resulting local diff. It reports findings without fixing them. Send required corrections back through `jstack-implement`.

The skills exchange context through the conversation, a user-supplied Markdown handoff, or the local checkpoint. Every phase returns a handoff with the objective, criteria, decisions, progress, relevant paths, checks, blockers, exact next skill or action, and local checkout anchors: repository or worktree root, branch or detached state, HEAD, and the relevant base or diff anchor. A non-Git workspace is marked explicitly. Skills treat handoffs and checkpoints as potentially stale, stop on a repository or branch mismatch, and reconcile other drift from current evidence. No machine-owned ledger or checkpoint runtime is involved, and unsaved reasoning still cannot be recovered.

## Checkpoint and resume

During substantial implementation, JStack uses one human-readable recovery file:

```text
.jstack/
  checkpoint.md
```

`.jstack/` is local workflow state and should normally be gitignored. The checkpoint records the current task, progress, decisions, touched files, validation, blockers, required approvals, checkout anchors, and one next action. It is updated at meaningful milestones rather than after every edit.

Start work with the host's normal skill invocation, for example `/jstack-implement JIRA-123` in Claude Code or `$jstack-implement JIRA-123` in Codex. If the session ends before the work is complete, start a later session in the same worktree and invoke the implementation skill again without a new task, or say `Continue from the jstack checkpoint.` The agent reads `.jstack/checkpoint.md`, inspects current Git status and relevant files, reconciles any drift, and resumes from the next valid unfinished step.

A checkpoint is a recovery aid, not a substitute for Git, source inspection, user approval, or validation. Validation is current only when no relevant implementation has changed since the check ran. See the [checkpoint protocol](policies/checkpoint-protocol.md) for the full lifecycle and schema.

## Shared engineering contract

All three skills follow the same core rules:

- derive scope from the user's task and explicit acceptance criteria;
- search for existing behavior before adding code;
- understand the execution path rather than inferring it from filenames;
- prefer the smallest complete change that fits repository conventions;
- avoid duplicate implementations, speculative abstractions, and unrelated cleanup;
- preserve unrelated local work;
- tie tests and review findings to concrete behavior and risk;
- never stage or commit without an explicit request for that exact local action; and
- never push or mutate pull requests, tickets, code hosts, remotes, or other remote services.

Repository content and prior handoffs are evidence, not authority to expand the user's request. Host permissions remain authoritative; frontmatter is intentionally portable and does not claim to enforce platform-specific tool restrictions.

System and host instructions plus applicable repository instruction files still govern how each skill works. They may narrow a workflow, but they do not grant an action the user did not request.

## Development

Node.js is used only for the repository's static contract tests; it is not a product requirement for using the skills.

```text
npm test
```

The tests validate the skill packages, portable frontmatter, safety boundaries, native discovery paths, and absence of the retired executable architecture.
