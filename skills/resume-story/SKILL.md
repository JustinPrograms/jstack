---
name: resume-story
description: Recover an interrupted local story-stack ticket from its checkpoint, validate it against current Git state, and continue from the recorded next action. Use for /resume-story after compaction, usage limits, or a new session.
---

# Resume Story

Recover the active ticket without replaying completed discovery. The checkpoint is a lead, not ground truth: compare it with the current local repository before acting and preserve every unresolved approval gate.

Before acting, read the shared checkpoint protocol. In an installation it is at `~/.story-stack/policies/checkpoint-protocol.md`; in this source project it is at `../../policies/checkpoint-protocol.md` relative to this file. If neither copy is available, stop rather than improvising the state or privacy rules. Resolve the CLI invocation as that policy describes; bare command examples do not imply a global installation.

## Find and validate the checkpoint

1. Resolve the canonical repository root.
2. Prefer a supplied project slug and ticket key. Otherwise run `story-stack state list --repo <absolute-repository-path> --json` and continue only if exactly one valid checkpoint matches. If selection is ambiguous, show safe candidate identifiers and ask the user to choose.
3. Read the selected checkpoint with `story-stack state show` before broad repository exploration.
4. Run `story-stack state validate --project <project-slug> --ticket <ticket-key> --repo <absolute-repository-path> --json`.
5. Compare recorded and current repository root, branch, HEAD, dirty state, changed-file summary, untracked summary, and worktree fingerprint. Inspect only the local diffs needed to explain discrepancies.

Do not initialize a missing checkpoint during resume. Report missing required information and ask for the intended ticket or suggest `/story` for a new ticket.

## Reconcile deliberately

Follow the shared categories:

- **Current:** the identity and fingerprint agree. Continue from the recorded next action after verifying that it is still unblocked.
- **Stale but reconcilable:** repository and branch agree and differences are locally observable. Refresh derived facts, correct semantic sections only where evidence supports the correction, and keep uncertain completion or intent as a question.
- **Different branch:** stop. Show the recorded and active branches and why the mismatch is material. Ask which context to use; do not switch branches or overwrite the checkpoint.
- **Missing required information:** stop at the missing field, invalid schema, absent repository, or ambiguous identity. Do not manufacture replacement values.

Safe reconciliation may update HEAD, dirty state, changed-file summaries, inspected or changed file lists, and the description of current work when the local diff makes it unambiguous. It may not invent acceptance criteria, plan approval, product decisions, completion claims, review dispositions, or user authorization.

If relevant files or validation configuration changed after the last successful test, label that result historical and schedule the narrowest appropriate rerun. When relevance cannot be established confidently, treat the validation as stale. Never describe historical validation as current.

Write a meaningful reconciliation through `story-stack state update` with a complete temporary body, preserving the current status unless the resumed workflow explicitly requires a supported transition. Always remove the temporary body after success or failure. Use `story-stack state snapshot` when only derived snapshot metadata changed and no semantic section needs correction. Avoid a write when validation reports current and the body remains accurate. Run `story-stack state validate --json` after any update. Resolve the displayed checkpoint path with `story-stack state path`.

## Recovery summary

Before continuing, display a compact summary with exactly these topics:

- **Objective**
- **Completed work**
- **Current state**
- **Next action**
- **Blockers**
- **Required approval**
- **Last successful validation**

Qualify unknown, stale, or historical information visibly. Do not include prohibited checkpoint content or verbose diffs.

## Continue from the next action

Resume the recorded exact next action without repeating completed repository discovery. Read only the files needed for that action. Honor the active ticket's mode and all current user constraints: for example, a planning or review next action remains non-editing, while implementation requires prior authority in the conversation and any recorded approvals.

Before lengthy work, ensure the checkpoint contains a precise recovery point. After meaningful progress, update it using the shared protocol. If the next action is already complete in the current repository, verify that fact, update the snapshot, and advance to the next genuinely pending action rather than performing it again.

Stop and ask when the next action crosses an approval gate, the user's authority is insufficient for the action, or reconciliation requires a product decision. A request to resume does not authorize remote actions, history changes, or source edits that the active workflow did not already permit.
