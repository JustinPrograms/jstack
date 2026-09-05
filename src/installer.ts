import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  expandPlatformTargets,
  getPlatformAdapter,
  type AdapterPaths,
  type DoctorReminder,
  type InstallScope,
  type PlatformProposal,
  type PlatformTarget,
  type TargetSelection,
} from "../adapters/registry.js";
import { writeFileAtomic } from "./checkpoint/atomic.js";
import { StoryStackError, errorMessage } from "./errors.js";

export const INSTALL_MANIFEST_SCHEMA_VERSION = 2 as const;
export const INSTALL_MANIFEST_FILENAME = "install-manifest.json";
export const INSTALL_TRANSACTION_FILENAME = ".install-transaction.json";
export const INSTALLED_SKILLS = ["story", "plan-eng-review", "justinstack-review", "resume-story"] as const;

export type InstalledSkill = (typeof INSTALLED_SKILLS)[number];
export type InstallRoot = "justinstack" | "story-stack" | "claude-skills" | "bob-skills" | "codex-skills";
export type InstallEntryKind = "copy" | "generated" | "manifest" | "obsolete";
export type CollisionKind = "file" | "directory" | "symbolic-link" | "other";
export type InstallAction = "create" | "unchanged" | "replace" | "remove" | "preserve" | "unsafe";

export interface InstallerOptions {
  /** Source checkout containing package.json, dist, skills, policies, and templates. */
  packageRoot?: string;
  /** Isolated home override, primarily for tests. */
  userHome?: string;
  /** Shared runtime and private-state root. Defaults to <userHome>/.justin-stack. */
  justinStackHome?: string;
  /** Deprecated compatibility alias for justinStackHome. */
  storyStackHome?: string;
  target?: TargetSelection;
  scope?: InstallScope;
  /** Starting directory used only when projectRoot is omitted. */
  cwd?: string;
  projectRoot?: string;
  /** Explicit skill-root overrides, primarily for isolated tests. */
  skillRoots?: Partial<Record<PlatformTarget, string>>;
  /** Deprecated compatibility override for Claude's skill root. */
  claudeSkillsRoot?: string;
  bobSkillsRoot?: string;
  codexSkillsRoot?: string;
  /** Optional Claude configuration root (CLAUDE_CONFIG_DIR) for global discovery/proposals. */
  claudeConfigDir?: string;
  /** Optional Codex configuration root (CODEX_HOME) for global instructions/config proposals only. */
  codexHome?: string;
  version?: string;
}

export interface ApplyInstallOptions {
  /** Required to replace an existing file not proven to be installer-owned. */
  confirmOverwrite?: boolean;
  /** Test-only abrupt-termination simulation. Leaves the durable journal in place. */
  testOnlyAbortAfterMutations?: number;
  /** Test-only termination immediately before the numbered target mutation. */
  testOnlyAbortBeforeMutation?: number;
  /** Test-only hook for simulating a non-cooperating writer before manifest commit. */
  testOnlyBeforeManifest?: () => Promise<void> | void;
  /** Test-only hook for simulating a writer during recovered manifest commit. */
  testOnlyBeforeRecoveryManifest?: () => Promise<void> | void;
}

export interface InstallPaths {
  userHome: string;
  projectRoot: string;
  justinRoot: string;
  /** Deprecated descriptive alias for justinRoot. */
  storyRoot: string;
  skillsRoot: string;
  skillRoots: Partial<Record<PlatformTarget, string>>;
  claudeConfigDir: string | null;
  codexHome: string | null;
  manifestPath: string;
}

export interface InstallCollision {
  targetPath: string;
  kind: CollisionKind;
  sha256: string | null;
  size: number | null;
  mode: number | null;
}

export interface InstallSafetyIssue {
  targetPath: string;
  message: string;
}

export type InstallBackupAction = "create" | "unchanged" | "unsafe";

export interface InstallBackupOperation {
  sourcePath: string;
  targetPath: string;
  sha256: string;
  action: InstallBackupAction;
  collision: InstallCollision | null;
}

export interface InstallPlanEntry {
  root: InstallRoot;
  destinationRoot: string;
  safetyRoot: string;
  relativePath: string;
  targetPath: string;
  kind: InstallEntryKind;
  sourcePath: string | null;
  generatedContents: string | null;
  sha256: string;
  mode: number;
  action: InstallAction;
  managed: boolean;
  previousSha256: string | null;
  previousMode: number | null;
  collision: InstallCollision | null;
  diff: string | null;
  installationKey: string | null;
}

/** Legacy schema-v1 entry retained for safe parsing and uninstall. */
export interface InstallManifestEntry {
  root: "story-stack" | "claude-skills";
  path: string;
  sha256: string;
}

export interface LegacyInstallManifest {
  schema_version: 1;
  package_version: string;
  entries: InstallManifestEntry[];
}

export interface ManifestFileEntry {
  path: string;
  sha256: string;
}

export interface ManifestInstallation {
  key: string;
  target: PlatformTarget;
  scope: InstallScope;
  workspace_id: string | null;
  /** Absolute root recorded at install time so uninstall never guesses a destination. */
  destination_root: string | null;
  entries: ManifestFileEntry[];
}

export interface InstallManifestV2 {
  schema_version: typeof INSTALL_MANIFEST_SCHEMA_VERSION;
  package_version: string;
  runtime_entries: ManifestFileEntry[];
  installations: ManifestInstallation[];
}

export type InstallManifest = LegacyInstallManifest | InstallManifestV2;

export interface ConfigurationProposalView extends PlatformProposal {
  targetExists: boolean;
  diff: string;
}

interface NormalizedInstallerOptions {
  packageRoot: string;
  packageVersion: string;
  userHome: string;
  justinStackHome: string;
  target: TargetSelection;
  scope: InstallScope;
  projectRoot: string;
  skillRoots: Partial<Record<PlatformTarget, string>>;
  claudeConfigDir?: string;
  codexHome?: string;
}

export interface InstallPlan {
  packageRoot: string;
  packageVersion: string;
  userHome: string;
  projectRoot: string;
  target: TargetSelection;
  targets: readonly PlatformTarget[];
  scope: InstallScope;
  justinRoot: string;
  /** Deprecated alias retained for callers of the Phase 1 API. */
  storyRoot: string;
  skillsRoot: string;
  skillRoots: Partial<Record<PlatformTarget, string>>;
  claudeConfigDir?: string;
  codexHome?: string;
  manifestPath: string;
  entries: InstallPlanEntry[];
  collisions: InstallCollision[];
  safetyIssues: InstallSafetyIssue[];
  configurationProposals: ConfigurationProposalView[];
  doctorReminders: DoctorReminder[];
  backupRoot: string | null;
  backupOperations: InstallBackupOperation[];
  manifest: InstallManifestV2;
  fingerprint: string;
  normalizedOptions: NormalizedInstallerOptions;
}

export interface InstallResult {
  written: string[];
  installed: string[];
  removed: string[];
  preserved: PreservedInstallFile[];
  unchanged: string[];
  overwritten: string[];
  backups: string[];
  backupRoot: string | null;
  manifestPath: string;
  configurationModified: false;
}

export type UninstallEntryStatus = "remove" | "missing" | "modified" | "unsafe";

export interface UninstallPlanEntry {
  root: InstallRoot;
  destinationRoot: string;
  safetyRoot: string;
  installationKey: string | null;
  relativePath: string;
  targetPath: string;
  expectedSha256: string;
  actualSha256: string | null;
  status: UninstallEntryStatus;
  reason: string | null;
}

export interface PreservedInstallFile {
  targetPath: string;
  reason: string;
}

export interface UninstallPlan {
  userHome: string;
  projectRoot: string;
  target: TargetSelection;
  scope: InstallScope;
  justinRoot: string;
  storyRoot: string;
  skillsRoot: string;
  skillRoots: Partial<Record<PlatformTarget, string>>;
  manifestPath: string;
  manifestFound: boolean;
  manifestSha256: string | null;
  packageVersion: string | null;
  entries: UninstallPlanEntry[];
  issues: string[];
  blocked: PreservedInstallFile[];
  canFullyUninstall: boolean;
  manifest: InstallManifest | null;
  normalizedOptions: Omit<NormalizedInstallerOptions, "packageVersion">;
}

export interface UninstallResult {
  removed: string[];
  missing: string[];
  preserved: PreservedInstallFile[];
  blocked: PreservedInstallFile[];
  manifestPath: string;
  manifestRemoved: boolean;
  complete: boolean;
  statePreserved: true;
}

export interface PlatformDoctorStatus {
  target: PlatformTarget;
  displayName: string;
  scope: InstallScope;
  skillsRoot: string;
  ok: boolean;
  installed: string[];
  missing: string[];
  stale: string[];
  obsolete: string[];
  reminders: readonly DoctorReminder[];
  configurationProposals: readonly ConfigurationProposalView[];
}

interface FileDescriptor {
  root: InstallRoot;
  destinationRoot: string;
  safetyRoot: string;
  relativePath: string;
  kind: Exclude<InstallEntryKind, "manifest" | "obsolete">;
  sourcePath: string | null;
  generatedContents: string | null;
  mode: number;
  installationKey: string | null;
}

interface ExistingManifest {
  source: string;
  sha256: string;
  manifest: InstallManifest;
}

interface BackupRecord {
  entry: InstallPlanEntry;
  contents: Uint8Array;
  mode: number;
  persistentPath: string;
}

type TransactionAction = "create" | "replace" | "remove";

interface InstallTransactionEntry {
  root: Exclude<InstallRoot, "story-stack">;
  destination_root: string;
  relative_path: string;
  target_path: string;
  action: TransactionAction;
  before_sha256: string | null;
  before_mode: number | null;
  after_sha256: string | null;
  after_mode: number | null;
  backup_path: string | null;
  state: "pending" | "applied";
}

interface InstallTransactionJournal {
  schema_version: 1;
  transaction_id: string;
  created_at: string;
  pid: number;
  user_home: string;
  project_root: string;
  justin_root: string;
  plan_fingerprint: string;
  manifest_path: string;
  manifest_before_sha256: string | null;
  manifest_before_mode: number | null;
  manifest_after_sha256: string;
  manifest_after_mode: number;
  manifest: InstallManifestV2;
  entries: InstallTransactionEntry[];
}

type InstallTransactionPaths = Pick<InstallPaths, "userHome" | "projectRoot" | "justinRoot" | "manifestPath">;

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TRANSACTION_BYTES = 4 * 1024 * 1024;
const MAX_INSTALL_LOCK_BYTES = 4096;
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_DIFF_LINES = 120;
const INSTALL_LOCK_RETRIES = 600;
const INSTALL_LOCK_DELAY_MS = 25;
const INSTALL_LOCK_STALE_MS = 30 * 1000;
const MALFORMED_LOCK_STALE_MS = 5 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
const INSTALLATION_KEY_PATTERN = /^(?:global:(?:claude|bob|codex)|project:[a-f0-9]{16}:(?:claude|bob|codex))$/u;
const SKILL_NAME_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/u;
const CURRENT_AND_LEGACY_SKILLS = [...INSTALLED_SKILLS, "review"] as const;
const SKILL_RESOURCE_DIRECTORIES = new Set(["references", "scripts", "assets"]);
const OPTIONAL_SKILL_FRONTMATTER = new Set(["license", "compatibility", "metadata", "allowed-tools"]);
const execFileAsync = promisify(execFile);

function defaultPackageRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(path.dirname(moduleDirectory)) === "dist"
    ? path.resolve(moduleDirectory, "../..")
    : path.resolve(moduleDirectory, "..");
}

