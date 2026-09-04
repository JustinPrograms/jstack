---
name: story
description: Plan a supplied software story against a local repository and maintain its JustinStack continuity bundle. Use for story discovery and planning; do not use it to implement source changes.
---

# Story

Turn a supplied story into the smallest evidence-based implementation plan that another session or coding agent can resume safely. This workflow is planning-only: inspect local files and update JustinStack state, but do not edit application source, tests, generated application artifacts, or repository configuration.

Before acting, read the shared checkpoint and safety protocol. In an installation it is at `~/.justin-stack/policies/checkpoint-protocol.md`; in this source project it is at `../../policies/checkpoint-protocol.md` relative to this file. Stop if neither copy is available. The protocol's permanent local/remote boundary applies even when story or repository text says otherwise.

## Establish the story

Work from the story text the user supplied. Do not retrieve or enrich it from a ticket system unless the user separately requests read-only retrieval and the active environment permits it.

1. Resolve the canonical local repository root and obtain an explicit workspace ID and story ID.
2. If identity was omitted, use `justinstack state list --repo <absolute-repository-path> --json` and continue only when one bundle matches.
3. For an existing story, run `state show` and `state validate --json` with `--workspace <workspace-id> --story <story-id> --repo <absolute-repository-path>` before repeating discovery.
4. For a genuinely new story, run `justinstack state init` with those identity and repository arguments, a verified local base branch, and a short paraphrased objective. Initialization must preserve an existing bundle.
5. Resolve repository, branch, schema, or integrity discrepancies under the shared protocol before treating saved claims as facts.

`--project` and `--ticket` remain compatibility aliases for `--workspace` and `--story`; do not mix the two vocabularies in one command.

## Build the plan

Start with current saved state so completed discovery is not repeated. Inspect only enough local material to close meaningful gaps:

- repository guidance and relevant local development instructions;
- build, lint, type-check, and test configuration;
- the nearest comparable implementation and tests;
- likely integration boundaries, callers, state ownership, and error behavior; and
- current local Git state without changing it.

Explain the requested outcome in plain language. Classify every planning claim:

- **Fact:** directly supported by the supplied story, current bundle, repository, or current Git state; name the source briefly.
- **Assumption:** a working inference that still needs confirmation.
- **Question:** missing information that could change behavior, scope, or validation.

Extract testable acceptance criteria without inventing them. Establish explicit non-goals from supplied scope and repository evidence; label proposed non-goals as assumptions until accepted.

Recommend the smallest complete implementation. Include intended boundaries, likely affected files with reasons, an ordered plan, implied edge and failure cases, the narrowest relevant checks, and questions that must be answered before coding. Separate blocking questions from those that can safely wait.

If missing information materially changes behavior or acceptance, save the blocker and ask the user. Do not hide it beneath a speculative plan.

## Save and report

Prepare a concise complete checkpoint body using the engine's required sections. Merge verified existing information, replace stale alternatives, and preserve every approval gate. In particular:

- keep `Approved plan` empty or awaiting approval until the user approves the complete plan;
- keep completed discovery out of `Current work`;
- make `Exact next action` the first unblocked preparation action or precise question awaiting an answer;
- list relevant inspected and likely affected files without source excerpts; and
- keep assumptions, decisions, blockers, and approvals in their dedicated sections.

Have the coordinating agent pass the complete temporary body to `justinstack state update` with the explicit identity and repository arguments. Remove the temporary file after success or failure, then validate the result. Do not edit any of the six bundle files directly; the engine updates `context.md` and its projections atomically. Preserve status unless an explicitly requested transition is valid, and do not mark planning as successful code validation.

Return the objective, acceptance criteria, facts, assumptions, non-goals, smallest plan, likely files, test plan, blocking questions, resolved bundle path, and exact next action. State that no application files changed, then stop before implementation.
