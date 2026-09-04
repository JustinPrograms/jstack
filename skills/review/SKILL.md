---
name: review
description: Review a local diff against an active JustinStack story and report actionable findings. Use for story-compliance review; it is report-only unless the user separately authorizes local fixes.
---

# Review

Evaluate the complete local change set against the active story and repository conventions. Produce evidence-backed findings and update JustinStack state, but do not edit application source, tests, generated artifacts, or repository configuration. A review request is not permission to fix, stage, commit, or perform a remote action.

Before acting, read the shared checkpoint and safety protocol. In an installation it is at `~/.justin-stack/policies/checkpoint-protocol.md`; in this source project it is at `../../policies/checkpoint-protocol.md` relative to this file. Stop if neither copy is available.

## Establish review scope

1. Resolve the canonical repository and explicit workspace/story identity.
2. Read the bundle with `justinstack state show`, then run `state validate --json` using `--workspace <workspace-id> --story <story-id> --repo <absolute-repository-path>`.
3. Stop for an unresolved branch or repository mismatch. Reconcile same-branch drift only from observable evidence; never infer intent from a filename.
4. Use the locally available base branch recorded by canonical state. If it is absent or ambiguous, report missing information and ask rather than selecting a convenient comparison.
5. Inspect the full local change set: committed branch changes relative to the local merge base, staged and unstaged changes, and relevant untracked files. Use read-only Git operations without switching branches or altering the index.

`--project` and `--ticket` are compatibility aliases for the canonical identity flags. Use the objective, criteria, non-goals, and approved plan as constraints only after reconciling them with the current repository. If no plan was approved, say so and do not invent approval.

Inspect current repository guidance and nearby code or tests only where they bear on the diff. Use shared local review lessons when they exist, but do not create or assume them.

## Review lenses

Review every relevant change through all ten lenses:

1. Story compliance
2. Missing requirements
3. Scope creep and non-goal violations
4. Correctness and regressions
5. Error and edge-case handling
6. Repository patterns, interfaces, and naming
7. Tests and validation
8. Debug residue, exposed secrets, and stale comments
9. Unnecessary complexity
10. Whether a smaller diff achieves the same result

Trace behavior through callers and tests far enough to support each claim. Do not present taste as a defect without repository evidence or concrete risk. Never reveal a suspected secret value; report only its safe location and category.

## Findings contract

Each finding must contain exactly:

- **Severity:** `blocker`, `should-fix`, or `optional`
- **File and location:** the narrowest reliable path, line, symbol, or hunk
- **Concrete evidence:** what the local diff and relevant code demonstrate
- **Why it matters:** the violated criterion or plausible failure
- **Smallest suggested correction:** a bounded correction, not a rewrite

Use blocker for unsafe work or a failed required outcome; should-fix for material correctness, maintenance, validation, or scope problems; optional for improvements that should not block the story. Order by severity and execution risk, and combine duplicate symptoms with one cause.

If there are no findings, say so and name checks not run or evidence unavailable. No findings is not proof of correctness.

## Update state and report

Replace stale review state with a concise current summary. Record unresolved findings as paraphrases in pending feedback and move only demonstrably resolved items to addressed feedback. Update inspected files, validation results, blockers, approvals, and the exact next action when evidence warrants it.

Do not present an old check as current after relevant files or configuration changed. Mark validation current only when appropriate checks succeeded for the current fingerprint.

Have the coordinating agent write through `justinstack state update` with a complete temporary body and explicit identity/repository arguments. Preserve status unless an explicit supported transition applies, preserve approval gates, and remove the temporary file after success or failure. If only Git-derived metadata changed and semantic state remains accurate, use `state snapshot`. Validate after any update.

Do not edit any of the six bundle files directly; the engine refreshes the canonical checkpoint and projections atomically.

Return the findings in the required format, a short compliance and scope summary, validation performed and still needed, the resolved bundle path, and the smallest recommended next action. Do not apply corrections. End after the report unless the user separately authorizes a local fix workflow.