async function enclosingGitRoot(cwd: string): Promise<string> {
  const resolvedCwd = assertUsableRoot(cwd, "Current working directory");
  try {
    const result = await execFileAsync("git", ["-C", resolvedCwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const candidate = result.stdout.trim();
    return assertUsableRoot(candidate, "Git repository root");
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
    if (candidate.code === "ENOENT") {
      throw new StoryStackError("Git is required to discover the project root but was not found on PATH", "GIT_NOT_FOUND");
    }
    const detail = (candidate.stderr ?? candidate.message ?? "unknown error").trim();
    if (/not a git repository/iu.test(detail)) return resolvedCwd;
    throw new StoryStackError(`Local Git project-root discovery failed: ${detail}`, "GIT_FAILED");
  }
}

function digest(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function digestFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function lstatOrNull(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertUsableRoot(candidate: string, label: string): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0 || /[\0-\x1f\x7f]/u.test(candidate)) {
    throw new StoryStackError(`${label} must be a non-empty path without control characters`, "INVALID_INSTALL_ROOT");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new StoryStackError(`${label} cannot be a filesystem root`, "INVALID_INSTALL_ROOT");
  }
  return resolved;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertContained(root: string, target: string, label: string): void {
  if (!isContained(root, target)) {
    throw new StoryStackError(`${label} escapes its allowed installation root`, "INSTALL_PATH_TRAVERSAL");
  }
}

function nativePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function workspaceId(projectRoot: string): string {
  const canonical = process.platform === "win32" ? path.resolve(projectRoot).toLowerCase() : path.resolve(projectRoot);
  return digest(canonical).slice(0, 16);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function installationKey(scope: InstallScope, target: PlatformTarget, projectRoot: string): string {
  return scope === "global" ? `global:${target}` : `project:${workspaceId(projectRoot)}:${target}`;
}

function explicitSkillOverrides(options: InstallerOptions): Partial<Record<PlatformTarget, string>> {
  const result: Partial<Record<PlatformTarget, string>> = { ...(options.skillRoots ?? {}) };
  if (options.claudeSkillsRoot !== undefined) result.claude = options.claudeSkillsRoot;
  if (options.bobSkillsRoot !== undefined) result.bob = options.bobSkillsRoot;
  if (options.codexSkillsRoot !== undefined) result.codex = options.codexSkillsRoot;
  return result;
}

export function resolveInstallPaths(
  userHome = os.homedir(),
  overrides: Pick<
    InstallerOptions,
    | "justinStackHome"
    | "storyStackHome"
    | "claudeSkillsRoot"
    | "bobSkillsRoot"
    | "codexSkillsRoot"
    | "skillRoots"
    | "target"
    | "scope"
    | "projectRoot"
    | "claudeConfigDir"
    | "codexHome"
  > = {},
): InstallPaths {
  const resolvedHome = assertUsableRoot(userHome, "User home");
  const projectRoot = assertUsableRoot(overrides.projectRoot ?? process.cwd(), "Project root");
  const scope = overrides.scope ?? "global";
  const target = overrides.target ?? "claude";
  const targets = expandPlatformTargets(target);
  const justinRoot = assertUsableRoot(
    overrides.justinStackHome ?? overrides.storyStackHome ?? path.join(resolvedHome, ".justin-stack"),
    "JustinStack home",
  );
  const claudeConfigDir = overrides.claudeConfigDir === undefined
    ? null
    : assertUsableRoot(overrides.claudeConfigDir, "Claude configuration root");
  const codexHome = overrides.codexHome === undefined
    ? null
    : assertUsableRoot(overrides.codexHome, "Codex home");
  const custom = explicitSkillOverrides(overrides);
  const skillRoots: Partial<Record<PlatformTarget, string>> = {};
  for (const platform of targets) {
    const context: AdapterPaths = {
      userHome: resolvedHome,
      projectRoot,
      justinStackHome: justinRoot,
      ...(claudeConfigDir === null ? {} : { claudeConfigDir }),
      ...(codexHome === null ? {} : { codexHome }),
    };
    skillRoots[platform] = assertUsableRoot(
      custom[platform] ?? getPlatformAdapter(platform).skillRoot(scope, context),
      `${platform} skills root`,
    );
    const skillsRoot = skillRoots[platform];
    if (skillsRoot !== undefined && (isContained(justinRoot, skillsRoot) || isContained(skillsRoot, justinRoot))) {
      throw new StoryStackError("Runtime and skill roots cannot overlap", "INVALID_INSTALL_ROOT");
    }
    const scopeBoundary = scope === "global" ? resolvedHome : projectRoot;
    const explicitClaudeBoundary = platform === "claude" && scope === "global" && claudeConfigDir !== null
      ? claudeConfigDir
      : null;
    if (skillsRoot !== undefined && !isContained(scopeBoundary, skillsRoot) &&
      (explicitClaudeBoundary === null || !isContained(explicitClaudeBoundary, skillsRoot))) {
      throw new StoryStackError(
        `${platform} ${scope} skill root must remain inside the ${scope === "global" ? "user home" : "project root"}`,
        "INVALID_INSTALL_ROOT",
      );
    }
  }
  const firstRoot = skillRoots[targets[0] ?? "claude"];
  if (firstRoot === undefined) throw new StoryStackError("No platform target was selected", "INVALID_INSTALL_TARGET");
  return {
    userHome: resolvedHome,
    projectRoot,
    justinRoot,
    storyRoot: justinRoot,
    skillsRoot: firstRoot,
    skillRoots,
    claudeConfigDir,
    codexHome,
    manifestPath: path.join(justinRoot, INSTALL_MANIFEST_FILENAME),
  };
}

function safetyRootFor(paths: Pick<InstallPaths, "userHome" | "projectRoot">, destinationRoot: string): string {
  if (isContained(paths.userHome, destinationRoot)) return paths.userHome;
  if (isContained(paths.projectRoot, destinationRoot)) return paths.projectRoot;
  // An explicit non-standard root is a user-selected trust anchor. Descendants
  // are still checked component-by-component before any read or write.
  return destinationRoot;
}

function installerLockPath(justinRoot: string): string {
  return path.join(path.dirname(justinRoot), `.${path.basename(justinRoot)}.installer.lock`);
}

interface InstallerLockMetadata {
  pid: number;
  created_at: string;
  token: string | null;
}

function parseInstallerLockMetadata(source: string): InstallerLockMetadata | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
    if (typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) return null;
    if (record.token !== undefined && (typeof record.token !== "string" || !/^[a-f0-9-]{36}$/u.test(record.token))) return null;
    return { pid: record.pid as number, created_at: record.created_at, token: record.token as string | undefined ?? null };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function installerLockIsStale(metadata: InstallerLockMetadata, stats: NonNullable<Awaited<ReturnType<typeof lstatOrNull>>>): boolean {
  const metadataAge = Date.now() - Date.parse(metadata.created_at);
  const filesystemAge = Date.now() - stats.mtimeMs;
  return Math.max(metadataAge, filesystemAge) >= INSTALL_LOCK_STALE_MS && !processIsAlive(metadata.pid);
}

interface InstallerLockQueueEntry {
  path: string;
  ticket: number;
  token: string;
}

interface InstallerLockQueue {
  blocked: boolean;
  choosing: string[];
  tickets: InstallerLockQueueEntry[];
}

function parseInstallerTicketName(name: string, prefix: string): { ticket: number; token: string } | null {
  if (!name.startsWith(prefix)) return null;
  const remainder = name.slice(prefix.length);
  const separator = remainder.indexOf(".");
  if (separator < 1) return null;
  const ticket = Number(remainder.slice(0, separator));
  const token = remainder.slice(separator + 1);
  if (!Number.isSafeInteger(ticket) || ticket < 1 || !/^[a-f0-9-]{36}$/u.test(token)) return null;
  return { ticket, token };
}

async function reclaimInstallerQueueArtifact(candidatePath: string): Promise<boolean> {
  const stats = await lstatOrNull(candidatePath);
  if (stats === null) return true;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_INSTALL_LOCK_BYTES) return false;
  let source: string;
  try {
    source = await readFile(candidatePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const metadata = parseInstallerLockMetadata(source);
  const malformedIsStale = metadata === null && Date.now() - stats.mtimeMs >= MALFORMED_LOCK_STALE_MS;
  if (!(metadata !== null ? installerLockIsStale(metadata, stats) : malformedIsStale)) return false;

  // Claim the exact artifact by atomic rename, then revalidate its own
  // metadata and age before removal. A concurrent contender cannot inherit a
  // path between inspection and cleanup, including the legacy base-lock name.
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
    if (claimedStats === null || claimedStats.isSymbolicLink() || !claimedStats.isFile() || claimedStats.size > MAX_INSTALL_LOCK_BYTES) {
      return false;
    }
    const claimedSource = await readFile(claimPath, "utf8");
    const claimedMetadata = parseInstallerLockMetadata(claimedSource);
    removeClaim = claimedMetadata === null
      ? Date.now() - claimedStats.mtimeMs >= MALFORMED_LOCK_STALE_MS
      : installerLockIsStale(claimedMetadata, claimedStats);
    if (removeClaim) return true;
    if (await lstatOrNull(candidatePath) === null) await rename(claimPath, candidatePath);
    return false;
  } finally {
    if (removeClaim) await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

async function removeOwnedInstallerLease(leasePath: string, token: string): Promise<void> {
  const claimPath = path.join(path.dirname(leasePath), `.${path.basename(leasePath)}.release.${randomUUID()}.tmp`);
  try {
    await rename(leasePath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let removeClaim = false;
  try {
    const stats = await lstatOrNull(claimPath);
    const source = stats !== null && stats.isFile() && !stats.isSymbolicLink() && stats.size <= MAX_INSTALL_LOCK_BYTES
      ? await readFile(claimPath, "utf8").catch(() => null)
      : null;
    removeClaim = source !== null && parseInstallerLockMetadata(source)?.token === token;
    if (!removeClaim && await lstatOrNull(leasePath) === null) await rename(claimPath, leasePath);
  } finally {
    if (removeClaim) await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

async function inspectInstallerLockQueue(lockPath: string): Promise<InstallerLockQueue> {
  const directory = path.dirname(lockPath);
  const baseName = path.basename(lockPath);
  const choosingPrefix = `${baseName}.choosing.`;
  const ticketPrefix = `${baseName}.ticket.`;
  const queue: InstallerLockQueue = { blocked: false, choosing: [], tickets: [] };
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== baseName && !entry.name.startsWith(choosingPrefix) && !entry.name.startsWith(ticketPrefix)) continue;
    const candidatePath = path.join(directory, entry.name);
    const stats = await lstatOrNull(candidatePath);
    if (stats === null) continue;
    if (entry.isSymbolicLink() || !entry.isFile() || stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_INSTALL_LOCK_BYTES) {
      queue.blocked = true;
      continue;
    }
    let source: string;
    try {
      source = await readFile(candidatePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      queue.blocked = true;
      continue;
    }
    const metadata = parseInstallerLockMetadata(source);
    if (entry.name === baseName) {
      const malformedIsStale = metadata === null && Date.now() - stats.mtimeMs >= MALFORMED_LOCK_STALE_MS;
      if ((metadata !== null && installerLockIsStale(metadata, stats)) || malformedIsStale) {
        if (await reclaimInstallerQueueArtifact(candidatePath)) continue;
      }
      queue.blocked = true;
      continue;
    }
    const tokenFromName = entry.name.startsWith(choosingPrefix)
      ? entry.name.slice(choosingPrefix.length)
      : parseInstallerTicketName(entry.name, ticketPrefix)?.token ?? "";
    const malformedIsStale = metadata === null && Date.now() - stats.mtimeMs >= MALFORMED_LOCK_STALE_MS;
    if ((metadata !== null && installerLockIsStale(metadata, stats)) || malformedIsStale) {
      if (await reclaimInstallerQueueArtifact(candidatePath)) continue;
    }
    if (metadata === null && entry.name.startsWith(choosingPrefix) && /^[a-f0-9-]{36}$/u.test(tokenFromName)) {
      queue.choosing.push(candidatePath);
      continue;
    }
    if (metadata === null || metadata.token !== tokenFromName) {
      queue.blocked = true;
      continue;
    }
    if (entry.name.startsWith(choosingPrefix)) {
      queue.choosing.push(candidatePath);
      continue;
    }
    const ticket = parseInstallerTicketName(entry.name, ticketPrefix);
    if (ticket === null) queue.blocked = true;
    else queue.tickets.push({ path: candidatePath, ...ticket });
  }
  return queue;
}

interface InstallerLockLease {
  path: string;
  token: string;
}

async function acquireInstallerLock(paths: InstallPaths): Promise<InstallerLockLease> {
  const lockPath = installerLockPath(paths.justinRoot);
  const lockParent = path.dirname(lockPath);
  const safetyRoot = isContained(paths.userHome, lockPath) ? paths.userHome : lockParent;
  const issue = await inspectParentSafety(safetyRoot, lockPath);
  if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
  await mkdir(lockParent, { recursive: true });
  const token = randomUUID();
  const choosingPath = `${lockPath}.choosing.${token}`;
  const owner = `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), token })}\n`;
  // Publish a recognized queue entry only after its owner record is complete
  // and flushed. A crash may leave an ignored temporary file, never a partial
  // choosing entry that strands future installers.
  await writeFileAtomic(choosingPath, owner);

  let ticketPath: string | null = null;
  try {
    const initial = await inspectInstallerLockQueue(lockPath);
    if (initial.blocked) throw new StoryStackError(`Installer lock cannot be safely inspected: ${lockPath}`, "INSTALL_LOCKED");
    const ticket = initial.tickets.reduce((maximum, candidate) => Math.max(maximum, candidate.ticket), 0) + 1;
    if (!Number.isSafeInteger(ticket)) throw new StoryStackError("Installer lock ticket space is exhausted", "INSTALL_LOCKED");
    ticketPath = `${lockPath}.ticket.${ticket}.${token}`;
    await rename(choosingPath, ticketPath);
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRIES; attempt += 1) {
      const queue = await inspectInstallerLockQueue(lockPath);
      if (queue.blocked) throw new StoryStackError(`Installer lock cannot be safely inspected: ${lockPath}`, "INSTALL_LOCKED");
      if (queue.choosing.length === 0) {
        queue.tickets.sort((left, right) => left.ticket - right.ticket || left.token.localeCompare(right.token, "en"));
        if (queue.tickets[0]?.path === ticketPath) return { path: ticketPath, token };
      }
      await delay(INSTALL_LOCK_DELAY_MS);
    }
    throw new StoryStackError(`Another JustinStack install or uninstall still holds the local lock: ${lockPath}`, "INSTALL_LOCKED");
  } catch (error) {
    await removeOwnedInstallerLease(ticketPath ?? choosingPath, token).catch(() => undefined);
    throw error;
  }
}

async function withInstallerLock<T>(
  paths: InstallPaths,
  operation: () => Promise<T>,
  recoveryOptions: { testOnlyBeforeManifest?: () => Promise<void> | void } = {},
): Promise<T> {
  const lease = await acquireInstallerLock(paths);
  try {
    await recoverInstallTransaction(paths, recoveryOptions);
    return await operation();
  } finally {
    await removeOwnedInstallerLease(lease.path, lease.token).catch(() => undefined);
  }
}

function assertManifestRelativePath(relativePath: unknown): asserts relativePath is string {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > 1024 ||
    relativePath.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(relativePath) ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/u.test(relativePath) ||
    relativePath.split("/").some((component) => component === "" || component === "." || component === "..") ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new StoryStackError("Install manifest contains an unsafe relative path", "INVALID_INSTALL_MANIFEST");
  }
}

function isRuntimePath(relativePath: string): boolean {
  const skillNames = CURRENT_AND_LEGACY_SKILLS.join("|");
  return (
    /^(?:bin\/(?:justinstack|story-stack)(?:\.js|\.cmd)?|runtime\/package\.json|runtime\/templates\/context\.v1\.md|runtime\/policies\/checkpoint-protocol\.md|policies\/checkpoint-protocol\.md)$/u.test(relativePath) ||
    new RegExp(`^runtime/skills/(?:${skillNames})/(?:SKILL\\.md|(?:references|scripts|assets)/(?:[^/]+/)*[^/]+)$`, "u").test(relativePath) ||
    /^runtime\/dist\/(?:src|adapters)\/(?:[^/]+\/)*[^/]+\.js$/u.test(relativePath)
  );
}

function isSkillPathForNames(relativePath: string, skills: readonly string[]): boolean {
  return skills.some(
    (skill) => relativePath === `${skill}/SKILL.md` ||
      [...SKILL_RESOURCE_DIRECTORIES].some((directory) => relativePath.startsWith(`${skill}/${directory}/`)),
  );
}

function isSkillPath(relativePath: string): boolean {
  return isSkillPathForNames(relativePath, INSTALLED_SKILLS);
}

function isManifestSkillPath(relativePath: string): boolean {
  return isSkillPathForNames(relativePath, CURRENT_AND_LEGACY_SKILLS);
}

function assertManifestFile(value: unknown, kind: "runtime" | "skill"): asserts value is ManifestFileEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoryStackError("Install manifest file entry must be an object", "INVALID_INSTALL_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "path,sha256") {
    throw new StoryStackError("Install manifest file entry has missing or unknown fields", "INVALID_INSTALL_MANIFEST");
  }
  assertManifestRelativePath(record.path);
  if ((kind === "runtime" ? !isRuntimePath(record.path) : !isManifestSkillPath(record.path))) {
    throw new StoryStackError(`Install manifest path is outside the ${kind} allowlist`, "INVALID_INSTALL_MANIFEST");
  }
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
    throw new StoryStackError("Install manifest entry has an invalid SHA-256 digest", "INVALID_INSTALL_MANIFEST");
  }
}

function assertLegacyEntry(value: unknown): asserts value is InstallManifestEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoryStackError("Install manifest entry must be an object", "INVALID_INSTALL_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "path,root,sha256") {
    throw new StoryStackError("Install manifest entry has missing or unknown fields", "INVALID_INSTALL_MANIFEST");
  }
  if (record.root !== "story-stack" && record.root !== "claude-skills") {
    throw new StoryStackError("Install manifest entry has an unknown root", "INVALID_INSTALL_MANIFEST");
  }
  assertManifestRelativePath(record.path);
  if (
    (record.root === "story-stack" && !isRuntimePath(record.path) && record.path !== INSTALL_MANIFEST_FILENAME) ||
    (record.root === "claude-skills" && !isManifestSkillPath(record.path))
  ) {
    throw new StoryStackError("Install manifest path is outside the owned-file allowlist", "INVALID_INSTALL_MANIFEST");
  }
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
    throw new StoryStackError("Install manifest entry has an invalid SHA-256 digest", "INVALID_INSTALL_MANIFEST");
  }
}

function assertVersion(value: unknown): asserts value is string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new StoryStackError("Install manifest has an invalid package version", "INVALID_INSTALL_MANIFEST");
  }
}

function assertInstallation(value: unknown): asserts value is ManifestInstallation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoryStackError("Install manifest installation must be an object", "INVALID_INSTALL_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (
    keys !== "destination_root,entries,key,scope,target,workspace_id" &&
    keys !== "entries,key,scope,target,workspace_id"
  ) {
    throw new StoryStackError("Install manifest installation has missing or unknown fields", "INVALID_INSTALL_MANIFEST");
  }
  if (!INSTALLATION_KEY_PATTERN.test(String(record.key))) {
    throw new StoryStackError("Install manifest has an invalid installation key", "INVALID_INSTALL_MANIFEST");
  }
  if (record.target !== "claude" && record.target !== "bob" && record.target !== "codex") {
    throw new StoryStackError("Install manifest has an invalid target", "INVALID_INSTALL_MANIFEST");
  }
  if (record.scope !== "project" && record.scope !== "global") {
    throw new StoryStackError("Install manifest has an invalid scope", "INVALID_INSTALL_MANIFEST");
  }
  if (record.workspace_id !== null && (typeof record.workspace_id !== "string" || !/^[a-f0-9]{16}$/u.test(record.workspace_id))) {
    throw new StoryStackError("Install manifest has an invalid workspace id", "INVALID_INSTALL_MANIFEST");
  }
  const expectedKey = record.scope === "global"
    ? `global:${record.target}`
    : `project:${String(record.workspace_id)}:${record.target}`;
  if (record.key !== expectedKey || (record.scope === "global") !== (record.workspace_id === null)) {
    throw new StoryStackError("Install manifest installation identity is inconsistent", "INVALID_INSTALL_MANIFEST");
  }
  if (record.destination_root !== undefined && record.destination_root !== null && (
    typeof record.destination_root !== "string" ||
    record.destination_root.length === 0 ||
    record.destination_root.length > 4096 ||
    /[\0-\x1f\x7f]/u.test(record.destination_root) ||
    !path.isAbsolute(record.destination_root) ||
    path.resolve(record.destination_root) !== record.destination_root ||
    record.destination_root === path.parse(record.destination_root).root
  )) {
    throw new StoryStackError("Install manifest has an invalid destination root", "INVALID_INSTALL_MANIFEST");
  }
  if (!Array.isArray(record.entries) || record.entries.length > 10_000) {
    throw new StoryStackError("Install manifest skill entries must be a bounded array", "INVALID_INSTALL_MANIFEST");
  }
  for (const entry of record.entries) assertManifestFile(entry, "skill");
  const names = (record.entries as ManifestFileEntry[]).map((entry) => entry.path);
  if (new Set(names).size !== names.length) {
    throw new StoryStackError("Install manifest contains duplicate skill paths", "INVALID_INSTALL_MANIFEST");
  }
}

export function parseInstallManifest(source: string): InstallManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new StoryStackError("Install manifest is not valid JSON", "INVALID_INSTALL_MANIFEST");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoryStackError("Install manifest must be a JSON object", "INVALID_INSTALL_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version === 1) {
    if (Object.keys(record).sort().join(",") !== "entries,package_version,schema_version") {
      throw new StoryStackError("Install manifest has missing or unknown fields", "INVALID_INSTALL_MANIFEST");
    }
    assertVersion(record.package_version);
    if (!Array.isArray(record.entries) || record.entries.length > 10_000) {
      throw new StoryStackError("Install manifest entries must be a bounded array", "INVALID_INSTALL_MANIFEST");
    }
    for (const entry of record.entries) assertLegacyEntry(entry);
    return {
      schema_version: 1,
      package_version: record.package_version,
      entries: (record.entries as InstallManifestEntry[]).map((entry) => ({ ...entry })),
    };
  }
  if (record.schema_version !== INSTALL_MANIFEST_SCHEMA_VERSION) {
    throw new StoryStackError(
      `Unsupported install manifest schema '${String(record.schema_version)}'`,
      "UNSUPPORTED_INSTALL_MANIFEST",
    );
  }
  if (Object.keys(record).sort().join(",") !== "installations,package_version,runtime_entries,schema_version") {
    throw new StoryStackError("Install manifest has missing or unknown fields", "INVALID_INSTALL_MANIFEST");
  }
  assertVersion(record.package_version);
  if (!Array.isArray(record.runtime_entries) || record.runtime_entries.length > 10_000) {
    throw new StoryStackError("Install manifest runtime entries must be a bounded array", "INVALID_INSTALL_MANIFEST");
  }
  for (const entry of record.runtime_entries) assertManifestFile(entry, "runtime");
  if (!Array.isArray(record.installations) || record.installations.length > 10_000) {
    throw new StoryStackError("Install manifest installations must be a bounded array", "INVALID_INSTALL_MANIFEST");
  }
  for (const installation of record.installations) assertInstallation(installation);
  const runtimeNames = (record.runtime_entries as ManifestFileEntry[]).map((entry) => entry.path);
  const installationKeys = (record.installations as ManifestInstallation[]).map((entry) => entry.key);
  if (new Set(runtimeNames).size !== runtimeNames.length || new Set(installationKeys).size !== installationKeys.length) {
    throw new StoryStackError("Install manifest contains duplicate paths or installations", "INVALID_INSTALL_MANIFEST");
  }
  return {
    schema_version: INSTALL_MANIFEST_SCHEMA_VERSION,
    package_version: record.package_version,
    runtime_entries: (record.runtime_entries as ManifestFileEntry[]).map((entry) => ({ ...entry })),
    installations: (record.installations as ManifestInstallation[]).map((installation) => ({
      ...installation,
      destination_root: installation.destination_root ?? null,
      entries: installation.entries.map((entry) => ({ ...entry })),
    })),
  };
}

