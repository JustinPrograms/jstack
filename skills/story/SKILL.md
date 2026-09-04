---
name: story
description: Plan a supplied software story against a local repository and maintain its story-stack checkpoint. Use for /story or requests to understand and plan ticket-shaped work; never use it to implement application changes.
---

# Story

Turn a supplied story into the smallest evidence-based implementation plan that another session can resume safely. This skill is planning-only: inspect local files and update local story-stack state, but do not edit application source, generated application artifacts, tests, or repository configuration.

Before acting, read the shared checkpoint protocol. In an installation it is at `~/.story-stack/policies/checkpoint-protocol.md`; in this source project it is at `../../policies/checkpoint-protocol.md` relative to this file. If neither copy is available, stop rather than improvising the state or privacy rules. Resolve the CLI invocation as that policy describes; bare command examples do not imply a global installation.

## Establish the ticket

Work from the story text the user supplied. Do not retrieve or enrich it from a remote ticket system.

1. Resolve the local repository root and obtain an explicit project slug and ticket key. If identity was omitted, use `story-stack state list --repo <absolute-repository-path> --json` only as allowed by the shared protocol.
2. Run `story-stack doctor` when runtime health is unknown or a CLI operation fails.
3. For an existing ticket, read `story-stack state show` and run `story-stack state validate --json` before repeating repository discovery.
4. For a new, unambiguous ticket, run `story-stack state init --project <project-slug> --ticket <ticket-key> --repo <absolute-repository-path> --base-branch <local-base-branch> --objective <short-paraphrase>`. Omit the base branch only when it is genuinely unknown. Initialization must preserve an existing checkpoint.
5. Resolve branch, repository, or schema discrepancies according to the shared protocol before treating checkpoint claims as facts.

Use a short paraphrase for the objective. Never place the full supplied story or other prohibited data in command arguments or the checkpoint.

## Build the plan

Start with the checkpoint so completed discovery is not repeated. Then inspect only enough local material to close important gaps:

- repository guidance and local development instructions;
- package, build, lint, type-check, and test configuration relevant to the story;
- the nearest comparable implementation and its tests;
- likely integration boundaries, callers, and error behavior; and
- current local Git state, without changing it.

Explain the story in plain language. Separate each planning statement into one of these evidence classes:

- **Fact:** directly supported by the supplied story, checkpoint, repository, or current Git state. Name the source briefly.
- **Assumption:** a reasonable working inference that still needs confirmation.
- **Question:** missing information that could change behavior, scope, or validation.

Extract testable acceptance criteria; do not silently invent criteria. Establish explicit non-goals from supplied scope and repository evidence. If a non-goal is merely proposed, label it as an assumption until approved.

Recommend the smallest correct implementation. Identify likely affected files with reasons, but do not promise a file will change until evidence supports it. Include:

- the intended behavior and boundaries;
- a short ordered implementation plan;
- edge and failure cases implied by the story or local patterns;
- the initial test plan, including the narrowest relevant checks; and
- questions that must be answered before coding, clearly separated from questions that can safely wait.

If missing information materially changes the implementation or acceptance behavior, record the blocker and ask the user. Do not bury it beneath a speculative plan.

## Save and report

Create a complete checkpoint body using all headings from the shared protocol. Merge verified existing information with the new plan and remove stale alternatives. In particular:

- keep `Approved plan` empty or explicitly awaiting approval unless the user has approved it;
- keep completed discovery out of `Current work`;
- make `Exact next action` the first unblocked coding-preparation action or the precise question awaiting an answer;
- list inspected and likely affected files without source excerpts;
- put unresolved assumptions and questions in their dedicated sections; and
- preserve every existing approval gate.

Pass the complete body through `story-stack state update --project <project-slug> --ticket <ticket-key> --repo <absolute-repository-path> --body-file <temporary-markdown-file>`, then validate it. Preserve an existing ticket status unless the user explicitly begins a supported re-planning transition. Do not use `--mark-validated` merely because planning finished. Always remove the temporary body after the update attempt, including on failure. Resolve the path reported to the user with `story-stack state path` rather than constructing it.

Return a concise planning report containing the plain-English objective, acceptance criteria, facts, assumptions, non-goals, smallest implementation plan, likely files, test plan, blocking questions, checkpoint path, and exact next action. State explicitly that no application files were changed.

Do not continue into implementation, even if the plan is straightforward. Planning completion is the terminal condition for `/story`.
