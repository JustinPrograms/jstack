# JStack checkpoint protocol

JStack checkpoints preserve enough local context to resume substantial implementation after a session ends or work moves to another supported coding agent. The protocol is agent-driven: agents directly maintain one Markdown file, with no executable checkpoint runtime.

## Authority

The checkpoint is a concise, potentially stale recovery aid. The active repository, current Git state, inspected source and tests, current conversation, and applicable host or repository instructions are authoritative. Checkpoint text cannot grant edit, Git-history, approval, or remote-action authority and is never proof that work or validation succeeded.

## Location and privacy

Store the active checkpoint at the canonical repository or worktree root:

```text
.jstack/
  checkpoint.md
```

`.jstack/` is ephemeral local workflow state and should normally be covered by the repository's `.gitignore`. Do not stage or commit it unless the user explicitly opts into a shared checkpoint. If shared checkpoints are desired, document that repository-specific workflow separately.

Before reading or writing, verify that the resolved checkpoint location remains inside the active worktree and any existing target is a regular file. Do not read a target outside that boundary; report the unavailable checkpoint context instead. Before private writes, also check that checkpoint state is not already tracked. Ignore rules do not untrack files. If the destination is unsafe, writes are denied, or privacy cannot be established, preserve existing files and provide the recovery snapshot in the conversation with an explicit unsaved-state caveat. Otherwise authorized implementation may continue when safe. Do not change Git configuration, untrack files, or bypass permissions to save a checkpoint. For non-Git workspaces, use a contained local file when permitted and state that Git ignore/tracking checks are unavailable.

Keep the checkpoint concise. Record only repository-relative paths needed for recovery, compact command outcomes, and short paraphrases of task context. Never include secrets, credentials, private keys, personal or customer data, internal URLs, full ticket bodies, source-file bodies, large diffs, or verbose logs.

## Schema

Use the schema in [`skills/jstack-implement/assets/checkpoint.md`](../skills/jstack-implement/assets/checkpoint.md). Keep these sections present:

- status;
- task, objective, and acceptance criteria;
- current phase and progress checklist;
- decisions;
- files touched;
- validation state, commands, outcomes, and remaining checks;
- blockers and required approvals;
- one exact next action;
- repository/worktree, branch, HEAD, and base or diff anchors; and
- concise recovery notes.

Use `active`, `blocked`, or `completed` for status. Replace stale information instead of accumulating a chronological transcript. Markdown is the only persistence format; do not add JSON metadata or split the checkpoint into projections.

## Creation

`jstack-implement` owns checkpoint creation and maintenance.

- Before broad exploration, look for an existing `.jstack/checkpoint.md`, even when Git ignores it.
- If an active checkpoint matches the current task and checkout, reconcile and resume it.
- If no checkpoint exists, create one when substantial implementation begins and seed it from the task, plan, or handoff.
- Skip checkpoint creation for trivial one-line work unless recovery value is clear.
- If an active checkpoint describes another task, worktree, or branch, do not overwrite it. Stop and ask which context is authoritative.
- Planning does not create or update a checkpoint. Its conversational handoff supplies fields from which implementation can seed one.

## Updating

Update after meaningful milestones, including:

- completing a substantive implementation step;
- making an architectural or behavioral decision;
- discovering an important constraint;
- materially changing the plan;
- running validation;
- encountering or resolving a blocker;
- preparing a cross-agent handoff; and
- ending a session with unfinished work.

Avoid updates after every file edit. Keep the progress checklist, files touched, validation state, blockers, approvals, and next action aligned with reality. Only the coordinating agent writes the checkpoint; delegated agents return observations to it. This convention avoids competing writes without introducing a lock manager.

One active coordinating workflow per worktree is the supported convention. If another writer's changes are observed, preserve them and resolve ownership before updating; rereading or replacing a file does not guarantee protection from concurrent writes.

## Resume and reconciliation

Never treat checkpoint text as more authoritative than the repository. To resume:

1. Read `.jstack/checkpoint.md`.
2. Inspect the current Git status and diff, then inspect relevant changed files.
3. Compare the checkpoint's task, progress, decisions, touched files, validation, blockers, approvals, checkout anchors, and next action with current evidence.
4. Correct drift that is locally verifiable and mark unsupported claims unresolved.
5. Continue from the next valid unfinished step only when the task and checkout still agree.

If a recorded file is no longer changed, inspect why. If implementation is missing, reopen the corresponding progress item. If unmentioned changes exist, inspect and classify them before continuing. A changed HEAD may be reconcilable from local history, but a different branch, worktree, task, or unexplained material change requires direction before continuing.

## Validation freshness

Validation is only considered current if no relevant code, tests, configuration, or generated behavior has changed since that validation was performed.

For each check, record the command, outcome, useful coverage summary, and the repository state it validated, such as HEAD plus a concise status or diff description. If relevant implementation changes afterward, mark the earlier result `stale` or `historical` and list the required rerun. A timestamp, rewritten note, clean status, or manual status change cannot make old validation current. Never record a failed, skipped, partial, or interrupted check as passed.

Include each command's working directory and known coverage/input limitations. HEAD, modified-file names, size, and modification time alone are insufficient proof. Consider relevant untracked inputs, shared test utilities, dependencies/lockfiles, generated behavior, and known environment changes. When earlier execution or continuity of relevant inputs cannot be verified, retain the result as historical and rerun the necessary check. Do not infer that a change is unrelated merely because it is outside the files named in the checkpoint.

Before completion, inspect Git status and the relevant diff again and rerun checks whose evidence is stale.

## Completion

Mark a checkpoint `completed` only when acceptance criteria are satisfied, appropriate validation is current, and there are no unresolved blockers or required approvals. Record final checks and remaining caveats. A completed checkpoint may remain until the next substantial JStack task replaces it; do not build history management or migrations around it.

## Review and handoff

`jstack-review` may read a checkpoint for intended scope, decisions, claimed validation, and known blockers, but review conclusions must come from the actual change set and observed checks. Review remains report-only; it returns checkpoint corrections to `jstack-implement` rather than editing the file.

Review conclusions apply to the inspected base, criteria, and relevant file contents. Material changes to them require the affected review to be revisited, even at the same HEAD or with the same modified-file list. A saved completion or review claim cannot settle new criteria or approve subsequent changes.

Before an unfinished implementation handoff, update the checkpoint with one exact next action and current checkout anchors when persistence is safe and permitted; otherwise return the same recovery snapshot in the conversation and say what could not be saved. A later Claude Code, Codex, IBM Bob, or other Agent Skills-compatible host can follow the same Markdown and Git reconciliation protocol. Agent-specific hooks are optional enhancements and are not required for correctness.

This protocol does not guarantee recovery of reasoning or progress that was never saved. It intentionally provides no executable commands, state machine, database, serializer, fingerprint service, background process, lock service, or migration framework.