function serializeManifest(manifest: InstallManifestV2): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readPackageVersion(packageRoot: string): Promise<string> {
  const packagePath = path.join(packageRoot, "package.json");
  try {
    const value = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
    const version = typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).version
      : undefined;
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new Error("invalid version");
    return version;
  } catch (error) {
    throw new StoryStackError(`Cannot read package metadata at ${packagePath}: ${errorMessage(error)}`, "INVALID_PACKAGE");
  }
}

async function assertRegularSource(sourcePath: string): Promise<void> {
  const stats = await lstatOrNull(sourcePath);
  if (stats === null || stats.isSymbolicLink() || !stats.isFile()) {
    throw new StoryStackError(`Required installer source is not a regular file: ${sourcePath}`, "MISSING_INSTALL_SOURCE");
  }
}

async function listRegularFiles(root: string, required: boolean): Promise<string[]> {
  const rootStats = await lstatOrNull(root);
  if (rootStats === null) {
    if (!required) return [];
    throw new StoryStackError(`Required installer source directory is missing: ${root}`, "MISSING_INSTALL_SOURCE");
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new StoryStackError(`Installer source directory is unsafe: ${root}`, "UNSAFE_INSTALL_SOURCE");
  }
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new StoryStackError(`Installer sources cannot contain symbolic links: ${entryPath}`, "UNSAFE_INSTALL_SOURCE");
      }
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
      else throw new StoryStackError(`Installer source is not a regular file: ${entryPath}`, "UNSAFE_INSTALL_SOURCE");
    }
  }
  await visit(root);
  return files;
}

function parseSkillScalar(raw: string, label: string, allowQuotedEmpty = false): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw new StoryStackError(`${label} must be a non-empty single-line string`, "INVALID_SKILL_FRONTMATTER");
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string" && (parsed.length > 0 || allowQuotedEmpty)) return parsed;
    } catch {
      // Report the stable installer error below.
    }
    throw new StoryStackError(`${label} must be a valid quoted string`, "INVALID_SKILL_FRONTMATTER");
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new StoryStackError(`${label} must be a valid quoted string`, "INVALID_SKILL_FRONTMATTER");
    }
    const parsed = value.slice(1, -1).replace(/''/gu, "'");
    if (parsed.length > 0 || allowQuotedEmpty) return parsed;
    throw new StoryStackError(`${label} must be a non-empty string`, "INVALID_SKILL_FRONTMATTER");
  }
  if (/^(?:null|~|true|false|[-+]?\d+(?:\.\d+)?)$/iu.test(value) || /^[\[{]/u.test(value)) {
    throw new StoryStackError(`${label} must be a string`, "INVALID_SKILL_FRONTMATTER");
  }
  return value;
}

function blockScalarStyle(raw: string): "literal" | "folded" | null {
  const value = raw.trim();
  if (!/^[|>](?:(?:[+-][1-9]?)|(?:[1-9][+-]?))?$/u.test(value)) return null;
  return value.startsWith("|") ? "literal" : "folded";
}

function readSkillBlockScalar(
  lines: readonly string[],
  startIndex: number,
  parentIndent: number,
  style: "literal" | "folded",
  label: string,
): { value: string; nextIndex: number } {
  const captured: { source: string; indent: number }[] = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      captured.push({ source: "", indent: parentIndent + 1 });
      continue;
    }
    const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (indent <= parentIndent) break;
    captured.push({ source: line, indent });
  }
  const contentIndent = captured
    .filter((entry) => entry.source.length > 0)
    .reduce((minimum, entry) => Math.min(minimum, entry.indent), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(contentIndent)) {
    throw new StoryStackError(`${label} block scalar must contain text`, "INVALID_SKILL_FRONTMATTER");
  }
  const content = captured.map((entry) => entry.source.length === 0 ? "" : entry.source.slice(contentIndent));
  const value = style === "literal"
    ? content.join("\n").trimEnd()
    : content.join("\n").split(/\n{2,}/u).map((paragraph) => paragraph.replace(/\n/gu, " ").trim()).join("\n").trimEnd();
  if (value.length === 0) {
    throw new StoryStackError(`${label} block scalar must contain text`, "INVALID_SKILL_FRONTMATTER");
  }
  return { value, nextIndex: index };
}

