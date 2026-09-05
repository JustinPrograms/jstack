# JustinStack

JustinStack is a small collection of portable Markdown skills for planning, implementing, and reviewing software changes with coding agents. The agent host supplies the conversation, repository tools, permissions, and skill discovery; JustinStack supplies the workflow instructions.

JustinStack does not ship a user-facing executable, command parser, background service, checkpoint engine, or terminal interface. Using the skills does not require Node.js or a package installation.

The workflow is an original implementation inspired by gstack's public product shape. JustinStack does not use gstack source code or setup scripts.

## Skills

| Skill | Purpose | Default effect |
| --- | --- | --- |
| `justinstack-plan` | Inspect a task and repository, challenge scope, and produce an implementation-ready plan. | Read-only |
| `justinstack-implement` | Apply an explicitly requested plan or precise change and run proportionate local checks. | Local edits and checks |
| `justinstack-review` | Review a local change set and report prioritized, evidence-backed findings. | Report-only |

The names are deliberately namespaced. Hosts can reserve generic names such as `plan` and `review`, so names like `justinstack-review` remain selectable without replacing a built-in command.

Each skill is a complete Agent Skills directory with portable `name` and `description` frontmatter:

```text
skills/
  justinstack-plan/
    SKILL.md
  justinstack-implement/
    SKILL.md
  justinstack-review/
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

After copying the folders:

- Claude Code and Bob IDE expose the skills as `/justinstack-plan`, `/justinstack-implement`, and `/justinstack-review`.
- Bob Shell can select them through `/skills`.
- Codex can select them through `/skills` or mention them as `$justinstack-plan`, `$justinstack-implement`, and `$justinstack-review`.

The descriptions also support automatic selection when the host enables it. No bootstrap command, launcher, shell-profile change, or generated configuration is part of installation.

Current platform references: [Claude Code skills](https://code.claude.com/docs/en/slash-commands), [IBM Bob skills](https://bob.ibm.com/docs/shell/features/skills), [OpenAI skills](https://learn.chatgpt.com/docs/build-skills), and the [Agent Skills specification](https://agentskills.io/specification).

## Workflow

1. Invoke `justinstack-plan` with the task or story. It inspects the repository, identifies existing code to reuse, resolves material decisions, and returns a ready or blocked plan.
2. Invoke `justinstack-implement` with the ready plan or a precise implementation request. It makes only the authorized local changes and reports the checks it actually ran.
3. Invoke `justinstack-review` against the resulting local diff. It reports findings without fixing them. Send required corrections back through `justinstack-implement`.

The skills exchange context through the conversation or a user-supplied Markdown handoff. Every phase returns a handoff with the objective, criteria, decisions, progress, relevant paths, checks, blockers, exact next skill or action, and local checkout anchors: repository or worktree root, branch or detached state, HEAD, and the relevant base or diff anchor. A non-Git workspace is marked explicitly. Skills treat handoffs as potentially stale, stop on a repository or branch mismatch, and reconcile other drift from current evidence. They do not auto-discover state, write hidden files, maintain a machine-owned ledger, or promise recovery of unsaved reasoning.

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
