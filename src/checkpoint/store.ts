import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StoryStackError } from "../errors.js";
import {
  emptyRoutingRecord,
  normalizeScope,
  parseRoutingRecord,
  serializeRoutingRecord,
  validateRoutingRecord,
  validateRoutingTask,
  type RoutingEvidence,
  type RoutingRecord,
  type RoutingTask,
} from "../routing.js";
import {
  inspectContinuityBundle,
  publishInitialContinuityBundle,
  renderContinuityBundle,
  writeBundleFileIfDifferent,
} from "./bundle.js";
import {
  assertSafeWritePath,
  assertStateRootOutsideRepository,
  lstatOrNull,
  readRegularFileOrNull,
} from "./filesystem.js";
import { writeFileAtomic } from "./atomic.js";
import { metadataEqualsExceptUpdatedAt, parseCheckpoint, serializeCheckpoint } from "./frontmatter.js";
import { captureGitSnapshot, detectBaseBranch, findRepositoryRoot, validateBaseBranch } from "./git.js";
import {
  checkpointBundlePaths,
  checkpointPath,
  legacyCheckpointPath,
  repositoryIdentity,
  sanitizeProjectSlug,
  sanitizeTicketKey,
} from "./identifiers.js";
import { reconcileCheckpoint } from "./reconcile.js";
import { extractSection, REQUIRED_SECTIONS, validateMarkdownBody } from "./schema.js";
import { loadCheckpointTemplate, replaceSection } from "./template.js";
import {
  SCHEMA_VERSION,
  TICKET_STATUSES,
  type Checkpoint,
  type CheckpointMetadata,
  type ContinuityBundleHealth,
  type ContinuityBundlePaths,
  type GitSnapshot,
  type ReconciliationResult,
  type TicketStatus,
} from "./types.js";

export interface StoreOptions {
  jstackHome?: string;
  /** @deprecated Use jstackHome. */
  storyStackHome?: string;
  workspacesRoot?: string;
  /** Legacy single-checkpoint root retained for explicit migration helpers. */
  stateRoot?: string;
  /** Legacy root when it is independent from the new JStack home. */
  legacyStateRoot?: string;
  packageRoot?: string;
  clock?: () => Date;
}

export interface CheckpointIdentity {
  projectSlug: string;
  ticketKey: string;
}

export interface CreateCheckpointOptions extends CheckpointIdentity {
  repositoryPath: string;
  baseBranch?: string;
  objective?: string;
}

export interface MutationResult {
  checkpoint: Checkpoint;
  checkpointPath: string;
  changed: boolean;
  repairedFiles?: string[];
}

export interface UpdateCheckpointOptions extends CheckpointIdentity {
  repositoryPath: string;
  body: string;
  section?: (typeof REQUIRED_SECTIONS)[number];
  status?: TicketStatus;
  allowApprovalChange?: boolean;
}

export interface RecordValidationOptions extends CheckpointIdentity {
  repositoryPath: string;
  summary: string;
  expectedWorktreeFingerprint: string;
  confirmedSuccessful: boolean;
}

export interface ApprovePlanOptions extends CheckpointIdentity {
  repositoryPath: string;
  body: string;
}

export interface ListedCheckpoint {
  checkpointPath: string;
  metadata?: CheckpointMetadata;
  error?: string;
}

export interface RecoverySummary {
  workspace: string;
  story: string;
  project: string;
  ticket: string;
  objective: string;
  acceptanceCriteria: string;
  nonGoals: string;
  relevantFiles: string;
  decisions: string;
  completedWork: string;
  currentWork: string;
  currentState: string;
  currentLocalDiffSummary: string;
  checks: string;
  failures: string;
  unresolvedQuestions: string;
  failuresAndUnresolvedQuestions: string;
  exactRecommendedNextStep: string;
  nextAction: string;
  blockers: string;
  requiredApproval: string;
  lastSuccessfulValidation: string;
  reconciliation: ReconciliationResult;
}

function resolveSafeStateRoot(candidate: string, label: string): string {
  if (candidate.length === 0 || /[\0-\x1f\x7f]/u.test(candidate)) {
    throw new StoryStackError(`${label} contains an empty value or control character`, "INVALID_STORY_HOME");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new StoryStackError(`${label} cannot be a filesystem root`, "INVALID_STORY_HOME");
  }
  return resolved;
}

export function defaultJStackHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = [environment.JSTACK_HOME, environment.STORY_STACK_HOME]
    .find((candidate) => candidate !== undefined && candidate.length > 0);
  const candidate = override && override.length > 0 ? override : path.join(os.homedir(), ".jstack");
  return resolveSafeStateRoot(candidate, "JStack home");
}

/** @deprecated Use defaultJStackHome. */
export const defaultStoryStackHome = defaultJStackHome;

export function defaultLegacyStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const explicitLegacy = environment.STORY_STACK_HOME;
  if (explicitLegacy && explicitLegacy.length > 0) {
    return path.join(resolveSafeStateRoot(explicitLegacy, "Legacy story-stack home"), "state");
  }
  // New-home overrides must not hide checkpoints written by Phase 1. The old
  // default remains independent unless its own compatibility override is set.
  return path.join(os.homedir(), ".story-stack", "state");
}

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

const readFileOrNull = readRegularFileOrNull;

function metadataFromSnapshot(
  existing: CheckpointMetadata,
  snapshot: GitSnapshot,
  now: string,
  options: { status?: TicketStatus; recordValidation?: boolean; clearValidation?: boolean } = {},
): CheckpointMetadata {
  const recordValidation = options.recordValidation === true;
  const clearValidation = options.clearValidation === true;
  return {
    ...existing,
    repository_id: repositoryIdentity(snapshot.repositoryRoot),
    current_branch: snapshot.currentBranch,
    head_commit: snapshot.headCommit,
    worktree_fingerprint: snapshot.worktreeFingerprint,
    ticket_status: options.status ?? existing.ticket_status,
    git_dirty: snapshot.dirty,
    changed_file_count: snapshot.changedFileCount,
    untracked_file_count: snapshot.untrackedFileCount,
    last_validation_at: recordValidation ? now : clearValidation ? null : existing.last_validation_at,
    last_validation_fingerprint: recordValidation
      ? snapshot.worktreeFingerprint
      : clearValidation
        ? null
        : existing.last_validation_fingerprint,
    updated_at: now,
  };
}

function isClear(section: string): boolean {
  const normalized = section
    .toLowerCase()
    .replace(/^\s*[-*]\s*/gmu, "")
    .replace(/[.`]/g, "")
    .trim();
  return ["none", "n/a", "not applicable", "no blockers", "no approvals required"].includes(normalized);
}

function isPlaceholder(section: string): boolean {
  const normalized = section
    .toLowerCase()
    .replace(/^\s*[-*]\s*/gmu, "")
    .replace(/[.`]/g, "")
    .trim();
  return normalized === "not recorded" || normalized === "nothing completed yet" || normalized.length === 0;
}

function combineRecoverySections(parts: readonly { label: string; value: string }[]): string {
  return parts.map((part) => `${part.label}:\n${part.value}`).join("\n\n");
}

function currentDiffSummary(snapshot: GitSnapshot): string {
  if (!snapshot.dirty) return "Clean worktree.";
  return [
    `Changed-file count: ${snapshot.changedFileCount}.`,
    `Untracked-file count: ${snapshot.untrackedFileCount}.`,
  ].join("\n");
}