function validateSkillFrontmatter(source: string, directoryName: string, sourcePath: string): void {
  const normalized = source.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new StoryStackError(`Skill must begin with YAML frontmatter: ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new StoryStackError(`Skill frontmatter is not terminated: ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
  }
  const fields = new Map<string, string>();
  const metadata = new Map<string, string>();
  let acceptsMetadataChildren = false;
  const lines = normalized.slice(4, end).split("\n");
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    if (/^\s/u.test(line)) {
      if (!acceptsMetadataChildren) {
        throw new StoryStackError(`Unexpected nested skill frontmatter in ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
      }
      const match = /^(\s+)([^:#][^:]*)\s*:\s*(.*)$/u.exec(line);
      if (match === null) {
        throw new StoryStackError(`Invalid metadata entry in ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
      }
      const key = match[2]?.trim() ?? "";
      if (key.length === 0 || metadata.has(key)) {
        throw new StoryStackError(`Duplicate or empty skill metadata key in ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
      }
      const rawValue = match[3] ?? "";
      const style = blockScalarStyle(rawValue);
      if (style === null) {
        metadata.set(key, parseSkillScalar(rawValue, `Skill metadata '${key}'`, true));
        index += 1;
      } else {
        const block = readSkillBlockScalar(lines, index + 1, match[1]?.length ?? 0, style, `Skill metadata '${key}'`);
        metadata.set(key, block.value);
        index = block.nextIndex;
      }
      continue;
    }
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) {
      throw new StoryStackError(`Invalid skill frontmatter line in ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
    }
    const key = line.slice(0, delimiter).trim();
    const rawValue = line.slice(delimiter + 1).trim();
    if (fields.has(key) || (key !== "name" && key !== "description" && !OPTIONAL_SKILL_FRONTMATTER.has(key))) {
      throw new StoryStackError(`Unknown or duplicate skill frontmatter field '${key}' in ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
    }
    acceptsMetadataChildren = key === "metadata" && rawValue.length === 0;
    if (key === "metadata") {
      if (rawValue !== "" && rawValue !== "{}") {
        throw new StoryStackError(`Skill metadata must be a mapping in ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
      }
      fields.set(key, rawValue);
      index += 1;
    } else {
      const style = blockScalarStyle(rawValue);
      if (style === null) {
        fields.set(key, parseSkillScalar(rawValue, `Skill ${key}`));
        index += 1;
      } else {
        const block = readSkillBlockScalar(lines, index + 1, 0, style, `Skill ${key}`);
        fields.set(key, block.value);
        index = block.nextIndex;
      }
    }
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) {
    throw new StoryStackError(`Skill frontmatter requires name and description: ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
  }
  if (!SKILL_NAME_PATTERN.test(name) || name !== directoryName) {
    throw new StoryStackError(
      `Skill name must match its directory and use 1-64 lowercase letters, numbers, or single hyphens: ${sourcePath}`,
      "INVALID_SKILL_FRONTMATTER",
    );
  }
  if (description.length === 0 || description.length > 1024) {
    throw new StoryStackError(`Skill description must contain 1-1024 characters: ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
  }
  if (fields.get("metadata") === "" && metadata.size === 0) {
    throw new StoryStackError(`Skill metadata must be a string mapping, not null: ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
  }
  const compatibility = fields.get("compatibility");
  if (compatibility !== undefined && compatibility.length > 500) {
    throw new StoryStackError(`Skill compatibility must contain at most 500 characters: ${sourcePath}`, "INVALID_SKILL_FRONTMATTER");
  }
}

async function portableSourceMode(sourcePath: string): Promise<number> {
  const stats = await lstat(sourcePath);
  return (stats.mode & 0o111) === 0 ? 0o644 : 0o755;
}

async function skillPackageFiles(packageRoot: string, skill: InstalledSkill): Promise<string[]> {
  const sourceRoot = path.join(packageRoot, "skills", skill);
  const rootStats = await lstatOrNull(sourceRoot);
  if (rootStats === null) {
    throw new StoryStackError(`Required installer source directory is missing: ${sourceRoot}`, "MISSING_INSTALL_SOURCE");
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new StoryStackError(`Installer source directory is unsafe: ${sourceRoot}`, "UNSAFE_INSTALL_SOURCE");
  }
  const directEntries = await readdir(sourceRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StoryStackError(`Required installer source directory is missing: ${sourceRoot}`, "MISSING_INSTALL_SOURCE");
    }
    throw error;
  });
  for (const entry of directEntries) {
    if (entry.isSymbolicLink()) {
      throw new StoryStackError(`Installer sources cannot contain symbolic links: ${path.join(sourceRoot, entry.name)}`, "UNSAFE_INSTALL_SOURCE");
    }
    const allowed = entry.name === "SKILL.md" && entry.isFile() ||
      SKILL_RESOURCE_DIRECTORIES.has(entry.name) && entry.isDirectory();
    if (!allowed) {
      throw new StoryStackError(`Canonical skill entry is outside the supported layout: ${path.join(sourceRoot, entry.name)}`, "UNSAFE_INSTALL_SOURCE");
    }
  }
  const skillPath = path.join(sourceRoot, "SKILL.md");
  await assertRegularSource(skillPath);
  validateSkillFrontmatter(await readFile(skillPath, "utf8"), skill, skillPath);
  const files = await listRegularFiles(sourceRoot, true);
  for (const sourcePath of files) {
    const relativePath = `${skill}/${normalizeRelativePath(path.relative(sourceRoot, sourcePath))}`;
    if (!isSkillPath(relativePath)) {
      throw new StoryStackError(`Canonical skill file is outside the supported layout: ${sourcePath}`, "UNSAFE_INSTALL_SOURCE");
    }
  }
  return files;
}

function nodeLauncher(): string {
  return `#!/usr/bin/env node
async function run() {
  const cli = await import("../runtime/dist/src/cli.js");
  if (typeof cli.main !== "function") throw new Error("Installed JustinStack CLI does not export main()");
  process.exitCode = await cli.main(process.argv.slice(2));
}

run().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
`;
}

function windowsLauncher(command: "justinstack" | "story-stack"): string {
  return `@echo off\r
node "%~dp0${command}.js" %*\r
exit /b %errorlevel%\r
`;
}

function runtimePackage(version: string): string {
  return `${JSON.stringify({ name: "justinstack-installed-runtime", version, private: true, type: "module" }, null, 2)}\n`;
}

async function readExistingManifest(manifestPath: string, safetyRoot: string): Promise<ExistingManifest | null> {
  const issue = await inspectParentSafety(safetyRoot, manifestPath);
  if (issue !== null) throw new StoryStackError(issue, "INVALID_INSTALL_MANIFEST");
  const stats = await lstatOrNull(manifestPath);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new StoryStackError("Install manifest is not a regular file", "INVALID_INSTALL_MANIFEST");
  }
  if (stats.size > MAX_MANIFEST_BYTES) {
    throw new StoryStackError("Install manifest exceeds the safe size limit", "INVALID_INSTALL_MANIFEST");
  }
  const source = await readFile(manifestPath, "utf8");
  return { source, sha256: digest(source), manifest: parseInstallManifest(source) };
}

async function inspectParentSafety(safetyRoot: string, targetPath: string): Promise<string | null> {
  assertContained(safetyRoot, targetPath, "Install target");
  let anchor = path.resolve(safetyRoot);
  let anchorStats = await lstatOrNull(anchor);
  while (anchorStats === null) {
    const parent = path.dirname(anchor);
    if (parent === anchor) break;
    anchor = parent;
    anchorStats = await lstatOrNull(anchor);
  }
  if (anchorStats === null || !anchorStats.isDirectory()) return `Destination ancestor is not a directory: ${anchor}`;
  if (anchorStats.isSymbolicLink()) return `Destination ancestor is a symbolic link or junction: ${anchor}`;
  const relativeParent = path.relative(anchor, path.dirname(targetPath));
  let cursor = anchor;
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stats = await lstatOrNull(cursor);
    if (stats === null) break;
    if (stats.isSymbolicLink()) return `Destination parent is a symbolic link or junction: ${cursor}`;
    if (!stats.isDirectory()) return `Destination parent is not a directory: ${cursor}`;
  }
  return null;
}

async function inspectCollision(targetPath: string): Promise<InstallCollision | null> {
  const stats = await lstatOrNull(targetPath);
  if (stats === null) return null;
  const metadata = { size: stats.size, mode: stats.mode & 0o777 };
  if (stats.isSymbolicLink()) return { targetPath, kind: "symbolic-link", sha256: null, ...metadata };
  if (stats.isDirectory()) return { targetPath, kind: "directory", sha256: null, ...metadata };
  if (!stats.isFile()) return { targetPath, kind: "other", sha256: null, ...metadata };
  return { targetPath, kind: "file", sha256: await digestFile(targetPath), ...metadata };
}

function redactDiff(source: string): string {
  return source
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/(["']?(?:token|secret|password|api[_-]?key)["']?\s*:\s*)["'][^"'\r\n]*["']/giu, "$1\"[REDACTED]\"")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;}]+/giu, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/(?:ghp|glpat|sk)-[A-Za-z0-9_-]{12,}/gu, "[REDACTED]");
}

function formatMode(mode: number | null): string {
  return mode === null ? "missing" : `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function modeMatches(actualMode: number | null, expectedMode: number): boolean {
  return process.platform === "win32" || actualMode !== null && (actualMode & 0o777) === expectedMode;
}

function hashOnlyDiff(
  beforeSha256: string | null,
  afterSha256: string,
  targetPath: string,
  beforeMode: number | null = null,
  afterMode: number | null = null,
): string {
  const metadata = afterMode === null
    ? []
    : [`- mode:${formatMode(beforeMode)}`, `+ mode:${formatMode(afterMode)}`];
  return [
    `--- ${redactDiff(targetPath)}`,
    `+++ ${redactDiff(targetPath)} (proposed)`,
    "@@ content-metadata-only @@",
    `- sha256:${beforeSha256 ?? "missing"}`,
    `+ sha256:${afterSha256}`,
    ...metadata,
    "",
  ].join("\n");
}

function boundedDiff(before: Uint8Array | null, after: Uint8Array, targetPath: string): string {
  if (after.byteLength > MAX_DIFF_BYTES || (before?.byteLength ?? 0) > MAX_DIFF_BYTES) {
    return hashOnlyDiff(before === null ? null : digest(before), digest(after), targetPath);
  }
  const beforeLines = before === null ? [] : Buffer.from(before).toString("utf8").split(/\r?\n/u);
  const afterLines = Buffer.from(after).toString("utf8").split(/\r?\n/u);
  const lines = [`--- ${redactDiff(targetPath)}`, `+++ ${redactDiff(targetPath)} (proposed)`, "@@ full bounded file @@"];
  for (const line of beforeLines.slice(0, MAX_DIFF_LINES / 2)) lines.push(`-${redactDiff(line)}`);
  for (const line of afterLines.slice(0, MAX_DIFF_LINES / 2)) lines.push(`+${redactDiff(line)}`);
  if (beforeLines.length + afterLines.length > MAX_DIFF_LINES) lines.push("... diff truncated ...");
  return `${lines.join("\n")}\n`;
}

function proposalDiff(proposal: PlatformProposal): string {
  const lines = proposal.snippet.split(/\r?\n/u).slice(0, MAX_DIFF_LINES);
  return [
    `--- ${redactDiff(proposal.targetPath)} (unchanged)`,
    `+++ ${redactDiff(proposal.targetPath)} (proposal only)`,
    "@@ suggested addition; not applied @@",
    ...lines.map((line) => `+${redactDiff(line)}`),
    ...(proposal.snippet.split(/\r?\n/u).length > MAX_DIFF_LINES ? ["... proposal truncated ..."] : []),
    "",
  ].join("\n");
}

async function materializeProposal(
  proposal: PlatformProposal,
  safetyRoot?: string,
): Promise<ConfigurationProposalView> {
  const safe = safetyRoot === undefined || await inspectParentSafety(safetyRoot, proposal.targetPath) === null;
  const stats = safe ? await lstatOrNull(proposal.targetPath) : null;
  return { ...proposal, targetExists: stats !== null, diff: proposalDiff(proposal) };
}

async function normalizeOptions(options: InstallerOptions): Promise<NormalizedInstallerOptions> {
  const packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot());
  const packageVersion = options.version ?? (await readPackageVersion(packageRoot));
  if (!VERSION_PATTERN.test(packageVersion)) throw new StoryStackError("Installer package version is invalid", "INVALID_PACKAGE");
  const target = options.target ?? "claude";
  const scope = options.scope ?? "global";
  const projectRoot = options.projectRoot ?? await enclosingGitRoot(options.cwd ?? process.cwd());
  const paths = resolveInstallPaths(options.userHome ?? os.homedir(), {
    ...(options.justinStackHome === undefined ? {} : { justinStackHome: options.justinStackHome }),
    ...(options.storyStackHome === undefined ? {} : { storyStackHome: options.storyStackHome }),
    projectRoot,
    ...(options.claudeSkillsRoot === undefined ? {} : { claudeSkillsRoot: options.claudeSkillsRoot }),
    ...(options.bobSkillsRoot === undefined ? {} : { bobSkillsRoot: options.bobSkillsRoot }),
    ...(options.codexSkillsRoot === undefined ? {} : { codexSkillsRoot: options.codexSkillsRoot }),
    ...(options.claudeConfigDir == null ? {} : { claudeConfigDir: options.claudeConfigDir }),
    ...(options.codexHome == null ? {} : { codexHome: options.codexHome }),
    ...(options.skillRoots === undefined ? {} : { skillRoots: options.skillRoots }),
    target,
    scope,
  });
  return {
    packageRoot,
    packageVersion,
    userHome: paths.userHome,
    justinStackHome: paths.justinRoot,
    target,
    scope,
    projectRoot: paths.projectRoot,
    skillRoots: paths.skillRoots,
    ...(paths.claudeConfigDir === null ? {} : { claudeConfigDir: paths.claudeConfigDir }),
    ...(paths.codexHome === null ? {} : { codexHome: paths.codexHome }),
  };
}

function runtimeDescriptors(
  packageRoot: string,
  justinRoot: string,
  safetyRoot: string,
  version: string,
): Promise<FileDescriptor[]> {
  return (async () => {
    const descriptors: FileDescriptor[] = [];
    for (const [compiledRoot, relativeRoot] of [
      [path.join(packageRoot, "dist", "src"), "runtime/dist/src"],
      [path.join(packageRoot, "dist", "adapters"), "runtime/dist/adapters"],
    ] as const) {
      for (const sourcePath of await listRegularFiles(compiledRoot, true)) {
        if (!sourcePath.endsWith(".js")) continue;
        descriptors.push({
          root: "justinstack",
          destinationRoot: justinRoot,
          safetyRoot,
          relativePath: `${relativeRoot}/${normalizeRelativePath(path.relative(compiledRoot, sourcePath))}`,
          kind: "copy",
          sourcePath,
          generatedContents: null,
          mode: 0o644,
          installationKey: null,
        });
      }
    }
    for (const [relativePath, sourcePath] of [
      ["runtime/templates/context.v1.md", path.join(packageRoot, "templates", "context.v1.md")],
      ["runtime/policies/checkpoint-protocol.md", path.join(packageRoot, "policies", "checkpoint-protocol.md")],
      ["policies/checkpoint-protocol.md", path.join(packageRoot, "policies", "checkpoint-protocol.md")],
    ] as const) {
      descriptors.push({
        root: "justinstack",
        destinationRoot: justinRoot,
        safetyRoot,
        relativePath,
        kind: "copy",
        sourcePath,
        generatedContents: null,
        mode: 0o644,
        installationKey: null,
      });
    }
    for (const skill of INSTALLED_SKILLS) {
      const sourceRoot = path.join(packageRoot, "skills", skill);
      for (const sourcePath of await skillPackageFiles(packageRoot, skill)) {
        const child = normalizeRelativePath(path.relative(sourceRoot, sourcePath));
        descriptors.push({
          root: "justinstack",
          destinationRoot: justinRoot,
          safetyRoot,
          relativePath: `runtime/skills/${skill}/${child}`,
          kind: "copy",
          sourcePath,
          generatedContents: null,
          mode: await portableSourceMode(sourcePath),
          installationKey: null,
        });
      }
    }
    for (const [relativePath, contents, mode] of [
      ["runtime/package.json", runtimePackage(version), 0o644],
      ["bin/justinstack.js", nodeLauncher(), 0o755],
      ["bin/justinstack", nodeLauncher(), 0o755],
      ["bin/justinstack.cmd", windowsLauncher("justinstack"), 0o644],
      ["bin/story-stack.js", nodeLauncher(), 0o755],
      ["bin/story-stack", nodeLauncher(), 0o755],
      ["bin/story-stack.cmd", windowsLauncher("story-stack"), 0o644],
    ] as const) {
      descriptors.push({
        root: "justinstack",
        destinationRoot: justinRoot,
        safetyRoot,
        relativePath,
        kind: "generated",
        sourcePath: null,
        generatedContents: contents,
        mode,
        installationKey: null,
      });
    }
    return descriptors;
  })();
}

async function skillDescriptors(
  packageRoot: string,
  target: PlatformTarget,
  scope: InstallScope,
  projectRoot: string,
  skillsRoot: string,
  safetyRoot: string,
): Promise<FileDescriptor[]> {
  const descriptors: FileDescriptor[] = [];
  const key = installationKey(scope, target, projectRoot);
  for (const skill of INSTALLED_SKILLS) {
    const sourceRoot = path.join(packageRoot, "skills", skill);
    for (const sourcePath of await skillPackageFiles(packageRoot, skill)) {
      const child = normalizeRelativePath(path.relative(sourceRoot, sourcePath));
      const relativePath = `${skill}/${child}`;
      if (!isSkillPath(relativePath)) {
        throw new StoryStackError(`Canonical skill file is outside the supported layout: ${sourcePath}`, "UNSAFE_INSTALL_SOURCE");
      }
      descriptors.push({
        root: `${target}-skills`,
        destinationRoot: skillsRoot,
        safetyRoot,
        relativePath,
        kind: "copy",
        sourcePath,
        generatedContents: null,
        mode: await portableSourceMode(sourcePath),
        installationKey: key,
      });
    }
  }
  return descriptors;
}

async function descriptorContents(descriptor: FileDescriptor): Promise<Uint8Array> {
  if (descriptor.sourcePath !== null) {
    await assertRegularSource(descriptor.sourcePath);
    return readFile(descriptor.sourcePath);
  }
  if (descriptor.generatedContents === null) throw new StoryStackError("Generated install entry has no contents", "INSTALL_INTERNAL_ERROR");
  return Buffer.from(descriptor.generatedContents, "utf8");
}

function ownershipMap(
  manifest: InstallManifestV2 | null,
  paths: InstallPaths,
): Map<string, string> {
  const owned = new Map<string, string>();
  if (manifest === null) return owned;
  for (const entry of manifest.runtime_entries) {
    owned.set(path.resolve(nativePath(paths.justinRoot, entry.path)), entry.sha256);
  }
  for (const installation of manifest.installations) {
    if (installation.destination_root === null) continue;
    for (const entry of installation.entries) {
      owned.set(path.resolve(nativePath(installation.destination_root, entry.path)), entry.sha256);
    }
  }
  return owned;
}

async function materializeDescriptor(
  descriptor: FileDescriptor,
  owned: Map<string, string>,
): Promise<InstallPlanEntry> {
  assertManifestRelativePath(descriptor.relativePath);
  if (descriptor.root === "justinstack" ? !isRuntimePath(descriptor.relativePath) : !isSkillPath(descriptor.relativePath)) {
    throw new StoryStackError(`Installer target is not allowlisted: ${descriptor.relativePath}`, "UNSAFE_INSTALL_TARGET");
  }
  const targetPath = path.resolve(nativePath(descriptor.destinationRoot, descriptor.relativePath));
  assertContained(descriptor.destinationRoot, targetPath, "Install target");
  const contents = await descriptorContents(descriptor);
  const sha256 = digest(contents);
  const safety = await inspectParentSafety(descriptor.safetyRoot, targetPath);
  const collision = safety === null ? await inspectCollision(targetPath) : null;
  let action: InstallAction = "create";
  let managed = false;
  let actionableCollision: InstallCollision | null = null;
  let diff: string | null = null;
  if (safety !== null) action = "unsafe";
  else if (collision !== null) {
    if (collision.kind !== "file") {
      action = "unsafe";
      actionableCollision = collision;
    } else if (collision.sha256 === sha256) {
      managed = owned.get(targetPath) === collision.sha256;
      if (managed && !modeMatches(collision.mode, descriptor.mode)) {
        action = "replace";
        diff = hashOnlyDiff(collision.sha256, sha256, targetPath, collision.mode, descriptor.mode);
      } else {
        action = "unchanged";
      }
    } else {
      action = "replace";
      managed = owned.get(targetPath) === collision.sha256;
      if (!managed) actionableCollision = collision;
      diff = !managed || (collision.size ?? 0) > MAX_DIFF_BYTES
        ? hashOnlyDiff(collision.sha256, sha256, targetPath, collision.mode, descriptor.mode)
        : boundedDiff(await readFile(targetPath), contents, targetPath);
    }
  }
  return {
    ...descriptor,
    targetPath,
    sha256,
    action,
    managed,
    previousSha256: collision?.sha256 ?? null,
    previousMode: collision?.mode ?? null,
    collision: actionableCollision,
    diff,
  };
}

interface ObsoleteMaterialization {
  planEntry: InstallPlanEntry | null;
  preservedEntry: ManifestFileEntry | null;
}

async function materializeObsolete(
  root: InstallRoot,
  destinationRoot: string,
  safetyRoot: string,
  manifestEntry: ManifestFileEntry,
  key: string | null,
): Promise<ObsoleteMaterialization> {
  const targetPath = path.resolve(nativePath(destinationRoot, manifestEntry.path));
  assertContained(destinationRoot, targetPath, "Obsolete install target");
  const safety = await inspectParentSafety(safetyRoot, targetPath);
  const collision = safety === null ? await inspectCollision(targetPath) : null;
  if (safety === null && collision === null) return { planEntry: null, preservedEntry: null };

  const canRemove = collision?.kind === "file" && collision.sha256 === manifestEntry.sha256;
  const reason = canRemove
    ? "Canonical source no longer contains this installer-owned file; remove the hash-matching obsolete copy."
    : safety ?? "Obsolete managed file was modified or changed type; preserve it and retain manifest ownership.";
  return {
    planEntry: {
      root,
      destinationRoot,
      safetyRoot,
      relativePath: manifestEntry.path,
      targetPath,
      kind: "obsolete",
      sourcePath: null,
      generatedContents: null,
      sha256: manifestEntry.sha256,
      mode: 0o644,
      action: canRemove ? "remove" : "preserve",
      managed: true,
      previousSha256: collision?.sha256 ?? null,
      previousMode: collision?.mode ?? null,
      collision: null,
      diff: reason,
      installationKey: key,
    },
    preservedEntry: canRemove ? null : { ...manifestEntry },
  };
}

function sortedManifestFiles(entries: readonly InstallPlanEntry[]): ManifestFileEntry[] {
  return entries
    .map((entry) => ({ path: entry.relativePath, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function ownedManifestFilesAfterApply(entries: readonly InstallPlanEntry[]): ManifestFileEntry[] {
  return sortedManifestFiles(entries.filter((entry) => entry.action !== "unchanged" || entry.managed));
}

function mergeManifestFiles(...groups: readonly ManifestFileEntry[][]): ManifestFileEntry[] {
  const byPath = new Map<string, ManifestFileEntry>();
  for (const group of groups) for (const entry of group) byPath.set(entry.path, { ...entry });
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function planBackupOperations(
  entries: readonly InstallPlanEntry[],
  paths: InstallPaths,
  safetyIssues: InstallSafetyIssue[],
): Promise<{ backupRoot: string | null; backupOperations: InstallBackupOperation[] }> {
  const replacing = entries.filter(
    (entry) =>
      (entry.action === "replace" || entry.action === "remove") && entry.previousSha256 !== null,
  );
  if (replacing.length === 0) return { backupRoot: null, backupOperations: [] };
  const setId = digest(JSON.stringify(replacing.map((entry) => ({
    targetPath: entry.targetPath,
    before: entry.previousSha256,
    after: entry.sha256,
    action: entry.action,
  })))).slice(0, 20);
  const backupRoot = path.join(paths.justinRoot, "backups", `install-${setId}`);
  const backupOperations: InstallBackupOperation[] = [];
  for (const [index, entry] of replacing.entries()) {
    const previousSha256 = entry.previousSha256;
    if (previousSha256 === null) continue;
    const targetPath = path.join(
      backupRoot,
      `${String(index).padStart(4, "0")}-${digest(entry.targetPath).slice(0, 12)}-${path.basename(entry.targetPath)}`,
    );
    assertContained(paths.justinRoot, targetPath, "Backup target");
    const parentIssue = await inspectParentSafety(safetyRootFor(paths, paths.justinRoot), targetPath);
    const collision = parentIssue === null ? await inspectCollision(targetPath) : null;
    const reusable = collision?.kind === "file" && collision.sha256 === previousSha256;
    const action: InstallBackupAction = parentIssue !== null || (collision !== null && !reusable)
      ? "unsafe"
      : reusable
        ? "unchanged"
        : "create";
    if (action === "unsafe") {
      safetyIssues.push({
        targetPath,
        message: parentIssue ?? "Backup target already exists with different contents or an unsafe file type",
      });
    }
    backupOperations.push({ sourcePath: entry.targetPath, targetPath, sha256: previousSha256, action, collision });
  }
  return { backupRoot, backupOperations };
}

function planFingerprint(
  entries: readonly InstallPlanEntry[],
  proposals: readonly ConfigurationProposalView[],
  backups: readonly InstallBackupOperation[],
): string {
  return digest(JSON.stringify({
    entries: entries.map((entry) => ({
      targetPath: entry.targetPath,
      sha256: entry.sha256,
      previousSha256: entry.previousSha256,
      previousMode: entry.previousMode,
      action: entry.action,
      managed: entry.managed,
    })),
    proposals: proposals.map((proposal) => ({ id: proposal.id, targetPath: proposal.targetPath })),
    backups: backups.map((backup) => ({
      sourcePath: backup.sourcePath,
      targetPath: backup.targetPath,
      sha256: backup.sha256,
      action: backup.action,
    })),
  }));
}

export async function planInstall(options: InstallerOptions = {}): Promise<InstallPlan> {
  const normalized = await normalizeOptions(options);
  const paths = resolveInstallPaths(normalized.userHome, {
    justinStackHome: normalized.justinStackHome,
    projectRoot: normalized.projectRoot,
    target: normalized.target,
    scope: normalized.scope,
    skillRoots: normalized.skillRoots,
    ...(normalized.claudeConfigDir === undefined ? {} : { claudeConfigDir: normalized.claudeConfigDir }),
    ...(normalized.codexHome === undefined ? {} : { codexHome: normalized.codexHome }),
  });
  const safetyIssues: InstallSafetyIssue[] = [];
  let existing: ExistingManifest | null = null;
  const manifestSafetyRoot = safetyRootFor(paths, paths.justinRoot);
  const manifestParentIssue = await inspectParentSafety(manifestSafetyRoot, paths.manifestPath);
  if (manifestParentIssue !== null) {
    safetyIssues.push({ targetPath: paths.manifestPath, message: manifestParentIssue });
  } else {
    try {
      existing = await readExistingManifest(paths.manifestPath, manifestSafetyRoot);
    } catch (error) {
      safetyIssues.push({ targetPath: paths.manifestPath, message: errorMessage(error) });
    }
  }
  if (existing?.manifest.schema_version === 1) {
    safetyIssues.push({
      targetPath: paths.manifestPath,
      message: "A legacy schema-v1 install manifest is present. Uninstall that managed installation before applying schema v2.",
    });
  }
  const existingV2 = existing?.manifest.schema_version === 2 ? existing.manifest : null;
  const owned = ownershipMap(existingV2, paths);
  const descriptors = await runtimeDescriptors(
    normalized.packageRoot,
    paths.justinRoot,
    safetyRootFor(paths, paths.justinRoot),
    normalized.packageVersion,
  );
  for (const target of expandPlatformTargets(normalized.target)) {
    const root = paths.skillRoots[target];
    if (root === undefined) throw new StoryStackError(`Missing skill root for ${target}`, "INSTALL_INTERNAL_ERROR");
    descriptors.push(...await skillDescriptors(
      normalized.packageRoot,
      target,
      normalized.scope,
      normalized.projectRoot,
      root,
      safetyRootFor(paths, root),
    ));
  }
  descriptors.sort((left, right) =>
    `${left.destinationRoot}:${left.relativePath}`.localeCompare(`${right.destinationRoot}:${right.relativePath}`, "en"));
  const entries: InstallPlanEntry[] = [];
  for (const descriptor of descriptors) entries.push(await materializeDescriptor(descriptor, owned));

  const currentRuntimeEntries = entries.filter((entry) => entry.root === "justinstack");
  const currentRuntimeManifest = ownedManifestFilesAfterApply(currentRuntimeEntries);
  const currentRuntimePaths = new Set(currentRuntimeManifest.map((entry) => entry.path));
  const preservedRuntime: ManifestFileEntry[] = [];
  for (const prior of existingV2?.runtime_entries ?? []) {
    if (currentRuntimePaths.has(prior.path)) continue;
    const obsolete = await materializeObsolete(
      "justinstack",
      paths.justinRoot,
      safetyRootFor(paths, paths.justinRoot),
      prior,
      null,
    );
    if (obsolete.planEntry !== null) entries.push(obsolete.planEntry);
    if (obsolete.preservedEntry !== null) preservedRuntime.push(obsolete.preservedEntry);
  }

  const records = new Map((existingV2?.installations ?? []).map((record) => [record.key, record]));
  for (const target of expandPlatformTargets(normalized.target)) {
    const key = installationKey(normalized.scope, target, normalized.projectRoot);
    const root = paths.skillRoots[target];
    if (root === undefined) throw new StoryStackError(`Missing skill root for ${target}`, "INSTALL_INTERNAL_ERROR");
    const targetEntries = entries.filter((entry) => entry.installationKey === key && entry.kind !== "obsolete");
    const currentTargetManifest = ownedManifestFilesAfterApply(targetEntries);
    const currentTargetPaths = new Set(currentTargetManifest.map((entry) => entry.path));
    const previousRecord = records.get(key);
    const preservedTarget: ManifestFileEntry[] = [];
    if (previousRecord?.destination_root === null) {
      safetyIssues.push({
        targetPath: paths.manifestPath,
        message: `Installed ${target} record predates destination tracking; its files cannot be upgraded safely without a recorded root.`,
      });
    } else if (previousRecord !== undefined && !samePath(previousRecord.destination_root, root)) {
      safetyIssues.push({
        targetPath: previousRecord.destination_root,
        message: `Refusing to relocate ${target} skills implicitly. Uninstall the recorded installation before choosing a different root.`,
      });
    } else if (previousRecord !== undefined) {
      for (const prior of previousRecord.entries) {
        if (currentTargetPaths.has(prior.path)) continue;
        const obsolete = await materializeObsolete(
          `${target}-skills`,
          root,
          safetyRootFor(paths, root),
          prior,
          key,
        );
        if (obsolete.planEntry !== null) entries.push(obsolete.planEntry);
        if (obsolete.preservedEntry !== null) preservedTarget.push(obsolete.preservedEntry);
      }
    }
    records.set(key, {
      key,
      target,
      scope: normalized.scope,
      workspace_id: normalized.scope === "project" ? workspaceId(normalized.projectRoot) : null,
      destination_root: root,
      entries: mergeManifestFiles(currentTargetManifest, preservedTarget),
    });
  }
  const manifest: InstallManifestV2 = {
    schema_version: INSTALL_MANIFEST_SCHEMA_VERSION,
    package_version: normalized.packageVersion,
    runtime_entries: mergeManifestFiles(currentRuntimeManifest, preservedRuntime),
    installations: [...records.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
  };
  const manifestContents = serializeManifest(manifest);
  const manifestBytes = Buffer.from(manifestContents, "utf8");
  const manifestStats = manifestParentIssue === null ? await lstatOrNull(paths.manifestPath) : null;
  let manifestCollision: InstallCollision | null = null;
  let manifestAction: InstallAction = manifestParentIssue === null ? "create" : "unsafe";
  let manifestManaged = existingV2 !== null;
  let manifestPreviousSha: string | null = null;
  let manifestDiff: string | null = null;
  if (manifestStats !== null) {
    if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
      manifestAction = "unsafe";
      manifestCollision = await inspectCollision(paths.manifestPath);
      manifestManaged = false;
    } else {
      manifestPreviousSha = await digestFile(paths.manifestPath);
      if (manifestPreviousSha === digest(manifestBytes) && modeMatches(manifestStats.mode & 0o777, 0o600)) {
        manifestAction = "unchanged";
      }
      else {
        manifestAction = "replace";
        manifestDiff = !manifestManaged || manifestStats.size > MAX_DIFF_BYTES || manifestPreviousSha === digest(manifestBytes)
          ? hashOnlyDiff(manifestPreviousSha, digest(manifestBytes), paths.manifestPath, manifestStats.mode & 0o777, 0o600)
          : boundedDiff(await readFile(paths.manifestPath), manifestBytes, paths.manifestPath);
        if (!manifestManaged) manifestCollision = await inspectCollision(paths.manifestPath);
      }
    }
  }
  entries.push({
    root: "justinstack",
    destinationRoot: paths.justinRoot,
    safetyRoot: safetyRootFor(paths, paths.justinRoot),
    relativePath: INSTALL_MANIFEST_FILENAME,
    targetPath: paths.manifestPath,
    kind: "manifest",
    sourcePath: null,
    generatedContents: manifestContents,
    sha256: digest(manifestBytes),
    mode: 0o600,
    action: manifestAction,
    managed: manifestManaged,
    previousSha256: manifestPreviousSha,
    previousMode: manifestStats === null ? null : manifestStats.mode & 0o777,
    collision: manifestCollision,
    diff: manifestDiff,
    installationKey: null,
  });

  for (const entry of entries) {
    if (entry.action === "preserve") continue;
    const issue = await inspectParentSafety(entry.safetyRoot, entry.targetPath);
    if (issue !== null) safetyIssues.push({ targetPath: entry.targetPath, message: issue });
  }
  const { backupRoot, backupOperations } = await planBackupOperations(entries, paths, safetyIssues);
  const configurationProposals: ConfigurationProposalView[] = [];
  const doctorReminders: DoctorReminder[] = [];
  for (const target of expandPlatformTargets(normalized.target)) {
    const context: AdapterPaths = {
      userHome: normalized.userHome,
      projectRoot: normalized.projectRoot,
      justinStackHome: paths.justinRoot,
      ...(normalized.claudeConfigDir === undefined ? {} : { claudeConfigDir: normalized.claudeConfigDir }),
      ...(normalized.codexHome === undefined ? {} : { codexHome: normalized.codexHome }),
    };
    const adapter = getPlatformAdapter(target);
    for (const proposal of adapter.proposals(normalized.scope, context)) {
      configurationProposals.push(await materializeProposal(
        proposal,
        proposalSafetyRoot(target, normalized, paths),
      ));
    }
    doctorReminders.push(...adapter.doctorReminders(normalized.scope, context));
  }
  return {
    packageRoot: normalized.packageRoot,
    packageVersion: normalized.packageVersion,
    userHome: normalized.userHome,
    projectRoot: normalized.projectRoot,
    target: normalized.target,
    targets: expandPlatformTargets(normalized.target),
    scope: normalized.scope,
    justinRoot: paths.justinRoot,
    storyRoot: paths.justinRoot,
    skillsRoot: paths.skillsRoot,
    skillRoots: paths.skillRoots,
    ...(paths.claudeConfigDir === null ? {} : { claudeConfigDir: paths.claudeConfigDir }),
    ...(paths.codexHome === null ? {} : { codexHome: paths.codexHome }),
    manifestPath: paths.manifestPath,
    entries,
    collisions: entries.flatMap((entry) => entry.collision === null ? [] : [entry.collision]),
    safetyIssues,
    configurationProposals,
    doctorReminders,
    backupRoot,
    backupOperations,
    manifest,
    fingerprint: planFingerprint(entries, configurationProposals, backupOperations),
    normalizedOptions: normalized,
  };
}

function isInstallPlan(value: InstallPlan | InstallerOptions): value is InstallPlan {
  return "entries" in value && Array.isArray(value.entries) && typeof value.fingerprint === "string";
}

async function entryContents(entry: InstallPlanEntry): Promise<Uint8Array> {
  if (entry.sourcePath !== null) {
    await assertRegularSource(entry.sourcePath);
    const contents = await readFile(entry.sourcePath);
    if (digest(contents) !== entry.sha256) {
      throw new StoryStackError(`Installer source changed after planning: ${entry.sourcePath}`, "INSTALL_PLAN_STALE");
    }
    return contents;
  }
  if (entry.generatedContents === null || digest(entry.generatedContents) !== entry.sha256) {
    throw new StoryStackError(`Generated installer entry is inconsistent: ${entry.targetPath}`, "INSTALL_PLAN_STALE");
  }
  return Buffer.from(entry.generatedContents, "utf8");
}

async function assertTargetMatchesPlan(entry: InstallPlanEntry): Promise<void> {
  const current = await inspectCollision(entry.targetPath);
  if (entry.previousSha256 === null) {
    if (current !== null) throw new StoryStackError(`Install target appeared after preflight: ${entry.targetPath}`, "INSTALL_PLAN_STALE");
    return;
  }
  if (current === null || current.kind !== "file" || current.sha256 !== entry.previousSha256 ||
    entry.previousMode !== null && !modeMatches(current.mode, entry.previousMode)) {
    throw new StoryStackError(`Install target changed after preflight: ${entry.targetPath}`, "INSTALL_PLAN_STALE");
  }
}

function transactionJournalPath(justinRoot: string): string {
  return path.join(justinRoot, INSTALL_TRANSACTION_FILENAME);
}

function assertAbsoluteNormalizedPath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 4096 ||
    /[\0-\x1f\x7f]/u.test(value) || !path.isAbsolute(value) || path.resolve(value) !== value ||
    value === path.parse(value).root
  ) {
    throw new StoryStackError(`${label} is invalid`, "INVALID_INSTALL_TRANSACTION");
  }
}

function assertTransactionMode(value: unknown, nullable: boolean, label: string): asserts value is number | null {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    throw new StoryStackError(`${label} is invalid`, "INVALID_INSTALL_TRANSACTION");
  }
}

function assertTransactionSha(value: unknown, nullable: boolean, label: string): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new StoryStackError(`${label} is invalid`, "INVALID_INSTALL_TRANSACTION");
  }
}

function manifestEntriesForTransaction(
  manifest: InstallManifestV2,
  root: InstallTransactionEntry["root"],
  destinationRoot: string,
): ManifestFileEntry[] {
  if (root === "justinstack") return manifest.runtime_entries;
  const target = root.slice(0, -"-skills".length) as PlatformTarget;
  return manifest.installations
    .filter((record) => record.target === target && record.destination_root !== null && samePath(record.destination_root, destinationRoot))
    .flatMap((record) => record.entries);
}

function parseInstallTransaction(source: string, paths: InstallTransactionPaths): InstallTransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new StoryStackError("Install transaction journal is not valid JSON", "INVALID_INSTALL_TRANSACTION");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoryStackError("Install transaction journal must be an object", "INVALID_INSTALL_TRANSACTION");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "created_at", "entries", "justin_root", "manifest", "manifest_after_mode", "manifest_after_sha256",
    "manifest_before_mode", "manifest_before_sha256", "manifest_path", "pid", "plan_fingerprint", "project_root",
    "schema_version", "transaction_id", "user_home",
  ].sort().join(",");
  if (Object.keys(record).sort().join(",") !== expectedKeys || record.schema_version !== 1) {
    throw new StoryStackError("Install transaction journal has missing or unknown fields", "INVALID_INSTALL_TRANSACTION");
  }
  if (typeof record.transaction_id !== "string" || !/^[0-9a-f-]{36}$/u.test(record.transaction_id)) {
    throw new StoryStackError("Install transaction id is invalid", "INVALID_INSTALL_TRANSACTION");
  }
  if (typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) {
    throw new StoryStackError("Install transaction timestamp is invalid", "INVALID_INSTALL_TRANSACTION");
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new StoryStackError("Install transaction pid is invalid", "INVALID_INSTALL_TRANSACTION");
  }
  if (typeof record.plan_fingerprint !== "string" || !SHA256_PATTERN.test(record.plan_fingerprint)) {
    throw new StoryStackError("Install transaction fingerprint is invalid", "INVALID_INSTALL_TRANSACTION");
  }
  assertAbsoluteNormalizedPath(record.user_home, "Install transaction user home");
  assertAbsoluteNormalizedPath(record.project_root, "Install transaction project root");
  assertAbsoluteNormalizedPath(record.justin_root, "Install transaction runtime root");
  assertAbsoluteNormalizedPath(record.manifest_path, "Install transaction manifest path");
  if (!samePath(record.user_home, paths.userHome) || !samePath(record.justin_root, paths.justinRoot) ||
    !samePath(record.manifest_path, paths.manifestPath)) {
    throw new StoryStackError("Install transaction journal belongs to a different runtime", "INVALID_INSTALL_TRANSACTION");
  }
  assertTransactionSha(record.manifest_before_sha256, true, "Install transaction prior manifest hash");
  assertTransactionMode(record.manifest_before_mode, true, "Install transaction prior manifest mode");
  if ((record.manifest_before_sha256 === null) !== (record.manifest_before_mode === null)) {
    throw new StoryStackError("Install transaction prior manifest metadata is inconsistent", "INVALID_INSTALL_TRANSACTION");
  }
  assertTransactionSha(record.manifest_after_sha256, false, "Install transaction manifest hash");
  assertTransactionMode(record.manifest_after_mode, false, "Install transaction manifest mode");
  const serializedCandidateManifest = JSON.stringify(record.manifest);
  if (serializedCandidateManifest === undefined) {
    throw new StoryStackError("Install transaction manifest is missing", "INVALID_INSTALL_TRANSACTION");
  }
  const parsedManifest = parseInstallManifest(serializedCandidateManifest);
  if (parsedManifest.schema_version !== INSTALL_MANIFEST_SCHEMA_VERSION ||
    digest(serializeManifest(parsedManifest)) !== record.manifest_after_sha256 || record.manifest_after_mode !== 0o600) {
    throw new StoryStackError("Install transaction manifest is inconsistent", "INVALID_INSTALL_TRANSACTION");
  }
  if (!Array.isArray(record.entries) || record.entries.length > 10_000) {
    throw new StoryStackError("Install transaction entries must be a bounded array", "INVALID_INSTALL_TRANSACTION");
  }

  const entries: InstallTransactionEntry[] = [];
  const targetPaths = new Set<string>();
  for (const valueEntry of record.entries) {
    if (typeof valueEntry !== "object" || valueEntry === null || Array.isArray(valueEntry)) {
      throw new StoryStackError("Install transaction entry must be an object", "INVALID_INSTALL_TRANSACTION");
    }
    const candidate = valueEntry as Record<string, unknown>;
    const entryKeys = [
      "action", "after_mode", "after_sha256", "backup_path", "before_mode", "before_sha256", "destination_root",
      "relative_path", "root", "state", "target_path",
    ].sort().join(",");
    if (Object.keys(candidate).sort().join(",") !== entryKeys) {
      throw new StoryStackError("Install transaction entry has missing or unknown fields", "INVALID_INSTALL_TRANSACTION");
    }
    if (candidate.root !== "justinstack" && candidate.root !== "claude-skills" &&
      candidate.root !== "bob-skills" && candidate.root !== "codex-skills") {
      throw new StoryStackError("Install transaction entry has an invalid root", "INVALID_INSTALL_TRANSACTION");
    }
    if (candidate.action !== "create" && candidate.action !== "replace" && candidate.action !== "remove") {
      throw new StoryStackError("Install transaction entry has an invalid action", "INVALID_INSTALL_TRANSACTION");
    }
    if (candidate.state !== "pending" && candidate.state !== "applied") {
      throw new StoryStackError("Install transaction entry has an invalid progress state", "INVALID_INSTALL_TRANSACTION");
    }
    assertAbsoluteNormalizedPath(candidate.destination_root, "Install transaction destination root");
    assertAbsoluteNormalizedPath(candidate.target_path, "Install transaction target path");
    assertManifestRelativePath(candidate.relative_path);
    const destinationRoot = candidate.destination_root as string;
    const targetPath = candidate.target_path as string;
    const relativePath = candidate.relative_path as string;
    const root = candidate.root as InstallTransactionEntry["root"];
    const action = candidate.action as TransactionAction;
    const relativePathAllowed = root === "justinstack"
      ? isRuntimePath(relativePath)
      : action === "remove" ? isManifestSkillPath(relativePath) : isSkillPath(relativePath);
    if (!relativePathAllowed || root === "justinstack" && !samePath(destinationRoot, paths.justinRoot)) {
      throw new StoryStackError("Install transaction entry is outside the owned-file allowlist", "INVALID_INSTALL_TRANSACTION");
    }
    const expectedTarget = path.resolve(nativePath(destinationRoot, relativePath));
    if (!samePath(expectedTarget, targetPath)) {
      throw new StoryStackError("Install transaction target is inconsistent", "INVALID_INSTALL_TRANSACTION");
    }
    assertTransactionSha(candidate.before_sha256, true, "Install transaction prior hash");
    assertTransactionMode(candidate.before_mode, true, "Install transaction prior mode");
    assertTransactionSha(candidate.after_sha256, true, "Install transaction resulting hash");
    assertTransactionMode(candidate.after_mode, true, "Install transaction resulting mode");
    if (candidate.backup_path !== null) assertAbsoluteNormalizedPath(candidate.backup_path, "Install transaction backup path");
    const hasBefore = candidate.before_sha256 !== null && candidate.before_mode !== null && candidate.backup_path !== null;
    const hasAfter = candidate.after_sha256 !== null && candidate.after_mode !== null;
    if ((action === "create" && (hasBefore || !hasAfter)) ||
      (action === "replace" && (!hasBefore || !hasAfter)) ||
      (action === "remove" && (!hasBefore || hasAfter)) ||
      (!hasBefore && (candidate.before_sha256 !== null || candidate.before_mode !== null || candidate.backup_path !== null))) {
      throw new StoryStackError("Install transaction entry metadata is inconsistent", "INVALID_INSTALL_TRANSACTION");
    }
    if (action === "replace" && candidate.before_sha256 === candidate.after_sha256 && candidate.before_mode === candidate.after_mode) {
      throw new StoryStackError("Install transaction replacement has no observable change", "INVALID_INSTALL_TRANSACTION");
    }
    if (candidate.backup_path !== null && !isContained(path.join(paths.justinRoot, "backups"), candidate.backup_path)) {
      throw new StoryStackError("Install transaction backup escapes the backup root", "INVALID_INSTALL_TRANSACTION");
    }
    if (root !== "justinstack") {
      const target = root.slice(0, -"-skills".length) as PlatformTarget;
      const ownsDestination = parsedManifest.installations.some((installation) =>
        installation.target === target && installation.destination_root !== null &&
        samePath(installation.destination_root, destinationRoot));
      if (!ownsDestination) {
        throw new StoryStackError("Install transaction skill root is absent from its manifest", "INVALID_INSTALL_TRANSACTION");
      }
    }
    const manifestEntries = manifestEntriesForTransaction(parsedManifest, root, destinationRoot);
    const desired = manifestEntries.find((entry) => entry.path === relativePath);
    if ((action === "remove" && desired !== undefined) ||
      (action !== "remove" && (desired === undefined || desired.sha256 !== candidate.after_sha256))) {
      throw new StoryStackError("Install transaction entry disagrees with its manifest", "INVALID_INSTALL_TRANSACTION");
    }
    if (targetPaths.has(targetPath)) {
      throw new StoryStackError("Install transaction contains duplicate target paths", "INVALID_INSTALL_TRANSACTION");
    }
    targetPaths.add(targetPath);
    entries.push({
      root,
      destination_root: destinationRoot,
      relative_path: relativePath,
      target_path: targetPath,
      action,
      before_sha256: candidate.before_sha256,
      before_mode: candidate.before_mode,
      after_sha256: candidate.after_sha256,
      after_mode: candidate.after_mode,
      backup_path: candidate.backup_path,
      state: candidate.state,
    });
  }
  return {
    schema_version: 1,
    transaction_id: record.transaction_id,
    created_at: record.created_at,
    pid: record.pid as number,
    user_home: record.user_home,
    project_root: record.project_root,
    justin_root: record.justin_root,
    plan_fingerprint: record.plan_fingerprint,
    manifest_path: record.manifest_path,
    manifest_before_sha256: record.manifest_before_sha256,
    manifest_before_mode: record.manifest_before_mode,
    manifest_after_sha256: record.manifest_after_sha256,
    manifest_after_mode: record.manifest_after_mode,
    manifest: parsedManifest,
    entries,
  };
}

function serializeInstallTransaction(journal: InstallTransactionJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not consistently supported on Windows.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeInstallTransaction(paths: InstallTransactionPaths, expectedSha256: string): Promise<void> {
  const journalPath = transactionJournalPath(paths.justinRoot);
  const issue = await inspectParentSafety(safetyRootFor(paths, paths.justinRoot), journalPath);
  if (issue !== null) throw new StoryStackError(issue, "INVALID_INSTALL_TRANSACTION");
  const collision = await inspectCollision(journalPath);
  if (collision === null) return;
  if (collision.kind !== "file" || collision.sha256 !== expectedSha256) {
    throw new StoryStackError("Install transaction journal changed during recovery", "INVALID_INSTALL_TRANSACTION");
  }
  await unlink(journalPath);
  await syncDirectory(path.dirname(journalPath));
}

async function readInstallTransaction(paths: InstallTransactionPaths): Promise<{ journal: InstallTransactionJournal; sha256: string } | null> {
  const journalPath = transactionJournalPath(paths.justinRoot);
  const issue = await inspectParentSafety(safetyRootFor(paths, paths.justinRoot), journalPath);
  if (issue !== null) throw new StoryStackError(issue, "INVALID_INSTALL_TRANSACTION");
  const stats = await lstatOrNull(journalPath);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_TRANSACTION_BYTES) {
    throw new StoryStackError("Install transaction journal is not a safe regular file", "INVALID_INSTALL_TRANSACTION");
  }
  const source = await readFile(journalPath, "utf8");
  return { journal: parseInstallTransaction(source, paths), sha256: digest(source) };
}

type TransactionFileState = "before" | "after" | "conflict";

async function transactionEntryState(
  entry: Pick<InstallTransactionEntry, "target_path" | "destination_root" | "before_sha256" | "before_mode" | "after_sha256" | "after_mode">,
  roots: Pick<InstallPaths, "userHome" | "projectRoot">,
): Promise<TransactionFileState> {
  const issue = await inspectParentSafety(safetyRootFor(roots, entry.destination_root), entry.target_path);
  if (issue !== null) return "conflict";
  const collision = await inspectCollision(entry.target_path);
  if (collision === null) {
    if (entry.after_sha256 === null) return "after";
    if (entry.before_sha256 === null) return "before";
    return "conflict";
  }
  if (collision.kind !== "file") return "conflict";
  if (entry.after_sha256 !== null && collision.sha256 === entry.after_sha256 &&
    entry.after_mode !== null && modeMatches(collision.mode, entry.after_mode)) return "after";
  if (entry.before_sha256 !== null && collision.sha256 === entry.before_sha256 &&
    entry.before_mode !== null && modeMatches(collision.mode, entry.before_mode)) return "before";
  return "conflict";
}

async function assertAppliedTransactionTargets(journal: InstallTransactionJournal): Promise<void> {
  const roots = { userHome: journal.user_home, projectRoot: journal.project_root };
  for (const entry of journal.entries) {
    if (entry.state !== "applied" || await transactionEntryState(entry, roots) !== "after") {
      throw new StoryStackError(
        `Install target changed before the manifest could be committed: ${entry.target_path}`,
        "INSTALL_PLAN_STALE",
      );
    }
  }
}

async function assertTransactionBackups(journal: InstallTransactionJournal): Promise<void> {
  const roots = { userHome: journal.user_home, projectRoot: journal.project_root };
  for (const entry of journal.entries) {
    if (entry.backup_path === null || entry.before_sha256 === null) continue;
    const issue = await inspectParentSafety(safetyRootFor(roots, journal.justin_root), entry.backup_path);
    const collision = issue === null ? await inspectCollision(entry.backup_path) : null;
    if (issue !== null || collision?.kind !== "file" || collision.sha256 !== entry.before_sha256) {
      throw new StoryStackError(`Install recovery backup is missing or invalid: ${entry.backup_path}`, "INSTALL_RECOVERY_REQUIRED");
    }
  }
}

async function restoreTransactionEntry(
  journal: InstallTransactionJournal,
  entry: InstallTransactionEntry,
): Promise<void> {
  const roots = { userHome: journal.user_home, projectRoot: journal.project_root };
  if (await transactionEntryState(entry, roots) !== "after") {
    throw new StoryStackError(`Install target changed during recovery: ${entry.target_path}`, "INSTALL_RECOVERY_REQUIRED");
  }
  if (entry.before_sha256 === null) {
    await unlink(entry.target_path);
    await cleanupEmptyParents(entry.target_path, entry.destination_root);
    return;
  }
  if (entry.backup_path === null || entry.before_mode === null) {
    throw new StoryStackError("Install transaction is missing rollback metadata", "INVALID_INSTALL_TRANSACTION");
  }
  const contents = await readFile(entry.backup_path);
  if (digest(contents) !== entry.before_sha256) {
    throw new StoryStackError(`Install recovery backup changed: ${entry.backup_path}`, "INSTALL_RECOVERY_REQUIRED");
  }
  await writeFileAtomic(entry.target_path, contents, {
    beforeRename: async (temporaryPath) => {
      if (process.platform !== "win32") await chmod(temporaryPath, entry.before_mode ?? 0o600);
      if (await transactionEntryState(entry, roots) !== "after") {
        throw new StoryStackError(`Install target changed during recovery: ${entry.target_path}`, "INSTALL_RECOVERY_REQUIRED");
      }
    },
  });
}

async function recoverInstallTransaction(
  paths: InstallTransactionPaths,
  options: { testOnlyBeforeManifest?: () => Promise<void> | void } = {},
): Promise<void> {
  const loaded = await readInstallTransaction(paths);
  if (loaded === null) return;
  const { journal, sha256: journalSha256 } = loaded;
  await assertTransactionBackups(journal);
  const roots = { userHome: journal.user_home, projectRoot: journal.project_root };
  const states: TransactionFileState[] = [];
  for (const entry of journal.entries) states.push(await transactionEntryState(entry, roots));
  if (states.includes("conflict")) {
    throw new StoryStackError("Interrupted install has targets that match neither its before nor after state", "INSTALL_RECOVERY_REQUIRED");
  }
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.state === "pending" && states[index] === "after" && entry.action !== "create") {
      throw new StoryStackError("Interrupted install contains an ambiguous replacement or removal", "INSTALL_RECOVERY_REQUIRED");
    }
  }
  const manifestState = await transactionEntryState({
    target_path: journal.manifest_path,
    destination_root: journal.justin_root,
    before_sha256: journal.manifest_before_sha256,
    before_mode: journal.manifest_before_mode,
    after_sha256: journal.manifest_after_sha256,
    after_mode: journal.manifest_after_mode,
  }, roots);
  const allAfter = journal.entries.every((entry, index) => entry.state === "applied" && states[index] === "after");
  if (allAfter) {
    if (manifestState === "conflict") {
      throw new StoryStackError("Interrupted install manifest changed during recovery", "INSTALL_RECOVERY_REQUIRED");
    }
    await options.testOnlyBeforeManifest?.();
    await assertAppliedTransactionTargets(journal);
    const currentManifestState = await transactionEntryState({
      target_path: journal.manifest_path,
      destination_root: journal.justin_root,
      before_sha256: journal.manifest_before_sha256,
      before_mode: journal.manifest_before_mode,
      after_sha256: journal.manifest_after_sha256,
      after_mode: journal.manifest_after_mode,
    }, roots);
    if (currentManifestState === "before") {
      const contents = serializeManifest(journal.manifest);
      await writeFileAtomic(journal.manifest_path, contents, {
        beforeRename: async (temporaryPath) => {
          if (process.platform !== "win32") await chmod(temporaryPath, journal.manifest_after_mode);
          if (await transactionEntryState({
            target_path: journal.manifest_path,
            destination_root: journal.justin_root,
            before_sha256: journal.manifest_before_sha256,
            before_mode: journal.manifest_before_mode,
            after_sha256: journal.manifest_after_sha256,
            after_mode: journal.manifest_after_mode,
          }, roots) !== "before") {
            throw new StoryStackError("Interrupted install manifest changed during recovery", "INSTALL_RECOVERY_REQUIRED");
          }
        },
      });
    } else if (currentManifestState !== "after") {
      throw new StoryStackError("Interrupted install manifest changed during recovery", "INSTALL_RECOVERY_REQUIRED");
    }
    await assertAppliedTransactionTargets(journal);
    if (await transactionEntryState({
      target_path: journal.manifest_path,
      destination_root: journal.justin_root,
      before_sha256: journal.manifest_before_sha256,
      before_mode: journal.manifest_before_mode,
      after_sha256: journal.manifest_after_sha256,
      after_mode: journal.manifest_after_mode,
    }, roots) !== "after") {
      throw new StoryStackError("Recovered install manifest did not remain current", "INSTALL_RECOVERY_REQUIRED");
    }
    await removeInstallTransaction(paths, journalSha256);
    return;
  }
  if (manifestState !== "before") {
    throw new StoryStackError("Interrupted install committed an inconsistent manifest", "INSTALL_RECOVERY_REQUIRED");
  }
  for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
    if (journal.entries[index]?.state === "applied" && states[index] === "after") {
      const entry = journal.entries[index];
      if (entry !== undefined) await restoreTransactionEntry(journal, entry);
    }
  }
  await removeInstallTransaction(paths, journalSha256);
}

