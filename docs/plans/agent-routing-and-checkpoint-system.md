<!-- /autoplan restore point: local gstack project state (machine-specific path omitted) -->
# Agent routing and continuity checkpoints

## Objective

Add a provider-neutral *advisory* orchestration policy to JStack that
classifies a unit of work, recommends an appropriate capability and amount of
parallelism, records evidence for escalation, and preserves enough local state
for a later agent to continue without rediscovering the task. It must not claim
to control a host until that host has a tested execution integration.

## Acceptance criteria

- Every declared delegation has a stable task ID, lifecycle state, work class
  (`light`, `medium`, or `heavy`), recommendation, current host/model if
  explicitly supplied, and rationale in an engine-owned routing record. The
  handoff projects only the concise active summary.
- A standard and a low-usage policy define a numeric *declared advisory-slot*
  ceiling,
  require reuse of recorded findings before new exploration, and distinguish a
  recommendation from a host-enforced limit.
- Escalation has explicit, testable triggers and evidence. Crossing a configured
  model or usage-cost boundary requires a user-approved policy, not an agent's
  unsupported confidence claim.
- One coordinator owns checkpoint writes. A resumed agent can identify the
  objective, approved plan, findings, decisions, progress, validation, and
  latest persisted next action without reading prior chat history.
- Checkpoint files do not save source bodies, diffs, secrets, remote data, or
  instructions that can expand the permanent safety boundary.
- The behavior is consistent for Claude, IBM Bob, and Codex installations, and
  validates on Windows without requiring Bash.
- Legacy bundles remain readable as `routing: not recorded`; migration is
  explicit, idempotent, and never erases the existing canonical handoff.

## Non-goals

- Do not promise that every supported agent host can select an arbitrary named
  model at runtime.
- Do not claim v1 can spawn, schedule, cap, or route an agent on a host. The
  current adapters only install skills and emit advisory configuration proposals.
- Do not replace JStack's existing story bundle with several independently
  writable Markdown files.
- Do not infer that a declared slot is a host-observed active agent, or that a
  scope warning proves two external agents are running.
- Do not add telemetry, cloud synchronization, provider credentials, or remote
  mutations.
- Do not implement an autonomous manager that may create unlimited agents.

## Existing leverage and constraints

- `src/checkpoint/store.ts` already serializes a single canonical checkpoint,
  projects recovery views, uses a per-story coordinator lock, and detects drift.
- `policies/checkpoint-protocol.md` already defines privacy, safety, and
  coordinator-only write rules.
- `skills/story`, `skills/plan-eng-review`, `skills/jstack-review`, and
  `skills/resume-story` define the planning and recovery lifecycle.
- `adapters/` keeps platform-specific material declarative; canonical workflow
  content must not be duplicated per agent platform.
- The current environment exposes GPT-family models, while other installations
  may expose Claude models. Policy must therefore target capabilities, then map
  them to host-supported model names at the adapter boundary.

## Proposed design

### 1. A complexity policy, not literal global model names

Define stable work classes:

| Class | Typical work | Default capability | Escalate when |
| --- | --- | --- | --- |
| `light` | search, locate, formatting, simple mechanical edits, checks | low-cost capability recommendation | task crosses an interface boundary or evidence contradicts the request |
| `medium` | implementation, ordinary debugging/review, unfamiliar code | standard capability recommendation | two materially different bounded attempts fail, a material architecture/security/concurrency concern appears, or the task fan-out grows beyond its initial boundary |
| `heavy` | architecture, security, concurrency/state, specification conflicts, failed medium attempts | high-reasoning capability recommendation | never automatically beyond the configured ceiling; report that the host cannot satisfy the recommendation |

Provider mappings are optional user configuration, for example `standard ->
Sonnet` and `high_reasoning -> Opus` on a Claude host, or a corresponding GPT
tier on Codex. V1 defaults to the caller's current model. An unsupported or
unconfigured mapping produces an explicit `manual choice required` recommendation;
it must not silently choose a different model or claim a named model was used.

### 2. Execution budgets and task admission

Add an execution mode selected by the coordinator:

- `standard`: at most three *declared advisory slots* total, including the coordinator,
  unless a user policy supplies a lower host-specific ceiling. Parallelize only
  independent, non-overlapping investigation or verification work.
- `low-usage`: one coordinator and no delegate by default. Permit one delegate
  only when a coordinator records a concise benefit/cost attestation and it
  has no overlapping declared write scope. Read continuity state before delegation
  and save a checkpoint after each completed logical step.