function recordedFailures(validationSummary: string): string {
  const failures = validationSummary
    .split("\n")
    .filter((line) => /^\s*(?:[-*]\s*)?(?:fail(?:ed|ing|ure)?|error|interrupted|blocked)\b/iu.test(line));
  return failures.length > 0 ? failures.join("\n") : "None explicitly recorded.";
}

function includeBundleHealth(
  reconciliation: ReconciliationResult,
  bundleHealth: ContinuityBundleHealth,
): ReconciliationResult {
  const reasons = [...reconciliation.reasons, ...bundleHealth.reasons];
  if (bundleHealth.status === "missing-required-information" && reconciliation.status !== "different-branch") {
    return {
      status: "missing-required-information",
      reasons,
      currentSnapshot: reconciliation.currentSnapshot,
      validationIsCurrent: reconciliation.validationIsCurrent,
      bundleHealth,
    };
  }
  if (reconciliation.status === "current" && bundleHealth.status === "repairable") {
    return {
      status: "stale-but-reconcilable",
      reasons,
      currentSnapshot: reconciliation.currentSnapshot,
      validationIsCurrent: reconciliation.validationIsCurrent,
      bundleHealth,
    };
  }
  return { ...reconciliation, reasons, bundleHealth };
}

function assertSuccessfulValidationSection(body: string): void {
  const value = extractSection(body, "Test and validation results")
    .toLowerCase()
    .replace(/^\s*[-*]\s*/gmu, "")
    .trim();
  const unsuccessful =
    /\b(?:not\s+(?:run|executed|completed|recorded|available|pass(?:ed)?|successful)|did\s+not\s+(?:run|finish|complete|pass|succeed)|fail(?:ed|ing|ure|ures)?|error(?:s)?|skip(?:ped|ping)?|inconclusive|undetermined|unavailable|interrupt(?:ed|ion)?|partial(?:ly)?|mixed|flaky|cancel(?:led|ed|lation)?|timed?\s*out|timeout|blocked|pending|unknown|incomplete|tbd)\b|\bn\s*\/\s*a\b/u;
  const successful = /\b(?:pass(?:ed)?|succeed(?:ed)?|success(?:ful(?:ly)?)?|ok)\b/u;
  if (value.length === 0 || value === "none" || value === "not recorded" || unsuccessful.test(value) || !successful.test(value)) {
    throw new StoryStackError(
      "A successful current test or validation summary is required before marking validation",
      "VALIDATION_SUMMARY_REQUIRED",
    );
  }
}

function assertCheckpointIdentity(identity: CheckpointIdentity, checkpoint: Checkpoint, label = "Checkpoint"): void {
  if (
    checkpoint.metadata.project_slug !== identity.projectSlug ||
    checkpoint.metadata.ticket_key !== identity.ticketKey
  ) {
    throw new StoryStackError(`${label} identity does not match its state directory`, "INVALID_CHECKPOINT", 4);
  }
}

function planApprovalChanged(originalBody: string, candidateBody: string): string | null {
  for (const section of PLAN_APPROVAL_SECTIONS) {
    if (extractSection(originalBody, section) !== extractSection(candidateBody, section)) return section;
  }
  return null;
}

function parseCheckpointForIdentity(
  source: string,
  identity: CheckpointIdentity,
  label = "Checkpoint",
): Checkpoint {
  const checkpoint = parseCheckpoint(source);
  assertCheckpointIdentity(identity, checkpoint, label);
  return checkpoint;
}

const STATUS_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  planning: ["planning", "ready", "blocked"],
  ready: ["ready", "in-progress", "blocked"],
  "in-progress": ["in-progress", "in-review", "blocked"],
  "in-review": ["in-review", "in-progress", "blocked", "completed"],
  blocked: ["blocked", "planning", "ready", "in-progress", "in-review"],
  completed: ["completed"],
};

const STALE_LOCK_AGE_MS = 30 * 60 * 1000;
const LOCK_ELECTION_RETRIES = 20;
const LOCK_ELECTION_DELAY_MS = 5;

const PLAN_APPROVAL_SECTIONS = ["Objective", "Acceptance criteria", "Non-goals", "Approved plan"] as const;

function processIsDefinitelyGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

interface LockOwner {
  pid: number;
  created_at: string;
  token?: string;
}

interface LockQueueState {
  blocked: boolean;
  choosing: string[];
  tickets: { path: string; ticket: number; token: string }[];
}

