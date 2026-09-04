<!-- /autoplan restore point: C:\\Users\\Justin\\.gstack\\projects\\justinstack\\main-autoplan-restore-20260904-163011.md -->
# Agent routing and continuity checkpoints

## Objective

Add a provider-neutral *advisory* orchestration policy to JustinStack that
classifies a unit of work, recommends an appropriate capability and amount of
parallelism, records evidence for escalation, and preserves enough local state
for a later agent to continue without rediscovering the task. It must not claim
to control a host until that host has a tested execution integration.

## Acceptance criteria

- Every declared delegation has a stable task ID, lifecycle state, work class
  (`light`, `medium`, or `heavy`), recommendation, current host/model if
  explicitly supplied, and rationale in an engine-owned routing record. The
  handoff projects only the concise active summary.
- A standard and a low-usage policy define a numeric *per-story declared
  advisory-slot* ceiling,
  require reuse of recorded findings before new exploration, and distinguish a
  recommendation from a host-enforced limit.
- Escalation has explicit, testable triggers and evidence. Crossing a configured
  model or usage-cost boundary requires a user-approved policy, not an agent's
  unsupported confidence claim.
- One coordinator owns checkpoint writes. A resumed agent can identify the
  objective, approved plan, findings, decisions, progress, validation, and
  exact next action without reading prior chat history.
- Checkpoint files do not save source bodies, diffs, secrets, remote data, or
  instructions that can expand the permanent safety boundary.
- The behavior is consistent for Claude, IBM Bob, and Codex installations, and
  validates on Windows without requiring Bash.
- Legacy bundles remain readable as `routing: not recorded`; migration is
  explicit, idempotent, and never erases the existing narrative handoff. A v2
  reader never consumes an unsealed mixed generation.

## Non-goals

- Do not promise that every supported agent host can select an arbitrary named
  model at runtime.
- Do not claim v1 can spawn, schedule, cap, or route an agent on a host. The
  current adapters only install skills and emit advisory configuration proposals.
- Do not replace JustinStack's existing story bundle with several independently
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
- `skills/story`, `skills/plan-eng-review`, `skills/review`, and
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
Each declaration records the effective policy version, source, and digest, so a
later policy edit cannot make a previous routing decision inexplicable.

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
versioned `routing.json` record. Because routing is canonical data rather than
a projection, bundle schema v2 stores all payloads in a sealed generation
directory and makes root `state.json` the atomic pointer to that generation.
The payload file set is the five Markdown files plus `routing.json`; `state.json`
hashes those payloads but never itself. Its generation ID is a digest of the
canonical payload-hash manifest. A reader first parses the state pointer, then
reads only the named generation and verifies every payload hash. It ignores
staging directories and refuses an invalid pointer/generation rather than
consuming mixed, uncommitted files.

Schema-v1 direct-file bundles remain readable as `routing: not recorded`.
The explicit, idempotent `state upgrade-routing` command copies their validated
narrative and projections into the first v2 generation with an empty typed
routing record, verifies it, then atomically publishes the v2 pointer. Old
binaries cannot validate v2; migration never auto-deletes/downgrades routing or
rewrites user narrative. This is not a free-form `.justinstack/` directory or a
live scheduler graph. Its projection mapping is:

| Requested concept | Canonical source / projection |
| --- | --- |
| `session.md` | checkpoint metadata, current work, coordinator, execution mode, and active routing summary |
| `plan.md` | approved plan and exact next action |
| `findings.md` | pending review feedback and blockers/questions |
| `decisions.md` | existing decisions projection, including escalation rationale |
| `progress.md` | existing progress projection, validation, and next action |