Task metadata records a stable task ID, lifecycle (`proposed`, `declared`,
`completed`, `abandoned`, or `unknown-after-resume`), normalized repository
relative read/write scopes, work class, recommendation, actual host/model only
when explicitly supplied, rationale, required inputs, expected output, parent
task, advisory-slot claim/release timestamps, and whether it may run in
parallel. Scope overlap means identical paths or an ancestor/descendant path
intersection after repository-relative normalization; globbing and paths
outside the repository are refused. In v1 the coordinator prompts or reports
when this policy is violated; it cannot observe, reject, or terminate a host
action it does not control. An eventual execution host may enforce claims, but
that is a separately approved milestone.

### 3. Explicit escalation and retry contract

For each task, record a bounded evidence object: `attempt_id`, approach
category, outcome, concise safe rationale, and timestamp. Recommend `light ->
medium` after one bounded failure or a named architecture/security/concurrency/
state-integrity/cross-platform trigger. Recommend `medium -> heavy` only after
two materially different bounded failures or the same named severity trigger.
An approach category is a controlled label, not a prompt fingerprint; raw
prompts and source bodies are never stored. Before escalation, the coordinator
writes what was tried, evidence, and what the next tier must decide. The
user-configured ceiling decides whether escalation is automatic, requires a
prompt, or is prohibited; `do-not-delegate` remains a valid outcome.

### 4. Checkpoint projection model

Keep `context.md` as the canonical narrative handoff and add one engine-owned,
versioned `routing.json` record to the existing continuity bundle. This is a
small explicit bundle-schema migration, not a free-form `.jstack/`
directory or a live scheduler graph. `state.json` hashes `routing.json`; the
record is parsed/serialized only by the checkpoint engine and is written before
the state-last commit marker. Legacy bundle schema v1 remains readable with an
empty `routing: not recorded` view, and the migration creates the new record
without rewriting user narrative content. Its mapping is:

| Requested concept | Canonical source / projection |
| --- | --- |
| `session.md` | checkpoint metadata, current work, coordinator, execution mode, and active routing summary |
| `plan.md` | approved plan and latest persisted next action |
| `findings.md` | pending review feedback and blockers/questions |
| `decisions.md` | existing decisions projection, including escalation rationale |
| `progress.md` | existing progress projection, validation, and next action |

The engine must own `routing.json` and projection output. Delegates return
structured observations to the coordinator; they never write checkpoint files
directly. Generic `state update --body-file` preserves the routing record but
cannot create, alter, or delete task data. State is saved after a material
decision, a completed logical unit, a failed or escalated attempt, a completed
validation, and before a long-running operation. Resumption converts any
unreleased declared task to `unknown-after-resume` rather than pretending it is
still active. If a future execution runner needs observed leases or a live task
graph, it gets a separate versioned ledger and host lifecycle integration;
only its active summary is projected into the handoff.

### 5. Safe platform integration

Expose policy first through canonical skill instructions, a local CLI/state
record, and documentation. Store policy in a versioned project-local file with
an explicitly documented optional user-level fallback and project-over-user
precedence. Its host IDs, aliases, ceilings, and escalation boundary are purely
user supplied. `doctor` validates local syntax and explains it cannot verify
provider availability. Adapters may describe host manual settings, but must not
assume Bash, mutate host configuration, or promise enforcement. The CLI returns
machine-readable advisory results (`recommended`, `manual-choice-required`,
`requires-user-approval`, `policy-exception`, or `do-not-delegate`); malformed
input remains a nonzero structured error. `--json` never mixes prose with the
result.

## Architecture

```text
canonical skills / CLI
          |
          v
 task classifier -> advisory recommendation -> coordinator decision record
          |                 |                         |
          |                 v                         v
          |          optional host mapping       delegated worker
          |                                      (returns observations only)
          v                                                  |
  checkpoint coordinator <---- structured finding / result ---+
          |
          +--> context.md (canonical narrative) + routing.json (engine-owned record)
          |                    |                         |
          |                    +--> decisions/progress/checks/handoff views
          +--> state.json hashes every bundle file and is written last

Future, separately approved execution-host milestone:

  host lifecycle API -> admission / lease guard -> versioned task ledger
                                      |
                                      +-> active summary projected into context.md
```

## Ordered implementation plan

1. Define the provider-neutral *advisory* policy schema and resolver contract:
   work classes, modes, declared-slot ceilings, optional capability labels,
   explicit host/model input, retry evidence, escalation thresholds, cost
   boundary, `do-not-delegate`, policy precedence, and result/exit states.
   Keep defaults conservative and explain that the current model remains in use.
