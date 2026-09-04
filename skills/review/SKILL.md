---
name: review
description: Review a local diff against an active story-stack ticket and report actionable findings. Use for /review or pre-merge story compliance review; it is report-only unless a separate request explicitly authorizes fixes.
---

# Review

Evaluate the complete local change set against the active ticket and repository conventions. Produce evidence-backed findings and update the checkpoint, but do not edit application source, tests, generated artifacts, or repository configuration. A request to review is not permission to fix.

Before acting, read the shared checkpoint protocol. In an installation it is at `~/.story-stack/policies/checkpoint-protocol.md`; in this source project it is at `../../policies/checkpoint-protocol.md` relative to this file. If neither copy is available, stop rather than improvising the state or privacy rules. Resolve the CLI invocation as that policy describes; bare command examples do not imply a global installation.

## Establish review scope

1. Resolve the repository root, project slug, and ticket key under the shared identity rules.
2. Read the checkpoint with `story-stack state show`, then run `story-stack state validate --json` against the current repository before trusting its plan or validation history.
3. Stop for an unresolved branch or repository mismatch. Reconcile same-branch local drift only from observable evidence and never infer intent from a changed filename.
4. Determine the local base branch from checkpoint metadata. It must already exist locally. If the recorded local base is absent or ambiguous, report missing required information and ask rather than selecting a convenient comparison.
5. Inspect the full local change set: committed branch changes relative to the local merge base, staged and unstaged changes, and relevant untracked files. Use read-only local Git operations. Do not switch branches or alter the index.

Use the checkpoint's objective, acceptance criteria, non-goals, and approved plan as review constraints only after reconciling them with the current repository. If no plan was approved, say so and review against the available objective and criteria without inventing approval.

Inspect current repository guidance and nearby code/tests for conventions that bear on the diff. If a local shared review-lessons file is introduced later, use it when present, but do not create or assume one in Phase 1.

## Review lenses

Review every relevant change through all of these lenses:

1. Story compliance
2. Missing requirements
3. Scope creep and non-goal violations
4. Correctness and likely regressions
5. Error and edge-case handling
6. Repository patterns, interfaces, and naming
7. Tests and validation coverage
8. Debug residue, exposed secrets, and stale comments
9. Unnecessary complexity
10. Whether a smaller diff produces the same result

Trace behavior far enough through callers and tests to support each claim. Do not report a stylistic preference as a defect unless repository evidence or a concrete maintenance risk supports it. Do not expose a suspected secret's value; identify only its safe location and category.

## Findings contract

Each finding must have exactly these fields:

- **Severity:** `blocker`, `should-fix`, or `optional`
- **File and location:** a path and the narrowest reliable line, symbol, or hunk
- **Concrete evidence:** what the local diff and relevant code demonstrate
- **Why it matters:** the violated criterion or plausible failure
- **Smallest suggested correction:** a bounded change, not a rewrite

Use `blocker` when the change is unsafe to proceed with or fails a required story outcome. Use `should-fix` for a material correctness, maintainability, validation, or scope issue. Use `optional` for a useful improvement that should not block the story.

Order findings by severity, then by execution risk. Avoid duplicates that share the same cause. If there are no findings, say that explicitly and mention any checks not run or evidence unavailable; absence of findings is not proof of correctness.

## Update state and report

Replace stale review state with a concise current summary. Put new unresolved findings in `Pending review feedback`, using paraphrases rather than verbatim review prose. Move only demonstrably resolved items to `Review feedback addressed`. Update `Files inspected`, `Test and validation results`, blockers, approvals, and `Exact next action` as warranted. Preserve unrelated ticket context and all approval gates.

An observed old test result is historical when relevant files or configuration changed after it. Do not present it as current and do not use `--mark-validated` unless the appropriate checks succeeded for the current fingerprint.

Write through `story-stack state update --project <project-slug> --ticket <ticket-key> --repo <absolute-repository-path> --body-file <temporary-markdown-file>`, preserving the current status unless the user explicitly requests a supported transition. Always remove the temporary body after success or failure, then run `story-stack state validate --json`. If only Git-derived metadata changed and the review body is already accurate, use `story-stack state snapshot` instead of rewriting it. Resolve the path reported to the user with `story-stack state path`.

Return:

- the findings in the required format;
- a short story-compliance and scope summary;
- validation performed and validation still needed;
- the checkpoint path; and
- the smallest recommended next action.

Do not apply corrections. End after the report and checkpoint update unless the user separately authorizes a fix workflow.
