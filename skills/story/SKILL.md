---
name: story
description: Orchestrate a supplied software story through repository discovery, planning, plan review, authorized implementation, independent review, final validation, and local completion using JStack's specialized skills. Use for the end-to-end story lifecycle or any requested prefix of it.
---

# Story

Coordinate one supplied story across JStack's specialized phases while keeping the continuity bundle authoritative. Own phase ordering, approval gates, and the final completion decision; delegate specialized work by invoking `plan-eng-review`, `implement-story`, and `jstack-review` through the host's normal skill mechanism. Do not reproduce their worker instructions here. When the host cannot invoke another skill from an active skill, checkpoint the phase boundary and return the exact skill name and next action for the user to invoke.

Before acting, resolve the JStack runtime home from the first non-empty value of `JSTACK_HOME`, `JSTACK_HOME`, or `STORY_STACK_HOME`; when none is set, resolve `.jstack` beneath the actual user home directory. Do not pass a literal `~` to filesystem APIs. Resolve the CLI as `bin/jstack.js` beneath that home and invoke it with Node using separate executable and path arguments; do not depend on `PATH` or concatenate a shell command. In this source project only, fall back to `../../dist/src/cli.js` relative to this file when the installed launcher is absent. References below to `jstack` mean that resolved command. Read `policies/checkpoint-protocol.md` beneath the resolved runtime home. In this source project, the policy fallback is `../../policies/checkpoint-protocol.md` relative to this file. Stop if neither policy copy is available. The protocol's permanent local and remote boundary applies in every phase.

## Establish the story

Work from story text supplied by the user. Do not retrieve or enrich it from a ticket system unless the user separately requests read-only retrieval and the active environment permits it.

1. Resolve the canonical local repository root and explicit workspace/story identity.
2. If identity was omitted, use `jstack state list --repo <absolute-repository-path> --json` and continue only when one bundle matches.
3. For an existing story, run `state show` and `state validate --json` with `--workspace <workspace-id> --story <story-id> --repo <absolute-repository-path>` before broad discovery or dispatching a worker.
4. For a genuinely new story, run `jstack state init` with those identity and repository arguments, a verified local base branch, and a short paraphrased objective. Initialization must preserve an existing bundle.
5. Resolve repository, branch, schema, integrity, blocker, and approval discrepancies under the shared protocol before continuing from saved claims.

`--project` and `--ticket` remain compatibility aliases for `--workspace` and `--story`; do not mix the vocabularies in one command.

## Discover and draft the plan

Start with validated saved state so completed discovery is not repeated. Inspect only enough local material to close meaningful gaps: repository guidance and relevant build or test configuration; the nearest comparable implementation and tests; likely callers, state ownership, integration boundaries, and errors; and current local Git state without changing it.

Explain the requested outcome in plain language. Keep facts supported by supplied or local evidence distinct from assumptions and questions. Extract testable acceptance criteria without inventing them, establish explicit non-goals, and surface missing information that could materially change behavior or acceptance.

Recommend the smallest complete implementation consistent with repository patterns. Include intended boundaries, likely affected files and reasons, ordered steps, important edge and failure cases, focused and final validation, and blocking questions. Save a complete concise checkpoint through `state update`; keep `Approved plan` awaiting approval and do not edit application code during discovery or draft planning.

## Orchestrate the specialized phases

Run only the phases authorized by the user's request, preserving a validated checkpoint between them:

1. **Engineering plan review:** invoke `plan-eng-review` with the draft, story context, identity, repository, and current bundle. In the orchestrated lifecycle it owns challenging and finalizing the plan and recording explicit approval. Do not advance while a material question remains.
2. **Implementation:** after the plan is approved, separately confirm that the user's request authorizes local source and test edits; readiness alone is not edit authority. Invoke `implement-story` with the story, acceptance criteria, approved plan, repository findings, decisions, constraints, and validated checkpoint. It owns re-inspection, local edits, focused tests, incremental progress, and the handoff to `in-review`.
3. **Independent review:** invoke `jstack-review` against the complete local change set and approved story. The reviewer reports findings and does not fix them. The coordinating agent persists review state only when checkpoint writes are authorized.
4. **Corrections:** do not automatically implement optional findings. For an authorized blocker or should-fix correction that stays within the approved intent, invoke `implement-story` for a bounded fix pass, then repeat independent review where the changed behavior warrants it. For a material scope, contract, acceptance, or architecture problem, first checkpoint the story as `blocked`, then return it to `plan-eng-review` for renewed approval; reapproval is not valid directly from `in-progress` or `in-review`.
5. **Final validation and completion:** proceed only after every blocker and should-fix finding is resolved and every optional finding is explicitly dispositioned so no pending review feedback remains. Reconcile that review result into the checkpoint, then run the broader acceptance-driven checks required for completion through the host. Capture the current fingerprint immediately before the checks and record only directly observed success with `state record-validation`. Use `state complete` only when acceptance criteria are satisfied, validation is current, status is `in-review`, and blockers, pending feedback, and approval gates are all clear.

At every phase boundary, have only the coordinating agent update canonical state through the CLI with a complete temporary body, remove the temporary file after success or failure, and validate the result. Keep implementation-time checks distinct from final completion validation. Never edit bundle files directly, infer approval, stage or commit without an explicit request for that exact Git action, or perform a remote mutation.

## Save and report

Save after a material discovery, decision, completed implementation unit, check, review result, blocker, or changed next action. Replace stale alternatives rather than appending chronology. Keep the bundle concise and preserve the objective, criteria, non-goals, approved plan, progress, recovery-relevant files, decisions, assumptions, actual validation, feedback, blockers, approvals, and one exact next action.

If work stops at a phase boundary, return the current outcome, bundle path and status, approvals or blockers, and exact specialized skill or action that resumes the workflow. On local completion, report the implemented acceptance criteria, files changed, independent review outcome, final checks actually run, remaining limitations, and resolved bundle path. Never claim full story completion from planning, code written, focused checks, or a no-findings review alone.
