import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
export const INSTALLED_SKILLS = ["story", "plan-eng-review", "review", "resume-story"] as const;

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
  projectRoot?: string;
  /** Explicit skill-root overrides, primarily for isolated tests. */
  skillRoots?: Partial<Record<PlatformTarget, string>>;
  /** Deprecated compatibility override for Claude's skill root. */
  claudeSkillsRoot?: string;
  bobSkillsRoot?: string;
  codexSkillsRoot?: string;
  version?: string;
}

export interface ApplyInstallOptions {
  /** Required to replace an existing file not proven to be installer-owned. */
  confirmOverwrite?: boolean;
}

export interface InstallPaths {
  userHome: string;
  projectRoot: string;
  justinRoot: string;
  /** Deprecated descriptive alias for justinRoot. */
  storyRoot: string;
  skillsRoot: string;
  skillRoots: Partial<Record<PlatformTarget, string>>;
  manifestPath: string;
}

export interface InstallCollision {
  targetPath: string;
  kind: CollisionKind;
  sha256: string | null;
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

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_DIFF_LINES = 120;
const INSTALL_LOCK_RETRIES = 600;
const INSTALL_LOCK_DELAY_MS = 25;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
const INSTALLATION_KEY_PATTERN = /^(?:global:(?:claude|bob|codex)|project:[a-f0-9]{16}:(?:claude|bob|codex))$/u;

function defaultPackageRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(path.dirname(moduleDirectory)) === "dist"
    ? path.resolve(moduleDirectory, "../..")
    : path.resolve(moduleDirectory, "..");
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
  const custom = explicitSkillOverrides(overrides);
  const skillRoots: Partial<Record<PlatformTarget, string>> = {};
  for (const platform of targets) {
    const context: AdapterPaths = { userHome: resolvedHome, projectRoot, justinStackHome: justinRoot };
    skillRoots[platform] = assertUsableRoot(
      custom[platform] ?? getPlatformAdapter(platform).skillRoot(scope, context),
      `${platform} skills root`,
    );
    const skillsRoot = skillRoots[platform];
    if (skillsRoot !== undefined && (isContained(justinRoot, skillsRoot) || isContained(skillsRoot, justinRoot))) {
      throw new StoryStackError("Runtime and skill roots cannot overlap", "INVALID_INSTALL_ROOT");
    }
    const scopeBoundary = scope === "global" ? resolvedHome : projectRoot;
    if (skillsRoot !== undefined && !isContained(scopeBoundary, skillsRoot)) {
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

async function acquireInstallerLock(paths: InstallPaths): Promise<{ handle: FileHandle; lockPath: string }> {
  const lockPath = installerLockPath(paths.justinRoot);
  const lockParent = path.dirname(lockPath);
  const safetyRoot = isContained(paths.userHome, lockPath) ? paths.userHome : lockParent;
  const issue = await inspectParentSafety(safetyRoot, lockPath);
  if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
  await mkdir(lockParent, { recursive: true });
  for (let attempt = 0; attempt < INSTALL_LOCK_RETRIES; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
      return { handle, lockPath };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await lstatOrNull(lockPath);
      if (stats !== null && (stats.isSymbolicLink() || !stats.isFile())) {
        throw new StoryStackError(`Installer lock path is unsafe: ${lockPath}`, "UNSAFE_INSTALL_DESTINATION");
      }
      await delay(INSTALL_LOCK_DELAY_MS);
    }
  }
  throw new StoryStackError(
    `Another JustinStack install or uninstall still holds the local lock: ${lockPath}`,
    "INSTALL_LOCKED",
  );
}

async function withInstallerLock<T>(paths: InstallPaths, operation: () => Promise<T>): Promise<T> {
  const { handle, lockPath } = await acquireInstallerLock(paths);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
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
  return (
    /^(?:bin\/(?:justinstack|story-stack)(?:\.js|\.cmd)?|runtime\/package\.json|runtime\/templates\/context\.v1\.md|runtime\/policies\/checkpoint-protocol\.md|policies\/checkpoint-protocol\.md)$/u.test(relativePath) ||
    /^runtime\/skills\/(?:story|plan-eng-review|review|resume-story)\/(?:SKILL\.md|references\/(?:[^/]+\/)*[^/]+)$/u.test(relativePath) ||
    /^runtime\/dist\/(?:src|adapters)\/(?:[^/]+\/)*[^/]+\.js$/u.test(relativePath)
  );
}

function isSkillPath(relativePath: string): boolean {
  return INSTALLED_SKILLS.some(
    (skill) => relativePath === `${skill}/SKILL.md` || relativePath.startsWith(`${skill}/references/`),
  );
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
  if ((kind === "runtime" ? !isRuntimePath(record.path) : !isSkillPath(record.path))) {
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
    (record.root === "claude-skills" && !isSkillPath(record.path))
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
  if (stats.isSymbolicLink()) return { targetPath, kind: "symbolic-link", sha256: null };
  if (stats.isDirectory()) return { targetPath, kind: "directory", sha256: null };
  if (!stats.isFile()) return { targetPath, kind: "other", sha256: null };
  return { targetPath, kind: "file", sha256: await digestFile(targetPath) };
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

function hashOnlyDiff(beforeSha256: string | null, afterSha256: string, targetPath: string): string {
  return `--- ${redactDiff(targetPath)}\n+++ ${redactDiff(targetPath)} (proposed)\n@@ binary-or-large-file @@\n- sha256:${beforeSha256 ?? "missing"}\n+ sha256:${afterSha256}\n`;
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
  const paths = resolveInstallPaths(options.userHome ?? os.homedir(), {
    ...(options.justinStackHome === undefined ? {} : { justinStackHome: options.justinStackHome }),
    ...(options.storyStackHome === undefined ? {} : { storyStackHome: options.storyStackHome }),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.claudeSkillsRoot === undefined ? {} : { claudeSkillsRoot: options.claudeSkillsRoot }),
    ...(options.bobSkillsRoot === undefined ? {} : { bobSkillsRoot: options.bobSkillsRoot }),
    ...(options.codexSkillsRoot === undefined ? {} : { codexSkillsRoot: options.codexSkillsRoot }),
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
      for (const sourcePath of await listRegularFiles(sourceRoot, true)) {
        const child = normalizeRelativePath(path.relative(sourceRoot, sourcePath));
        descriptors.push({
          root: "justinstack",
          destinationRoot: justinRoot,
          safetyRoot,
          relativePath: `runtime/skills/${skill}/${child}`,
          kind: "copy",
          sourcePath,
          generatedContents: null,
          mode: 0o644,
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
    for (const sourcePath of await listRegularFiles(sourceRoot, true)) {
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
        mode: 0o644,
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
      action = "unchanged";
      managed = owned.get(targetPath) === collision.sha256;
    } else {
      action = "replace";
      managed = owned.get(targetPath) === collision.sha256;
      if (!managed) actionableCollision = collision;
      const targetStats = await lstat(targetPath);
      diff = targetStats.size > MAX_DIFF_BYTES
        ? hashOnlyDiff(collision.sha256, sha256, targetPath)
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
      if (manifestPreviousSha === digest(manifestBytes)) manifestAction = "unchanged";
      else {
        manifestAction = "replace";
        manifestDiff = manifestStats.size > MAX_DIFF_BYTES
          ? hashOnlyDiff(manifestPreviousSha, digest(manifestBytes), paths.manifestPath)
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
    };
    const adapter = getPlatformAdapter(target);
    for (const proposal of adapter.proposals(normalized.scope, context)) {
      configurationProposals.push(await materializeProposal(
        proposal,
        normalized.scope === "project" ? paths.projectRoot : paths.userHome,
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
  if (current === null || current.kind !== "file" || current.sha256 !== entry.previousSha256) {
    throw new StoryStackError(`Install target changed after preflight: ${entry.targetPath}`, "INSTALL_PLAN_STALE");
  }
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
        await writeFileAtomic(entry.targetPath, backup.contents);
        if (process.platform !== "win32") await chmod(entry.targetPath, backup.mode);
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
        beforeRename: async () => {
          const issue = await inspectParentSafety(safetyRootFor(fresh, fresh.justinRoot), operation.targetPath);
          if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
          await assertTargetMatchesPlan(entry);
          await assertBackupMatchesPlan();
        },
      });
      if (process.platform !== "win32") await chmod(operation.targetPath, 0o600);
    }
    backups.push({ entry, contents, mode: stats.mode & 0o777, persistentPath: operation.targetPath });
  }

  const writtenEntries: InstallPlanEntry[] = [];
  try {
    const ordered = [
      ...changing.filter((entry) => entry.kind !== "manifest" && entry.action !== "remove"),
      ...changing.filter((entry) => entry.action === "remove"),
      ...changing.filter((entry) => entry.kind === "manifest"),
    ];
    for (const entry of ordered) {
      if (entry.action === "remove") {
        const issue = await inspectParentSafety(entry.safetyRoot, entry.targetPath);
        if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
        await assertTargetMatchesPlan(entry);
        await unlink(entry.targetPath);
        writtenEntries.push(entry);
        await cleanupEmptyParents(entry.targetPath, entry.destinationRoot);
        continue;
      }
      const contents = prepared.get(entry.targetPath);
      if (contents === undefined) throw new StoryStackError("Installer lost prepared contents", "INSTALL_INTERNAL_ERROR");
      await writeFileAtomic(entry.targetPath, contents, {
        beforeRename: async () => {
          const issue = await inspectParentSafety(entry.safetyRoot, entry.targetPath);
          if (issue !== null) throw new StoryStackError(issue, "UNSAFE_INSTALL_DESTINATION");
          await assertTargetMatchesPlan(entry);
        },
      });
      writtenEntries.push(entry);
      if (process.platform !== "win32") await chmod(entry.targetPath, entry.mode);
    }
  } catch (error) {
    const failures = await rollbackInstall(writtenEntries, backups);
    if (failures.length > 0) {
      throw new StoryStackError(
        `Install failed (${errorMessage(error)}) and rollback was incomplete: ${failures.join("; ")}`,
        "INSTALL_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
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
  });
  return withInstallerLock(paths, async () => applyInstallUnlocked(input, applyOptions));
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

async function canonicalSkillFiles(packageRoot: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const skill of INSTALLED_SKILLS) {
    const root = path.join(packageRoot, "skills", skill);
    for (const sourcePath of await listRegularFiles(root, true)) {
      const relative = `${skill}/${normalizeRelativePath(path.relative(root, sourcePath))}`;
      result.set(relative, await digestFile(sourcePath));
    }
  }
  return result;
}

export async function inspectPlatformInstallations(options: InstallerOptions = {}): Promise<PlatformDoctorStatus[]> {
  const normalized = await normalizeOptions(options);
  const paths = resolveInstallPaths(normalized.userHome, {
    justinStackHome: normalized.justinStackHome,
    projectRoot: normalized.projectRoot,
    target: normalized.target,
    scope: normalized.scope,
    skillRoots: normalized.skillRoots,
  });
  const canonical = await canonicalSkillFiles(normalized.packageRoot);
  let installedManifest: InstallManifestV2 | null = null;
  let manifestProblem = false;
  try {
    const loaded = await readExistingManifest(paths.manifestPath, safetyRootFor(paths, paths.justinRoot));
    installedManifest = loaded?.manifest.schema_version === 2 ? loaded.manifest : null;
    manifestProblem = loaded !== null && loaded.manifest.schema_version !== 2;
  } catch {
    manifestProblem = true;
  }
  const currentRuntimePaths = new Set(
    (await runtimeDescriptors(
      normalized.packageRoot,
      paths.justinRoot,
      safetyRootFor(paths, paths.justinRoot),
      normalized.packageVersion,
    )).map((entry) => entry.relativePath),
  );
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
    const recordedRootIsSafe = recordedRoot !== null && recordedRoot !== undefined && isContained(scopeBoundary, recordedRoot);
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
    for (const [relative, expected] of canonical) {
      const targetPath = path.resolve(nativePath(skillsRoot, relative));
      const parentIssue = await inspectParentSafety(safetyRootFor(paths, skillsRoot), targetPath);
      if (parentIssue !== null) {
        stale.push(targetPath);
        continue;
      }
      const stats = await lstatOrNull(targetPath);
      if (stats === null) missing.push(targetPath);
      else if (stats.isSymbolicLink() || !stats.isFile() || await digestFile(targetPath) !== expected) stale.push(targetPath);
      else installed.push(targetPath);
    }
    const context: AdapterPaths = {
      userHome: normalized.userHome,
      projectRoot: normalized.projectRoot,
      justinStackHome: paths.justinRoot,
    };
    const adapter = getPlatformAdapter(target);
    const configurationProposals: ConfigurationProposalView[] = [];
    for (const proposal of adapter.proposals(normalized.scope, context)) {
      configurationProposals.push(await materializeProposal(
        proposal,
        normalized.scope === "project" ? paths.projectRoot : paths.userHome,
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
      if (!isContained(scopeBoundary, skillRoot)) {
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
          safetyRootFor(paths, skillRoot),
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
