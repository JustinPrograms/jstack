import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { assertSafeWritePath, readRegularFileOrNull } from "./filesystem.js";
import { writeFileAtomic } from "./atomic.js";
import { metadataEqualsExceptUpdatedAt, parseCheckpoint, serializeCheckpoint } from "./frontmatter.js";
import { captureGitSnapshot, detectBaseBranch, findRepositoryRoot, validateBaseBranch } from "./git.js";
import {
  checkpointBundlePaths,
  checkpointPath,
  legacyCheckpointPath,
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
  justinStackHome?: string;
  /** @deprecated Use justinStackHome. */
  storyStackHome?: string;
  workspacesRoot?: string;
  /** Legacy single-checkpoint root retained for explicit migration helpers. */
  stateRoot?: string;
  /** Legacy root when it is independent from the new JustinStack home. */
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
  markValidated?: boolean;
  allowApprovalChange?: boolean;
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
  routing: string;
  reconciliation: ReconciliationResult;
}

export function defaultJustinStackHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = [environment.JUSTINSTACK_HOME, environment.JUSTIN_STACK_HOME, environment.STORY_STACK_HOME]
    .find((candidate) => candidate !== undefined && candidate.length > 0);
  const candidate = override && override.length > 0 ? override : path.join(os.homedir(), ".justin-stack");
  if (candidate.includes("\0")) throw new StoryStackError("JustinStack home contains an invalid NUL byte", "INVALID_STORY_HOME");
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new StoryStackError("Story-stack home cannot be a filesystem root", "INVALID_STORY_HOME");
  }
  return resolved;
}

/** @deprecated Use defaultJustinStackHome. */
export const defaultStoryStackHome = defaultJustinStackHome;

export function defaultLegacyStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const explicitLegacy = environment.STORY_STACK_HOME;
  if (explicitLegacy && explicitLegacy.length > 0) return path.join(path.resolve(explicitLegacy), "state");
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
  options: { status?: TicketStatus; markValidated?: boolean } = {},
): CheckpointMetadata {
  return {
    ...existing,
    repository_path: snapshot.repositoryRoot,
    current_branch: snapshot.currentBranch,
    head_commit: snapshot.headCommit,
    worktree_fingerprint: snapshot.worktreeFingerprint,
    ticket_status: options.status ?? existing.ticket_status,
    git_dirty: snapshot.dirty,
    changed_file_summary: [...snapshot.changedFiles],
    changed_file_count: snapshot.changedFileCount,
    untracked_files: [...snapshot.untrackedFiles],
    untracked_file_count: snapshot.untrackedFileCount,
    last_validation_at: options.markValidated ? now : existing.last_validation_at,
    last_validation_fingerprint: options.markValidated
      ? snapshot.worktreeFingerprint
      : existing.last_validation_fingerprint,
    updated_at: now,
  };
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
  const lines = [
    `Changed-file count: ${snapshot.changedFileCount}.`,
    `Untracked-file count: ${snapshot.untrackedFileCount}.`,
  ];
  if (snapshot.changedFiles.length > 0) {
    lines.push("Changed files:", ...snapshot.changedFiles.map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
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
  if (
    value.length === 0 ||
    /^(?:not run|not recorded|none|skipped|failed|failing|interrupted|partial)(?:[.:;\s]|$)/u.test(value)
  ) {
    throw new StoryStackError(
      "A successful current test or validation summary is required before marking validation",
      "VALIDATION_SUMMARY_REQUIRED",
    );
  }
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

function processIsDefinitelyGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function acquireCheckpointLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
          "utf8",
        );
        await handle.sync();
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt > 0) break;
      try {
        const lockSource = await readFileOrNull(lockPath);
        if (lockSource === null) continue;
        const lock = JSON.parse(lockSource) as { pid?: unknown; created_at?: unknown };
        const age = typeof lock.created_at === "string" ? Date.now() - Date.parse(lock.created_at) : 0;
        if (
          typeof lock.pid === "number" &&
          Number.isFinite(age) &&
          age >= STALE_LOCK_AGE_MS &&
          processIsDefinitelyGone(lock.pid)
        ) {
          await rm(lockPath);
          continue;
        }
      } catch {
        // A malformed or unreadable lock is preserved for manual inspection.
      }
      break;
    }
  }
  throw new StoryStackError(
    `Checkpoint lock is active or cannot be proven stale: ${lockPath}`,
    "CHECKPOINT_LOCKED",
  );
}