The engine must own `routing.json` and projection output. Delegates return
structured observations to the coordinator; they never write checkpoint files
directly. Generic `state update --body-file` preserves the routing record but
cannot create, alter, or delete task data. A failed write before the pointer
commit leaves the prior sealed generation readable; a pointer or payload hash
mismatch is an integrity failure, not a repair that silently recreates routing
data. Only deterministic Markdown projections may be regenerated from a
verified `context.md` plus routing record. State is saved after a material
decision, a completed logical unit, a failed or escalated attempt, a completed
validation, and before a long-running operation. `state routing
reconcile-resume`—not read-only recovery—converts unreleased declarations to
`unknown-after-resume`. If a future execution runner needs observed leases or a
live task graph, it gets a separate versioned ledger and host lifecycle
integration; only its active summary is projected into the handoff.

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
          +--> stage a full payload generation under the story lock
                         |
                         +--> context.md + routing.json + deterministic projections
                                             |
                                             +--> verify payload hash manifest
                                                            |
                                                            +--> atomically publish state.json pointer

  reader: state pointer -> named generation -> verify all payload hashes -> recovery view

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
2. Define the versioned engine-owned `routing.json` schema: task IDs, complete
   lifecycle transition table and idempotency rules, normalized scopes, slot
   claim/release data, effective policy provenance/hash, evidence, cardinality/
   history limits, typed privacy validation, and concise field-to-projection
   map. Refuse raw prompts, URLs, source/diff-like bodies, credentials,
   multiline injection, unbounded strings, and unrecognized enums.
3. Define bundle v2 before implementation: `BundlePayloadFile` is five Markdown
   payloads plus `routing.json` (never self-hashed `state.json`); schema v2
   state is an atomic pointer to one immutable payload generation and its
   manifest digest. Parse both v1 and v2. `state upgrade-routing` performs the
   explicit idempotent v1-to-v2 conversion; it is distinct from existing
   `state migrate`, which moves a legacy-location checkpoint. Specify that old
   binaries report v2 unsupported and no automatic downgrade/deletion occurs.
4. Implement generation transactions under the existing story lock: build and
   fsync a new generation, validate all payload hashes, atomically publish the
   state pointer last, and retain the previous sealed generation until a later
   successful cleanup. Readers load the pointer first and never consume
   top-level/staging/mixed files. Extend fault injection and repair semantics:
   projections may be regenerated only from verified canonical inputs; corrupt
   routing/pointer data is an integrity failure, never an empty replacement.
5. Add a dedicated `state routing` dispatcher with `assess` (pure), `declare`,
   `record-attempt`, `complete`, `abandon`, `inspect`, and
   `reconcile-resume`. Accept structured input files for task/evidence data;
   each mutating command verifies canonical identity and current Git state
   before writing. Read-only recovery reports routing but never mutates it.
   Emit one machine-readable result for `--json`.
6. Implement advisory validation: report per-story declared-slot excess,
   normalized-scope conflict, missing low-usage attestation, escalation
   threshold, user-approval boundary, and `do-not-delegate`. Do not imply a
   host action was blocked or a model was selected/observed without explicit
   input.
7. Update canonical workflow skills to classify work before delegation, read
   state before exploration, require structured delegate findings, and
   checkpoint at the named boundaries. Describe standard and low-usage behavior
   without tying the source skill to a provider brand.
8. Update adapters, `doctor`, and installation output with local-only policy
   validation, manual host configuration, advisory limitations, a compatibility
   matrix, and sanitized `doctor --json` support guidance. Keep proposals
   non-mutating.
9. Add a Windows-safe first-run tutorial: initialize, inspect effective policy,
   assess/record from a file, manually delegate, record the result, and recover
   after interruption. Include expected `--json` output and plainly say no host
   is spawned, capped, or model-switched.
10. Dogfood a manual local study across interrupted/resumed stories. Compare
   time-to-correct-next-action, repeated-inspection count, missing-decision
   rate, and unnecessary-escalation rate against a recorded baseline. Advance
   only if predeclared thresholds improve without unsafe persistence.
11. Only after a host exposes a supported lifecycle API and dogfood evidence
    shows the advisory policy helps, write a separate RFC for host enforcement,
    observed leases, and real admission control.

## Failure modes and planned handling

