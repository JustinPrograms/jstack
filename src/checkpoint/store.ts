import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StoryStackError } from "../errors.js";
import { writeFileAtomic } from "./atomic.js";
import { assertSafeWritePath } from "./filesystem.js";
import { metadataEqualsExceptUpdatedAt, parseCheckpoint, serializeCheckpoint } from "./frontmatter.js";
import { captureGitSnapshot, detectBaseBranch, findRepositoryRoot, validateBaseBranch } from "./git.js";
import { checkpointPath, sanitizeProjectSlug, sanitizeTicketKey } from "./identifiers.js";
import { reconcileCheckpoint } from "./reconcile.js";
import { extractSection, REQUIRED_SECTIONS, validateMarkdownBody } from "./schema.js";
import { loadCheckpointTemplate, replaceSection } from "./template.js";
import {
  SCHEMA_VERSION,
  TICKET_STATUSES,
  type Checkpoint,
  type CheckpointMetadata,
  type GitSnapshot,
  type ReconciliationResult,
  type TicketStatus,
} from "./types.js";

export interface StoreOptions {
  stateRoot?: string;
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
  project: string;
  ticket: string;
  objective: string;
  completedWork: string;
  currentState: string;
  nextAction: string;
  blockers: string;
  requiredApproval: string;
  lastSuccessfulValidation: string;
  reconciliation: ReconciliationResult;
}

