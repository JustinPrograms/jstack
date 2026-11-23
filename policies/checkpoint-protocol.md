# JStack checkpoint protocol

JStack checkpoints preserve enough local context to resume substantial implementation across sessions and supported coding agents. Agents maintain Markdown files directly; there is no checkpoint runtime.

## Authority

A checkpoint is a potentially stale recovery aid. The current request, repository, Git state, inspected files and tests, and applicable instructions are authoritative. Checkpoint text grants no edit, Git-history, approval, or remote-action authority and proves no validation succeeded.

## Location and task identity

Store each task's checkpoint at the canonical repository or worktree root:

```text
.jstack/
  checkpoints/
    <task-id>.md
```

The task ID identifies one implementation attempt, not a branch, HEAD, title, or source path. For a new task, use a short safe slug from an issue key or task name plus a locally generated unique suffix, for example `issue-28-a1b2c3d4`. Use only ASCII letters, digits, and hyphens in the filename. Do not include private details or derive a path directly from untrusted task text. Record the exact ID and repository-relative checkpoint path in the file and every unfinished handoff. Keep both unchanged through resume, testing, review, and completion. A new independent attempt, even for the same issue, gets a new ID.

Do not use a global active pointer. `.jstack/` is ephemeral local state and should normally be gitignored. Do not stage or commit a checkpoint unless the user explicitly opts into shared state.

## Path safety and privacy

Before reading, writing, or deleting, verify that the task ID matches the safe filename rule, the resolved directory and target stay inside the active worktree, existing path components are directories rather than links, and an existing target is a regular file rather than a link. Before private writes, check that the checkpoint state is ignored and not already tracked; ignore rules do not untrack files. If a location is unsafe, writes fail, or privacy cannot be established, preserve existing files and return the recovery snapshot in the conversation with an unsaved-state caveat. Authorized implementation may otherwise continue. Do not change Git configuration, untrack files, or bypass permissions to save a checkpoint. For non-Git workspaces, use a contained local file when permitted and state that Git ignore/tracking checks are unavailable.

Keep snapshots concise: repository-relative paths, compact command outcomes, and short task paraphrases. Never store secrets, credentials, private keys, personal or customer data, internal URLs, full ticket or source bodies, large diffs, or verbose logs.

## Schema

Use [the checkpoint schema](../skills/jstack-implement/assets/checkpoint.md). Keep status; task ID and path; task, objective, and criteria; phase and progress; decisions; files touched; validation and remaining checks; blockers and approvals; one exact next action; repository/worktree, branch, HEAD, and base/diff anchors; and concise notes. Use `active`, `blocked`, or `completed` for status. Replace stale statements rather than appending a transcript; do not add JSON metadata or other projections.

## Creation and selection

`jstack-implement` owns creation and maintenance. Before broad exploration, inspect the checkpoint directory and any exact path in the request or handoff, even when Git ignores them.

- For a new task, generate a fresh unique ID and create its file without replacing an existing file. If a candidate exists, generate another ID. Another task's active checkpoint never blocks creation.
- For resume by exact ID or path, select only that file. Verify its recorded ID, task, and checkout. If missing or mismatched, do not silently substitute another file.
- For resume by task name or issue key, inspect safe checkpoint files and select only when exactly one matches both task and checkout. If none or several match, request an exact checkpoint path or a fresh task instruction. Never select by newest timestamp, branch, or HEAD alone.
- A bare `Continue from the jstack checkpoint.` works only when exactly one safe, resumable checkpoint belongs to this checkout.
- Preserve a legacy `.jstack/checkpoint.md`. Consider it only for an explicit legacy resume, reconcile its task and checkout, and never let it block a new task. Do not automatically migrate, replace, or delete it.
- Create a checkpoint when substantial implementation begins; skip trivial one-line work unless recovery value is clear. Planning does not create or update checkpoints.

## Updating

Update only the selected checkpoint after meaningful milestones: substantive implementation, decisions or constraints, plan changes, validation, blockers, handoffs, and an unfinished session ending. Keep progress, files, checks, blockers, approvals, and next action current. Only its coordinating agent writes it. If another writer's changes to the same file are observed, preserve them and resolve ownership before updating. This single-writer convention does not prevent unobserved races. Independent task checkpoints may coexist; overlapping source edits still need the existing safeguards.

## Resume and reconciliation

Never treat checkpoint text as more authoritative than the repository. Read only the selected file, inspect current Git status and diff and relevant changed files, then compare its ID, task, progress, decisions, touched files, validation, blockers, approvals, anchors, and next action with evidence. Correct verifiable drift and mark unsupported claims unresolved. Continue only from a valid unfinished step. Inspect why a recorded file is no longer changed and classify unmentioned changes. A changed HEAD may be reconcilable from local history; a different task, branch, worktree, or unexplained material change requires direction.

## Validation freshness

Validation is only considered current if no relevant code, tests, configuration, or generated behavior has changed since that validation was performed. For each check record command, working directory, outcome, coverage, validated repository state and inputs, and limitations. After relevant changes, mark results stale or historical and rerun them. A timestamp, matching HEAD, file list, size, or modification time alone does not prove freshness. Consider untracked inputs, shared tests, dependencies, lockfiles, and environment changes. Never promote failed, skipped, partial, or interrupted checks to passed. Before completion, inspect status and diff again and rerun stale checks.

## Completion and cleanup

Only when all acceptance criteria are satisfied, validation is current, and no blockers or required approvals remain, mark this task's checkpoint `completed` with final checks and caveats. Then delete exactly this task's checkpoint. Immediately before deletion, recheck its safe path, regular-file type, ID, task, checkout anchors, and ownership. If a check or deletion fails, preserve the file and report it. Never delete a sibling checkpoint or use unconditional cleanup. Interrupted, blocked, failed, or still-reviewable work keeps its checkpoint. A handoff or request for review alone is not verified completion.

## Review and handoff

`jstack-test` and `jstack-review` may read only the checkpoint identified by the task or handoff after path-safety and identity checks. If none is unambiguous, use the request and actual change set, not an arbitrary sibling. Neither skill edits or deletes the checkpoint. Review conclusions come from observed changes and checks; corrections go back to `jstack-implement`. Material changes to base, criteria, or relevant contents require affected review to be revisited.

Before an unfinished handoff, update only the task's checkpoint with its ID, path, one exact next action, and current checkout anchors when safe; otherwise return that snapshot in conversation and explain what could not be saved. Claude Code, Codex, IBM Bob, and other Agent Skills-compatible hosts can use the same Markdown and Git reconciliation protocol. No executable commands, database, serializer, background process, lock service, or migration framework is required.