class SimulatedAbruptInstallTermination extends Error {
  constructor() {
    super("Simulated abrupt installer termination");
    this.name = "SimulatedAbruptInstallTermination";
  }
}

async function createInstallTransaction(
  plan: InstallPlan,
  changing: readonly InstallPlanEntry[],
  backups: readonly BackupRecord[],
): Promise<{ path: string; sha256: string; journal: InstallTransactionJournal }> {
  const manifestEntry = plan.entries.find((entry) => entry.kind === "manifest");
  if (manifestEntry === undefined) {
    throw new StoryStackError("Install plan has no manifest entry", "INSTALL_INTERNAL_ERROR");
  }
  const backupByTarget = new Map(backups.map((backup) => [backup.entry.targetPath, backup]));
  const entries: InstallTransactionEntry[] = changing
    .filter((entry) => entry.kind !== "manifest")
    .map((entry) => {
      if (entry.root === "story-stack") {
        throw new StoryStackError("Install plan contains a legacy target root", "INSTALL_INTERNAL_ERROR");
      }
      const backup = backupByTarget.get(entry.targetPath);
      if (entry.previousSha256 !== null && backup === undefined) {
        throw new StoryStackError(`Install transaction has no backup for ${entry.targetPath}`, "INSTALL_INTERNAL_ERROR");
      }
      return {
        root: entry.root,
        destination_root: entry.destinationRoot,
        relative_path: entry.relativePath,
        target_path: entry.targetPath,
        action: entry.action as TransactionAction,
        before_sha256: entry.previousSha256,
        before_mode: backup?.mode ?? null,
        after_sha256: entry.action === "remove" ? null : entry.sha256,
        after_mode: entry.action === "remove" ? null : entry.mode,
        backup_path: backup?.persistentPath ?? null,
        state: "pending",
      };
    });
  const journal: InstallTransactionJournal = {
    schema_version: 1,
    transaction_id: randomUUID(),
    created_at: new Date().toISOString(),
    pid: process.pid,
    user_home: plan.userHome,
    project_root: plan.projectRoot,
    justin_root: plan.justinRoot,
    plan_fingerprint: plan.fingerprint,
    manifest_path: plan.manifestPath,
    manifest_before_sha256: manifestEntry.previousSha256,
    manifest_before_mode: manifestEntry.previousMode,
    manifest_after_sha256: manifestEntry.sha256,
    manifest_after_mode: manifestEntry.mode,
    manifest: plan.manifest,
    entries,
  };
  const contents = serializeInstallTransaction(journal);
  if (Buffer.byteLength(contents, "utf8") > MAX_TRANSACTION_BYTES) {
    throw new StoryStackError("Install transaction journal exceeds the safe size limit", "INSTALL_INTERNAL_ERROR");
  }
  const journalPath = transactionJournalPath(plan.justinRoot);
  const safetyRoot = safetyRootFor(plan, plan.justinRoot);
  const issue = await inspectParentSafety(safetyRoot, journalPath);
  if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
  if (await inspectCollision(journalPath) !== null) {
    throw new StoryStackError("An install transaction journal already exists", "INSTALL_RECOVERY_REQUIRED");
  }
  await writeFileAtomic(journalPath, contents, {
    beforeRename: async (temporaryPath) => {
      if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
      const currentIssue = await inspectParentSafety(safetyRoot, journalPath);
      if (currentIssue !== null) throw new StoryStackError(currentIssue, "UNSAFE_INSTALL_DESTINATION");
      if (await inspectCollision(journalPath) !== null) {
        throw new StoryStackError("An install transaction journal appeared during preflight", "INSTALL_RECOVERY_REQUIRED");
      }
    },
  });
  return { path: journalPath, sha256: digest(contents), journal };
}