export function defaultStoryStackHome(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.STORY_STACK_HOME;
  const candidate = override && override.length > 0 ? override : path.join(os.homedir(), ".story-stack");
  if (candidate.includes("\0")) throw new StoryStackError("Story-stack home contains an invalid NUL byte", "INVALID_STORY_HOME");
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new StoryStackError("Story-stack home cannot be a filesystem root", "INVALID_STORY_HOME");
  }
  return resolved;
}

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new StoryStackError(`State path must be a regular file, not a link or directory: ${filePath}`, "UNSAFE_STATE_FILE");
    }
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

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
  readonly storyStackHome: string;
  readonly stateRoot: string;
  readonly packageRoot: string | undefined;
  readonly clock: () => Date;

  constructor(options: StoreOptions = {}) {
    this.stateRoot = path.resolve(options.stateRoot ?? path.join(defaultStoryStackHome(), "state"));
    if (this.stateRoot === path.parse(this.stateRoot).root) {
      throw new StoryStackError("Checkpoint state root cannot be a filesystem root", "INVALID_STORY_HOME");
    }
    this.storyStackHome = path.dirname(this.stateRoot);
    this.packageRoot = options.packageRoot;
    this.clock = options.clock ?? (() => new Date());
  }

  pathFor(identity: CheckpointIdentity): string {
    return checkpointPath(this.stateRoot, identity.projectSlug, identity.ticketKey);
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

  async create(options: CreateCheckpointOptions): Promise<MutationResult> {
    const filePath = this.pathFor(options);
    await assertSafeWritePath(this.stateRoot, filePath);
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
      return { checkpoint: existing, checkpointPath: filePath, changed: false };
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
    await this.writeWithCompareAndSwap(filePath, checkpoint, null);
    return { checkpoint, checkpointPath: filePath, changed: true };
  }

  async validate(identity: CheckpointIdentity, repositoryPath: string): Promise<ReconciliationResult> {
    let checkpoint: Checkpoint;
    try {
      checkpoint = await this.load(identity);
    } catch (error) {
      if (
        error instanceof StoryStackError &&
        ["INVALID_CHECKPOINT", "UNSUPPORTED_SCHEMA", "CHECKPOINT_NOT_FOUND"].includes(error.code)
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
    return reconcileCheckpoint(checkpoint.metadata, snapshot);
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
      return { checkpoint: original, checkpointPath: filePath, changed: false };
    }
    await this.writeWithCompareAndSwap(filePath, candidate, originalSource);
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
      return { checkpoint: original, checkpointPath: filePath, changed: false };
    }
    await this.writeWithCompareAndSwap(filePath, candidate, originalSource);
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
      return { checkpoint: original, checkpointPath: filePath, changed: false };
    }
    await this.writeWithCompareAndSwap(filePath, candidate, originalSource);
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
      return { checkpoint: original, checkpointPath: filePath, changed: false };
    }
    const now = this.clock().toISOString();
    const candidate: Checkpoint = {
      metadata: metadataFromSnapshot(original.metadata, snapshot, now, { status: "completed" }),
      body: original.body,
    };
    await this.writeWithCompareAndSwap(filePath, candidate, originalSource);
    return { checkpoint: candidate, checkpointPath: filePath, changed: true };
  }

  async recovery(identity: CheckpointIdentity, repositoryPath: string): Promise<RecoverySummary> {
    const checkpoint = await this.load(identity);
    const reconciliation = reconcileCheckpoint(checkpoint.metadata, await captureGitSnapshot(repositoryPath));
    const validationSummary = extractSection(checkpoint.body, "Test and validation results");
    const validation = checkpoint.metadata.last_validation_at
      ? `${checkpoint.metadata.last_validation_at} (${reconciliation.validationIsCurrent ? "current" : "historical; repository state changed"}) - ${validationSummary}`
      : "None recorded.";
    const dirty = reconciliation.currentSnapshot?.dirty ? "dirty" : "clean";
    return {
      project: checkpoint.metadata.project_slug,
      ticket: checkpoint.metadata.ticket_key,
      objective: extractSection(checkpoint.body, "Objective"),
      completedWork: extractSection(checkpoint.body, "Completed work"),
      currentState: `${checkpoint.metadata.ticket_status}; checkpoint ${reconciliation.status}; worktree ${dirty}`,
      nextAction: extractSection(checkpoint.body, "Exact next action"),
      blockers: extractSection(checkpoint.body, "Blockers and questions"),
      requiredApproval: extractSection(checkpoint.body, "Required user approvals"),
      lastSuccessfulValidation: validation,
      reconciliation,
    };
  }

  async list(repositoryPath?: string): Promise<ListedCheckpoint[]> {
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
      const tickets = await readdir(projectPath, { withFileTypes: true });
      for (const ticket of tickets.filter((entry) => entry.isDirectory())) {
        const filePath = path.join(projectPath, ticket.name, "context.md");
        try {
          await access(filePath, constants.R_OK);
          const source = await readFileOrNull(filePath);
          if (source === null) continue;
          const checkpoint = parseCheckpoint(source);
          if (checkpoint.metadata.project_slug !== project.name || checkpoint.metadata.ticket_key !== ticket.name) {
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

  private async writeWithCompareAndSwap(
    filePath: string,
    checkpoint: Checkpoint,
    expectedSource: string | null,
  ): Promise<void> {
    await assertSafeWritePath(this.stateRoot, filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await assertSafeWritePath(this.stateRoot, filePath);
    const expectedDigest = expectedSource === null ? null : digest(expectedSource);
    const lockPath = `${filePath}.lock`;
    let lockHandle;
    let ownsLock = false;
    try {
      lockHandle = await acquireCheckpointLock(lockPath);
      ownsLock = true;
      await lockHandle.close();
      lockHandle = undefined;
      const verifyUnchanged = async () => {
        await assertSafeWritePath(this.stateRoot, filePath);
        const currentSource = await readFileOrNull(filePath);
        const currentDigest = currentSource === null ? null : digest(currentSource);
        if (currentDigest !== expectedDigest) {
          throw new StoryStackError(
            "Checkpoint changed during the update; reload it before retrying",
            "CHECKPOINT_CONFLICT",
          );
        }
      };
      await verifyUnchanged();
      await writeFileAtomic(filePath, serializeCheckpoint(checkpoint), { beforeRename: verifyUnchanged });
    } finally {
      if (lockHandle !== undefined) await lockHandle.close().catch(() => undefined);
      if (ownsLock) await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}

export function assertTicketStatus(value: string): asserts value is TicketStatus {
  if (!TICKET_STATUSES.includes(value as TicketStatus)) {
    throw new StoryStackError(`Status must be one of: ${TICKET_STATUSES.join(", ")}`, "INVALID_STATUS");
  }
}