2. Define the versioned engine-owned `routing.json` schema: task IDs,
   lifecycle/status transitions, normalized scopes, slot claim/release data,
   evidence, cardinality/history limits, privacy limits, and the concise
   field-to-projection map. Specify schema-v1 legacy read, idempotent upgrade,
   and downgrade behavior before code changes.
3. Migrate the continuity bundle atomically: add `routing.json` to the typed
   file set and state hashes, extend bundle-state validation, publish it before
   `state.json`, and preserve existing context/projections. `state update
   --body-file` must be unable to erase routing data. Extend recovery with an
   explicit routing summary and stale/unknown-after-resume reconciliation.
4. Add coordinator APIs and narrow CLI commands that assess, declare, complete,
   abandon, and inspect a routing record. Accept structured input files for
   task/evidence data; every command verifies canonical identity and current Git
   state before writing. Emit a single machine-readable result for `--json`.
5. Implement advisory validation: report declared-slot excess, normalized-scope
   conflict, missing low-usage attestation, escalation threshold, user-approval
   boundary, and `do-not-delegate`. Do not imply a host action was blocked or a
   model was selected/observed without explicit input.
6. Update canonical workflow skills to classify work before delegation, read
   state before exploration, require structured delegate findings, and
   checkpoint at the named boundaries. Describe standard and low-usage behavior
   without tying the source skill to a provider brand.
7. Update adapters, `doctor`, and installation output with local-only policy
   validation, manual host configuration, advisory limitations, a compatibility
   matrix, and sanitized `doctor --json` support guidance. Keep proposals
   non-mutating.
8. Add a Windows-safe first-run tutorial: initialize, inspect effective policy,
   assess/record from a file, manually delegate, record the result, and recover
   after interruption. Include expected `--json` output and plainly say no host
   is spawned, capped, or model-switched.
9. Dogfood a manual local study across interrupted/resumed stories. Compare
   time-to-correct-next-action, repeated-inspection count, missing-decision
   rate, and unnecessary-escalation rate against a recorded baseline. Advance
   only if predeclared thresholds improve without unsafe persistence.
10. Only after a host exposes a supported lifecycle API and dogfood evidence
    shows the advisory policy helps, write a separate RFC for host enforcement,
    observed leases, and real admission control.

## Failure modes and planned handling

| Failure mode | Detection | Handling | User-visible outcome | Planned test |
| --- | --- | --- | --- | --- |
| Host lacks configured model | local resolver sees unknown/unconfigured mapping | emit manual-choice recommendation; retain current model | named, local limitation | resolver unit test |
| Two agents overwrite context | existing story lock plus declared scope comparison | coordinator remains sole checkpoint writer; report conflict but do not claim execution observation | one coordinator owns state | scope/lock integration test |
| Low-usage run fan-outs | declared-slot and attestation validation | return `policy-exception` or `do-not-delegate`; require a concise rationale | predictable one-delegate exception | policy CLI test |
| Agent repeats failed work | controlled approach-category evidence | require a materially different category before the next counted attempt | escalation or new approach is visible | retry-state test |
| Checkpoint is interrupted | content hashes and state-last write | recovery detects and repairs projections | resumable handoff remains intact | atomic-write recovery test |
| Handoff contains unsafe content | existing privacy/schema validation | reject and request a concise paraphrase | no sensitive material persisted | schema/privacy test |
| Legacy bundle lacks routing record | schema-v1 bundle inspection | return `routing: not recorded`; explicit idempotent migration creates the record | non-destructive upgrade path | migration fixture test |
| Product overreaches into an unenforceable scheduler | host capability contract is absent | retain advisory scope; defer execution integration | honest capability boundary | adapter contract test |

## Validation matrix

| Criterion / branch | Test level | Command |
| --- | --- | --- |
| Policy precedence, defaults, malformed policy, and invalid aliases | unit | `npm test` |
| Capability recommendation, manual-choice, approval, exception, and do-not-delegate result/exit states | unit | `npm test` |
| Declared slot, normalized scope, low-usage attestation, and retry threshold | unit/integration | `npm test` |
| Legacy bundle compatibility, routing-record migration, generic update preservation, locks, CAS, and interrupted repair | integration | `npm test` |
| Windows path/spaces, PowerShell/cmd launchers, and no-Bash behavior | CLI/integration | `npm test` on Windows |
| Adapter proposals remain non-mutating | adapter/CLI | `npm test` |
| Full build/typecheck | build | `npm run build` |

## Decisions to validate during review

1. Keep one engine-owned canonical checkpoint with projections rather than five
   peer-authored Markdown files.
2. Make `light`, `medium`, and `heavy` complexity classes portable; provider
   model names are optional user mappings and v1 retains the current model.