| Failure mode | Detection | Handling | User-visible outcome | Planned test |
| --- | --- | --- | --- | --- |
| Host lacks configured model | local resolver sees unknown/unconfigured mapping | emit manual-choice recommendation; retain current model | named, local limitation | resolver unit test |
| Two agents overwrite context | existing story lock plus declared scope comparison | coordinator remains sole checkpoint writer; report conflict but do not claim execution observation | one coordinator owns state | scope/lock integration test |
| Low-usage run fan-outs | declared-slot and attestation validation | return `policy-exception` or `do-not-delegate`; require a concise rationale | predictable one-delegate exception | policy CLI test |
| Agent repeats failed work | controlled approach-category evidence | require a materially different category before the next counted attempt | escalation or new approach is visible | retry-state test |
| Checkpoint generation is interrupted | state pointer/hash verification | prior sealed generation remains readable; invalid pointer/payload is refused, not silently repaired | coherent prior handoff or explicit integrity error | stage-by-stage fault test |
| Routing input contains unsafe content | typed routing privacy/schema validation | reject and request a concise safe rationale | no sensitive material persisted | routing-schema/privacy test |
| Legacy bundle lacks routing record | schema-v1 bundle inspection | return `routing: not recorded`; explicit idempotent migration creates the record | non-destructive upgrade path | migration fixture test |
| Product overreaches into an unenforceable scheduler | host capability contract is absent | retain advisory scope; defer execution integration | honest capability boundary | adapter contract test |

## Validation matrix

| Criterion / branch | Test level | Command |
| --- | --- | --- |
| Policy precedence, defaults, malformed policy, and invalid aliases | unit | `npm test` |
| Capability recommendation, manual-choice, approval, exception, and do-not-delegate result/exit states | unit | `npm test` |
| Declared slot, normalized scope, low-usage attestation, and retry threshold | unit/integration | `npm test` |
| V1/v2 compatibility, generation migration, generic update preservation, locks, CAS, and stage-by-stage interrupted publish | integration | `npm test` |
| Windows path/spaces, PowerShell/cmd launchers, and no-Bash behavior | CLI/integration | `npm test` on Windows |
| Adapter proposals remain non-mutating | adapter/CLI | `npm test` |
| Full build/typecheck | build | `npm run build` |

## Decisions to validate during review

1. Keep one engine-owned canonical checkpoint with projections rather than five
   peer-authored Markdown files.
2. Make `light`, `medium`, and `heavy` complexity classes portable; provider
   model names are optional user mappings and v1 retains the current model.
3. Set `standard` to three per-story declared advisory slots total and
   `low-usage` to one coordinator slot by default, allowing one attested
   delegate as an exception.
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

1. The valuable problem is avoiding repeated discovery after usage limits,
   compaction, and agent handoffs. That is directly aligned with JustinStack's
   stated product, and the current bundle already addresses part of it.
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
| checkpoint recovery | partial projection exists after interruption | v1 behavior detects repairable drift; v2 sealed generations retain the prior committed view | existing + planned | explicit repair or integrity outcome | existing health + fault tests |

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

## DX review: developer workflow and operability

### Product classification and developer persona

This is a developer-facing local CLI, TypeScript library, and installed skill
pack, not a runtime that owns agent execution. The primary persona is an
independent engineer working across Claude, Bob, or Codex in a Windows-capable
repository: they have a limited usage budget, may switch agent/session midway,
and need a reliable next action without giving a local tool their provider
credentials or a background daemon.

> “I need a quick answer to whether this task deserves a second agent. I want
> the choice, evidence, and handoff preserved locally—but I do not want a tool
> claiming it changed a model, launched someone, or knows my bill when it did
> none of those things.”

### DX premise and competitive target

No external competitive benchmark is needed to decide this local workflow. The
relevant bar is a user who can install a local CLI, understand its limits, make
one safe routing decision, and resume it on Windows without reading source.
The target is a two-minute time-to-first-useful-output from an existing story,
with one copyable end-to-end path. This is a **DX POLISH** decision: it makes
the recommended advisory scope legible rather than expanding provider control.

### Magical moment and first-run journey

The magical moment is a user providing a small structured task file and seeing
one unambiguous local result such as: low-usage has no delegate by default,
the current model remains unchanged, the exact reason is stored, and the next
checkpoint action is shown. It must take under two minutes and work from
PowerShell or `cmd`, not require Bash.

