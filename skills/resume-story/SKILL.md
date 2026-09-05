---
name: resume-story
description: Recover the latest successfully persisted JustinStack story state, validate it against current Git state, and continue from its saved next action. Use after compaction, usage limits, or a new agent session.
---

# Resume Story

Recover the active story from its latest successfully persisted checkpoint without replaying completed discovery. Saved state is a lead, not ground truth: compare it with the current local repository, preserve every unresolved approval gate, and obey the shared execution boundary.

Before acting, resolve the JustinStack runtime home from the first non-empty value of `JUSTINSTACK_HOME`, `JUSTIN_STACK_HOME`, or `STORY_STACK_HOME`; when none is set, resolve `.justin-stack` beneath the actual user home directory. Do not pass a literal `~` to filesystem APIs. Resolve the CLI as `bin/justinstack.js` beneath that home and invoke it with Node using separate executable and path arguments; do not depend on `PATH` or concatenate a shell command. In this source project only, fall back to `../../dist/src/cli.js` relative to this file when the installed launcher is absent. References below to `justinstack` mean that resolved command. Read `policies/checkpoint-protocol.md` beneath the resolved runtime home. In this source project, the policy fallback is `../../policies/checkpoint-protocol.md` relative to this file. Stop if neither policy copy is available.

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

Avoid writing when validation is current and semantic state is accurate. Validate again after any update. Capture the current fingerprint before running a check through the host, then use `state record-validation --expected-fingerprint <sha256> --confirm-validation-succeeded` to bind the coordinator's observed-success attestation. JustinStack does not execute the check; do not infer freshness from user-authored PASS text.

An abrupt usage-limit cutoff cannot run a final save hook reliably. Only a bundle whose last-written integrity manifest validates is guaranteed to survive; reasoning or progress since that write may be absent. Treat recovery after such a cutoff as best effort, show the checkpoint timestamp and Git drift, and never claim that unsaved work was captured.

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

## Continue from the persisted next action

Continue only when validation and the active workflow make the saved next action safe. It is exact as of the checkpoint timestamp, not necessarily the moment the prior session ended:

- do not repeat completed discovery merely to rebuild context;
- inspect only the files needed for the next action;
- update state after meaningful progress and before lengthy work when practical;
- preserve scope, non-goals, decisions, review findings, and gates;
- use current Git evidence instead of historical summaries; and
- stop before any action the active skill or user request did not authorize.

A request to resume does not authorize source edits, tests, staging, committing, or a remote action by itself. Never push or mutate a pull request, merge request, ticket system, code host, or other remote service. Read-only Git and remote retrieval remain allowed only within the shared protocol.

If the next action crosses an approval gate or requires a product decision, ask before acting. Otherwise perform exactly that next authorized local action, update the bundle through the CLI, validate it, and report the new next action.