async function markTransactionEntryApplied(
  transaction: { path: string; sha256: string; journal: InstallTransactionJournal },
  entryIndex: number,
): Promise<void> {
  const existing = transaction.journal.entries[entryIndex];
  if (existing === undefined || existing.state !== "pending") {
    throw new StoryStackError("Install transaction progress is inconsistent", "INSTALL_INTERNAL_ERROR");
  }
  const next: InstallTransactionJournal = {
    ...transaction.journal,
    entries: transaction.journal.entries.map((entry, index) =>
      index === entryIndex ? { ...entry, state: "applied" } : { ...entry }),
  };
  const contents = serializeInstallTransaction(next);
  const roots = { userHome: next.user_home, projectRoot: next.project_root };
  const safetyRoot = safetyRootFor(roots, next.justin_root);
  const issue = await inspectParentSafety(safetyRoot, transaction.path);
  if (issue !== null) throw new StoryStackError(issue, "INVALID_INSTALL_TRANSACTION");
  await writeFileAtomic(transaction.path, contents, {
    beforeRename: async (temporaryPath) => {
      if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
      const collision = await inspectCollision(transaction.path);
      if (collision?.kind !== "file" || collision.sha256 !== transaction.sha256) {
        throw new StoryStackError("Install transaction journal changed while recording progress", "INSTALL_RECOVERY_REQUIRED");
      }
    },
  });
  transaction.journal = next;
  transaction.sha256 = digest(contents);
}