| Stage | User action | Product response | Friction to remove |
| --- | --- | --- | --- |
| 1. Orient | Read the routing overview after existing `state init` docs | states “advisory; does not spawn/cap/switch models” before any command | do not bury the limitation in adapter docs |
| 2. Configure | inspect effective project/user policy | shows source, precedence, safe defaults, and unconfigured host mapping | distinguish invalid configuration from unknown host capability |
| 3. Assess | pass a structured task file | returns class, current-model default, declared slot impact, and reason | avoid fragile long flags on Windows |
| 4. Decide | accept, request approval, or choose do-not-delegate | records a typed result and concise attestation where required | do not present an advisory warning as an error |
| 5. Delegate manually | user starts any host worker themselves | skill gives bounded inputs/expected findings only | never imply the CLI observed its lifecycle |
| 6. Close or escalate | record outcome/evidence | returns exactly one result state and checkpoint update | no raw prompts or source-body fingerprints |
| 7. Resume | run recovery, then explicitly reconcile if needed | shows sealed routing summary and exact next action | only reconciliation may mark a declaration `unknown-after-resume` |

### Result and configuration contract

Policy discovery must be predictable: project-local policy overrides optional
user policy; no file means conservative built-in defaults; a malformed file is
a nonzero structured error; absent host/model information is `unknown`; and an
unconfigured or unsupported mapping is the valid advisory result
`manual-choice-required`. `doctor` validates syntax only and says that provider
availability was not checked. A user supplied model name is recorded as
supplied, not observed.

The CLI result matrix is part of the public DX contract:

| State | Meaning | Exit behavior |
| --- | --- | --- |
| `recommended` | valid advisory recommendation within policy | success |
| `manual-choice-required` | valid task; host/model mapping is absent or unsupported | success |
| `requires-user-approval` | valid escalation crosses configured boundary | success; no record changes beyond the recommendation |
| `policy-exception` | valid request conflicts with a declared mode and has a recorded exception | success with visible warning |
| `do-not-delegate` | valid decision to keep work with coordinator | success |
| structured error | malformed input, unsafe path, invalid transition, or stale identity | nonzero, existing error envelope |

`--json` emits exactly one JSON object; human text belongs only to non-JSON
mode. Large task or evidence text is passed by a structured input file so that
PowerShell quoting, paths with spaces, and shell-specific escaping do not
become the first-run experience.

### Persistence and recovery ergonomics

The independent DX review identified a hard contract gap: prose in the 16
fixed `context.md` sections cannot be queried, protected against generic body
replacement, or reliably shown in recovery. The plan therefore adopts the
typed, versioned `routing.json` record and bundle-state migration described
above. It must define task IDs, lifecycle transition rules, field bounds,
history cardinality, normalized relative scopes, controlled approach labels,
and projection fields. The generic state-body update preserves the record;
routing changes only use dedicated commands. Recovery reports `not recorded`
for legacy stories and the sealed declaration state; only explicit reconciliation
may report `unknown-after-resume` for an unreleased declaration.

### First-time confusion report and required polish

1. **Enforcement confusion:** every command, example, adapter note, and result
   says “declared advisory slot,” never “active agent limit.”
2. **Model confusion:** classify complexity, then use current model unless a
   user mapping exists; do not fabricate host discovery or cost estimates.
3. **Low-usage confusion:** the one-delegate exception requires a concise
   coordinator attestation, not an unobservable economic calculation.
4. **Escalation confusion:** publish the single threshold matrix—one bounded
   light failure, two materially different medium failures, or a named severity
   trigger—and a privacy-safe evidence shape.
5. **Compatibility confusion:** provide a host matrix, supported-version
   verification steps, and sanitized `doctor --json` attachment guidance.
6. **Upgrade confusion:** show legacy `not recorded`, explicit migration,
   preservation during generic updates, downgrade behavior, and repair rules.

### DX scorecard

| Dimension | Current | Planned target | Release condition |
| --- | --- | --- | --- |
| Getting started | 4/10 | 8/10 | Windows-safe five-step tutorial and example fixture |
| API/CLI clarity | 5/10 | 8/10 | narrow verbs, typed input files, result/exit matrix |
| Error recovery | 6/10 | 8/10 | legacy/stale/scope outcomes explain next action |
| Documentation | 5/10 | 8/10 | advisory limits and first-run flow are prominent |
| Upgrade path | 6/10 | 8/10 | idempotent bundle migration and downgrade contract |
| Environment fit | 7/10 | 9/10 | PowerShell/cmd paths verified; no Bash requirement |
| Support/compatibility | 4/10 | 6/10 | compact matrix and sanitized support artifact |
| DX measurement | 3/10 | 7/10 | local manual dogfood rubric; no telemetry |