3. Set `standard` to three declared advisory slots total and `low-usage` to one
   coordinator slot by default, allowing one attested delegate as an exception.
4. Require evidence-based escalation, an explicit cost ceiling, and a
   `do-not-delegate` decision before extra agent work.
5. Defer scheduler, automatic routing, and live task-ledger enforcement until
   a host exposes a tested execution lifecycle API.

## First implementation action

Write an RFC-level advisory policy and the versioned `routing.json` record
contract before changing the checkpoint store, adapters, or skill text. Include
the exact state migration, result/exit matrix, and measured success gate that
decides whether an execution-host milestone is worth proposing.

## CEO review: strategy and scope

### System audit

The repository has one committed baseline and a large in-progress working tree
that already introduces a six-file continuity bundle, platform-aware install,
and permanent safety policy. There are no stashed changes or project `TODOS.md`.
The only matched TODO-style text is the test that enforces canonical skill text
does not contain such placeholders. This proposal should build on the current
continuity work, not compete with it.

### Premise challenge

1. The valuable problem is avoiding repeated discovery after the latest
   successful checkpoint, compaction, and agent handoffs. That is directly
   aligned with JStack's stated product, and the current bundle already
   addresses part of it without promising a final save at an abrupt cutoff.
2. The premise that a portable package can choose models or cap concurrency is
   false today. `adapters/types.ts` exposes only skill paths, proposals, and
   doctor reminders; no adapter can discover a model, start a delegate, or
   receive task lifecycle events.
3. The proposed five Markdown files solve a real handoff readability problem,
   but five peer-writable documents would discard the canonical ownership,
   compare-and-swap, and state-last commit marker that the current bundle has.
   A small engine-owned routing record is justified only because task lifecycle
   fields must be parsed, preserved, and recoverable rather than prose.
4. More agents do not automatically reduce usage. They help only when their
   scopes are independent and their output prevents later rediscovery. A
   low-usage default of coordinator plus delegate can spend more than a single
   focused agent.

### What already exists

| Sub-problem | Existing leverage | Decision |
| --- | --- | --- |
| Canonical local handoff | `src/checkpoint/store.ts` and `bundle.ts` | reuse; add only a typed routing record to the bundle |
| Decisions and progress views | generated `decisions.md` and `progress.md` | reuse and enrich bounded sections |
| Recovery | `CheckpointStore.recovery` and `state recovery` | include a typed routing summary and legacy-not-recorded result |
| Coordination | per-story lock plus CAS in `writeWithCompareAndSwap` | retain coordinator-only writer rule |
| Privacy and safety | `schema.ts` and `checkpoint-protocol.md` | apply to routing evidence and handoffs |
| Cross-platform installation | declarative adapters and installer tests | report host limits, do not invent control APIs |

### Dream-state delta

```text
CURRENT                         THIS MILESTONE                    12-MONTH IDEAL
Six-file safe handoff      ->   Evidence-backed advice       ->   Optional host integrations
but no routing record           + low-usage discipline            that can enforce leases,
or delegation outcome.          + resumable decisions.            budgets, and capability policy.
```

### Alternatives considered

| Approach | Effort | Risk | Verdict |
| --- | --- | --- | --- |
| A. Advisory continuity extension | M | Low | Recommended: strengthens the existing wedge and is truthful on every host. |
| B. Build a cross-provider scheduler now | XL | High | Reject for now: no adapter has a lifecycle API, so the package would mostly simulate control. |
| C. Add prose-only guidance to skills | S | Medium | Insufficient alone: it creates no durable evidence or recovery record. |

Approach A is the smallest complete release: it records the decision, outcome,
and escalation evidence while keeping host execution ownership honest. It also
creates the evidence needed to decide whether Approach B is ever worthwhile.

### Mode and temporal interrogation

Use selective expansion. The core policy and existing handoff integration are
in scope; host execution, automatic model switching, a global scheduler,
telemetry, and remote coordination are deferred. In the first implementation
hour the engineer needs the exact advisory schema and field-to-section map;
in the next hours they need migration and privacy boundaries; later work must
prove recovery and Windows behavior before any adapter guidance changes.

### Error and rescue registry

| Codepath | Failure | Handling | User sees | Test |
| --- | --- | --- | --- | --- |
| policy parse | unknown class, invalid ceiling, malformed mapping | reject with field-specific local error | actionable configuration error | unit |
| host capability lookup | no configured mapping or unsupported host | retain current model and emit manual-choice recommendation | honest limitation | unit |
| low-usage delegation | no benefit/cost rationale or scope overlap | record warning; coordinator may choose not to delegate | explicit do-not-delegate result | integration |
| checkpoint update | competing coordinator or changed context | existing CAS/lock rejects update | reload-before-retry error | integration |
| handoff projection | unsafe or oversized finding | existing privacy/schema validation rejects it | concise-paraphrase request | schema |