function assertStatusTransition(from: TicketStatus, to: TicketStatus): void {
  if (!STATUS_TRANSITIONS[from].includes(to)) {
    throw new StoryStackError(`Ticket status cannot move from '${from}' to '${to}'`, "INVALID_STATUS_TRANSITION");
  }
}

export class CheckpointStore {
  readonly justinStackHome: string;
  /** @deprecated Use justinStackHome. */
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
    this.justinStackHome = path.resolve(
      options.justinStackHome ?? options.storyStackHome ?? inferredHome ?? defaultJustinStackHome(),
    );
    this.storyStackHome = this.justinStackHome;
    this.stateRoot = path.resolve(
      options.legacyStateRoot ??
      options.stateRoot ??
      // `storyStackHome` is the deprecated Phase 1 home override, so retain
      // its old `state/` location. A new JustinStack/workspace override alone
      // must not redirect legacy discovery away from ~/.story-stack/state.
      (options.storyStackHome === undefined
        ? defaultLegacyStateRoot()
        : path.join(path.resolve(options.storyStackHome), "state")),
    );
    this.workspacesRoot = path.resolve(options.workspacesRoot ?? path.join(this.storyStackHome, "workspaces"));
    if (
      this.storyStackHome === path.parse(this.storyStackHome).root ||
      this.stateRoot === path.parse(this.stateRoot).root ||
      this.workspacesRoot === path.parse(this.workspacesRoot).root
    ) {
      throw new StoryStackError("Checkpoint state root cannot be a filesystem root", "INVALID_STORY_HOME");
    }
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
    return parseCheckpoint(source);
  }

  async loadLegacy(identity: CheckpointIdentity): Promise<Checkpoint> {
    const filePath = this.legacyPathFor(identity);
    const source = await readFileOrNull(filePath);
    if (source === null) throw new StoryStackError(`Legacy checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const checkpoint = parseCheckpoint(source);
    if (
      checkpoint.metadata.project_slug !== identity.projectSlug ||
      checkpoint.metadata.ticket_key !== identity.ticketKey
    ) {
      throw new StoryStackError("Legacy checkpoint identity does not match its state directory", "INVALID_CHECKPOINT", 4);
    }
    return checkpoint;
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
    const checkpoint = await this.load(identity);
    const snapshot = await captureGitSnapshot(repositoryPath);
    this.assertSameRepository(checkpoint.metadata, snapshot);
    if (checkpoint.metadata.current_branch !== snapshot.currentBranch) {
      throw new StoryStackError("Refusing to initialize routing from a different branch", "BRANCH_MISMATCH", 3);
    }
    return this.mutateRouting(identity, (routing) => ({ routing, changed: false }), true);
  }

  async declareRoutingTask(
    identity: CheckpointIdentity,
    repositoryPath: string,
    task: RoutingTask,
  ): Promise<{ changed: boolean; routing: RoutingRecord; task: RoutingTask }> {
    const checkpoint = await this.assertRoutingRepository(identity, repositoryPath);
    const normalized = normalizeRoutingTaskScopes(task, checkpoint.metadata.repository_path);
    return this.mutateRouting(identity, (routing) => {
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
    await this.assertRoutingRepository(identity, repositoryPath);
    return this.mutateRouting(identity, (routing) => {
      const index = routing.tasks.findIndex((item) => item.id === taskId);
      if (index < 0) throw new StoryStackError(`Routing task '${taskId}' was not found`, "ROUTING_NOT_FOUND", 4);
      const current = routing.tasks[index];
      if (current === undefined || current.status === "completed" || current.status === "abandoned") {
        throw new StoryStackError("Cannot record an attempt for a terminal routing task", "INVALID_ROUTING_TRANSITION", 4);
      }
      const validatedEvidence = validateRoutingRecord({ schema_version: 1, tasks: [{ ...current, evidence: [...current.evidence, evidence] }] }).tasks[0]?.evidence.at(-1);
      if (validatedEvidence === undefined) throw new StoryStackError("Routing evidence could not be validated", "INVALID_ROUTING");
      const duplicate = current.evidence.find((item) => item.attempt_id === validatedEvidence.attempt_id);
      if (duplicate !== undefined) {
        if (JSON.stringify(duplicate) !== JSON.stringify(validatedEvidence)) throw new StoryStackError("Routing attempt ID already exists with different evidence", "ROUTING_CONFLICT", 4);
        return { routing, changed: false, task: current };
      }
      const task = validateRoutingTask({ ...current, evidence: [...current.evidence, validatedEvidence], updated_at: this.clock().toISOString() });
      const tasks = [...routing.tasks];
      tasks[index] = task;
      return { routing: validateRoutingRecord({ ...routing, tasks }), changed: true, task };
    });
  }

  async transitionRoutingTask(
    identity: CheckpointIdentity,
    repositoryPath: string,
    taskId: string,
    status: Extract<RoutingTask["status"], "completed" | "abandoned" | "unknown-after-resume">,
  ): Promise<{ changed: boolean; routing: RoutingRecord; task: RoutingTask }> {
    await this.assertRoutingRepository(identity, repositoryPath);
    return this.mutateRouting(identity, (routing) => {
      const index = routing.tasks.findIndex((item) => item.id === taskId);
      if (index < 0) throw new StoryStackError(`Routing task '${taskId}' was not found`, "ROUTING_NOT_FOUND", 4);
      const current = routing.tasks[index];
      if (current === undefined) throw new StoryStackError("Routing task was not found", "ROUTING_NOT_FOUND", 4);
      if (current.status === status) return { routing, changed: false, task: current };
      if (current.status === "completed" || current.status === "abandoned") throw new StoryStackError("Cannot change a terminal routing task", "INVALID_ROUTING_TRANSITION", 4);
      const task = validateRoutingTask({ ...current, status, updated_at: this.clock().toISOString() });
      const tasks = [...routing.tasks];
      tasks[index] = task;
      return { routing: validateRoutingRecord({ ...routing, tasks }), changed: true, task };
    });
  }

  async reconcileRoutingResume(identity: CheckpointIdentity, repositoryPath: string): Promise<{ changed: boolean; routing: RoutingRecord }> {
    await this.assertRoutingRepository(identity, repositoryPath);
    return this.mutateRouting(identity, (routing) => {
      const now = this.clock().toISOString();
      const tasks = routing.tasks.map((task) => task.status === "declared" ? validateRoutingTask({ ...task, status: "unknown-after-resume", updated_at: now }) : task);
      const changed = tasks.some((task, index) => task !== routing.tasks[index]);
      return { routing: changed ? validateRoutingRecord({ ...routing, tasks }) : routing, changed };
    });
  }

  /** Copy a validated legacy checkpoint into the bundle layout without removing the source. */
  async migrateLegacy(identity: CheckpointIdentity): Promise<MutationResult> {
    const legacy = await this.loadLegacy(identity);
    const targetPath = this.pathFor(identity);
    const targetSource = await readFileOrNull(targetPath);
    if (targetSource !== null) {
      const current = parseCheckpoint(targetSource);
      if (serializeCheckpoint(current) !== serializeCheckpoint(legacy)) {
        throw new StoryStackError(
          "Legacy and continuity checkpoints differ; refusing to choose one automatically",
          "CHECKPOINT_CONFLICT",
          4,
        );
      }
      const repairedFiles = await this.repairBundle(current, targetSource);
      return { checkpoint: current, checkpointPath: targetPath, changed: false, repairedFiles };
    }
    await this.writeWithCompareAndSwap(identity, legacy, null);
    return { checkpoint: legacy, checkpointPath: targetPath, changed: true };
  }

  async create(options: CreateCheckpointOptions): Promise<MutationResult> {
    const filePath = this.pathFor(options);
    await assertSafeWritePath(this.workspacesRoot, filePath);
    const existingSource = await readFileOrNull(filePath);
    if (existingSource !== null) {
      const existing = parseCheckpoint(existingSource);
      const current = await captureGitSnapshot(options.repositoryPath);
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
      const repairedFiles = await this.repairBundle(existing, existingSource);
      return { checkpoint: existing, checkpointPath: filePath, changed: false, repairedFiles };
    }
    const snapshot = await captureGitSnapshot(options.repositoryPath);
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
        repository_path: snapshot.repositoryRoot,
        current_branch: snapshot.currentBranch,
        base_branch: baseBranch,
        head_commit: snapshot.headCommit,
        worktree_fingerprint: snapshot.worktreeFingerprint,
        ticket_status: "planning",
        created_at: now,
        updated_at: now,
        git_dirty: snapshot.dirty,
        changed_file_summary: snapshot.changedFiles,
        changed_file_count: snapshot.changedFileCount,
        untracked_files: snapshot.untrackedFiles,
        untracked_file_count: snapshot.untrackedFileCount,
        last_validation_at: null,
        last_validation_fingerprint: null,
      },
      body,
    };
    await this.writeWithCompareAndSwap(options, checkpoint, null);
    return { checkpoint, checkpointPath: filePath, changed: true };
  }

  async validate(identity: CheckpointIdentity, repositoryPath: string): Promise<ReconciliationResult> {
    let checkpoint: Checkpoint;
    try {
      checkpoint = await this.load(identity);
    } catch (error) {
      if (
        error instanceof StoryStackError &&
        ["INVALID_CHECKPOINT", "UNSUPPORTED_SCHEMA", "CHECKPOINT_NOT_FOUND", "UNSAFE_STATE_FILE"].includes(error.code)
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
    const snapshot = await captureGitSnapshot(repositoryPath);
    const reconciliation = reconcileCheckpoint(checkpoint.metadata, snapshot);
    const bundleHealth = await this.bundleHealth(identity);
    return includeBundleHealth(reconciliation, bundleHealth);
  }

  async snapshot(
    identity: CheckpointIdentity,
    repositoryPath: string,
    options: { markValidated?: boolean } = {},
  ): Promise<MutationResult> {
    const filePath = this.pathFor(identity);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpoint(originalSource);
    const snapshot = await captureGitSnapshot(repositoryPath);
    this.assertSameRepository(original.metadata, snapshot);
    if (original.metadata.current_branch !== snapshot.currentBranch) {
      throw new StoryStackError(
        `Refusing to refresh checkpoint from branch '${original.metadata.current_branch}' on '${snapshot.currentBranch}'`,
        "BRANCH_MISMATCH",
        3,
      );
    }
    const now = this.clock().toISOString();
    if (options.markValidated) assertSuccessfulValidationSection(original.body);
    const candidate: Checkpoint = {
      metadata: metadataFromSnapshot(original.metadata, snapshot, now, options),
      body: original.body,
    };
    if (metadataEqualsExceptUpdatedAt(original.metadata, candidate.metadata)) {
      const repairedFiles = await this.repairBundle(original, originalSource);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    await this.writeWithCompareAndSwap(identity, candidate, originalSource);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async update(options: UpdateCheckpointOptions): Promise<MutationResult> {
    const filePath = this.pathFor(options);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpoint(originalSource);
    const snapshot = await captureGitSnapshot(options.repositoryPath);
    this.assertSameRepository(original.metadata, snapshot);
    if (original.metadata.current_branch !== snapshot.currentBranch) {
      throw new StoryStackError("Refusing to update a checkpoint from a different branch", "BRANCH_MISMATCH", 3);
    }
    const body = options.section ? replaceSection(original.body, options.section, options.body) : validateMarkdownBody(options.body);
    const oldApprovals = extractSection(original.body, "Required user approvals");
    const newApprovals = extractSection(body, "Required user approvals");
    if (oldApprovals !== newApprovals && !options.allowApprovalChange) {
      throw new StoryStackError(
        "Changing Required user approvals needs --allow-approval-change after the coordinator verifies the gate",
        "APPROVAL_CHANGE_REFUSED",
      );
    }
    const now = this.clock().toISOString();
    if (options.status !== undefined) assertStatusTransition(original.metadata.ticket_status, options.status);
    if (options.markValidated) assertSuccessfulValidationSection(body);
    const metadata = metadataFromSnapshot(original.metadata, snapshot, now, {
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.markValidated === undefined ? {} : { markValidated: options.markValidated }),
    });
    const candidate = { metadata, body };
    if (metadataEqualsExceptUpdatedAt(original.metadata, metadata) && original.body === body) {
      const repairedFiles = await this.repairBundle(original, originalSource);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    await this.writeWithCompareAndSwap(options, candidate, originalSource);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async approvePlan(options: ApprovePlanOptions): Promise<MutationResult> {
    const filePath = this.pathFor(options);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpoint(originalSource);
    const snapshot = await captureGitSnapshot(options.repositoryPath);
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
    const metadata = metadataFromSnapshot(original.metadata, snapshot, now, { status: "ready" });
    const candidate: Checkpoint = { metadata, body };
    if (metadataEqualsExceptUpdatedAt(original.metadata, metadata) && original.body === body) {
      const repairedFiles = await this.repairBundle(original, originalSource);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    await this.writeWithCompareAndSwap(options, candidate, originalSource);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async complete(identity: CheckpointIdentity, repositoryPath: string): Promise<MutationResult> {
    const filePath = this.pathFor(identity);
    const originalSource = await readFileOrNull(filePath);
    if (originalSource === null) throw new StoryStackError(`Checkpoint not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", 4);
    const original = parseCheckpoint(originalSource);
    const snapshot = await captureGitSnapshot(repositoryPath);
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
      const repairedFiles = await this.repairBundle(original, originalSource);
      return { checkpoint: original, checkpointPath: filePath, changed: false, repairedFiles };
    }
    const now = this.clock().toISOString();
    const candidate: Checkpoint = {
      metadata: metadataFromSnapshot(original.metadata, snapshot, now, { status: "completed" }),
      body: original.body,
    };
    await this.writeWithCompareAndSwap(identity, candidate, originalSource);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async recovery(identity: CheckpointIdentity, repositoryPath: string): Promise<RecoverySummary> {
    const checkpoint = await this.load(identity);
    const routing = await this.loadRouting(identity);
    const snapshot = await captureGitSnapshot(repositoryPath);
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
      routing: routing === null
        ? "Not recorded. Run state upgrade-routing before declaring advisory routing tasks."
        : routing.tasks.length === 0
          ? "No routing tasks recorded."
          : routing.tasks.map((task) => `${task.id}: ${task.status}; ${task.work_class}; ${task.result}`).join("\n"),
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
          const checkpoint = parseCheckpoint(source);
          if (checkpoint.metadata.project_slug !== workspace.name || checkpoint.metadata.ticket_key !== story.name) {
            throw new StoryStackError("Checkpoint identity does not match its state directory", "INVALID_CHECKPOINT");
          }
          if (
            canonicalRepository === undefined ||
            comparablePath(checkpoint.metadata.repository_path) === comparablePath(canonicalRepository)
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
          const checkpoint = parseCheckpoint(source);
          if (checkpoint.metadata.project_slug !== project.name || checkpoint.metadata.ticket_key !== ticket.name) {
            throw new StoryStackError("Legacy checkpoint identity does not match its state directory", "INVALID_CHECKPOINT");
          }
          if (
            canonicalRepository === undefined ||
            comparablePath(checkpoint.metadata.repository_path) === comparablePath(canonicalRepository)
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

  private assertSameRepository(metadata: CheckpointMetadata, snapshot: GitSnapshot): void {
    if (comparablePath(metadata.repository_path) !== comparablePath(snapshot.repositoryRoot)) {
      throw new StoryStackError("Active repository does not match checkpoint repository", "REPOSITORY_MISMATCH", 4);
    }
  }

  private async assertRoutingRepository(identity: CheckpointIdentity, repositoryPath: string): Promise<Checkpoint> {
    const checkpoint = await this.load(identity);
    const snapshot = await captureGitSnapshot(repositoryPath);
    this.assertSameRepository(checkpoint.metadata, snapshot);
    if (checkpoint.metadata.current_branch !== snapshot.currentBranch) {
      throw new StoryStackError("Refusing to change routing from a different branch", "BRANCH_MISMATCH", 3);
    }
    return checkpoint;
  }

  private async mutateRouting<T extends { routing: RoutingRecord; changed: boolean }>(
    identity: CheckpointIdentity,
    mutate: (routing: RoutingRecord) => T,
    createIfMissing = false,
  ): Promise<T> {
    const paths = this.bundlePathsFor(identity);
    await assertSafeWritePath(this.workspacesRoot, paths.routing);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await assertSafeWritePath(this.workspacesRoot, paths.lock);
    let lockHandle;
    let ownsLock = false;
    try {
      lockHandle = await acquireCheckpointLock(paths.lock);
      ownsLock = true;
      await lockHandle.close();
      lockHandle = undefined;
      const source = await readRegularFileOrNull(paths.routing);
      if (source === null && !createIfMissing) {
        throw new StoryStackError("Routing is not initialized for this story; run state upgrade-routing first", "ROUTING_UPGRADE_REQUIRED", 4);
      }
      const current = source === null ? emptyRoutingRecord() : parseRoutingRecord(source);
      const result = mutate(current);
      if (result.changed || source === null) await writeFileAtomic(paths.routing, serializeRoutingRecord(result.routing));
      return { ...result, changed: result.changed || source === null };
    } finally {
      if (lockHandle !== undefined) await lockHandle.close().catch(() => undefined);
      if (ownsLock) await rm(paths.lock, { force: true }).catch(() => undefined);
    }
  }

  private async repairBundle(checkpoint: Checkpoint, expectedSource: string): Promise<string[]> {
    const health = await inspectContinuityBundle(
      this.bundlePathsFor({
        projectSlug: checkpoint.metadata.project_slug,
        ticketKey: checkpoint.metadata.ticket_key,
      }),
      checkpoint,
    );
    if (health.status === "current") return [];
    if (health.status === "missing-required-information") {
      throw new StoryStackError(health.reasons.join(" "), "UNSAFE_STATE_FILE", 4);
    }
    return this.writeWithCompareAndSwap(
      { projectSlug: checkpoint.metadata.project_slug, ticketKey: checkpoint.metadata.ticket_key },
      checkpoint,
      expectedSource,
    );
  }

  private async writeWithCompareAndSwap(
    identity: CheckpointIdentity,
    checkpoint: Checkpoint,
    expectedSource: string | null,
  ): Promise<string[]> {
    if (
      checkpoint.metadata.project_slug !== identity.projectSlug ||
      checkpoint.metadata.ticket_key !== identity.ticketKey
    ) {
      throw new StoryStackError("Checkpoint identity does not match its continuity bundle", "INVALID_CHECKPOINT");
    }
    const paths = this.bundlePathsFor(identity);
    await assertSafeWritePath(this.workspacesRoot, paths.context);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await assertSafeWritePath(this.workspacesRoot, paths.context);
    await assertSafeWritePath(this.workspacesRoot, paths.lock);
    const expectedDigest = expectedSource === null ? null : digest(expectedSource);
    let lockHandle;
    let ownsLock = false;
    try {
      lockHandle = await acquireCheckpointLock(paths.lock);
      ownsLock = true;
      await lockHandle.close();
      lockHandle = undefined;
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
      if (lockHandle !== undefined) await lockHandle.close().catch(() => undefined);
      if (ownsLock) await rm(paths.lock, { force: true }).catch(() => undefined);
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