### Local dogfood measurement

Before proposing host enforcement, run at least five interrupted/resumed local
stories with a recorded no-routing baseline. For each, record time from resume
to a correct next action, repeated repository-inspection count, missing decision
fields, and unnecessary escalation. “Correct” means the next action matches
the current worktree/plan and does not duplicate already recorded discovery.
Advance only when the advisory path improves time and repeated inspection in a
predeclared majority of stories, records no unsafe content, and introduces no
unresolved migration/recovery defect. Store the study locally and in summary
form only.

### DX validation additions

- Test policy precedence, missing/unknown/unconfigured/unsupported mappings,
  and local-syntax-only doctor output.
- Test every JSON result/exit state without mixed prose, including required
  approval, exception, and do-not-delegate.
- Add legacy and mixed old/new bundle fixtures; prove a generic body update
  cannot delete routing data and recovery reports its state correctly.
- Test stale declaration reconciliation, scope conflicts, bounded evidence,
  long paths/spaces, and PowerShell/cmd launcher examples.
- Run documentation examples as CLI fixtures and verify no example claims that
  the host spawned a delegate, enforced a cap, or switched a model.

### Independent DX review consensus

| Question | Primary DX review | Independent review | Resolution |
| --- | --- | --- | --- |
| Can Markdown alone meet task-state acceptance? | no | no | use typed routing record plus migration |
| Can v1 measure active hosts or cost? | no | no | call slots/cost attestations advisory |
| Is policy discovery currently sufficient? | no | no | versioned local policy and resolver contract |
| Is the first-run flow specified? | not yet | no | add Windows-safe file-based tutorial |
| Is recovery/legacy behavior specified? | incomplete | no | typed recovery and migration fixtures |

The DX gate is satisfied only by shipping the explicit CLI, file-format,
result-state, migration, and tutorial contracts—not by adding more prose to
agent prompts.

## Engineering review: data integrity and implementation plan

### Repository-grounded architecture decision

`src/checkpoint/types.ts` currently fixes bundle schema v1 and a five-Markdown
payload set. `src/checkpoint/bundle.ts` derives every bundle file from
`context.md`, and `src/checkpoint/store.ts` repairs drift by rendering those
projections under a per-story lock and then writing `state.json` last.
`src/cli.ts` exposes only two-token `state <action>` commands; its existing
`state migrate` already means legacy-location migration. `adapters/types.ts`
contains installation paths and proposal-only reminders, not an agent runtime.

Routing cannot be another render-only projection: a repair from `context.md`
would lose task lifecycle/evidence state. The chosen architecture is therefore
two canonical inputs—narrative `context.md` and typed `routing.json`—sealed
with their projections in immutable generation directories. `state.json` is a
manifest pointer, not a self-hashed payload. This is the smallest reliable
change that supports task state without claiming host control.

```text
policy file + structured task input
              |
              v
 pure policy/scope/privacy/transition modules ----> advisory result
              |                                      (JSON or human)
              v
 coordinator store transaction, per-story lock
              |
              +--> load and verify current state pointer + payload manifest
              +--> preserve context + routing unless dedicated routing mutation
              +--> create immutable generation / validate all hashes
              +--> atomically replace root state pointer
              |
              v
 recovery reads the sealed generation only -> summary/projections/next action
```

### Data contracts and migration

- Introduce a `BundlePayloadFile` union for the five Markdown payloads plus
  `routing.json`; `ContinuityBundleFile` adds but never self-hashes
  `state.json`. Version the manifest parser as a discriminated v1/v2 union.
- A v2 manifest holds the active generation name, payload-hash map, manifest
  digest, checkpoint metadata, and identity. Its digest is computed from a
  canonical serialization of payload hashes, avoiding a state self-reference.
- Each generation is immutable after pointer publication. The store retains the
  prior sealed generation during a successful transaction; staging directories
  are ignored by readers and cleaned only after a later verified write.