async function cleanupEmptyParents(targetPath: string, boundary: string): Promise<void> {
  let cursor = path.dirname(targetPath);
  while (cursor !== boundary && isContained(boundary, cursor)) {
    try {
      await rmdir(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      if (code !== "ENOENT") return;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function rollbackInstall(written: readonly InstallPlanEntry[], backups: readonly BackupRecord[]): Promise<string[]> {
  const failures: string[] = [];
  const byTarget = new Map(backups.map((backup) => [backup.entry.targetPath, backup]));
  for (const entry of [...written].reverse()) {
    try {
      const current = await inspectCollision(entry.targetPath);
      if (current !== null && (current.kind !== "file" || current.sha256 !== entry.sha256)) {
        throw new Error("installed file changed before rollback");
      }
      const backup = byTarget.get(entry.targetPath);
      if (backup !== undefined) {
        await writeFileAtomic(entry.targetPath, backup.contents, {
          beforeRename: async (temporaryPath) => {
            if (process.platform !== "win32") await chmod(temporaryPath, backup.mode);
          },
        });
      } else if (current !== null) {
        await unlink(entry.targetPath);
        await cleanupEmptyParents(entry.targetPath, entry.destinationRoot);
      }
    } catch (error) {
      failures.push(`${entry.targetPath}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

async function applyInstallUnlocked(
  input: InstallPlan | InstallerOptions = {},
  applyOptions: ApplyInstallOptions = {},
): Promise<InstallResult> {
  if (applyOptions.testOnlyAbortAfterMutations !== undefined &&
    (!Number.isSafeInteger(applyOptions.testOnlyAbortAfterMutations) || applyOptions.testOnlyAbortAfterMutations <= 0)) {
    throw new StoryStackError("Test failure injection must be a positive integer", "INVALID_ARGUMENTS");
  }
  if (applyOptions.testOnlyAbortBeforeMutation !== undefined &&
    (!Number.isSafeInteger(applyOptions.testOnlyAbortBeforeMutation) || applyOptions.testOnlyAbortBeforeMutation <= 0)) {
    throw new StoryStackError("Test failure injection must be a positive integer", "INVALID_ARGUMENTS");
  }
  const supplied = isInstallPlan(input) ? input : null;
  const fresh = await planInstall(supplied?.normalizedOptions ?? input);
  if (supplied !== null && supplied.fingerprint !== fresh.fingerprint) {
    throw new StoryStackError("Install sources or targets changed after planning; create a new plan", "INSTALL_PLAN_STALE");
  }
  if (fresh.safetyIssues.length > 0) {
    throw new StoryStackError(
      `Unsafe install destination: ${fresh.safetyIssues.map((issue) => issue.message).join("; ")}`,
      "UNSAFE_INSTALL_DESTINATION",
    );
  }
  if (fresh.collisions.length > 0 && applyOptions.confirmOverwrite !== true) {
    throw new StoryStackError(
      `Install targets differ from canonical files; explicit overwrite confirmation is required: ${fresh.collisions.map((item) => item.targetPath).join(", ")}`,
      "INSTALL_COLLISION",
    );
  }
  if (fresh.collisions.some((collision) => collision.kind !== "file")) {
    throw new StoryStackError("Directories, links, and special files cannot be overwritten", "UNSAFE_INSTALL_DESTINATION");
  }
  const changing = fresh.entries.filter(
    (entry) => entry.action === "create" || entry.action === "replace" || entry.action === "remove",
  );
  const prepared = new Map<string, Uint8Array>();
  for (const entry of changing.filter((entry) => entry.action !== "remove")) {
    prepared.set(entry.targetPath, await entryContents(entry));
  }
  for (const entry of fresh.entries) {
    if (entry.action === "unsafe") throw new StoryStackError(`Unsafe install target: ${entry.targetPath}`, "UNSAFE_INSTALL_DESTINATION");
    if (entry.action === "preserve") continue;
    const issue = await inspectParentSafety(entry.safetyRoot, entry.targetPath);
    if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
    await assertTargetMatchesPlan(entry);
  }

  const backupRoot = fresh.backupRoot;
  const backups: BackupRecord[] = [];
  const changingByTarget = new Map(changing.map((entry) => [entry.targetPath, entry]));
  for (const operation of fresh.backupOperations) {
    if (operation.action === "unsafe") {
      throw new StoryStackError(`Unsafe backup target: ${operation.targetPath}`, "UNSAFE_INSTALL_DESTINATION");
    }
    const entry = changingByTarget.get(operation.sourcePath);
    if (entry === undefined || entry.previousSha256 !== operation.sha256) {
      throw new StoryStackError("Installer backup plan is inconsistent", "INSTALL_INTERNAL_ERROR");
    }
    const assertBackupMatchesPlan = async (): Promise<void> => {
      const current = await inspectCollision(operation.targetPath);
      if (operation.action === "create") {
        if (current !== null) {
          throw new StoryStackError(`Backup target appeared after preflight: ${operation.targetPath}`, "INSTALL_PLAN_STALE");
        }
        return;
      }
      if (current === null || current.kind !== "file" || current.sha256 !== operation.sha256) {
        throw new StoryStackError(`Backup target changed after preflight: ${operation.targetPath}`, "INSTALL_PLAN_STALE");
      }
    };

    await assertTargetMatchesPlan(entry);
    const stats = await lstat(entry.targetPath);
    const contents = await readFile(entry.targetPath);
    if (digest(contents) !== operation.sha256) {
      throw new StoryStackError(`Install target changed while creating its backup: ${entry.targetPath}`, "INSTALL_PLAN_STALE");
    }
    const backupIssue = await inspectParentSafety(safetyRootFor(fresh, fresh.justinRoot), operation.targetPath);
    if (backupIssue !== null) throw new StoryStackError(backupIssue, "UNSAFE_INSTALL_DESTINATION");
    await assertBackupMatchesPlan();
    if (operation.action === "create") {
      await writeFileAtomic(operation.targetPath, contents, {
        beforeRename: async (temporaryPath) => {
          if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
          const issue = await inspectParentSafety(safetyRootFor(fresh, fresh.justinRoot), operation.targetPath);
          if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
          await assertTargetMatchesPlan(entry);
          await assertBackupMatchesPlan();
        },
      });
    }
    backups.push({ entry, contents, mode: stats.mode & 0o777, persistentPath: operation.targetPath });
  }

  const writtenEntries: InstallPlanEntry[] = [];
  const transaction = changing.length === 0 ? null : await createInstallTransaction(fresh, changing, backups);
  let mutationCount = 0;
  const beginMutation = (): void => {
    mutationCount += 1;
    if (mutationCount === applyOptions.testOnlyAbortBeforeMutation) throw new SimulatedAbruptInstallTermination();
  };
  const finishMutation = async (entry: InstallPlanEntry): Promise<void> => {
    if (transaction !== null && entry.kind !== "manifest") {
      const entryIndex = transaction.journal.entries.findIndex((candidate) => candidate.target_path === entry.targetPath);
      if (entryIndex < 0) throw new StoryStackError("Install transaction lost a target entry", "INSTALL_INTERNAL_ERROR");
      await markTransactionEntryApplied(transaction, entryIndex);
    }
    if (mutationCount === applyOptions.testOnlyAbortAfterMutations) throw new SimulatedAbruptInstallTermination();
  };
  try {
    const ordered = [
      ...changing.filter((entry) => entry.kind !== "manifest" && entry.action !== "remove"),
      ...changing.filter((entry) => entry.action === "remove"),
      ...changing.filter((entry) => entry.kind === "manifest"),
    ];
    for (const entry of ordered) {
      if (entry.kind === "manifest" && transaction !== null) {
        await applyOptions.testOnlyBeforeManifest?.();
        await assertAppliedTransactionTargets(transaction.journal);
      }
      beginMutation();
      if (entry.action === "remove") {
        const issue = await inspectParentSafety(entry.safetyRoot, entry.targetPath);
        if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
        await assertTargetMatchesPlan(entry);
        await unlink(entry.targetPath);
        writtenEntries.push(entry);
        await cleanupEmptyParents(entry.targetPath, entry.destinationRoot);
        await finishMutation(entry);
        continue;
      }
      const contents = prepared.get(entry.targetPath);
      if (contents === undefined) throw new StoryStackError("Installer lost prepared contents", "INSTALL_INTERNAL_ERROR");
      await writeFileAtomic(entry.targetPath, contents, {
        beforeRename: async (temporaryPath) => {
          if (process.platform !== "win32") await chmod(temporaryPath, entry.mode);
          const issue = await inspectParentSafety(entry.safetyRoot, entry.targetPath);
          if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
          await assertTargetMatchesPlan(entry);
        },
      });
      writtenEntries.push(entry);
      await finishMutation(entry);
    }
    if (transaction !== null) {
      await assertAppliedTransactionTargets(transaction.journal);
      const manifest = writtenEntries.find((entry) => entry.kind === "manifest");
      const manifestState = manifest === undefined ? null : await inspectCollision(manifest.targetPath);
      if (
        manifest === undefined || manifestState?.kind !== "file" || manifestState.sha256 !== manifest.sha256 ||
        !modeMatches(manifestState.mode, manifest.mode)
      ) {
        throw new StoryStackError("Installed manifest changed before transaction completion", "INSTALL_PLAN_STALE");
      }
    }
  } catch (error) {
    if (error instanceof SimulatedAbruptInstallTermination) throw error;
    const failures = await rollbackInstall(writtenEntries, backups);
    if (failures.length > 0) {
      throw new StoryStackError(
        `Install failed (${errorMessage(error)}) and rollback was incomplete: ${failures.join("; ")}`,
        "INSTALL_ROLLBACK_FAILED",
      );
    }
    if (transaction !== null) {
      await removeInstallTransaction(fresh, transaction.sha256);
    }
    throw error;
  }
  if (transaction !== null) await removeInstallTransaction(fresh, transaction.sha256);
  const written = writtenEntries.filter((entry) => entry.action !== "remove").map((entry) => entry.targetPath);
  const removed = writtenEntries.filter((entry) => entry.action === "remove").map((entry) => entry.targetPath);
  return {
    written,
    installed: written,
    removed,
    preserved: fresh.entries
      .filter((entry) => entry.action === "preserve")
      .map((entry) => ({ targetPath: entry.targetPath, reason: entry.diff ?? "Preserved obsolete managed file" })),
    unchanged: fresh.entries.filter((entry) => entry.action === "unchanged").map((entry) => entry.targetPath),
    overwritten: writtenEntries
      .filter((entry) => entry.action === "replace" && entry.previousSha256 !== null)
      .map((entry) => entry.targetPath),
    backups: backups.map((backup) => backup.persistentPath),
    backupRoot,
    manifestPath: fresh.manifestPath,
    configurationModified: false,
  };
}

export async function applyInstall(
  input: InstallPlan | InstallerOptions = {},
  applyOptions: ApplyInstallOptions = {},
): Promise<InstallResult> {
  const supplied = isInstallPlan(input) ? input : null;
  const normalized = await normalizeOptions(supplied?.normalizedOptions ?? input);
  const paths = resolveInstallPaths(normalized.userHome, {
    justinStackHome: normalized.justinStackHome,
    projectRoot: normalized.projectRoot,
    target: normalized.target,
    scope: normalized.scope,
    skillRoots: normalized.skillRoots,
    ...(normalized.claudeConfigDir === undefined ? {} : { claudeConfigDir: normalized.claudeConfigDir }),
    ...(normalized.codexHome === undefined ? {} : { codexHome: normalized.codexHome }),
  });
  return withInstallerLock(
    paths,
    async () => applyInstallUnlocked(input, applyOptions),
    { ...(applyOptions.testOnlyBeforeRecoveryManifest === undefined
      ? {}
      : { testOnlyBeforeManifest: applyOptions.testOnlyBeforeRecoveryManifest }) },
  );
}

export function formatInstallPlan(plan: InstallPlan): string {
  const lines = [
    `justinstack ${plan.packageVersion} install plan (dry-run; no files written)`,
    `Target: ${plan.target}`,
    `Scope: ${plan.scope}`,
    `Shared runtime: ${plan.justinRoot}`,
  ];
  for (const target of plan.targets) lines.push(`${getPlatformAdapter(target).label} skills: ${plan.skillRoots[target] ?? "unresolved"}`);
  if (plan.backupOperations.length > 0) {
    lines.push("Backup operations (performed before target mutations):");
    for (const operation of plan.backupOperations) {
      lines.push(`  ${operation.action.toUpperCase()} ${operation.targetPath} <= ${operation.sourcePath}`);
    }
  }
  lines.push("File operations:");
  for (const entry of plan.entries) {
    lines.push(`  ${entry.action.toUpperCase()} ${entry.targetPath}`);
    if (entry.action === "unchanged" && !entry.managed && entry.kind !== "manifest") {
      lines.push("    Existing byte-identical file is left unowned and will not be removed by uninstall.");
    }
    if (entry.diff !== null) lines.push(...entry.diff.trimEnd().split("\n").map((line) => `    ${line}`));
  }
  if (plan.configurationProposals.length > 0) {
    lines.push("Configuration proposals (PROPOSE ONLY; never applied by install):");
    for (const proposal of plan.configurationProposals) {
      lines.push(`  PROPOSE ONLY ${proposal.targetPath}: ${proposal.summary}`);
      lines.push(...proposal.diff.trimEnd().split("\n").map((line) => `    ${line}`));
    }
  }
  if (plan.safetyIssues.length > 0) {
    lines.push("Safety refusals:");
    for (const issue of plan.safetyIssues) lines.push(`  ${issue.targetPath}: ${issue.message}`);
  }
  if (plan.collisions.length > 0) {
    lines.push("Unmanaged existing files require --confirm-overwrite JUSTINSTACK with --apply.");
  }
  lines.push("No agent configuration, PATH, shell profile, Git configuration, or remote service will be changed.");
  return `${lines.join("\n")}\n`;
}

interface ExpectedInstallFile {
  sha256: string;
  mode: number;
}

async function canonicalSkillFiles(packageRoot: string): Promise<Map<string, ExpectedInstallFile>> {
  const result = new Map<string, ExpectedInstallFile>();
  for (const skill of INSTALLED_SKILLS) {
    const root = path.join(packageRoot, "skills", skill);
    for (const sourcePath of await skillPackageFiles(packageRoot, skill)) {
      const relative = `${skill}/${normalizeRelativePath(path.relative(root, sourcePath))}`;
      result.set(relative, { sha256: await digestFile(sourcePath), mode: await portableSourceMode(sourcePath) });
    }
  }
  return result;
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

async function inspectDoctorFile(
  targetPath: string,
  destinationRoot: string,
  safetyRoot: string,
  expected: ExpectedInstallFile,
): Promise<"installed" | "missing" | "stale"> {
  assertContained(destinationRoot, targetPath, "Doctor target");
  const issue = await inspectParentSafety(safetyRoot, targetPath);
  if (issue !== null) return "stale";
  const collision = await inspectCollision(targetPath);
  if (collision === null) return "missing";
  if (collision.kind !== "file" || collision.sha256 !== expected.sha256 || !modeMatches(collision.mode, expected.mode)) {
    return "stale";
  }
  return "installed";
}

function proposalSafetyRoot(
  target: PlatformTarget,
  normalized: NormalizedInstallerOptions,
  paths: InstallPaths,
): string {
  if (normalized.scope === "project") return paths.projectRoot;
  if (target === "claude" && normalized.claudeConfigDir !== undefined) return normalized.claudeConfigDir;
  if (target === "codex" && normalized.codexHome !== undefined) return normalized.codexHome;
  return paths.userHome;
}

export async function inspectPlatformInstallations(options: InstallerOptions = {}): Promise<PlatformDoctorStatus[]> {
  const normalized = await normalizeOptions(options);
  const paths = resolveInstallPaths(normalized.userHome, {
    justinStackHome: normalized.justinStackHome,
    projectRoot: normalized.projectRoot,
    target: normalized.target,
    scope: normalized.scope,
    skillRoots: normalized.skillRoots,
    ...(normalized.claudeConfigDir === undefined ? {} : { claudeConfigDir: normalized.claudeConfigDir }),
    ...(normalized.codexHome === undefined ? {} : { codexHome: normalized.codexHome }),
  });
  const canonical = await canonicalSkillFiles(normalized.packageRoot);
  let installedManifest: InstallManifestV2 | null = null;
  let manifestProblem = false;
  try {
    const loaded = await readExistingManifest(paths.manifestPath, safetyRootFor(paths, paths.justinRoot));
    installedManifest = loaded?.manifest.schema_version === 2 ? loaded.manifest : null;
    const manifestStats = loaded === null ? null : await lstat(paths.manifestPath);
    manifestProblem = loaded !== null && (
      loaded.manifest.schema_version !== 2 || !modeMatches(manifestStats?.mode ?? null, 0o600) ||
      loaded.manifest.package_version !== normalized.packageVersion
    );
  } catch {
    manifestProblem = true;
  }
  const runtimeExpected = new Map<string, ExpectedInstallFile>();
  for (const descriptor of await runtimeDescriptors(
    normalized.packageRoot,
    paths.justinRoot,
    safetyRootFor(paths, paths.justinRoot),
    normalized.packageVersion,
  )) {
    runtimeExpected.set(descriptor.relativePath, {
      sha256: digest(await descriptorContents(descriptor)),
      mode: descriptor.mode,
    });
  }
  const currentRuntimePaths = new Set(runtimeExpected.keys());
  const runtimeOwnership = new Map((installedManifest?.runtime_entries ?? []).map((entry) => [entry.path, entry.sha256]));
  const obsoleteRuntime = (installedManifest?.runtime_entries ?? [])
    .filter((entry) => !currentRuntimePaths.has(entry.path))
    .map((entry) => path.resolve(nativePath(paths.justinRoot, entry.path)));
  const statuses: PlatformDoctorStatus[] = [];
  for (const target of expandPlatformTargets(normalized.target)) {
    const configuredRoot = paths.skillRoots[target];
    if (configuredRoot === undefined) continue;
    const key = installationKey(normalized.scope, target, normalized.projectRoot);
    const record = installedManifest?.installations.find((candidate) => candidate.key === key);
    const recordedRoot = record?.destination_root;
    const scopeBoundary = normalized.scope === "global" ? paths.userHome : paths.projectRoot;
    const claudeBoundary = target === "claude" && normalized.scope === "global" ? normalized.claudeConfigDir ?? null : null;
    const recordedRootIsSafe = recordedRoot !== null && recordedRoot !== undefined &&
      (isContained(scopeBoundary, recordedRoot) || claudeBoundary !== null && isContained(claudeBoundary, recordedRoot));
    const skillsRoot = recordedRootIsSafe ? recordedRoot : configuredRoot;
    const installed: string[] = [];
    const missing: string[] = [];
    const stale: string[] = [];
    const obsolete = [
      ...obsoleteRuntime,
      ...(record?.entries ?? [])
        .filter((entry) => !canonical.has(entry.path))
        .map((entry) => path.resolve(nativePath(skillsRoot, entry.path))),
    ];
    if (record === undefined || !recordedRootIsSafe || manifestProblem) stale.push(paths.manifestPath);
    const runtimeSafetyRoot = safetyRootFor(paths, paths.justinRoot);
    for (const [relative, expected] of runtimeExpected) {
      const targetPath = path.resolve(nativePath(paths.justinRoot, relative));
      const ownershipMatches = runtimeOwnership.get(relative) === expected.sha256;
      if (!ownershipMatches) addUnique(stale, paths.manifestPath);
      const status = await inspectDoctorFile(targetPath, paths.justinRoot, runtimeSafetyRoot, expected);
      if (status === "missing") addUnique(missing, targetPath);
      else if (status === "stale" || !ownershipMatches) addUnique(stale, targetPath);
      else addUnique(installed, targetPath);
    }
    const recordOwnership = new Map((record?.entries ?? []).map((entry) => [entry.path, entry.sha256]));
    for (const [relative, expected] of canonical) {
      const targetPath = path.resolve(nativePath(skillsRoot, relative));
      const ownershipMatches = recordOwnership.get(relative) === expected.sha256;
      if (!ownershipMatches) addUnique(stale, paths.manifestPath);
      const status = await inspectDoctorFile(targetPath, skillsRoot, safetyRootFor(paths, skillsRoot), expected);
      if (status === "missing") addUnique(missing, targetPath);
      else if (status === "stale" || !ownershipMatches) addUnique(stale, targetPath);
      else addUnique(installed, targetPath);
    }
    const context: AdapterPaths = {
      userHome: normalized.userHome,
      projectRoot: normalized.projectRoot,
      justinStackHome: paths.justinRoot,
      ...(normalized.claudeConfigDir === undefined ? {} : { claudeConfigDir: normalized.claudeConfigDir }),
      ...(normalized.codexHome === undefined ? {} : { codexHome: normalized.codexHome }),
    };
    const adapter = getPlatformAdapter(target);
    const configurationProposals: ConfigurationProposalView[] = [];
    for (const proposal of adapter.proposals(normalized.scope, context)) {
      configurationProposals.push(await materializeProposal(
        proposal,
        proposalSafetyRoot(target, normalized, paths),
      ));
    }
    statuses.push({
      target,
      displayName: adapter.label,
      scope: normalized.scope,
      skillsRoot,
      ok: missing.length === 0 && stale.length === 0 && obsolete.length === 0,
      installed,
      missing,
      stale,
      obsolete,
      reminders: adapter.doctorReminders(normalized.scope, context),
      configurationProposals,
    });
  }
  return statuses;
}

async function inspectUninstallEntry(
  destinationRoot: string,
  safetyRoot: string,
  root: InstallRoot,
  manifestEntry: ManifestFileEntry,
  key: string | null,
): Promise<UninstallPlanEntry> {
  const targetPath = path.resolve(nativePath(destinationRoot, manifestEntry.path));
  assertContained(destinationRoot, targetPath, "Uninstall target");
  const parentIssue = await inspectParentSafety(safetyRoot, targetPath);
  if (parentIssue !== null) {
    return { root, destinationRoot, safetyRoot, installationKey: key, relativePath: manifestEntry.path, targetPath, expectedSha256: manifestEntry.sha256, actualSha256: null, status: "unsafe", reason: parentIssue };
  }
  const stats = await lstatOrNull(targetPath);
  if (stats === null) {
    return { root, destinationRoot, safetyRoot, installationKey: key, relativePath: manifestEntry.path, targetPath, expectedSha256: manifestEntry.sha256, actualSha256: null, status: "missing", reason: null };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { root, destinationRoot, safetyRoot, installationKey: key, relativePath: manifestEntry.path, targetPath, expectedSha256: manifestEntry.sha256, actualSha256: null, status: "unsafe", reason: "Owned path is no longer a regular file" };
  }
  const actualSha256 = await digestFile(targetPath);
  return {
    root,
    destinationRoot,
    safetyRoot,
    installationKey: key,
    relativePath: manifestEntry.path,
    targetPath,
    expectedSha256: manifestEntry.sha256,
    actualSha256,
    status: actualSha256 === manifestEntry.sha256 ? "remove" : "modified",
    reason: actualSha256 === manifestEntry.sha256 ? null : "File content differs from the install manifest",
  };
}

export async function planUninstall(options: InstallerOptions = {}): Promise<UninstallPlan> {
  const normalizedWithVersion = await normalizeOptions(options);
  const { packageVersion: _ignored, ...normalized } = normalizedWithVersion;
  const paths = resolveInstallPaths(normalized.userHome, {
    justinStackHome: normalized.justinStackHome,
    projectRoot: normalized.projectRoot,
    target: normalized.target,
    scope: normalized.scope,
    skillRoots: normalized.skillRoots,
    ...(normalized.claudeConfigDir === undefined ? {} : { claudeConfigDir: normalized.claudeConfigDir }),
    ...(normalized.codexHome === undefined ? {} : { codexHome: normalized.codexHome }),
  });
  const loaded = await readExistingManifest(paths.manifestPath, safetyRootFor(paths, paths.justinRoot));
  if (loaded === null) {
    const reason = `Install manifest not found: ${paths.manifestPath}`;
    return {
      userHome: paths.userHome, projectRoot: paths.projectRoot, target: normalized.target, scope: normalized.scope,
      justinRoot: paths.justinRoot, storyRoot: paths.justinRoot, skillsRoot: paths.skillsRoot, skillRoots: paths.skillRoots,
      manifestPath: paths.manifestPath, manifestFound: false, manifestSha256: null, packageVersion: null, entries: [],
      issues: [reason], blocked: [{ targetPath: paths.manifestPath, reason }], canFullyUninstall: false,
      manifest: null, normalizedOptions: normalized,
    };
  }
  const entries: UninstallPlanEntry[] = [];
  if (loaded.manifest.schema_version === 1) {
    for (const entry of loaded.manifest.entries) {
      const destinationRoot = entry.root === "story-stack" ? paths.justinRoot : paths.skillsRoot;
      entries.push(await inspectUninstallEntry(
        destinationRoot,
        safetyRootFor(paths, destinationRoot),
        entry.root,
        entry,
        null,
      ));
    }
  } else {
    const selectedKeys = new Set(expandPlatformTargets(normalized.target).map((target) => installationKey(normalized.scope, target, normalized.projectRoot)));
    const selected = loaded.manifest.installations.filter((record) => selectedKeys.has(record.key));
    for (const record of selected) {
      if (record.destination_root === null) {
        entries.push({
          root: `${record.target}-skills`,
          destinationRoot: paths.skillRoots[record.target] ?? paths.skillsRoot,
          safetyRoot: paths.userHome,
          installationKey: record.key,
          relativePath: record.entries[0]?.path ?? "story/SKILL.md",
          targetPath: paths.manifestPath,
          expectedSha256: loaded.sha256,
          actualSha256: loaded.sha256,
          status: "modified",
          reason: "Installed record has no destination root; refusing to guess an uninstall path",
        });
        continue;
      }
      const skillRoot = record.destination_root;
      const scopeBoundary = record.scope === "global" ? paths.userHome : paths.projectRoot;
      const claudeBoundary = record.target === "claude" && record.scope === "global"
        ? normalized.claudeConfigDir ?? null
        : null;
      const recordedRootIsSafe = isContained(scopeBoundary, skillRoot) ||
        (claudeBoundary !== null && isContained(claudeBoundary, skillRoot));
      if (!recordedRootIsSafe) {
        entries.push({
          root: `${record.target}-skills`,
          destinationRoot: skillRoot,
          safetyRoot: scopeBoundary,
          installationKey: record.key,
          relativePath: record.entries[0]?.path ?? "story/SKILL.md",
          targetPath: paths.manifestPath,
          expectedSha256: loaded.sha256,
          actualSha256: loaded.sha256,
          status: "unsafe",
          reason: `Recorded skill root escapes the ${record.scope} installation boundary`,
        });
        continue;
      }
      for (const entry of record.entries) {
        entries.push(await inspectUninstallEntry(
          skillRoot,
          isContained(scopeBoundary, skillRoot) ? scopeBoundary : claudeBoundary ?? skillRoot,
          `${record.target}-skills`,
          entry,
          record.key,
        ));
      }
    }
    const removesAll = selected.length > 0 && selected.length === loaded.manifest.installations.length;
    if (removesAll) {
      for (const entry of loaded.manifest.runtime_entries) {
        entries.push(await inspectUninstallEntry(
          paths.justinRoot,
          safetyRootFor(paths, paths.justinRoot),
          "justinstack",
          entry,
          null,
        ));
      }
    }
    if (selected.length === 0) {
      entries.push({
        root: "justinstack", destinationRoot: paths.justinRoot, safetyRoot: safetyRootFor(paths, paths.justinRoot), installationKey: null,
        relativePath: INSTALL_MANIFEST_FILENAME, targetPath: paths.manifestPath, expectedSha256: loaded.sha256,
        actualSha256: loaded.sha256, status: "modified", reason: "No matching installed target and scope were found",
      });
    }
  }
  const blocked = entries
    .filter((entry) => entry.status === "modified" || entry.status === "unsafe")
    .map((entry) => ({ targetPath: entry.targetPath, reason: entry.reason ?? entry.status }));
  return {
    userHome: paths.userHome,
    projectRoot: paths.projectRoot,
    target: normalized.target,
    scope: normalized.scope,
    justinRoot: paths.justinRoot,
    storyRoot: paths.justinRoot,
    skillsRoot: paths.skillsRoot,
    skillRoots: paths.skillRoots,
    manifestPath: paths.manifestPath,
    manifestFound: true,
    manifestSha256: loaded.sha256,
    packageVersion: loaded.manifest.package_version,
    entries,
    issues: blocked.map((item) => `${item.targetPath}: ${item.reason}`),
    blocked,
    canFullyUninstall: blocked.length === 0,
    manifest: loaded.manifest,
    normalizedOptions: normalized,
  };
}

function isUninstallPlan(value: UninstallPlan | InstallerOptions): value is UninstallPlan {
  return "manifestFound" in value && "entries" in value;
}

async function manifestStillMatches(plan: UninstallPlan): Promise<boolean> {
  if (plan.manifestSha256 === null) return false;
  if (await inspectParentSafety(safetyRootFor(plan, plan.justinRoot), plan.manifestPath) !== null) return false;
  const stats = await lstatOrNull(plan.manifestPath);
  return stats !== null && stats.isFile() && !stats.isSymbolicLink() && await digestFile(plan.manifestPath) === plan.manifestSha256;
}

async function assertUninstallEntryMatchesPlan(entry: UninstallPlanEntry): Promise<void> {
  const issue = await inspectParentSafety(entry.safetyRoot, entry.targetPath);
  if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
  const current = await inspectCollision(entry.targetPath);
  if (current === null || current.kind !== "file" || current.sha256 !== entry.expectedSha256) {
    throw new StoryStackError(`Uninstall target changed after preflight: ${entry.targetPath}`, "UNINSTALL_PLAN_STALE");
  }
}

async function applyUninstallUnlocked(input: UninstallPlan | InstallerOptions = {}): Promise<UninstallResult> {
  const supplied = isUninstallPlan(input) ? input : null;
  const fresh = await planUninstall(supplied?.normalizedOptions ?? input);
  if (!fresh.manifestFound || fresh.manifestSha256 === null || fresh.manifest === null) {
    throw new StoryStackError(`Install manifest not found: ${fresh.manifestPath}`, "INSTALL_MANIFEST_NOT_FOUND");
  }
  if (supplied !== null && supplied.manifestSha256 !== fresh.manifestSha256) {
    throw new StoryStackError("Install manifest changed after planning", "UNINSTALL_PLAN_STALE");
  }
  const removed: string[] = [];
  const missing: string[] = [];
  const preserved: PreservedInstallFile[] = [];
  const failedInstallationKeys = new Set<string>();
  for (const entry of fresh.entries.filter((candidate) => candidate.root !== "justinstack" || fresh.manifest?.schema_version === 1)) {
    if (entry.status === "missing") { missing.push(entry.targetPath); continue; }
    if (entry.status !== "remove") {
      preserved.push({ targetPath: entry.targetPath, reason: entry.reason ?? entry.status });
      if (entry.installationKey !== null) failedInstallationKeys.add(entry.installationKey);
      continue;
    }
    try {
      await assertUninstallEntryMatchesPlan(entry);
      await unlink(entry.targetPath);
      removed.push(entry.targetPath);
      await cleanupEmptyParents(entry.targetPath, entry.destinationRoot);
    } catch (error) {
      preserved.push({ targetPath: entry.targetPath, reason: `Removal failed: ${errorMessage(error)}` });
      if (entry.installationKey !== null) failedInstallationKeys.add(entry.installationKey);
    }
  }

  let manifestRemoved = false;
  if (fresh.manifest.schema_version === 1) {
    if (preserved.length === 0 && await manifestStillMatches(fresh)) {
      await unlink(fresh.manifestPath);
      manifestRemoved = true;
    }
  } else {
    const selectedKeys = new Set(expandPlatformTargets(fresh.target).map((target) => installationKey(fresh.scope, target, fresh.projectRoot)));
    const blockedKeys = new Set(
      [
        ...failedInstallationKeys,
        ...fresh.entries
        .filter((entry) => entry.installationKey !== null && (entry.status === "modified" || entry.status === "unsafe"))
        .map((entry) => entry.installationKey as string),
      ],
    );
    const remaining = fresh.manifest.installations.filter(
      (record) => !selectedKeys.has(record.key) || blockedKeys.has(record.key),
    );
    if (remaining.length === 0 && preserved.length === 0) {
      for (const entry of fresh.entries.filter((candidate) => candidate.root === "justinstack")) {
        if (entry.status === "missing") { missing.push(entry.targetPath); continue; }
        if (entry.status !== "remove") { preserved.push({ targetPath: entry.targetPath, reason: entry.reason ?? entry.status }); continue; }
        try {
          await assertUninstallEntryMatchesPlan(entry);
          await unlink(entry.targetPath);
          removed.push(entry.targetPath);
          await cleanupEmptyParents(entry.targetPath, entry.destinationRoot);
        } catch (error) {
          preserved.push({ targetPath: entry.targetPath, reason: `Removal failed: ${errorMessage(error)}` });
        }
      }
      if (preserved.length === 0 && await manifestStillMatches(fresh)) {
        await unlink(fresh.manifestPath);
        manifestRemoved = true;
      }
    } else if (await manifestStillMatches(fresh)) {
      const nextManifest: InstallManifestV2 = { ...fresh.manifest, installations: remaining };
      await writeFileAtomic(fresh.manifestPath, serializeManifest(nextManifest), {
        beforeRename: async () => {
          if (!await manifestStillMatches(fresh)) {
            throw new StoryStackError("Install manifest changed during uninstall", "UNINSTALL_PLAN_STALE");
          }
        },
      });
    } else {
      preserved.push({ targetPath: fresh.manifestPath, reason: "Manifest changed during uninstall" });
    }
  }
  return {
    removed,
    missing,
    preserved,
    blocked: preserved,
    manifestPath: fresh.manifestPath,
    manifestRemoved,
    complete: manifestRemoved && preserved.length === 0,
    statePreserved: true,
  };
}

export async function applyUninstall(input: UninstallPlan | InstallerOptions = {}): Promise<UninstallResult> {
  const supplied = isUninstallPlan(input) ? input : null;
  const normalizedWithVersion = await normalizeOptions(supplied?.normalizedOptions ?? input);
  const paths = resolveInstallPaths(normalizedWithVersion.userHome, {
    justinStackHome: normalizedWithVersion.justinStackHome,
    projectRoot: normalizedWithVersion.projectRoot,
    target: normalizedWithVersion.target,
    scope: normalizedWithVersion.scope,
    skillRoots: normalizedWithVersion.skillRoots,
    ...(normalizedWithVersion.claudeConfigDir === undefined ? {} : { claudeConfigDir: normalizedWithVersion.claudeConfigDir }),
    ...(normalizedWithVersion.codexHome === undefined ? {} : { codexHome: normalizedWithVersion.codexHome }),
  });
  return withInstallerLock(paths, async () => applyUninstallUnlocked(input));
}

export function formatUninstallPlan(plan: UninstallPlan): string {
  const lines = [
    "justinstack uninstall plan (dry-run; no files removed)",
    `Target: ${plan.target}`,
    `Scope: ${plan.scope}`,
    `Manifest: ${plan.manifestPath}`,
  ];
  if (!plan.manifestFound) {
    lines.push("  MISSING install manifest; installer ownership cannot be established.");
    return `${lines.join("\n")}\n`;
  }
  for (const entry of plan.entries) lines.push(`  ${entry.status.toUpperCase()} ${entry.targetPath}`);
  lines.push(plan.issues.length > 0
    ? "Modified or unsafe files will be preserved with their manifest ownership."
    : "Only manifest-owned, hash-matching files will be removed.");
  lines.push("Story checkpoints under the JustinStack workspace directory are always preserved.");
  return `${lines.join("\n")}\n`;
}
