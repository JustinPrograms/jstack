---
name: resume-story
description: Recover interrupted JustinStack story work from shared local state, validate it against current Git state, and continue from the exact next action. Use after compaction, usage limits, or a new agent session.
---

# Resume Story

Recover the active story without replaying completed discovery. Saved state is a lead, not ground truth: compare it with the current local repository, preserve every unresolved approval gate, and obey the shared execution boundary.

Before acting, read the shared checkpoint and safety protocol. In an installation it is at `~/.justin-stack/policies/checkpoint-protocol.md`; in this source project it is at `../../policies/checkpoint-protocol.md` relative to this file. Stop if neither copy is available.

## Find and validate the story

1. Resolve the canonical local repository root.
2. Prefer explicit `--workspace <workspace-id> --story <story-id>`. If identity is absent, run `justinstack state list --repo <absolute-repository-path> --json` and continue only when exactly one valid bundle matches. If none or several match, show safe candidate identifiers and ask.
3. Read the selected bundle with `justinstack state show` before broad repository exploration.
4. Run `state validate --json` with the same identity and repository arguments.
5. Treat the result as current, stale but reconcilable, different branch, or missing required information under the shared protocol.

`--project` and `--ticket` are compatibility aliases for the canonical identity flags. Never choose a story from branch text alone.

## Reconcile before continuing

- **Current:** trust only claims covered by the validated identity and fingerprint.
- **Stale but reconcilable:** inspect the local diff and changed paths. Update locally verifiable facts, mark affected checks historical, and refresh state. Do not infer product intent or completion from a file change.
- **Different branch:** stop. Display the recorded and current branch and ask which context is authoritative. Do not rewrite the bundle.
- **Missing required information:** stop before the saved next action and ask for the missing identity or context. Do not fabricate it.

Use `justinstack state update` when semantic state changes and `state snapshot` when only Git-derived metadata changes. Have only the coordinating agent write, use a complete temporary body, preserve status and approval gates, and remove the temporary file after success or failure. Do not edit `context.md`, projections, or `state.json` directly.

Avoid writing when validation is current and semantic state is accurate. Validate again after any update.

## Display the recovery summary

Derive the summary from the validated six-file bundle and current repository. Include:

- objective and acceptance criteria;
- non-goals and relevant files;
- decisions already made;
- completed work and current work;
- current local diff summary;
- tests and checks run, clearly marking historical results;
- failures and unresolved questions;
- blockers and required approvals; and
- the exact recommended next step.

Keep the summary concise enough to act on immediately. Never paste source bodies, full diffs, ticket prose, internal links, names, or verbatim review comments into state or the report.

## Continue at the exact next action

Continue only when validation and the active workflow make the saved next action safe:

- do not repeat completed discovery merely to rebuild context;
- inspect only the files needed for the next action;
- update state after meaningful progress and before lengthy work when practical;
- preserve scope, non-goals, decisions, review findings, and gates;
- use current Git evidence instead of historical summaries; and
- stop before any action the active skill or user request did not authorize.

A request to resume does not authorize source edits, tests, staging, committing, or a remote action by itself. Never push or mutate a pull request, merge request, ticket system, code host, or other remote service. Read-only Git and remote retrieval remain allowed only within the shared protocol.

If the next action crosses an approval gate or requires a product decision, ask before acting. Otherwise perform exactly that next authorized local action, update the bundle through the CLI, validate it, and report the new next action.