- `state upgrade-routing` is explicit and idempotent. It validates a v1 bundle,
  copies it into generation one with a bounded empty routing record, verifies
  the result, then publishes the v2 pointer. It is separate from legacy-path
  `state migrate`. Old binaries report v2 unsupported. There is no automatic
  downgrade or routing deletion.
- `state path`, `show`, `validate`, `bundle-status`, `repair`, and `recovery`
  must resolve the active generation via the pointer; they cannot keep treating
  a root `context.md` as authoritative after v2.

### Routing record and transition contract

`routing.json` is a bounded, privacy-validated record rather than a transcript.
It contains its own schema version, policy provenance/digest, at most the
configured task/history limits, and tasks with: safe ID, parent ID, class,
recommendation/result state, declared per-story slot effect, normalized
read/write scopes, explicit supplied host/model, rationale, lifecycle, and
bounded evidence. Controlled enums replace prompt or content fingerprints.

Permitted lifecycle transitions must be published and unit-tested:

| From | Allowed transition | Idempotency |
| --- | --- | --- |
| absent | `declare` -> `proposed`/`declared` | same ID+payload returns current result |
| `declared` | `record-attempt`, `complete`, `abandon`, `reconcile-resume` | same mutation is no-op |
| `unknown-after-resume` | `declare` anew, `complete`, `abandon` | requires explicit coordinator decision |
| `completed` / `abandoned` | none | terminal; reject mutation |

`assess` is pure. `declare`, `record-attempt`, `complete`, `abandon`, and
`reconcile-resume` are coordinator-only mutations. Recovery is read-only and
must never change `declared` to `unknown-after-resume` by implication.

### Correctness, safety, and performance requirements

1. **Commit visibility.** Readers parse `state.json` first and verify every
   payload in its named immutable generation. A crash before pointer replacement
   leaves the old pointer/generation current. A corrupt pointer or hash mismatch
   is a named integrity failure; it is not repaired by inventing an empty route.
   Fault injection covers staging, every payload write, generation rename, and
   pointer replacement.
2. **Concurrency.** The story lock and compare-and-swap compare the sealed
   manifest generation, not only `context.md`, so routing-only writes cannot
   race body updates. The declared-slot ceiling is per story; no claim is made
   about processes outside the record.
3. **Scope security.** A pure normalizer rejects NUL/control characters,
   absolute paths, traversal, glob syntax, and non-repository paths; uses
   canonical segments/separators and Windows case rules; and defines root scope
   explicitly. Conflict tests use equal, ancestor, descendant, and disjoint
   paths—not string prefix matching.
4. **Privacy.** The routing parser applies equivalent or stricter bounds than
   Markdown: secret detection, URL/source/diff rejection, short safe strings,
   explicit enums, bounded list lengths, and no content treated as instruction.
   Projected routing summary is sanitized again before handoff rendering.
5. **Performance.** No repository-wide scan, provider network call, telemetry,
   daemon, or process enumeration is introduced. Read/validate work is bounded
   by one story manifest and its payloads; history compaction is deterministic.

### File-level change map

| Area | Planned change |
| --- | --- |
| `src/checkpoint/types.ts`, `identifiers.ts` | v1/v2 manifest types, payload paths, generation IDs, safe scope types |
| new `src/routing/*` modules | policy, resolver, record schema, privacy, scope normalization, transitions, result types |
| `src/checkpoint/bundle.ts` | v1/v2 parse, immutable generation render/verify, pointer manifest, safe projection rendering |
| `src/checkpoint/store.ts` | sealed-generation read, CAS transaction, explicit upgrade, routing mutations, read-only recovery summary |
| `src/cli.ts` | `state upgrade-routing`; nested `state routing` dispatcher; input-file and JSON/exit contract; pointer-aware state views |
| `src/installer.ts`, adapters, skills, policy, README | package policy/template allowlist if needed; advisory-only wording; compatibility/tutorial/docs |
| tests and `package.json` | add routing suite and explicitly add every compiled test file to the existing fixed `node --test` command |

### Test plan and release sequencing

The detailed test artifact is
`C:\Users\Justin\.gstack\projects\justinstack\justin-main-agent-routing-test-plan-20260904-164500.md`.
It covers policy/resolver/scope/privacy units; v1/v2 conversion; staged publish
faults; lock/CAS races; generic update preservation; lifecycle/JSON/exit paths;
Windows paths and launchers; adapter claims; and executable documentation.
Because `package.json` enumerates test files explicitly, new tests do not run
until the script includes them.

