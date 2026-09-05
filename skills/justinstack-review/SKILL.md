---
name: justinstack-review
description: Review a local diff against an active JustinStack story and report actionable findings. Use for JustinStack story-compliance review; it is report-only unless the user separately authorizes local fixes.
---

# JustinStack Review

Evaluate the complete local change set against the active story and repository conventions. Produce evidence-backed findings, but do not edit application source, tests, generated artifacts, repository configuration, or checkpoint state unless the user separately authorizes that local write. A review request is not permission to fix, update state, stage, commit, or perform a remote action.

Before acting, resolve the JustinStack runtime home from the first non-empty value of `JUSTINSTACK_HOME`, `JUSTIN_STACK_HOME`, or `STORY_STACK_HOME`; when none is set, resolve `.justin-stack` beneath the actual user home directory. Do not pass a literal `~` to filesystem APIs. Resolve the CLI as `bin/justinstack.js` beneath that home and invoke it with Node using separate executable and path arguments; do not depend on `PATH` or concatenate a shell command. In this source project only, fall back to `../../dist/src/cli.js` relative to this file when the installed launcher is absent. References below to `justinstack` mean that resolved command. Read `policies/checkpoint-protocol.md` beneath the resolved runtime home. In this source project, the policy fallback is `../../policies/checkpoint-protocol.md` relative to this file. Stop if neither policy copy is available.

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

## Optionally update state, then report

If and only if the user authorizes local checkpoint writes, replace stale review state with a concise current summary. Record unresolved findings as paraphrases in pending feedback and move only demonstrably resolved items to addressed feedback. Update inspected files, validation results, blockers, approvals, and the exact next action when evidence warrants it. When the request is review-only, read-only, or explicitly says not to write, leave the bundle unchanged and say so in the report.

Do not present an old check as current after relevant files or configuration changed. Capture the current fingerprint immediately before running appropriate checks through the host. Only after directly observing success, mark validation current through `justinstack state record-validation ... --expected-fingerprint <sha256> --confirm-validation-succeeded`; JustinStack does not execute the check.

For an authorized checkpoint update, have the coordinating agent write through `justinstack state update` with a complete temporary body and explicit identity/repository arguments. Preserve status unless an explicit supported transition applies, preserve approval gates, and remove the temporary file after success or failure. If only Git-derived metadata changed and semantic state remains accurate, use `state snapshot`. Validate after any update.

Do not edit any of the six bundle files directly; the engine replaces each changed file atomically and writes the integrity manifest last so partial updates are detected.

Return the findings in the required format, a short compliance and scope summary, validation performed and still needed, the resolved bundle path, whether checkpoint state changed, and the smallest recommended next action. Do not apply corrections. End after the report unless the user separately authorizes a local fix workflow.