### Failure modes registry

| Codepath | Failure mode | Rescued? | Test? | User sees? | Logged? |
| --- | --- | --- | --- | --- | --- |
| routing recommendation | label is mistaken for host enforcement | yes, wording and contract limit v1 to advisory | planned | manual choice, not a false success | decision record |
| model escalation | automatic spend crosses the user's budget | yes, policy ceiling controls prompt/prohibit behavior | planned | explicit escalation recommendation | decision record |
| delegate result | verbose source or secret enters state | yes, current privacy gate rejects it | existing + planned | safe rejection | existing validation |
| checkpoint recovery | partial projection exists after interruption | yes, state-last and repair detect it | existing | repairable bundle report | existing health view |

No row has the combination of unrescued, untested, and silent behavior. The
new policy must preserve that property.

### CEO review sections

1. **Architecture.** The advisory path fits the existing direction: canonical
   skills and CLI produce a recommendation, the coordinator records it, and
   the engine projects recovery views. A scheduler would create an unrelated
   control plane beside an application that currently only plans, reviews, and
   resumes work, so it is deferred.
2. **Errors.** Every new user-facing outcome needs named handling above. In
   particular, an unavailable mapping is not a fallback selection and an
   escalation cannot imply cost approval.
3. **Security.** Routing evidence is untrusted local content just like a story
   or checkpoint. It must be concise, bounded, secret-redacted, and unable to
   alter the permanent safety boundary; no host credentials or remote state is
   in scope.
4. **Data and interaction edges.** Valid flows are classify, recommend, record,
   hand off, and resume. Shadow paths are absent mapping, no-delegation decision,
   duplicate attempt, parallel write claim, and interrupted checkpoint update.
5. **Code quality.** `light`, `medium`, and `heavy` should classify work
   complexity, not pretend to standardize providers. A small policy parser plus
   a typed routing-record serializer are clearer than a multi-provider
   abstraction hierarchy.
6. **Tests.** The proposal must test every policy branch, then existing bundle
   repair and recovery paths. It does not need an end-to-end agent-spawn test
   until a real host lifecycle API exists.
7. **Performance.** State remains short text and existing bounded checkpoint
   limits apply. Avoid scanning the full repository merely to classify a task;
   use the current handoff and a declared scope first.
8. **Observability.** No telemetry is allowed. Local decision/evidence records
   and recovery output are sufficient for a user to audit why delegation or
   escalation was recommended.
9. **Deployment.** This is a local CLI/skill release. Preserve dry-run-first
   installer behavior and validate Windows without Bash; ship one explicit,
   idempotent bundle migration before enabling routing writes.
10. **Long-term trajectory.** The durable asset is portable, auditable recovery,
    not stale provider aliases. A future execution integration must earn its
    complexity with a supported host contract and dogfood evidence.

### Independent strategy review

An independent review agreed with the primary analysis that the continuity
problem is the wedge but a cross-provider scheduler is premature. It also
flagged false equivalence among provider model tiers, ambiguous low-usage
accounting, and the need for a schema migration if a future live execution
ledger is introduced. A Codex CLI second opinion was attempted read-only twice, but it
did not produce a final response within the command window; it is recorded as
unavailable rather than treated as consensus.

### CEO consensus

| Dimension | Primary review | Independent review | Consensus |
| --- | --- | --- | --- |
| Premises valid | continuity yes; enforcement no | same | confirmed |
| Right problem | portable handoff is the wedge | same | confirmed |
| Scope calibration | advisory first | same | confirmed |
| Alternatives | defer scheduler | same | confirmed |
| Market risk | provider controls will evolve | same | confirmed |
| 6-month trajectory | own recovery, not a brittle control plane | same | confirmed |

### Not in scope

- Automatic model selection, execution, or provider billing control: no tested
  cross-host lifecycle interface exists.
- A live task graph, leases, or ownership ledger: requires an explicit versioned
  schema migration and an execution host.
- Telemetry or cloud synchronization: violates the local-first safety contract.
- An unlimited normal-mode agent pool: prevents meaningful usage budgeting.

### CEO completion summary

The recommended plan is the advisory continuity extension. It preserves the
existing checkpoint contract, gives the user the model-routing discipline they
want, and avoids claiming a capability that no current adapter owns. One
material product-direction challenge is intentionally held for the final gate:
whether to accept advisory-first scope or insist on an execution host as a new
separate project.