Implementation is sequential through contracts and storage (steps 1–6), because
the CLI and docs depend on their exact result/migration semantics. Once those
contracts are frozen, documentation/skills/adapter wording can proceed in
parallel with non-overlapping unit/CLI test work. Do not parallelize routing
store changes with bundle migration changes in the same worktree.

### Independent engineering review consensus

| Risk | Primary review | Independent review | Resolution |
| --- | --- | --- | --- |
| state self-hash and legacy read | identified in v2 design | blocker | payload manifest excludes state; v1/v2 parser + explicit upgrade |
| routing regenerated as projection | identified | high | two canonical inputs; preserve routing under lock |
| state-last mixed reads | identified | high | immutable generations + state-pointer-first readers |
| incomplete lifecycle verbs | identified | high | add dispatcher including record-attempt and explicit reconcile |
| scope/privacy boundary | identified | medium | pure normalizer and typed privacy schema |
| test wiring | identified | medium | add explicit test target in `package.json` |

The independent reviewer found advisory-first technically viable after these
contracts are fixed. A separate Codex CLI review was unavailable in the local
time window and is not counted as consensus.

## Decision audit trail

| ID | Decision | Classification | Basis | Outcome |
| --- | --- | --- | --- | --- |
| D1 | Start with advisory continuity, not cross-provider execution control | User-approved scope resolution | P1 completeness; P4 reuse existing wedge; adapters lack lifecycle APIs | accepted |
| D2 | Classify work complexity, with optional user-owned provider mappings | Mechanical | P5 explicit; host tiers/cost are not comparable or observable | accepted |
| D3 | Define `standard` as three and `low-usage` as one per-story declared advisory slots, with one attested exception | Taste | P3 pragmatic; balance visibility and limited usage without false host claims | accepted |
| D4 | Use a typed engine-owned routing record, not five peer-authored Markdown files or prose sections | Mechanical | P1 complete recovery; P4 preserves existing bundle ownership/lock | accepted |
| D5 | Upgrade to a sealed v2 generation manifest instead of self-hashing/in-place mutable routing | Mechanical | P5 explicit atomic-reader semantics; independent engineering blocker | accepted |
| D6 | Keep cost/benefit as coordinator attestation and escalation as evidence plus a user boundary | Mechanical | P5 explicit; billing and host activity are unavailable locally | accepted |
| D7 | Separate `state upgrade-routing` from legacy-location `state migrate` | Mechanical | P5 avoids ambiguous CLI/migration behavior | accepted |
| D8 | Require Windows-safe input files, one JSON result, and executable docs | Mechanical | P1 complete DX; P5 clear cross-shell contract | accepted |
| D9 | Defer observed leases, scheduler admission, automatic model switching, telemetry, and cloud sync | User-approved scope resolution | current product/adapter boundary plus local-first safety | accepted |

## GSTACK REVIEW REPORT

| Review | Result | Material resolution |
| --- | --- | --- |
| CEO / strategy | completed | portable recovery is the wedge; advisory-first selected |
| Design | skipped | no UI surface in scope |
| Developer experience | completed | typed task state, result contract, Windows tutorial, and measurable dogfood gate added |
| Engineering | completed | sealed v2 generation manifest, routing lifecycle, migration, security, and test wiring specified |
| Independent reviewers | completed | strategy, DX, and engineering reviews incorporated |
| Codex CLI external voice | unavailable | two read-only attempts produced no final response; not treated as consensus |

**Verdict: APPROVED FOR IMPLEMENTATION.** The plan now gives the requested
LIGHT/MEDIUM/HEAVY discipline, standard/low-usage policy, escalation rule, and
continuity checkpoints in a form the current product can honestly implement:
it recommends and records decisions locally, while leaving host execution under
the user and provider. The approved implementation starts with the policy,
routing-record, and sealed-bundle-v2 contracts; it must not begin with adapter
promises or host-control claims.

**UNRESOLVED DECISIONS:** None. The user approved the advisory-first plan.