function parseLockOwner(source: string): LockOwner | null {
  try {
    const parsed = JSON.parse(source) as Partial<LockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof parsed.created_at !== "string" ||
      !Number.isFinite(Date.parse(parsed.created_at))
    ) {
      return null;
    }
    if (parsed.token !== undefined && typeof parsed.token !== "string") return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

function lockIsStale(owner: LockOwner): boolean {
  const age = Date.now() - Date.parse(owner.created_at);
  return Number.isFinite(age) && age >= STALE_LOCK_AGE_MS && processIsDefinitelyGone(owner.pid);
}

async function reclaimStaleLockArtifact(candidatePath: string): Promise<boolean> {
  const stats = await lstatOrNull(candidatePath);
  if (stats === null) return true;
  if (stats.isSymbolicLink() || !stats.isFile()) return false;

  const fileAge = Date.now() - stats.mtimeMs;
  let source: string;
  try {
    source = await readRegularFileOrNull(candidatePath) ?? "";
  } catch {
    return false;
  }
  const owner = parseLockOwner(source);
  if (owner === null) {
    if (!Number.isFinite(fileAge) || fileAge < STALE_LOCK_AGE_MS) return false;
  } else if (!lockIsStale(owner)) {
    return false;
  }

  // Claim the exact immutable lock name with an atomic rename before deciding
  // whether it is safe to delete. New-protocol choosing and ticket names carry
  // random tokens and are never reused, so another contender cannot inherit
  // the candidate path while cleanup is in progress.
  const claimPath = path.join(path.dirname(candidatePath), `.${path.basename(candidatePath)}.reclaim.${randomUUID()}.tmp`);
  try {
    await rename(candidatePath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }

  let removeClaim = false;
  try {
    const claimedStats = await lstatOrNull(claimPath);
    if (claimedStats === null || claimedStats.isSymbolicLink() || !claimedStats.isFile()) return false;
    const claimedSource = await readRegularFileOrNull(claimPath);
    if (claimedSource === null) return true;
    const claimedOwner = parseLockOwner(claimedSource);
    const claimedAge = Date.now() - claimedStats.mtimeMs;
    removeClaim = claimedOwner === null
      ? Number.isFinite(claimedAge) && claimedAge >= STALE_LOCK_AGE_MS
      : lockIsStale(claimedOwner);
    if (removeClaim) return true;

    // The file became a live lease before our atomic claim. Restore it only
    // when the unique original name is still vacant; otherwise leave the
    // claimed artifact intact rather than overwrite another owner.
    if (await lstatOrNull(candidatePath) === null) await rename(claimPath, candidatePath);
    return false;
  } finally {
    if (removeClaim) await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

function parseTicketFileName(name: string, ticketPrefix: string): { ticket: number; token: string } | null {
  if (!name.startsWith(ticketPrefix)) return null;
  const remainder = name.slice(ticketPrefix.length);
  const separator = remainder.indexOf(".");
  if (separator < 1) return null;
  const ticket = Number(remainder.slice(0, separator));
  const token = remainder.slice(separator + 1);
  if (!Number.isSafeInteger(ticket) || ticket < 1 || !/^[a-f0-9-]{36}$/u.test(token)) return null;
  return { ticket, token };
}

async function inspectLockQueue(lockPath: string): Promise<LockQueueState> {
  const directory = path.dirname(lockPath);
  const baseName = path.basename(lockPath);
  const choosingPrefix = `${baseName}.choosing.`;
  const ticketPrefix = `${baseName}.ticket.`;
  const state: LockQueueState = { blocked: false, choosing: [], tickets: [] };
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== baseName && !entry.name.startsWith(choosingPrefix) && !entry.name.startsWith(ticketPrefix)) {
      continue;
    }
    const candidatePath = path.join(directory, entry.name);
    let source: string | null;
    try {
      source = await readFileOrNull(candidatePath);
    } catch {
      state.blocked = true;
      continue;
    }
    if (source === null) continue;
    const owner = parseLockOwner(source);
    if ((owner !== null && lockIsStale(owner)) || owner === null) {
      if (await reclaimStaleLockArtifact(candidatePath)) continue;
    }
    if (owner !== null && lockIsStale(owner)) {
      state.blocked = true;
      continue;
    }
    if (owner === null && entry.name.startsWith(choosingPrefix)) {
      state.choosing.push(candidatePath);
      continue;
    }
    if (owner === null || entry.name === baseName) {
      state.blocked = true;
      continue;
    }
    if (entry.name.startsWith(choosingPrefix)) {
      const token = entry.name.slice(choosingPrefix.length);
      if (owner.token !== token || !/^[a-f0-9-]{36}$/u.test(token)) state.blocked = true;
      else state.choosing.push(candidatePath);
      continue;
    }
    const ticketEntry = parseTicketFileName(entry.name, ticketPrefix);
    if (ticketEntry === null || owner.token !== ticketEntry.token) {
      state.blocked = true;
      continue;
    }
    state.tickets.push({ path: candidatePath, ...ticketEntry });
  }
  return state;
}

async function acquireCheckpointLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  const baseName = path.basename(lockPath);
  const choosingPath = path.join(path.dirname(lockPath), `${baseName}.choosing.${token}`);
  const owner = `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), token })}\n`;
  // writeFileAtomic uses an unrecognized temporary name, flushes it, and only
  // then publishes the recognized choosing artifact. A crash can therefore
  // leave either no contender or a complete owner record, never a partial one.
  await writeFileAtomic(choosingPath, owner);

  let ticketPath: string | null = null;
  try {
    const initial = await inspectLockQueue(lockPath);
    if (initial.blocked) throw new StoryStackError(`Checkpoint lock cannot be safely inspected: ${lockPath}`, "CHECKPOINT_LOCKED");
    const ticket = initial.tickets.reduce((maximum, contender) => Math.max(maximum, contender.ticket), 0) + 1;
    if (!Number.isSafeInteger(ticket)) {
      throw new StoryStackError(`Checkpoint lock ticket space is exhausted: ${lockPath}`, "CHECKPOINT_LOCKED");
    }
    ticketPath = path.join(path.dirname(lockPath), `${baseName}.ticket.${ticket}.${token}`);
    await rename(choosingPath, ticketPath);

    for (let attempt = 0; attempt <= LOCK_ELECTION_RETRIES; attempt += 1) {
      const queue = await inspectLockQueue(lockPath);
      if (queue.blocked) {
        throw new StoryStackError(`Checkpoint lock cannot be safely inspected: ${lockPath}`, "CHECKPOINT_LOCKED");
      }
      if (queue.choosing.length > 0) {
        if (attempt < LOCK_ELECTION_RETRIES) {
          await delay(LOCK_ELECTION_DELAY_MS);
          continue;
        }
        throw new StoryStackError(`Checkpoint lock election did not settle: ${lockPath}`, "CHECKPOINT_LOCKED");
      }
      queue.tickets.sort((left, right) => left.ticket - right.ticket || left.token.localeCompare(right.token, "en"));
      if (queue.tickets[0]?.path === ticketPath) return ticketPath;
      throw new StoryStackError(`Checkpoint lock is active: ${lockPath}`, "CHECKPOINT_LOCKED");
    }
    throw new StoryStackError(`Checkpoint lock election failed: ${lockPath}`, "CHECKPOINT_LOCKED");
  } catch (error) {
    await rm(ticketPath ?? choosingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertStatusTransition(from: TicketStatus, to: TicketStatus): void {
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new StoryStackError(`Ticket status cannot move from '${from}' to '${to}'`, "INVALID_STATUS_TRANSITION");
  }
}

export class CheckpointStore {
  readonly jstackHome: string;
  /** @deprecated Use jstackHome. */
  readonly storyStackHome: string;
  readonly workspacesRoot: string;
  /** Legacy `.story-stack/state`-style root; used only by migration helpers. */
  readonly stateRoot: string;
  readonly packageRoot: string | undefined;
  readonly clock: () => Date;

  constructor(options: StoreOptions = {}) {
    const inferredHome = options.stateRoot !== undefined
      ? path.dirname(path.resolve(options.stateRoot))
      : options.workspacesRoot !== undefined
        ? path.dirname(path.resolve(options.workspacesRoot))
        : undefined;
    this.jstackHome = resolveSafeStateRoot(
      options.jstackHome ?? options.storyStackHome ?? inferredHome ?? defaultJStackHome(),
      "JStack home",
    );
    this.storyStackHome = this.jstackHome;
    this.stateRoot = resolveSafeStateRoot(
      options.legacyStateRoot ??
      options.stateRoot ??
      // `storyStackHome` is the deprecated Phase 1 home override, so retain
      // its old `state/` location. A new JStack/workspace override alone
      // must not redirect legacy discovery away from ~/.story-stack/state.
      (options.storyStackHome === undefined
        ? defaultLegacyStateRoot()
        : path.join(path.resolve(options.storyStackHome), "state")),
      "Legacy checkpoint root",
    );
    this.workspacesRoot = resolveSafeStateRoot(
      options.workspacesRoot ?? path.join(this.storyStackHome, "workspaces"),
      "Checkpoint workspace root",
    );
    this.packageRoot = options.packageRoot;
    this.clock = options.clock ?? (() => new Date());
  }

  pathFor(identity: CheckpointIdentity): string {
    return checkpointPath(this.workspacesRoot, identity.projectSlug, identity.ticketKey);
  }

  bundlePathsFor(identity: CheckpointIdentity): ContinuityBundlePaths {
    return checkpointBundlePaths(this.workspacesRoot, identity.projectSlug, identity.ticketKey);
  }

  legacyPathFor(identity: CheckpointIdentity): string {
    return legacyCheckpointPath(this.stateRoot, identity.projectSlug, identity.ticketKey);
  }

  normalizeIdentity(projectInput: string, ticketInput: string): CheckpointIdentity {
    return {
      projectSlug: sanitizeProjectSlug(projectInput),
      ticketKey: sanitizeTicketKey(ticketInput),
    };
  }

  async load(identity: CheckpointIdentity): Promise<Checkpoint> {
    const filePath = this.pathFor(identity);
    const source = await readFileOrNull(filePath);
    if (source === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    return parseCheckpointForIdentity(source, identity);
  }

  async loadLegacy(identity: CheckpointIdentity): Promise<Checkpoint> {
    const filePath = this.legacyPathFor(identity);
    const source = await readFileOrNull(filePath);
    if (source === null) throw new StoryStackError(`Legacy checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    return parseCheckpointForIdentity(source, identity, "Legacy checkpoint");
  }

  async bundleHealth(identity: CheckpointIdentity): Promise<ContinuityBundleHealth> {
    return inspectContinuityBundle(this.bundlePathsFor(identity), await this.load(identity));
  }

  /** Returns null until the coordinator explicitly initializes advisory routing for this story. */
  async loadRouting(identity: CheckpointIdentity): Promise<RoutingRecord | null> {
    const source = await readRegularFileOrNull(this.bundlePathsFor(identity).routing);
    return source === null ? null : parseRoutingRecord(source);
  }

  async upgradeRouting(identity: CheckpointIdentity, repositoryPath: string): Promise<{ changed: boolean; routing: RoutingRecord }> {
    const { repositoryRoot } = await this.assertRoutingRepository(identity, repositoryPath);
    return this.mutateRouting(identity, repositoryRoot, (routing) => ({ routing, changed: false }), true);
  }

  async declareRoutingTask(
    identity: CheckpointIdentity,
    repositoryPath: string,
    task: RoutingTask,
  ): Promise<{ changed: boolean; routing: RoutingRecord; task: RoutingTask }> {
    const { repositoryRoot } = await this.assertRoutingRepository(identity, repositoryPath);
    const normalized = normalizeRoutingTaskScopes(task, repositoryRoot);
    return this.mutateRouting(identity, repositoryRoot, (routing) => {
      const existing = routing.tasks.find((item) => item.id === normalized.id);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
          throw new StoryStackError(`Routing task '${normalized.id}' already exists with different data`, "ROUTING_CONFLICT", 4);
        }
        return { routing, changed: false, task: existing };
      }
      if (routing.tasks.filter((item) => item.status === "declared").length >= 32) {
        throw new StoryStackError("Routing record has too many declared tasks", "ROUTING_LIMIT", 4);
      }
      const next = validateRoutingRecord({ ...routing, tasks: [...routing.tasks, normalized] });
      return { routing: next, changed: true, task: normalized };
    });
  }

  async recordRoutingAttempt(
    identity: CheckpointIdentity,
    repositoryPath: string,
    taskId: string,
    evidence: RoutingEvidence,
  ): Promise<{ changed: boolean; routing: RoutingRecord; task: RoutingTask }> {
    const { repositoryRoot } = await this.assertRoutingRepository(identity, repositoryPath);
    return this.mutateRouting(identity, repositoryRoot, (routing) => {
      const index = routing.tasks.findIndex((item) => item.id === taskId);
      if (index < 0) throw new StoryStackError(`Routing task '${taskId}' was not found`, "ROUTING_NOT_FOUND", 4);
      const current = routing.tasks[index];
      if (current === undefined || current.status === "completed" || current.status === "abandoned") {
        throw new StoryStackError("Cannot record an attempt for a terminal routing task", "INVALID_ROUTING_TRANSITION", 4);
      }
      const validatedEvidence = validateRoutingRecord({
        schema_version: 1,
        tasks: [{ ...current, evidence: [...current.evidence, evidence] }],
      }).tasks[0]?.evidence.at(-1);
      if (validatedEvidence === undefined) {
        throw new StoryStackError("Routing evidence could not be validated", "INVALID_ROUTING");
      }
      const duplicate = current.evidence.find((item) => item.attempt_id === validatedEvidence.attempt_id);
      if (duplicate !== undefined) {
        if (JSON.stringify(duplicate) !== JSON.stringify(validatedEvidence)) {
          throw new StoryStackError("Routing attempt ID already exists with different evidence", "ROUTING_CONFLICT", 4);
        }
        return { routing, changed: false, task: current };
      }
      const updated = validateRoutingTask({
        ...current,
        evidence: [...current.evidence, validatedEvidence],
        updated_at: this.clock().toISOString(),
      });
      const tasks = [...routing.tasks];
      tasks[index] = updated;
      return { routing: validateRoutingRecord({ ...routing, tasks }), changed: true, task: updated };
    });
  }

  async transitionRoutingTask(
    identity: CheckpointIdentity,
    repositoryPath: string,
    taskId: string,
    status: Extract<RoutingTask["status"], "completed" | "abandoned" | "unknown-after-resume">,
  ): Promise<{ changed: boolean; routing: RoutingRecord; task: RoutingTask }> {
    const { repositoryRoot } = await this.assertRoutingRepository(identity, repositoryPath);
    return this.mutateRouting(identity, repositoryRoot, (routing) => {
      const index = routing.tasks.findIndex((item) => item.id === taskId);
      if (index < 0) throw new StoryStackError(`Routing task '${taskId}' was not found`, "ROUTING_NOT_FOUND", 4);
      const current = routing.tasks[index];
      if (current === undefined) throw new StoryStackError("Routing task was not found", "ROUTING_NOT_FOUND", 4);
      if (current.status === status) return { routing, changed: false, task: current };
      if (current.status === "completed" || current.status === "abandoned") {
        throw new StoryStackError("Cannot change a terminal routing task", "INVALID_ROUTING_TRANSITION", 4);
      }
      const updated = validateRoutingTask({ ...current, status, updated_at: this.clock().toISOString() });
      const tasks = [...routing.tasks];
      tasks[index] = updated;
      return { routing: validateRoutingRecord({ ...routing, tasks }), changed: true, task: updated };
    });
  }

  async reconcileRoutingResume(identity: CheckpointIdentity, repositoryPath: string): Promise<{ changed: boolean; routing: RoutingRecord }> {
    const { repositoryRoot } = await this.assertRoutingRepository(identity, repositoryPath);
    return this.mutateRouting(identity, repositoryRoot, (routing) => {
      const now = this.clock().toISOString();
      const tasks = routing.tasks.map((task) => task.status === "declared"
        ? validateRoutingTask({ ...task, status: "unknown-after-resume", updated_at: now })
        : task);
      const changed = tasks.some((task, index) => task !== routing.tasks[index]);
      return { routing: changed ? validateRoutingRecord({ ...routing, tasks }) : routing, changed };
    });
  }

  /** Copy a validated legacy checkpoint into the bundle layout without removing the source. */
  async migrateLegacy(identity: CheckpointIdentity, repositoryPath: string): Promise<MutationResult> {
    const repositoryRoot = await findRepositoryRoot(repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot, true);
    const legacy = await this.loadLegacy(identity);
    this.assertSameRepository(legacy.metadata, repositoryRoot);
    const targetPath = this.pathFor(identity);
    const targetSource = await readFileOrNull(targetPath);
    if (targetSource !== null) {
      const current = parseCheckpointForIdentity(targetSource, identity);
      if (serializeCheckpoint(current) !== serializeCheckpoint(legacy)) {
        throw new StoryStackError(
          "Legacy and continuity checkpoints differ; refusing to choose one automatically",
          "CHECKPOINT_CONFLICT",
          4,
        );
      }
      const repairedFiles = await this.repairBundle(identity, current, targetSource, repositoryRoot);
      return { checkpoint: current, checkpointPath: targetPath, changed: false, repairedFiles };
    }
    await this.writeWithCompareAndSwap(identity, legacy, null, repositoryRoot);
    return { checkpoint: legacy, checkpointPath: targetPath, changed: true };
  }

  async create(options: CreateCheckpointOptions): Promise<MutationResult> {
    const repositoryRoot = await findRepositoryRoot(options.repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const filePath = this.pathFor(options);
    await assertSafeWritePath(this.workspacesRoot, filePath);
    const existingSource = await readFileOrNull(filePath);
    if (existingSource !== null) {
      const existing = parseCheckpointForIdentity(existingSource, options);
      const current = await captureGitSnapshot(repositoryRoot);
      const reconciliation = reconcileCheckpoint(existing.metadata, current);
      if (reconciliation.status === "different-branch") {
        throw new StoryStackError(reconciliation.reasons.join(" "), "BRANCH_MISMATCH", 3);
      }
      if (reconciliation.status === "missing-required-information") {
        throw new StoryStackError(reconciliation.reasons.join(" "), "REPOSITORY_MISMATCH", 4);
      }
      if (options.baseBranch !== undefined && options.baseBranch !== existing.metadata.base_branch) {
        throw new StoryStackError(
          `Existing checkpoint records base '${existing.metadata.base_branch}', not '${options.baseBranch}'`,
          "BASE_BRANCH_MISMATCH",
          4,
        );
      }
      const repairedFiles = await this.repairBundle(options, existing, existingSource, repositoryRoot);
      return { checkpoint: existing, checkpointPath: filePath, changed: false, repairedFiles };
    }
    const snapshot = await captureGitSnapshot(repositoryRoot);
    const now = this.clock().toISOString();
    let body = await loadCheckpointTemplate(this.packageRoot);
    if (options.objective !== undefined) body = replaceSection(body, "Objective", options.objective);
    const baseBranch = options.baseBranch ?? (await detectBaseBranch(snapshot.repositoryRoot, snapshot.currentBranch));
    await validateBaseBranch(snapshot.repositoryRoot, baseBranch, snapshot);
    const checkpoint: Checkpoint = {
      metadata: {
        schema_version: SCHEMA_VERSION,
        project_slug: options.projectSlug,
        ticket_key: options.ticketKey,
        repository_id: repositoryIdentity(snapshot.repositoryRoot),
        current_branch: snapshot.currentBranch,
        base_branch: baseBranch,
        head_commit: snapshot.headCommit,
        worktree_fingerprint: snapshot.worktreeFingerprint,
        ticket_status: "planning",
        created_at: now,
        updated_at: now,
        git_dirty: snapshot.dirty,
        changed_file_count: snapshot.changedFileCount,
        untracked_file_count: snapshot.untrackedFileCount,
        last_validation_at: null,
        last_validation_fingerprint: null,
      },
      body,
    };
    await this.writeWithCompareAndSwap(options, checkpoint, null, repositoryRoot);
    return { checkpoint, checkpointPath: filePath, changed: true };
  }

  async validate(identity: CheckpointIdentity, repositoryPath: string): Promise<ReconciliationResult> {
    try {
      const repositoryRoot = await findRepositoryRoot(repositoryPath);
      await this.assertStateRootsOutsideRepository(repositoryRoot);
      const checkpoint = await this.load(identity);
      const snapshot = await captureGitSnapshot(repositoryRoot);
      const reconciliation = reconcileCheckpoint(checkpoint.metadata, snapshot);
      const bundleHealth = await inspectContinuityBundle(this.bundlePathsFor(identity), checkpoint);
      return includeBundleHealth(reconciliation, bundleHealth);
    } catch (error) {
      if (
        error instanceof StoryStackError &&
        [
          "INVALID_CHECKPOINT",
          "UNSUPPORTED_SCHEMA",
          "CHECKPOINT_NOT_FOUND",
          "UNSAFE_STATE_FILE",
          "STATE_ROOT_INSIDE_REPOSITORY",
        ].includes(error.code)
      ) {
        return {
          status: "missing-required-information",
          reasons: [error.message],
          currentSnapshot: null,
          validationIsCurrent: false,
        };
      }
      throw error;
    }
  }

  async snapshot(
    identity: CheckpointIdentity,
    repositoryPath: string,
    options: { markValidated?: boolean } = {},
  ): Promise<MutationResult> {
    if (options.markValidated) {
      throw new StoryStackError(
        "Snapshot cannot mark validation; record a successful current test or validation through update",
        "VALIDATION_UPDATE_REQUIRED",
      );
    }
    const repositoryRoot = await findRepositoryRoot(repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const filePath = this.pathFor(identity);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpointForIdentity(originalSource, identity);
    const snapshot = await captureGitSnapshot(repositoryRoot);
    this.assertSameRepository(original.metadata, snapshot);
    if (original.metadata.current_branch !== snapshot.currentBranch) {
      throw new StoryStackError(
        `Refusing to refresh checkpoint from branch '${original.metadata.current_branch}' on '${snapshot.currentBranch}'`,
        "BRANCH_MISMATCH",
        3,
      );
    }
    const now = this.clock().toISOString();
    const candidate: Checkpoint = {
      metadata: metadataFromSnapshot(original.metadata, snapshot, now),
      body: original.body,
    };
    if (metadataEqualsExceptUpdatedAt(original.metadata, candidate.metadata)) {
      const repairedFiles = await this.repairBundle(identity, original, originalSource, repositoryRoot);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    if (original.metadata.ticket_status === "completed") {
      throw new StoryStackError(
        "Completed checkpoints are immutable; start a new story or use a future explicit reopen workflow",
        "COMPLETED_CHECKPOINT_IMMUTABLE",
      );
    }
    await this.writeWithCompareAndSwap(identity, candidate, originalSource, repositoryRoot);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async update(options: UpdateCheckpointOptions): Promise<MutationResult> {
    const repositoryRoot = await findRepositoryRoot(options.repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const filePath = this.pathFor(options);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpointForIdentity(originalSource, options);
    const snapshot = await captureGitSnapshot(repositoryRoot);
    this.assertSameRepository(original.metadata, snapshot);
    if (original.metadata.current_branch !== snapshot.currentBranch) {
      throw new StoryStackError("Refusing to update a checkpoint from a different branch", "BRANCH_MISMATCH", 3);
    }
    const body = options.section ? replaceSection(original.body, options.section, options.body) : validateMarkdownBody(options.body);
    if (original.metadata.ticket_status === "completed") {
      if (body === original.body && options.status === undefined && !options.allowApprovalChange) {
        const repairedFiles = await this.repairBundle(options, original, originalSource, repositoryRoot);
        return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
      }
      throw new StoryStackError(
        "Completed checkpoints are immutable; start a new story or use a future explicit reopen workflow",
        "COMPLETED_CHECKPOINT_IMMUTABLE",
      );
    }
    const changedPlanSection = planApprovalChanged(original.body, body);
    if (original.metadata.ticket_status !== "planning" && changedPlanSection !== null) {
      throw new StoryStackError(
        `Changing '${changedPlanSection}' after plan approval requires the dedicated approve-plan workflow`,
        "PLAN_REAPPROVAL_REQUIRED",
      );
    }
    const oldApprovals = extractSection(original.body, "Required user approvals");
    const newApprovals = extractSection(body, "Required user approvals");
    if (oldApprovals !== newApprovals && !options.allowApprovalChange) {
      throw new StoryStackError(
        "Changing Required user approvals needs --allow-approval-change after the coordinator verifies the gate",
        "APPROVAL_CHANGE_REFUSED",
      );
    }
    const now = this.clock().toISOString();
    if (options.status === "ready") {
      throw new StoryStackError("Use approvePlan to enter 'ready' status", "INVALID_STATUS_TRANSITION");
    }
    if (options.status === "completed") {
      throw new StoryStackError("Use complete to enter 'completed' status", "INVALID_STATUS_TRANSITION");
    }
    if (options.status !== undefined) assertStatusTransition(original.metadata.ticket_status, options.status);
    const validationChanged =
      extractSection(original.body, "Test and validation results") !== extractSection(body, "Test and validation results");
    const metadata = metadataFromSnapshot(original.metadata, snapshot, now, {
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(validationChanged || changedPlanSection !== null ? { clearValidation: true } : {}),
    });
    const candidate = { metadata, body };
    if (metadataEqualsExceptUpdatedAt(original.metadata, metadata) && original.body === body) {
      const repairedFiles = await this.repairBundle(options, original, originalSource, repositoryRoot);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    await this.writeWithCompareAndSwap(options, candidate, originalSource, repositoryRoot);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async recordValidation(options: RecordValidationOptions): Promise<MutationResult> {
    const repositoryRoot = await findRepositoryRoot(options.repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const filePath = this.pathFor(options);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpointForIdentity(originalSource, options);
    if (original.metadata.ticket_status === "completed") {
      throw new StoryStackError(
        "Completed checkpoints are immutable; validation cannot be replaced without an explicit reopen workflow",
        "COMPLETED_CHECKPOINT_IMMUTABLE",
      );
    }
    if (original.metadata.ticket_status === "planning") {
      throw new StoryStackError(
        "Planning checkpoints cannot record code validation; approve or explicitly block the plan first",
        "VALIDATION_DURING_PLANNING",
      );
    }
    if (options.confirmedSuccessful !== true) {
      throw new StoryStackError(
        "Recording validation requires an explicit confirmation that the external check succeeded",
        "VALIDATION_SUCCESS_NOT_CONFIRMED",
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(options.expectedWorktreeFingerprint)) {
      throw new StoryStackError(
        "Validation evidence requires the pre-check SHA-256 worktree fingerprint",
        "INVALID_VALIDATION_FINGERPRINT",
      );
    }

    const snapshot = await captureGitSnapshot(repositoryRoot);
    const reconciliation = reconcileCheckpoint(original.metadata, snapshot);
    if (reconciliation.status !== "current") {
      throw new StoryStackError(
        `Validation requires a current checkpoint (${reconciliation.status}): ${reconciliation.reasons.join(" ")}`,
        "VALIDATION_CHECKPOINT_STALE",
        reconciliation.status === "different-branch" ? 3 : 2,
      );
    }
    if (snapshot.worktreeFingerprint !== options.expectedWorktreeFingerprint) {
      throw new StoryStackError(
        "Repository state no longer matches the fingerprint observed before validation; run the check again",
        "VALIDATION_EVIDENCE_STALE",
        2,
      );
    }
    const body = replaceSection(original.body, "Test and validation results", options.summary);
    assertSuccessfulValidationSection(body);

    const now = this.clock().toISOString();
    const metadata = metadataFromSnapshot(original.metadata, snapshot, now, { recordValidation: true });
    const candidate = { metadata, body };
    await this.writeWithCompareAndSwap(
      options,
      candidate,
      originalSource,
      repositoryRoot,
      options.expectedWorktreeFingerprint,
    );
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async approvePlan(options: ApprovePlanOptions): Promise<MutationResult> {
    const repositoryRoot = await findRepositoryRoot(options.repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const filePath = this.pathFor(options);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpointForIdentity(originalSource, options);
    const snapshot = await captureGitSnapshot(repositoryRoot);
    const reconciliation = reconcileCheckpoint(original.metadata, snapshot);
    if (reconciliation.status !== "current") {
      const exitCode = reconciliation.status === "different-branch" ? 3 : reconciliation.status === "stale-but-reconcilable" ? 2 : 4;
      throw new StoryStackError(
        `Plan approval requires a current checkpoint (${reconciliation.status}): ${reconciliation.reasons.join(" ")}`,
        "PLAN_APPROVAL_STALE",
        exitCode,
      );
    }
    if (!["planning", "ready", "blocked"].includes(original.metadata.ticket_status)) {
      throw new StoryStackError(
        `Plan approval cannot replace work already in '${original.metadata.ticket_status}'`,
        "INVALID_STATUS_TRANSITION",
      );
    }

    const body = validateMarkdownBody(options.body);
    if (extractSection(original.body, "Required user approvals") !== extractSection(body, "Required user approvals")) {
      throw new StoryStackError(
        "Plan approval must preserve existing Required user approvals; change gates separately with explicit authorization",
        "APPROVAL_CHANGE_REFUSED",
      );
    }
    for (const section of ["Objective", "Acceptance criteria", "Approved plan", "Exact next action"] as const) {
      const value = extractSection(body, section);
      if (isPlaceholder(value) || (section === "Approved plan" && /\b(?:awaiting|pending)\s+approval\b/iu.test(value))) {
        throw new StoryStackError(`Plan approval requires a substantive '${section}' section`, "INCOMPLETE_PLAN");
      }
    }
    if (!isClear(extractSection(body, "Blockers and questions"))) {
      throw new StoryStackError("Resolve material blockers and questions before approving the plan", "PLAN_BLOCKERS_REMAIN");
    }

    assertStatusTransition(original.metadata.ticket_status, "ready");
    const now = this.clock().toISOString();
    const validationChanged =
      extractSection(original.body, "Test and validation results") !== extractSection(body, "Test and validation results");
    const planChanged = planApprovalChanged(original.body, body) !== null;
    const metadata = metadataFromSnapshot(original.metadata, snapshot, now, {
      status: "ready",
      ...(validationChanged || planChanged ? { clearValidation: true } : {}),
    });
    const candidate: Checkpoint = { metadata, body };
    if (metadataEqualsExceptUpdatedAt(original.metadata, metadata) && original.body === body) {
      const repairedFiles = await this.repairBundle(options, original, originalSource, repositoryRoot);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    await this.writeWithCompareAndSwap(options, candidate, originalSource, repositoryRoot);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async complete(identity: CheckpointIdentity, repositoryPath: string): Promise<MutationResult> {
    const repositoryRoot = await findRepositoryRoot(repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const filePath = this.pathFor(identity);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpointForIdentity(originalSource, identity);
    const snapshot = await captureGitSnapshot(repositoryRoot);
    const reconciliation = reconcileCheckpoint(original.metadata, snapshot);
    if (reconciliation.status !== "current") {
      throw new StoryStackError(`Checkpoint must be current before completion (${reconciliation.status})`, "STALE_CHECKPOINT", 2);
    }
    if (!reconciliation.validationIsCurrent) {
      throw new StoryStackError("Current worktree has no successful validation recorded", "STALE_VALIDATION", 2);
    }
    if (original.metadata.ticket_status !== "in-review" && original.metadata.ticket_status !== "completed") {
      throw new StoryStackError("Ticket must be in-review before completion", "INVALID_STATUS_TRANSITION");
    }
    if (isPlaceholder(extractSection(original.body, "Acceptance criteria"))) {
      throw new StoryStackError("Acceptance criteria must be recorded before completion", "INCOMPLETE_CHECKPOINT");
    }
    if (isPlaceholder(extractSection(original.body, "Approved plan"))) {
      throw new StoryStackError("An approved plan must be recorded before completion", "INCOMPLETE_CHECKPOINT");
    }
    assertSuccessfulValidationSection(original.body);
    if (!isClear(extractSection(original.body, "Blockers and questions"))) {
      throw new StoryStackError("Resolve recorded blockers and questions before completion", "BLOCKERS_REMAIN");
    }
    if (!isClear(extractSection(original.body, "Required user approvals"))) {
      throw new StoryStackError("Required user approval remains recorded", "APPROVAL_REQUIRED");
    }
    if (!isClear(extractSection(original.body, "Pending review feedback"))) {
      throw new StoryStackError("Pending review feedback remains recorded", "PENDING_REVIEW_FEEDBACK");
    }
    if (original.metadata.ticket_status === "completed") {
      const repairedFiles = await this.repairBundle(identity, original, originalSource, repositoryRoot);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    const now = this.clock().toISOString();
    const candidate: Checkpoint = {
      metadata: metadataFromSnapshot(original.metadata, snapshot, now, { status: "completed" }),
      body: original.body,
    };
    await this.writeWithCompareAndSwap(identity, candidate, originalSource, repositoryRoot);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async recovery(identity: CheckpointIdentity, repositoryPath: string): Promise<RecoverySummary> {
    const repositoryRoot = await findRepositoryRoot(repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const checkpoint = await this.load(identity);
    const snapshot = await captureGitSnapshot(repositoryRoot);
    const reconciliation = includeBundleHealth(
      reconcileCheckpoint(checkpoint.metadata, snapshot),
      await inspectContinuityBundle(this.bundlePathsFor(identity), checkpoint),
    );
    const validationSummary = extractSection(checkpoint.body, "Test and validation results");
    const validation = checkpoint.metadata.last_validation_at
      ? `${checkpoint.metadata.last_validation_at} (${reconciliation.validationIsCurrent ? "current" : "historical; repository state changed"}) - ${validationSummary}`
      : "None recorded.";
    const dirty = reconciliation.currentSnapshot?.dirty ? "dirty" : "clean";
    const objective = extractSection(checkpoint.body, "Objective");
    const completedWork = extractSection(checkpoint.body, "Completed work");
    const currentWork = extractSection(checkpoint.body, "Current work");
    const nextAction = extractSection(checkpoint.body, "Exact next action");
    const blockers = extractSection(checkpoint.body, "Blockers and questions");
    const unresolvedQuestions = combineRecoverySections([
      { label: "Blockers and questions", value: blockers },
      { label: "Pending review feedback", value: extractSection(checkpoint.body, "Pending review feedback") },
    ]);
    const failures = recordedFailures(validationSummary);
    return {
      workspace: checkpoint.metadata.project_slug,
      story: checkpoint.metadata.ticket_key,
      project: checkpoint.metadata.project_slug,
      ticket: checkpoint.metadata.ticket_key,
      objective,
      acceptanceCriteria: extractSection(checkpoint.body, "Acceptance criteria"),
      nonGoals: extractSection(checkpoint.body, "Non-goals"),
      relevantFiles: combineRecoverySections([
        { label: "Files inspected", value: extractSection(checkpoint.body, "Files inspected") },
        { label: "Files changed and why", value: extractSection(checkpoint.body, "Files changed and why") },
      ]),
      decisions: extractSection(checkpoint.body, "Decisions and rationale"),
      completedWork,
      currentWork,
      currentState: `${checkpoint.metadata.ticket_status}; checkpoint ${reconciliation.status}; worktree ${dirty}`,
      currentLocalDiffSummary: currentDiffSummary(snapshot),
      checks: validationSummary,
      failures,
      unresolvedQuestions,
      failuresAndUnresolvedQuestions: combineRecoverySections([
        { label: "Failures", value: failures },
        { label: "Unresolved questions", value: unresolvedQuestions },
      ]),
      exactRecommendedNextStep: nextAction,
      nextAction,
      blockers,
      requiredApproval: extractSection(checkpoint.body, "Required user approvals"),
      lastSuccessfulValidation: validation,
      reconciliation,
    };
  }

  async list(repositoryPath?: string): Promise<ListedCheckpoint[]> {
    let canonicalRepository: string | undefined;
    if (repositoryPath !== undefined) canonicalRepository = await findRepositoryRoot(repositoryPath);
    let workspaces;
    try {
      workspaces = await readdir(this.workspacesRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const results: ListedCheckpoint[] = [];
    for (const workspace of workspaces.filter((entry) => entry.isDirectory())) {
      const storiesPath = path.join(this.workspacesRoot, workspace.name, "stories");
      let stories;
      try {
        stories = await readdir(storiesPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const story of stories.filter((entry) => entry.isDirectory())) {
        const filePath = path.join(storiesPath, story.name, "context.md");
        try {
          await access(filePath, constants.R_OK);
          const source = await readFileOrNull(filePath);
          if (source === null) continue;
          const checkpoint = parseCheckpointForIdentity(source, {
            projectSlug: workspace.name,
            ticketKey: story.name,
          });
          if (
            canonicalRepository === undefined ||
            checkpoint.metadata.repository_id === repositoryIdentity(canonicalRepository)
          ) {
            results.push({ checkpointPath: filePath, metadata: checkpoint.metadata });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            results.push({ checkpointPath: filePath, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
    return results.sort((a, b) => a.checkpointPath.localeCompare(b.checkpointPath, "en"));
  }

  async listLegacy(repositoryPath?: string): Promise<ListedCheckpoint[]> {
    let canonicalRepository: string | undefined;
    if (repositoryPath !== undefined) canonicalRepository = await findRepositoryRoot(repositoryPath);
    let projects;
    try {
      projects = await readdir(this.stateRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const results: ListedCheckpoint[] = [];
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      const projectPath = path.join(this.stateRoot, project.name);
      let tickets;
      try {
        tickets = await readdir(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ticket of tickets.filter((entry) => entry.isDirectory())) {
        const filePath = path.join(projectPath, ticket.name, "context.md");
        try {
          const source = await readFileOrNull(filePath);
          if (source === null) continue;
          const checkpoint = parseCheckpointForIdentity(
            source,
            { projectSlug: project.name, ticketKey: ticket.name },
            "Legacy checkpoint",
          );
          if (
            canonicalRepository === undefined ||
            checkpoint.metadata.repository_id === repositoryIdentity(canonicalRepository)
          ) {
            results.push({ checkpointPath: filePath, metadata: checkpoint.metadata });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            results.push({ checkpointPath: filePath, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
    return results.sort((a, b) => a.checkpointPath.localeCompare(b.checkpointPath, "en"));
  }

  async resolveIdentity(
    projectInput: string | undefined,
    ticketInput: string | undefined,
    repositoryPath: string,
  ): Promise<CheckpointIdentity> {
    if ((projectInput === undefined) !== (ticketInput === undefined)) {
      throw new StoryStackError("Provide both --project and --ticket, or neither", "INCOMPLETE_IDENTITY");
    }
    if (projectInput !== undefined && ticketInput !== undefined) return this.normalizeIdentity(projectInput, ticketInput);
    const root = (await captureGitSnapshot(repositoryPath)).repositoryRoot;
    const matches = (await this.list(root)).filter((item) => item.metadata !== undefined);
    if (matches.length === 0) {
      const invalid = (await this.list()).filter((item) => item.error !== undefined);
      const suffix = invalid.length > 0 ? `; ${invalid.length} invalid checkpoint(s) also require repair` : "";
      throw new StoryStackError(`No checkpoint matches the active repository${suffix}`, "CHECKPOINT_NOT_FOUND", 4);
    }
    if (matches.length > 1) {
      const candidates = matches.map((item) => `${item.metadata?.project_slug}/${item.metadata?.ticket_key}`).join(", ");
      throw new StoryStackError(`Active ticket is ambiguous; specify --project and --ticket. Candidates: ${candidates}`, "AMBIGUOUS_TICKET", 4);
    }
    const metadata = matches[0]?.metadata;
    if (!metadata) throw new StoryStackError("Matching checkpoint is invalid", "INVALID_CHECKPOINT", 4);
    return { projectSlug: metadata.project_slug, ticketKey: metadata.ticket_key };
  }

  private assertSameRepository(metadata: CheckpointMetadata, repository: GitSnapshot | string): void {
    const repositoryRoot = typeof repository === "string" ? repository : repository.repositoryRoot;
    if (metadata.repository_id !== repositoryIdentity(repositoryRoot)) {
      throw new StoryStackError("Active repository does not match checkpoint repository", "REPOSITORY_MISMATCH", 4);
    }
  }

  private async assertRoutingRepository(
    identity: CheckpointIdentity,
    repositoryPath: string,
  ): Promise<{ checkpoint: Checkpoint; repositoryRoot: string }> {
    const repositoryRoot = await findRepositoryRoot(repositoryPath);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const checkpoint = await this.load(identity);
    const snapshot = await captureGitSnapshot(repositoryRoot);
    this.assertSameRepository(checkpoint.metadata, snapshot);
    if (checkpoint.metadata.current_branch !== snapshot.currentBranch) {
      throw new StoryStackError("Refusing to change routing from a different branch", "BRANCH_MISMATCH", 3);
    }
    return { checkpoint, repositoryRoot };
  }

  private async mutateRouting<T extends { routing: RoutingRecord; changed: boolean }>(
    identity: CheckpointIdentity,
    repositoryRoot: string,
    mutate: (routing: RoutingRecord) => T,
    createIfMissing = false,
  ): Promise<T> {
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const paths = this.bundlePathsFor(identity);
    await assertSafeWritePath(this.workspacesRoot, paths.routing);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await assertSafeWritePath(this.workspacesRoot, paths.lock);
    let lockLeasePath: string | null = null;
    try {
      lockLeasePath = await acquireCheckpointLock(paths.lock);
      await this.assertStateRootsOutsideRepository(repositoryRoot);
      const source = await readRegularFileOrNull(paths.routing);
      if (source === null && !createIfMissing) {
        throw new StoryStackError(
          "Routing is not initialized for this story; run state upgrade-routing first",
          "ROUTING_UPGRADE_REQUIRED",
          4,
        );
      }
      const current = source === null ? emptyRoutingRecord() : parseRoutingRecord(source);
      const result = mutate(current);
      if (result.changed || source === null) {
        await writeFileAtomic(paths.routing, serializeRoutingRecord(result.routing));
      }
      return { ...result, changed: result.changed || source === null };
    } finally {
      if (lockLeasePath !== null) await rm(lockLeasePath, { force: true }).catch(() => undefined);
    }
  }

  private async assertStateRootsOutsideRepository(repositoryRoot: string, includeLegacy = false): Promise<void> {
    await assertStateRootOutsideRepository(this.workspacesRoot, repositoryRoot);
    if (includeLegacy) await assertStateRootOutsideRepository(this.stateRoot, repositoryRoot);
  }

  private async repairBundle(
    identity: CheckpointIdentity,
    checkpoint: Checkpoint,
    expectedSource: string,
    repositoryRoot: string,
  ): Promise<string[]> {
    assertCheckpointIdentity(identity, checkpoint);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const health = await inspectContinuityBundle(
      this.bundlePathsFor(identity),
      checkpoint,
    );
    if (health.status === "current") return [];
    if (health.status === "missing-required-information") {
      throw new StoryStackError(health.reasons.join(" "), "UNSAFE_STATE_FILE", 4);
    }
    return this.writeWithCompareAndSwap(identity, checkpoint, expectedSource, repositoryRoot);
  }

  private async writeWithCompareAndSwap(
    identity: CheckpointIdentity,
    checkpoint: Checkpoint,
    expectedSource: string | null,
    repositoryRoot: string,
    expectedRepositoryFingerprint?: string,
  ): Promise<string[]> {
    assertCheckpointIdentity(identity, checkpoint, "Checkpoint bundle");
    this.assertSameRepository(checkpoint.metadata, repositoryRoot);
    await this.assertStateRootsOutsideRepository(repositoryRoot);
    const paths = this.bundlePathsFor(identity);
    await assertSafeWritePath(this.workspacesRoot, paths.context);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await assertSafeWritePath(this.workspacesRoot, paths.context);
    await assertSafeWritePath(this.workspacesRoot, paths.lock);
    const expectedDigest = expectedSource === null ? null : digest(expectedSource);
    let lockLeasePath: string | null = null;
    try {
      lockLeasePath = await acquireCheckpointLock(paths.lock);
      await this.assertStateRootsOutsideRepository(repositoryRoot);
      if (expectedRepositoryFingerprint !== undefined) {
        const currentSnapshot = await captureGitSnapshot(repositoryRoot);
        if (currentSnapshot.worktreeFingerprint !== expectedRepositoryFingerprint) {
          throw new StoryStackError(
            "Repository state changed before validation evidence could be recorded; run the check again",
            "VALIDATION_EVIDENCE_STALE",
            2,
          );
        }
      }
      const verifyUnchanged = async () => {
        await assertSafeWritePath(this.workspacesRoot, paths.context);
        const currentSource = await readFileOrNull(paths.context);
        const currentDigest = currentSource === null ? null : digest(currentSource);
        if (currentDigest !== expectedDigest) {
          throw new StoryStackError(
            "Checkpoint changed during the update; reload it before retrying",
            "CHECKPOINT_CONFLICT",
          );
        }
      };
      await verifyUnchanged();
      const rendered = renderContinuityBundle(checkpoint);
      if (expectedSource === null) {
        await publishInitialContinuityBundle(this.workspacesRoot, paths, rendered);
        return [...Object.keys(rendered.files)];
      }
      const changedFiles: string[] = [];
      for (const fileName of ["decisions.md", "progress.md", "checks.md", "handoff.md"] as const) {
        if (await writeBundleFileIfDifferent(this.workspacesRoot, paths, rendered, fileName)) changedFiles.push(fileName);
      }
      if (
        await writeBundleFileIfDifferent(
          this.workspacesRoot,
          paths,
          rendered,
          "context.md",
          verifyUnchanged,
        )
      ) {
        changedFiles.push("context.md");
      }
      const committedSource = rendered.files["context.md"];
      const verifyCommitted = async () => {
        const currentSource = await readFileOrNull(paths.context);
        if (currentSource !== committedSource) {
          throw new StoryStackError(
            "Canonical checkpoint changed before the bundle commit marker was written",
            "CHECKPOINT_CONFLICT",
          );
        }
      };
      if (
        await writeBundleFileIfDifferent(
          this.workspacesRoot,
          paths,
          rendered,
          "state.json",
          verifyCommitted,
        )
      ) {
        changedFiles.push("state.json");
      }
      return changedFiles;
    } finally {
      if (lockLeasePath !== null) await rm(lockLeasePath, { force: true }).catch(() => undefined);
    }
  }
}

function normalizeRoutingTaskScopes(task: RoutingTask, repositoryRoot: string): RoutingTask {
  return validateRoutingTask({
    ...task,
    read_scopes: task.read_scopes.map((scope) => normalizeScope(repositoryRoot, scope)),
    write_scopes: task.write_scopes.map((scope) => normalizeScope(repositoryRoot, scope)),
  });
}

export function assertTicketStatus(value: string): asserts value is TicketStatus {
  if (!TICKET_STATUSES.includes(value as TicketStatus)) {
    throw new StoryStackError(`Status must be one of: ${TICKET_STATUSES.join(", ")}`, "INVALID_STATUS");
  }
}
