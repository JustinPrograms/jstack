# JStack vNext architecture review

Review date: 2026-09-09. Status: critique reconciled; the accepted [architecture contract](architecture.md) records the user's subsequent instruction to proceed. Findings below preserve the original review baseline.

**Verdict: proceed with changes.** Preserve the portable workflow goal, but replace the proposed infrastructure-first roadmap with small improvements to the existing skills. There is no demonstrated requirement for a runtime, persistent repository index, model router, or multi-task state layout in the first release.

This reviews the supplied *JStack vNext — Architecture and Implementation Plan*, sections 1–51, against local `main` at `dc50343514926df90d2e638a2801cd7fa2bf4ef1`. The review branch is `agent/vnext-architecture-review`, in `.worktree/vnext-architecture-review`. Local `main` was three commits ahead of and one behind its recorded upstream; no fetch or remote comparison was performed. Other worktrees were not reviewed. This document preserves the critique; the accepted contract and shipped policies define the subsequent implementation.

## 1. Blockers

These block the corresponding proposed behavior, not the current release.

### B1. Persistence changes phase boundaries without resolving write authority

Proposal sections 7, 31, and 32 make planning persist state and allow review persistence. Today, [planning](../skills/jstack-plan/SKILL.md#authority-and-safety) writes a plan only on explicit request, [review](../skills/jstack-review/SKILL.md#report) is report-only, and the [checkpoint protocol](../policies/checkpoint-protocol.md#creation) makes implementation the checkpoint writer. This is a product contract change, not a storage refactor.

In a repository without an ignore rule, planning cannot both write private state safely and obey the proposal's metadata-only write boundary: editing `.gitignore` is another repository write. A host that denies filesystem writes presents the same problem. Git ignoring also does not protect a state file already tracked by Git. [Git ignore documentation](https://git-scm.com/docs/gitignore).

**Required resolution:** retain conversational planning and review by default. Allow an explicitly requested plan/report export within existing host permissions. Keep milestone checkpoints for substantial authorized implementation. If automatic planning persistence is later adopted, specify its permission, ignore, already-tracked-file, and write-failure behavior first; a failed metadata write must leave a usable conversational handoff. Do not silently change Git configuration or untrack files.

### B2. Secondary execution has no enforceable privacy or permission contract

Sections 17–23 and 36 describe preferences and fallbacks, but do not define the actual execution boundary. A provider CLI may read repository files, load project instructions, start configured tools, retain sessions, or have permissions different from the parent. Restricting the supplied prompt does not restrict that process's filesystem or network access. An authenticated executable on PATH is not evidence that repository content may be sent through it.

**Required resolution:** make secondary execution optional and conditional on current user/host authorization, an allowed destination, bounded context, and verified execution restrictions. A repository routing preference must not enable a new provider or widen permissions. Do not inherit arbitrary endpoints, executable paths, or shell commands from project state. A timeout or denied permission must not trigger a more privileged fallback. If restrictions cannot be established, provide the primary review and label the missing second review; preserve an explicitly required reviewer as an unmet requirement.

Existing shipped skills permanently forbid remote repository/service mutations. Any later inference adapter needs an explicit contract distinguishing inference from those forbidden actions, without weakening the prohibition. The repository maintainer's separately authorized Git workflow is not the installed product's authority model.

### B3. Multi-task storage does not resolve task identity or concurrent ownership

Sections 24 and 28 overclaim what directories solve. Two sessions on `JIRA-123` can still overwrite one checkpoint. Two different tasks in the same worktree can race on `active`, while also editing the same files. A deleted convenience pointer cannot be reconstructed reliably when several tasks fit the checkout. Branch names and HEAD identify neither the user's intended task nor a unique dirty state.

**Required resolution:** retain one active coordinating workflow per worktree initially. Separate worktrees already provide independent working directories and indexes through Git; use Git to resolve their identity rather than assuming `.git` is a directory. [Git worktree documentation](https://git-scm.com/docs/git-worktree).

If task directories become necessary, define explicit task selection, ambiguous/missing-pointer handling, safe identifiers, same-task collision handling, and interrupted writes before migrating. Use opaque filesystem-safe identifiers with ticket IDs as display metadata, or validate ticket-derived names. Directory separation and atomic replacement each solve only part of concurrency: neither prevents a second coordinator from saving stale state over newer state. Do not claim multi-writer correctness from a one-writer convention.

### B4. Validation and review freshness lack a defined evidence boundary

Section 26's `HEAD` plus a dirty fingerprint is underspecified. At the same HEAD and with the same modified-file list, file contents can change. Tests may also depend on untracked inputs, lockfiles, shared test utilities, environment configuration, generated output, or external services. File size and modification time are useful hints, not proof of identical validated behavior.

The proposal also treats review as a phase without defining when its disposition expires. A clean review of one diff is stale after a material change, just as a test result can be stale. Two reviewers can observe different diffs if edits continue during their passes.

**Required resolution:** define exactly what evidence supports each claim. Record the command, working directory, outcome, coverage, relevant checkout state, and known limitations without recording secrets. Preserve the existing conservative rule: uncertain relevance or unverified prior results require revalidation before completion. A changed acceptance criterion may invalidate a plan or review even with identical source. Defer selective validation reuse until its dependency boundary can be demonstrated. Bind reviews to a named base and actual reviewed file contents; pause relevant edits or verify before/after state and invalidate affected findings when it changes.

### B5. Packaging and security arrive after components already depend on them

Sections 33 and 43 introduce shared internals, but both current [shell setup](../setup) and [PowerShell setup](../setup.ps1) copy only three named skill directories. A reference outside those directories will be absent from a manual install. Copy-over updates also have no removal step for obsolete files, no all-package version consistency check, and no rollback on partial installation. Those limitations become more consequential with executable/shared assets.

**Required resolution:** choose a self-contained installed layout and test it before any shared-asset dependency ships. Keep individual skill directories manually installable. A small release-time copy of one canonical reference into each package is acceptable if equality and reference resolution are checked; it is preferable to a runtime policy loader. Address update conflicts and interrupted installation when packaging changes. Move threat analysis into each affected phase, especially before persistent state or provider execution; a final security pass cannot repair foundational authority choices cheaply.

## 2. Architecture disagreements

The repository is already much closer to the goal than the proposal's component diagram implies. [README](../README.md#workflow) and the [checkpoint protocol](../policies/checkpoint-protocol.md) already describe portable handoffs, implementation recovery, checkout mismatch handling, stale validation, milestone updates, and one coordinator. The three skills already require tracing callers, comparable implementations, and tests. These need evaluation and refinement before replacement.

| Question requested by the plan | Recommendation and reason |
| --- | --- |
| Does JStack need executable internals? | **Not yet.** No measured capability gap is supplied. Permit a future optional helper only for a specific repeatable operation whose host-native baseline fails; do not predeclare six modules. |
| Should `.jstack/` use the proposed layout? | **Defer it.** Keep one checkpoint per worktree. Task history, an active pointer, configuration, summaries, and caches add different lifecycles without demonstrated demand. |
| Is task-based model routing the right abstraction? | **Task purpose is a label, not a router.** Separate required tools, freshness of context, permissions, allowed data destination, and cost bounds. `independent` is not a capability tier comparable with `fast` or `deep`. |
| Should discovery remain deterministic-first? | **Yes, and task-first.** Start with the supplied task and relevant paths, then widen search. A complete inventory before every small task can cost more than it saves. |
| Is a dedicated resume skill useful? | **Potentially for discoverability.** Existing implementation already resumes. Add a thin entry point only if restart evaluations show users cannot find or safely continue the correct workflow. |
| Should plan and review automatically use independent models? | **No universal default.** Use a bounded second pass for substantial uncertainty or explicit demand, where supported and authorized. Evaluate incremental findings and cost. |
| Should plans/checkpoints persist by default? | **Distinguish them.** Keep implementation checkpoints for substantial work; keep planning/review exports explicit. Avoid three overlapping records of criteria, decisions, progress, and next action. |
| Is the phase ordering correct? | **No.** Measure the current workflow first, then ship end-to-end improvements. Security and packaging accompany each change; optional routing does not gate planning improvements. |

### Reuse host facilities without assuming portability of their extensions

The Agent Skills standard already provides on-demand references, assets, and optional scripts; supported script languages depend on the host, and its tool-allowance field is experimental. It does not establish a common model-routing or sandbox API. Use those packaging facilities rather than another discoverable internal command layer. [Agent Skills specification](https://agentskills.io/specification).

| Surface checked | Verified facility | Architectural implication |
| --- | --- | --- |
| Codex | Skills load progressively; native subagents support model configuration and inherit sandbox policy, with live parent overrides affecting children. | Use available host tools; do not assume a role name or a requested child setting guarantees isolation. [Skills](https://learn.chatgpt.com/docs/build-skills), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents). |
| Claude Code | Skills can use a separate subagent context; custom subagents expose tools, models, and permission settings, subject to parent-mode and packaging restrictions. | Keep Claude-specific settings outside the portable skill contract and verify effective restrictions. [Skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents). |
| IBM Bob Shell | Skills and supporting files are documented; activation normally requests approval unless configured otherwise. | A resume-to-skill transition may involve the host's activation flow. Fresh reviewer isolation and model control were not established by this source; mark them unverified, not absent. [Bob skills](https://bob.ibm.com/docs/shell/features/skills). |

This is documentation verification, not a live host compatibility certification. Bob IDE, Bob Shell, Codex clients, and Claude configurations should be separate rows in an eventual tested capability matrix. The session's actual capabilities and policy determine execution; a vendor name does not.

### Independence needs more than a provider label

A fresh same-model reviewer can produce a separately reasoned opinion. A different model that inherits the primary conversation or reads saved findings is anchored. Record context isolation and model/provider diversity separately; do not collapse both into `independent_model`. If provenance is unavailable, say unknown.

An independent reviewer also needs room to challenge the primary's file selection. Give the agreed target and criteria, then allow bounded discovery within authorized scope. Sending only the primary model's selected excerpts can preserve its blind spots. Conversely, allowing unrestricted repository access can expose saved review findings. That tradeoff must be explicit.

Use severity, evidence, and unresolved disagreements in the final report. Calling a finding “Confirmed” because two reviewers repeated it contradicts section 21's evidence rule. Agreement is provenance, not validation.

### Discovery and context selection should be one adaptive workflow

Sections 9–14 assume a one-way pipeline from ranking to context to reasoning. Real investigation often discovers a missing caller after the first read. Keep iterative queries and explicit coverage gaps. A language server may assist with symbols; text matching alone cannot promise accurate call graphs across dynamic imports, reflection, generated code, and every language.

Context limits should bound search output and excerpts, while preserving criteria and relevant instructions. When critical material exceeds the budget, split investigation or report incomplete coverage. Do not silently discard required behavior to satisfy a numeric cap or claim “minimum necessary context” has been proven.

## 3. Things to simplify/remove

- Remove `core/` managers, general routing profiles, provider adapters, global indexes, summaries, and configuration from the first delivery. Keep them as hypotheses with explicit entry criteria.
- Defer the fourth public skill and task-state migration independently. Resume discoverability does not require an index, cache, or model router.
- Keep one canonical checkpoint schema and clearly name its writer. If a separate plan is exported, treat it as intended scope; checkpoint progress is the current implementation snapshot, not a competing plan. Changes to scope require reconciliation with the user request.
- Replace four speculative architecture documents with one accepted decision record initially. Split only when distinct implemented contracts need separate maintenance.
- Do not introduce a TOML parser merely to expose profiles that the host already chooses. Existing repository/host instructions can express a bounded review preference; they cannot grant provider access.
- Reuse the checkpoint's verified paths and symbols as search starting points. Reopen the relevant files on continuation; do not maintain model-generated file summaries by default.

A cheaper discovery sequence is: inspect current task and checkout; read applicable instructions and relevant manifests; search named paths/symbols; return matching paths before excerpts; inspect the implementation and nearest test/comparable path; expand callers and shared dependencies as uncertainty requires. Use `rg --files` for bounded file discovery and `rg`/Git/host search for content as appropriate. Include relevant untracked work when using a tracked-file inventory.

Search exclusions must be defaults, not absolute bans. An authored `build/` directory or a task explicitly changing vendored code remains relevant. Hidden instructions and the ignored checkpoint need deliberate lookup. Ripgrep filters ignored, hidden, binary, and symlinked content by default, so absence from a search is not proof of absence from the workspace. [Ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md).

Measure cost across the whole workflow: discovery, repeated context input, secondary generation, reconciliation, state maintenance, and rework. A cheap ranking call can increase total cost if the primary must reread its inputs or recover a missed file. Repeated summaries can erase necessary details. Fresh cross-provider calls may duplicate substantial context. Section 38's tool/model ordering is a useful starting preference, not an economic law. No token reduction or quality improvement has been measured in this review.

## 4. Missing failure modes

| Failure scenario | Required behavior or design constraint |
| --- | --- |
| `active` is missing, points outside `tasks/`, names a completed task, or conflicts with an explicit request | Treat pointer text as untrusted data. Require a contained valid target; never infer intent from newest modification time. Resolve ambiguity before continuation. |
| Two processes resume the same task; one saves an old snapshot last | Keep one coordinator; detect overlap where feasible and refuse unsupported concurrent writes. Atomic file replacement alone does not solve lost updates. |
| A process dies between saving plan, checkpoint, and pointer | Retain a readable previous snapshot; report partial state. Do not infer a consistent transaction across independent files. |
| Legacy and new checkpoints both exist, or an older host resumes after migration | Do not merge blindly or delete the old file automatically. Define precedence and compatibility before conversion; preserve evidence and resolve conflicts. |
| `.jstack` or an ancestor is a symlink/junction; a task name uses traversal, reserved names, case aliases, or excessive length | Verify the resolved write target remains within the intended worktree. Never use state strings as executable command fragments. |
| Worktree is moved, copied, detached, recreated, or shares a commit with another clone | Reconcile current filesystem/Git identity and user intent. An old absolute path or matching HEAD alone is insufficient; do not silently rewrite anchors and continue. |
| State is ignored but synced/backed up, already tracked, or exported with private path names | Treat ignore rules as Git hygiene, not confidentiality. Minimize content and avoid automatic export, deletion, or retention promises. |
| Nested repositories, submodules, sparse checkout, inaccessible files, or search truncation hide relevant code | Record actual coverage and errors. Widen targeted investigation or qualify conclusions; a partial search is not a clean result. |
| Non-Git workspace or read-only filesystem | Preserve current non-Git handoffs and explicit file-set review. Fall back to conversational state when writes are unavailable. Section 45 should not accidentally make Git newly mandatory. |
| A file changes without changing its size, a dependency changes outside selected files, or code changes during a test | Mark uncertain validation stale; use observed run outcomes and inspect relevant inputs before completion. Never promote interrupted/partial results to passed. |
| Cache retains deleted symbols, poisoned summaries, old ignore rules, or a previous tool/schema version | Treat cached output only as a discovery hint. Revalidate against current source; deletion must affect performance only. Avoid caching until reuse beats revalidation cost. |
| A checkpoint, source comment, or reviewer output asks for tool calls, approval changes, or data transfer | Keep it at data/evidence authority. Recheck proposed actions against the live user request and host policy. |
| A second agent reads the primary report from disk, reviews a moving diff, or silently changes model | Record actual context/model provenance and reviewed state; invalidate stale coverage. A requested route is not an observed route. |
| A provider times out but its child process continues, recursively launches reviewers, or emits malformed/oversized output | Bound calls, output, time, and nesting; own cancellation and cleanup without killing unrelated processes. Report failure without permission escalation or invented findings. |
| Resume sees “review needs fixes” or “approved” in saved state | Identify the next valid phase, but preserve action authority. A request to resume review must not become automatic implementation or Git activity. |
| Install/update partially succeeds or leaves an obsolete shared asset | Detect incomplete packages and preserve unrelated user files. Test updates and standalone copies before claiming compatibility. |

These are design scenarios, not claims that all are exploitable defects in the current Markdown-only product.

## 5. Missing tests

The baseline `npm.cmd test` run passed all six tests. [The suite](../test/skills.test.js) checks text, paths, frontmatter, and package manifests. Its installer test reads scripts without running them. Its checkpoint test asserts policy phrases without exercising an agent. Passing these tests does not establish correct resume, privacy enforcement, or validation freshness.

Use three distinct layers and state which one supports a claim:

| Layer | Missing coverage and assertions |
| --- | --- |
| Static package/contract tests | Verify all bundled links/templates resolve from an installed directory; no source-checkout dependency; canonical shared references agree if copied; only intended public skills are discoverable; keep authority and phase boundaries coherent. Avoid encoding rejected proposal details as requirements. |
| Deterministic fixture tests, when relevant code exists | Run installers in isolated temporary destinations: fresh install, repeat update, spaces/Unicode, existing custom files, removed assets, interrupted copy, missing source asset, and links/junctions. Test any future state helper for invalid IDs, collisions, interrupted writes, legacy/new conflicts, path containment, and unknown formats. |
| Host workflow evaluations | Run documented scenarios against installed skills in each supported client, using synthetic repositories and explicit expected outcomes. Observe tool actions, modified paths, recovered next steps, and unsupported claims. These are behavioral evaluations, not proofs derived from policy wording. |

Priority host scenarios: cold-session resume with missing or stale context; wrong task/branch/worktree; changed HEAD with explainable and unexplained drift; failed/interrupted check; relevant and apparently unrelated changes after a pass; criteria changes without a diff; clean worktree with unfinished requirements; untracked task files; blocked persistence; and malicious saved instructions. Verify planning/review remain within their write boundaries.

For discovery, use seeded tasks in small repositories and monorepos, including misleading filenames, generated boundaries, hidden config, and shared test dependencies. Compare current skills with revised instructions before comparing a helper. Measure relevant-path recall, incorrect conclusions, bytes actually read/returned, tool calls, latency, and total tokens where observable. Reducing reads while missing the defect is failure.

For any later secondary-review experiment, seed known defects and measure unique valid findings, false positives, missed criteria, and reconciliation effort. Test identical review targets, no inherited findings, unavailable capabilities, denied destinations, output injection, malformed output, timeout cancellation, recursion limits, and explicit-reviewer requirements. Mocks should inspect actual subprocess arguments/tool restrictions and payload boundaries, not merely the router's selected label. Real-host smoke evaluations are still needed; normal unit tests must not depend on live model calls.

The existing broad retired-architecture text scan also includes documentation. Keep its protection, but if future historical/architecture prose needs to discuss a forbidden name, distinguish discussion from executable dependency deliberately rather than weakening the guard wholesale.

## 6. Changes to phase ordering

Replace the eleven implementation phases with independently useful slices. Each later slice needs evidence from the preceding work; these are proposed boundaries, not authorization to create PRs.

| Slice | Deliverable and exit condition | Relationship to supplied phases |
| --- | --- | --- |
| A. Reconcile the architecture | Accept or revise the decisions below; document authority, persistence defaults, fallback, and supported evidence. Keep runtime absent. | Narrow Phase 0; bring threat modeling from Phase 10 forward. |
| B. Evaluate and improve current workflows | Establish restart/discovery/review baselines; improve focused search and handoffs in the existing skills. Include static checks and installed-package checks with each change. | Integrate useful parts of Phases 3, 4, 7, and 8 before building components. |
| C. Address demonstrated recovery friction | First refine the current checkpoint protocol. Add a thin resume entry point if discoverability still fails. Add task directories only for a demonstrated multiple-task need, with selection and compatibility tests. | Decouple and condition Phases 1 and 2. |
| D. Evaluate a bounded second review | Use an available authorized host facility, state actual independence, and compare quality/cost against the primary review. No general router required. | Bring a small part of Phases 7 and 9 ahead of Phases 5 and 6. |
| E. Add optional acceleration if justified | A small isolated spike addresses a measured bottleneck; baseline remains functional without it. Require dependency, packaging, privacy, and failure tests before shipping. | Make scanner caching, routing, and provider adapters contingent rather than inevitable. |

Installation instructions, compatibility checks, and security tests belong to every slice that changes behavior. A final adversarial pass remains useful. Dogfooding should begin with the current product in explicitly invoked installed sessions; repository source skills are not maintenance-agent instructions.

## 7. Revised architecture recommendation

The host owns execution, tools, permissions, model configuration, and conversation management. JStack owns workflow instructions, concise evidence requirements, and a portable recovery convention. Git and filesystem inspection establish checkout reality; text/symbol search supplies current repository evidence.

Retain this initial local state:

```text
.jstack/
  checkpoint.md   # substantial implementation; one coordinator per worktree
```

Continue accepting explicitly supplied plan/handoff files without requiring a particular task directory. No default configuration file, active pointer, cache, or separate review artifact is needed. A future task layout is a separate product decision; it should not be introduced just to support a proposed resume button.

Keep `jstack-plan`, `jstack-implement`, and `jstack-review` as the public surface initially. If added, `jstack-resume` should locate permitted local evidence, reconcile the checkout, describe the next phase, and continue only within the current request's authority. It must have a portable textual handoff when the host cannot invoke another skill. It must not duplicate implementation/review logic or make saved phase labels into permissions.

Second review is an optional workflow step. Its minimal contract is the task and acceptance criteria, actual review target, authorized context/tools, whether the context is fresh, known model/provider identity, a bounded effort, and evidence-backed findings or a clear failure. Keep configuration of the execution mechanism with the host where possible. Do not build a central dispatcher until multiple real integrations demonstrate shared logic worth extracting.

A helper earns inclusion only after a spike establishes all of the following: a specific unmet behavior, a measured improvement over native tools, an acceptable supported-runtime/install story, a safe fallback without the helper, and tests for its actual failure boundary. Being deterministic or hidden from the user is not sufficient justification. A source hash helper cannot by itself establish test dependency completeness or trustworthy agent behavior.

The concrete decisions proposed for reconciliation are:

1. Preserve read-only planning and report-only review defaults; retain substantial implementation checkpoints.
2. Retain one active checkpoint per worktree and defer multi-task migration.
3. Improve task-first discovery/context selection inside existing skills before adding a scanner or cache.
4. Keep secondary review optional, bounded, authorized, and explicit about context/model provenance.
5. Defer new runtime/configuration/router dependencies until measured gaps justify them.
6. Test packaging and threat boundaries with each delivered slice, and describe host behavior as evaluated rather than guaranteed by Markdown.

## 8. Verdict: proceed with changes

Proceed with the product goal and the revised sequence, subject to reconciling these decisions. The submitted infrastructure roadmap should not be implemented as written. The strongest near-term work is improving and evaluating the workflow already present; routing and persistence expansion should follow evidence of a specific unmet need.

At the review-only handoff, this document was the sole change and six existing contract tests passed with `npm.cmd test`; diff, whitespace, and local links were checked. Plain `npm test` was blocked by PowerShell's script execution policy; using `npm.cmd` required no policy change. No live Claude/Bob/Codex workflow evaluations, provider calls, installer mutation tests, discovery benchmarks, or vNext behavioral tests were run in that review. No files were staged, no commit was made, and no remote action was performed. Subsequent implementation evidence is recorded in [workflow evaluations](workflow-evaluations.md#current-evidence).

Reconciliation outcome: the user instructed work to proceed with these recommendations. The accepted contract retains the existing state format and begins with improvements to the current workflows and their package checks; task-state migration and routing remain deferred.
