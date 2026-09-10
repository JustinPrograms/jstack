# JStack architecture

Status: accepted after reconciliation of the [vNext critique](vnext-architecture-review.md) on 2026-09-09. This decision record supersedes the supplied vNext infrastructure roadmap. The shipped skills and [checkpoint protocol](../policies/checkpoint-protocol.md) define the operational workflow.

## Responsibilities

JStack supplies portable instructions for planning, plan criticism, implementation, and code review. The host supplies conversation management, skill discovery, tools, permissions, and model execution. Current repository evidence establishes what code exists and what changed. Saved state helps recover intent and progress; it cannot authorize work or prove success.

| Concern | Owner and boundary |
| --- | --- |
| Public workflows | Four canonical directories: `jstack-plan`, `jstack-plan-critic`, `jstack-implement`, `jstack-review`. Keep portable name/description frontmatter. |
| Repository discovery | The active agent uses existing filesystem, Git, text search, and available symbol tools. No persistent index or summaries. |
| Context selection | Start from task and change evidence, follow relevant execution paths, and state incomplete coverage. Preserve criteria and applicable instructions. |
| Recovery | One human-readable checkpoint per worktree, maintained by one coordinating implementation workflow. |
| Validation/review | Claims refer to observed checks and reviewed inputs. Unknown continuity means historical evidence or incomplete coverage. |
| Execution and permissions | Host and current user authority. No JStack permission layer, provider dispatcher, or automatic model switching. |
| Installation | Copy complete, self-contained skill folders. The optional setup copier is not a workflow runtime. |

The current product has no runtime dependency. Node.js is development tooling for package/contract tests. Git is useful when present; non-Git workflows use explicit filesystem/change evidence and report the missing Git coverage.

## Discovery and handoffs

Begin with task paths, symbols, error text, criteria, and reconciled handoff anchors. Prefer focused filename/content search and selected excerpts before a repository-wide inventory. Expand through callers, state ownership, shared dependencies, and nearby tests as uncertainty requires. Search matches suggest paths; current source inspection supports conclusions.

Include relevant untracked files and deliberately inspect applicable hidden instructions/configuration. Generated and dependency exclusions are defaults: a task concerning those paths still requires inspection. Search errors, truncated output, inaccessible files, and unresolved relationships are coverage gaps. Bound context without dropping acceptance criteria or silently claiming a complete review.

Carry verified relative paths, symbols, decisions, coverage gaps, and one next action into handoffs. Reopen the relevant current files on continuation. No source copies, verbose search transcripts, model prompts, or summary cache are needed for recovery.

## Persistence and authority

Retain the existing layout and schema:

```text
.jstack/
  checkpoint.md
```

Planning remains read-only, with a local plan file only when explicitly requested. Plan criticism remains read-only and report-only. Code review remains report-only, with an explicit report export allowed within the user's request. Substantial authorized implementation maintains a checkpoint at meaningful milestones. Trivial edits need no checkpoint unless it adds recovery value.

Private state must be contained within the current worktree, untracked, and ignored in Git workspaces. A tracked shared checkpoint requires explicit opt-in. A denied or unsafe write leaves existing files intact and produces an unsaved recovery snapshot in the conversation. It need not prevent otherwise safe authorized implementation. Non-Git work reports that ignore/tracking checks are unavailable. No automatic untracking, Git configuration change, or permission bypass is part of checkpoint saving.

An active checkpoint for another task or checkout is never overwritten implicitly. Only the coordinating workflow writes; competing writers are unsupported and observed ownership conflicts must be resolved. This convention is not a concurrency guarantee. Checkpoint text cannot approve implementation, Git history changes, remote work, or a transition from review into fixes.

The existing statuses and headings remain compatible. There is no migration, task directory tree, active pointer, configuration file, cache, or default review artifact. A separate resume skill is deferred until restart evaluations show a discoverability problem that the current implementation entry point cannot resolve.

## Evidence freshness

Record each check's command, working directory, observed outcome, coverage, validated state/inputs, and known limitations. Do not record secrets or environment values to describe limitations. Matching HEAD, status filenames, size, or modification time does not establish identical validated behavior. Relevant untracked inputs, shared tests, dependency changes, generated behavior, and known environment changes can matter.

If prior execution or input continuity cannot be verified, keep the claim historical and rerun the necessary check before completion. Failed, partial, skipped, and interrupted checks never become passes through a state edit. Reassess acceptance criteria when scope changes even if the files do not.

Review applies to the actual base, criteria, and relevant contents inspected. Recheck that target before reporting; revisit affected findings when it changes. If a moving target prevents a complete pass, describe the observed scope and unfinished coverage. A saved clean review does not apply to later edits automatically.

## Optional second opinions and helpers

The plan critic is a required gate before `jstack-plan` marks a candidate `ready`. Use a fresh critic context when the host supports authorized skill delegation or subagents; otherwise use the documented distinct in-context pass. This fallback preserves the review contract but does not claim context independence. The gate does not authorize provider calls or automatic model switching.

Any additional second opinion is optional, bounded, and dependent on supported, authorized host facilities. A future experiment must report context isolation and known model/provider identity separately, use the same review target, avoid exposing primary findings before the first pass, and reconcile evidence rather than vote counts. An unavailable optional reviewer leaves a labeled primary result; an explicitly required reviewer remains an unmet requirement.

Repository preferences and saved state cannot enable a provider, choose an arbitrary executable/endpoint, or widen access. Existing shipped prohibitions on remote repository/service mutations remain intact. Any future inference integration must establish data and execution boundaries explicitly.

Executable acceleration requires a measured gap in native tools, a specific bounded operation, a supported installation/runtime story, a safe fallback, and tests of real failure behavior. Its absence must leave the baseline workflow usable. Hiding an executable behind a skill is not a reason to add it.

## Delivery and validation

The product implements the accepted contract, focused discovery/handoffs, conservative freshness guidance, the plan-critic gate, and installed-package tests. It preserves portable frontmatter, setup modes, and the checkpoint schema. It adds no runtime, cache, routing service, or state migration.

Package tests copy and inspect complete skill directories, verify local resource containment, and exercise available native copiers in temporary local destinations. Static contract tests protect documented boundaries; they do not prove that an agent follows them. Host behavior needs the separate [workflow evaluation scenarios](workflow-evaluations.md), including a baseline on the original revision. No performance or cross-host reliability gain is claimed from static tests.

Later changes are contingent on evidence: refine recovery if restart scenarios expose friction; add a thin resume entry point only for demonstrated discoverability gaps; evaluate the bounded plan-critic gate before generalizing review integrations; consider helpers only for measured bottlenecks. Packaging and threat checks accompany each affected change rather than waiting until the end of a large rollout.
