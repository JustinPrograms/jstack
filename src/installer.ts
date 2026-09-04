import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StoryStackError, errorMessage } from "./errors.js";
import { writeFileAtomic } from "./checkpoint/atomic.js";

export const INSTALL_MANIFEST_SCHEMA_VERSION = 1 as const;
export const INSTALL_MANIFEST_FILENAME = "install-manifest.json";
export const INSTALLED_SKILLS = ["story", "plan-eng-review", "review", "resume-story"] as const;

export type InstalledSkill = (typeof INSTALLED_SKILLS)[number];
export type InstallRoot = "story-stack" | "claude-skills";
export type InstallEntryKind = "copy" | "generated" | "manifest";
export type CollisionKind = "file" | "directory" | "symbolic-link" | "other";

export interface InstallerOptions {
  /** The story-stack source checkout containing package.json, dist, skills, policies, and templates. */
  packageRoot?: string;
  /** Used instead of the operating-system home directory. Primarily useful for isolated tests. */
  userHome?: string;
  /** Exact runtime/private-state root. Defaults to <userHome>/.story-stack. */
  storyStackHome?: string;
  /** Exact Claude skills root. Defaults to <userHome>/.claude/skills. */
  claudeSkillsRoot?: string;
  /** Overrides the version read from package.json. Primarily useful for packaging tests. */
  version?: string;
}

export interface ApplyInstallOptions {
  /** Required to replace any existing regular-file target. */
  confirmOverwrite?: boolean;
}

export interface InstallPaths {
  userHome: string;
  storyRoot: string;
  skillsRoot: string;
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

export interface InstallPlanEntry {
  root: InstallRoot;
  relativePath: string;
  targetPath: string;
  kind: InstallEntryKind;
  sourcePath: string | null;
  generatedContents: string | null;
  sha256: string;
  mode: number;
  collision: InstallCollision | null;
}

export interface InstallManifestEntry {
  root: InstallRoot;
  path: string;
  sha256: string;
}

export interface InstallManifest {
  schema_version: typeof INSTALL_MANIFEST_SCHEMA_VERSION;
  package_version: string;
  entries: InstallManifestEntry[];
}

export interface InstallPlan {
  packageRoot: string;
  packageVersion: string;
  userHome: string;
  storyRoot: string;
  skillsRoot: string;
  manifestPath: string;
  entries: InstallPlanEntry[];
  collisions: InstallCollision[];
  safetyIssues: InstallSafetyIssue[];
  manifest: InstallManifest;
  fingerprint: string;
}

export interface InstallResult {
  /** Every file written, including the manifest. */
  written: string[];
  /** Backward-compatible descriptive alias for written. */
  installed: string[];
  overwritten: string[];
  manifestPath: string;
}

export type UninstallEntryStatus = "remove" | "missing" | "modified" | "unsafe";

export interface UninstallPlanEntry {
  root: InstallRoot;
  relativePath: string;
  targetPath: string;
  expectedSha256: string;
  actualSha256: string | null;
  status: UninstallEntryStatus;
  reason: string | null;
}

export interface UninstallPlan {
  userHome: string;
  storyRoot: string;
  skillsRoot: string;
  manifestPath: string;
  manifestFound: boolean;
  manifestSha256: string | null;
  packageVersion: string | null;
  entries: UninstallPlanEntry[];
  issues: string[];
  blocked: PreservedInstallFile[];
  canFullyUninstall: boolean;
}

export interface PreservedInstallFile {
  targetPath: string;
  reason: string;
}

export interface UninstallResult {
  removed: string[];
  missing: string[];
  preserved: PreservedInstallFile[];
  /** Descriptive alias used by CLI output for files refused or failed. */
  blocked: PreservedInstallFile[];
  manifestPath: string;
  manifestRemoved: boolean;
  complete: boolean;
  statePreserved: true;
}

interface SourceEntry {
  root: InstallRoot;
  relativePath: string;
  sourcePath: string;
  mode: number;
}

interface GeneratedEntry {
  root: InstallRoot;
  relativePath: string;
  contents: string;
  mode: number;
}

interface CollisionBackup {
  contents: Uint8Array;
  mode: number;
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;

function defaultPackageRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(path.dirname(moduleDirectory)) === "dist"
    ? path.resolve(moduleDirectory, "../..")
    : path.resolve(moduleDirectory, "..");
}

export function resolveInstallPaths(
  userHome = os.homedir(),
  overrides: Pick<InstallerOptions, "storyStackHome" | "claudeSkillsRoot"> = {},
): InstallPaths {
  if (typeof userHome !== "string" || userHome.trim().length === 0 || /\0/u.test(userHome)) {
    throw new StoryStackError("The installer requires a valid user home directory", "INVALID_INSTALL_HOME");
  }
  const resolvedHome = path.resolve(userHome);
  const storyRoot = path.resolve(overrides.storyStackHome ?? path.join(resolvedHome, ".story-stack"));
  const skillsRoot = path.resolve(overrides.claudeSkillsRoot ?? path.join(resolvedHome, ".claude", "skills"));
  if (storyRoot === path.parse(storyRoot).root || skillsRoot === path.parse(skillsRoot).root) {
    throw new StoryStackError("Install roots cannot be filesystem roots", "INVALID_INSTALL_ROOT");
  }
  if (isContained(storyRoot, skillsRoot) || isContained(skillsRoot, storyRoot)) {
    throw new StoryStackError("Runtime and Claude skill roots cannot overlap", "INVALID_INSTALL_ROOT");
  }
  return {
    userHome: resolvedHome,
    storyRoot,
    skillsRoot,
    manifestPath: path.join(storyRoot, INSTALL_MANIFEST_FILENAME),
  };
}

async function safetyAnchor(paths: InstallPaths, destinationRoot: string): Promise<string> {
  if (isContained(paths.userHome, destinationRoot)) return paths.userHome;
  let cursor = path.dirname(destinationRoot);
  for (;;) {
    if ((await lstatOrNull(cursor)) !== null) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}

async function inspectInstallParentSafety(
  paths: InstallPaths,
  destinationRoot: string,
  targetPath: string,
): Promise<string | null> {
  return inspectParentSafety(await safetyAnchor(paths, destinationRoot), targetPath);
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

function isAllowlistedManifestEntry(root: InstallRoot, relativePath: string): boolean {
  if (root === "claude-skills") {
    return INSTALLED_SKILLS.some((skill) => relativePath === `${skill}/SKILL.md`);
  }
  return (
    relativePath === "bin/story-stack.js" ||
    relativePath === "bin/story-stack" ||
    relativePath === "bin/story-stack.cmd" ||
    relativePath === "runtime/package.json" ||
    relativePath === "runtime/templates/context.v1.md" ||
    relativePath === "policies/checkpoint-protocol.md" ||
    /^runtime\/dist\/src\/(?:[^/]+\/)*[^/]+\.js$/u.test(relativePath)
  );
}

function assertManifestEntry(value: unknown): asserts value is InstallManifestEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoryStackError("Install manifest entry must be an object", "INVALID_INSTALL_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "path,root,sha256") {
    throw new StoryStackError("Install manifest entry has missing or unknown fields", "INVALID_INSTALL_MANIFEST");
  }
  if (record.root !== "story-stack" && record.root !== "claude-skills") {
    throw new StoryStackError("Install manifest entry has an unknown root", "INVALID_INSTALL_MANIFEST");
  }
  assertManifestRelativePath(record.path);
  if (!isAllowlistedManifestEntry(record.root, record.path)) {
    throw new StoryStackError(
      `Install manifest path is outside the owned-file allowlist: ${record.path}`,
      "INVALID_INSTALL_MANIFEST",
    );
  }
  if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
    throw new StoryStackError("Install manifest entry has an invalid SHA-256 digest", "INVALID_INSTALL_MANIFEST");
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
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "entries,package_version,schema_version") {
    throw new StoryStackError("Install manifest has missing or unknown fields", "INVALID_INSTALL_MANIFEST");
  }
  if (record.schema_version !== INSTALL_MANIFEST_SCHEMA_VERSION) {
    throw new StoryStackError(
      `Unsupported install manifest schema '${String(record.schema_version)}'`,
      "UNSUPPORTED_INSTALL_MANIFEST",
    );
  }
  if (typeof record.package_version !== "string" || !VERSION_PATTERN.test(record.package_version)) {
    throw new StoryStackError("Install manifest has an invalid package version", "INVALID_INSTALL_MANIFEST");
  }
  if (!Array.isArray(record.entries) || record.entries.length > 10_000) {
    throw new StoryStackError("Install manifest entries must be a bounded array", "INVALID_INSTALL_MANIFEST");
  }
  for (const entry of record.entries) assertManifestEntry(entry);
  const entries = record.entries as InstallManifestEntry[];
  const identities = entries.map((entry) => `${entry.root}:${entry.path}`);
  if (new Set(identities).size !== identities.length) {
    throw new StoryStackError("Install manifest contains duplicate paths", "INVALID_INSTALL_MANIFEST");
  }
  return {
    schema_version: INSTALL_MANIFEST_SCHEMA_VERSION,
    package_version: record.package_version,
    entries: entries.map((entry) => ({ ...entry })),
  };
}

function serializeManifest(manifest: InstallManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readPackageVersion(packageRoot: string): Promise<string> {
  const packagePath = path.join(packageRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
  } catch (error) {
    throw new StoryStackError(`Cannot read package metadata at ${packagePath}: ${errorMessage(error)}`, "INVALID_PACKAGE");
  }
  const version =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).version
      : undefined;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new StoryStackError(`Package metadata at ${packagePath} has an invalid version`, "INVALID_PACKAGE");
  }
  return version;
}

async function assertRegularSource(sourcePath: string): Promise<void> {
  const stats = await lstatOrNull(sourcePath);
  if (stats === null || !stats.isFile() || stats.isSymbolicLink()) {
    throw new StoryStackError(`Required installer source is not a regular file: ${sourcePath}`, "MISSING_INSTALL_SOURCE");
  }
}

async function listCompiledJavaScript(compiledRoot: string): Promise<string[]> {
  const rootStats = await lstatOrNull(compiledRoot);
  if (rootStats === null || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new StoryStackError(
      `Compiled runtime not found at ${compiledRoot}; run the local build first`,
      "MISSING_COMPILED_RUNTIME",
    );
  }
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new StoryStackError(`Compiled runtime cannot contain symbolic links: ${entryPath}`, "UNSAFE_INSTALL_SOURCE");
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        results.push(entryPath);
      }
    }
  }
  await visit(compiledRoot);
  const cliPath = path.join(compiledRoot, "cli.js");
  if (!results.includes(cliPath)) {
    throw new StoryStackError(`Compiled CLI not found at ${cliPath}; run the local build first`, "MISSING_COMPILED_RUNTIME");
  }
  return results;
}

function nodeLauncher(): string {
  return `#!/usr/bin/env node
async function run() {
  const cli = await import("../runtime/dist/src/cli.js");
  if (typeof cli.main !== "function") {
    throw new Error("Installed story-stack CLI does not export main()");
  }
  process.exitCode = await cli.main(process.argv.slice(2));
}

run().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
`;
}

function windowsLauncher(): string {
  return `@echo off\r
node "%~dp0story-stack.js" %*\r
exit /b %errorlevel%\r
`;
}

function runtimePackage(version: string): string {
  return `${JSON.stringify(
    {
      name: "story-stack-installed-runtime",
      version,
      private: true,
      type: "module",
    },
    null,
    2,
  )}\n`;
}

async function inspectParentSafety(safetyRoot: string, targetPath: string): Promise<string | null> {
  assertContained(safetyRoot, targetPath, "Install target");
  const rootStats = await lstatOrNull(safetyRoot);
  if (rootStats === null) return `Destination safety root does not exist: ${safetyRoot}`;
  if (rootStats.isSymbolicLink()) return `Destination parent is a symbolic link or junction: ${safetyRoot}`;
  if (!rootStats.isDirectory()) return `Destination parent is not a directory: ${safetyRoot}`;

  const targetParent = path.dirname(targetPath);
  const relativeParent = path.relative(safetyRoot, targetParent);
  let cursor = safetyRoot;
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

function rootPath(paths: InstallPaths, root: InstallRoot): string {
  return root === "story-stack" ? paths.storyRoot : paths.skillsRoot;
}

function planFingerprint(entries: InstallPlanEntry[]): string {
  return digest(
    JSON.stringify(
      entries.map((entry) => ({
        root: entry.root,
        path: entry.relativePath,
        sha256: entry.sha256,
        mode: entry.mode,
        kind: entry.kind,
        sourcePath: entry.sourcePath,
      })),
    ),
  );
}

async function materializeEntry(
  entry: SourceEntry | GeneratedEntry,
  paths: InstallPaths,
  kind: Exclude<InstallEntryKind, "manifest">,
): Promise<InstallPlanEntry> {
  assertManifestRelativePath(entry.relativePath);
  if (!isAllowlistedManifestEntry(entry.root, entry.relativePath)) {
    throw new StoryStackError(`Installer target is not allowlisted: ${entry.relativePath}`, "UNSAFE_INSTALL_TARGET");
  }
  const targetRoot = rootPath(paths, entry.root);
  const targetPath = path.resolve(nativePath(targetRoot, entry.relativePath));
  assertContained(targetRoot, targetPath, "Install target");
  const safetyMessage = await inspectInstallParentSafety(paths, targetRoot, targetPath);
  const collision = safetyMessage === null ? await inspectCollision(targetPath) : null;
  if ("sourcePath" in entry) {
    await assertRegularSource(entry.sourcePath);
    const contents = await readFile(entry.sourcePath);
    return {
      root: entry.root,
      relativePath: entry.relativePath,
      targetPath,
      kind,
      sourcePath: entry.sourcePath,
      generatedContents: null,
      sha256: digest(contents),
      mode: entry.mode,
      collision,
    };
  }
  return {
    root: entry.root,
    relativePath: entry.relativePath,
    targetPath,
    kind,
    sourcePath: null,
    generatedContents: entry.contents,
    sha256: digest(entry.contents),
    mode: entry.mode,
    collision,
  };
}

export async function planInstall(options: InstallerOptions = {}): Promise<InstallPlan> {
  const packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot());
  const paths = resolveInstallPaths(options.userHome ?? os.homedir(), {
    ...(options.storyStackHome === undefined ? {} : { storyStackHome: options.storyStackHome }),
    ...(options.claudeSkillsRoot === undefined ? {} : { claudeSkillsRoot: options.claudeSkillsRoot }),
  });
  const packageVersion = options.version ?? (await readPackageVersion(packageRoot));
  if (!VERSION_PATTERN.test(packageVersion)) {
    throw new StoryStackError("Installer package version is invalid", "INVALID_PACKAGE");
  }

  const compiledRoot = path.join(packageRoot, "dist", "src");
  const compiledFiles = await listCompiledJavaScript(compiledRoot);
  const sourceEntries: SourceEntry[] = compiledFiles.map((sourcePath) => ({
    root: "story-stack",
    relativePath: `runtime/dist/src/${normalizeRelativePath(path.relative(compiledRoot, sourcePath))}`,
    sourcePath,
    mode: 0o644,
  }));
  sourceEntries.push(
    {
      root: "story-stack",
      relativePath: "runtime/templates/context.v1.md",
      sourcePath: path.join(packageRoot, "templates", "context.v1.md"),
      mode: 0o644,
    },
    {
      root: "story-stack",
      relativePath: "policies/checkpoint-protocol.md",
      sourcePath: path.join(packageRoot, "policies", "checkpoint-protocol.md"),
      mode: 0o644,
    },
  );
  for (const skill of INSTALLED_SKILLS) {
    sourceEntries.push({
      root: "claude-skills",
      relativePath: `${skill}/SKILL.md`,
      sourcePath: path.join(packageRoot, "skills", skill, "SKILL.md"),
      mode: 0o644,
    });
  }

  const generatedEntries: GeneratedEntry[] = [
    {
      root: "story-stack",
      relativePath: "runtime/package.json",
      contents: runtimePackage(packageVersion),
      mode: 0o644,
    },
    {
      root: "story-stack",
      relativePath: "bin/story-stack.js",
      contents: nodeLauncher(),
      mode: 0o755,
    },
    {
      root: "story-stack",
      relativePath: "bin/story-stack",
      contents: nodeLauncher(),
      mode: 0o755,
    },
    {
      root: "story-stack",
      relativePath: "bin/story-stack.cmd",
      contents: windowsLauncher(),
      mode: 0o644,
    },
  ];

  const entries: InstallPlanEntry[] = [];
  for (const entry of [...sourceEntries].sort((left, right) =>
    `${left.root}:${left.relativePath}`.localeCompare(`${right.root}:${right.relativePath}`, "en"),
  )) {
    entries.push(await materializeEntry(entry, paths, "copy"));
  }
  for (const entry of generatedEntries.sort((left, right) =>
    `${left.root}:${left.relativePath}`.localeCompare(`${right.root}:${right.relativePath}`, "en"),
  )) {
    entries.push(await materializeEntry(entry, paths, "generated"));
  }

  const manifest: InstallManifest = {
    schema_version: INSTALL_MANIFEST_SCHEMA_VERSION,
    package_version: packageVersion,
    entries: entries
      .map((entry) => ({ root: entry.root, path: entry.relativePath, sha256: entry.sha256 }))
      .sort((left, right) => `${left.root}:${left.path}`.localeCompare(`${right.root}:${right.path}`, "en")),
  };
  const manifestContents = serializeManifest(manifest);
  const manifestSafety = await inspectInstallParentSafety(paths, paths.storyRoot, paths.manifestPath);
  const manifestCollision = manifestSafety === null ? await inspectCollision(paths.manifestPath) : null;
  entries.push({
    root: "story-stack",
    relativePath: INSTALL_MANIFEST_FILENAME,
    targetPath: paths.manifestPath,
    kind: "manifest",
    sourcePath: null,
    generatedContents: manifestContents,
    sha256: digest(manifestContents),
    mode: 0o600,
    collision: manifestCollision,
  });

  const safetyIssues: InstallSafetyIssue[] = [];
  for (const entry of entries) {
    const message = await inspectInstallParentSafety(paths, rootPath(paths, entry.root), entry.targetPath);
    if (message !== null && !safetyIssues.some((issue) => issue.targetPath === entry.targetPath && issue.message === message)) {
      safetyIssues.push({ targetPath: entry.targetPath, message });
    }
  }
  return {
    packageRoot,
    packageVersion,
    userHome: paths.userHome,
    storyRoot: paths.storyRoot,
    skillsRoot: paths.skillsRoot,
    manifestPath: paths.manifestPath,
    entries,
    collisions: entries.flatMap((entry) => (entry.collision === null ? [] : [entry.collision])),
    safetyIssues,
    manifest,
    fingerprint: planFingerprint(entries),
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

function collisionSummary(collisions: InstallCollision[]): string {
  return collisions.map((collision) => collision.targetPath).join(", ");
}

async function assertCollisionUnchanged(entry: InstallPlanEntry): Promise<void> {
  const current = await inspectCollision(entry.targetPath);
  const expected = entry.collision;
  if (expected === null) {
    if (current !== null) {
      throw new StoryStackError(`Install target appeared after preflight: ${entry.targetPath}`, "INSTALL_COLLISION");
    }
    return;
  }
  if (
    current === null ||
    current.kind !== expected.kind ||
    current.sha256 !== expected.sha256 ||
    current.kind !== "file"
  ) {
    throw new StoryStackError(`Install target changed after preflight: ${entry.targetPath}`, "INSTALL_PLAN_STALE");
  }
}

async function rollbackInstall(
  writtenEntries: InstallPlanEntry[],
  backups: Map<string, CollisionBackup>,
  plan: InstallPlan,
): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of [...writtenEntries].reverse()) {
    try {
      const current = await inspectCollision(entry.targetPath);
      const backup = backups.get(entry.targetPath);
      if (current !== null && (current.kind !== "file" || current.sha256 !== entry.sha256)) {
        throw new StoryStackError(
          "Installed file changed before rollback; preserving it to avoid destroying concurrent work",
          "INSTALL_ROLLBACK_CONFLICT",
        );
      }
      if (backup !== undefined) {
        await writeFileAtomic(entry.targetPath, backup.contents);
        if (process.platform !== "win32") await chmod(entry.targetPath, backup.mode);
      } else if (current !== null) {
        await unlink(entry.targetPath);
        await cleanupEmptyParents(entry.targetPath, rootPath(plan, entry.root));
      }
    } catch (error) {
      failures.push(`${entry.targetPath}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

export async function applyInstall(
  input: InstallPlan | InstallerOptions = {},
  applyOptions: ApplyInstallOptions = {},
): Promise<InstallResult> {
  const suppliedPlan = isInstallPlan(input) ? input : null;
  const freshPlan = await planInstall(
    suppliedPlan === null
      ? input
      : {
          packageRoot: suppliedPlan.packageRoot,
          userHome: suppliedPlan.userHome,
          storyStackHome: suppliedPlan.storyRoot,
          claudeSkillsRoot: suppliedPlan.skillsRoot,
          version: suppliedPlan.packageVersion,
        },
  );
  if (suppliedPlan !== null && suppliedPlan.fingerprint !== freshPlan.fingerprint) {
    throw new StoryStackError("Install sources or targets changed after planning; create a new plan", "INSTALL_PLAN_STALE");
  }
  if (freshPlan.safetyIssues.length > 0) {
    throw new StoryStackError(
      `Unsafe install destination: ${freshPlan.safetyIssues.map((issue) => issue.message).join("; ")}`,
      "UNSAFE_INSTALL_DESTINATION",
    );
  }
  if (freshPlan.collisions.length > 0 && applyOptions.confirmOverwrite !== true) {
    throw new StoryStackError(
      `Install targets already exist; explicit overwrite confirmation is required: ${collisionSummary(freshPlan.collisions)}`,
      "INSTALL_COLLISION",
    );
  }
  const nonFileCollisions = freshPlan.collisions.filter((collision) => collision.kind !== "file");
  if (nonFileCollisions.length > 0) {
    throw new StoryStackError(
      `Only regular-file collisions can be overwritten: ${collisionSummary(nonFileCollisions)}`,
      "UNSAFE_INSTALL_DESTINATION",
    );
  }

  // Read and verify every source before making the first filesystem change.
  const prepared = new Map<string, Uint8Array>();
  for (const entry of freshPlan.entries) prepared.set(entry.targetPath, await entryContents(entry));
  for (const entry of freshPlan.entries) {
    const safetyMessage = await inspectInstallParentSafety(
      freshPlan,
      rootPath(freshPlan, entry.root),
      entry.targetPath,
    );
    if (safetyMessage !== null) {
      throw new StoryStackError(safetyMessage, "UNSAFE_INSTALL_DESTINATION");
    }
    await assertCollisionUnchanged(entry);
  }

  // Preserve every confirmed collision before the first replacement. This lets
  // ordinary I/O failures roll the whole install back without losing user data.
  const backups = new Map<string, CollisionBackup>();
  for (const entry of freshPlan.entries.filter((candidate) => candidate.collision !== null)) {
    await assertCollisionUnchanged(entry);
    const stats = await lstat(entry.targetPath);
    backups.set(entry.targetPath, {
      contents: await readFile(entry.targetPath),
      mode: stats.mode & 0o777,
    });
  }

  const installed: string[] = [];
  const overwritten: string[] = [];
  const orderedEntries = [
    ...freshPlan.entries.filter((entry) => entry.kind !== "manifest"),
    ...freshPlan.entries.filter((entry) => entry.kind === "manifest"),
  ];
  const writtenEntries: InstallPlanEntry[] = [];
  try {
    for (const entry of orderedEntries) {
      const contents = prepared.get(entry.targetPath);
      if (contents === undefined) throw new StoryStackError("Installer lost prepared file contents", "INSTALL_INTERNAL_ERROR");
      await writeFileAtomic(entry.targetPath, contents, {
        beforeRename: async () => assertCollisionUnchanged(entry),
      });
      writtenEntries.push(entry);
      if (process.platform !== "win32") await chmod(entry.targetPath, entry.mode);
      installed.push(entry.targetPath);
      if (entry.collision !== null) overwritten.push(entry.targetPath);
    }
  } catch (error) {
    const rollbackFailures = await rollbackInstall(writtenEntries, backups, freshPlan);
    if (rollbackFailures.length > 0) {
      throw new StoryStackError(
        `Install failed (${errorMessage(error)}) and rollback was incomplete: ${rollbackFailures.join("; ")}`,
        "INSTALL_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
  return { written: installed, installed, overwritten, manifestPath: freshPlan.manifestPath };
}

export function formatInstallPlan(plan: InstallPlan): string {
  const lines = [
    `story-stack ${plan.packageVersion} install plan (no files written)`,
    `Runtime root: ${plan.storyRoot}`,
    `Claude skills root: ${plan.skillsRoot}`,
    "Targets:",
  ];
  for (const entry of plan.entries) {
    const action = entry.collision === null ? "CREATE" : "COLLISION";
    const source = entry.sourcePath ?? (entry.kind === "manifest" ? "generated manifest (written last)" : "generated launcher/runtime metadata");
    lines.push(`  ${action} ${entry.targetPath} <- ${source}`);
  }
  if (plan.safetyIssues.length > 0) {
    lines.push("Safety refusals:");
    for (const issue of plan.safetyIssues) lines.push(`  ${issue.targetPath}: ${issue.message}`);
  }
  if (plan.collisions.length > 0) {
    lines.push("Existing targets (apply requires explicit overwrite confirmation):");
    for (const collision of plan.collisions) lines.push(`  ${collision.kind}: ${collision.targetPath}`);
  }
  lines.push("No PATH, shell profile, Claude settings, Git configuration, or remote service will be changed.");
  return `${lines.join("\n")}\n`;
}

async function readManifestForUninstall(paths: InstallPaths): Promise<{
  manifest: InstallManifest;
  sha256: string;
} | null> {
  const manifestPath = paths.manifestPath;
  const parentIssue = await inspectInstallParentSafety(paths, paths.storyRoot, manifestPath);
  if (parentIssue !== null) throw new StoryStackError(parentIssue, "UNSAFE_UNINSTALL_DESTINATION");
  const stats = await lstatOrNull(manifestPath);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new StoryStackError("Install manifest is not a regular file", "INVALID_INSTALL_MANIFEST");
  }
  if (stats.size > MAX_MANIFEST_BYTES) {
    throw new StoryStackError("Install manifest exceeds the safe size limit", "INVALID_INSTALL_MANIFEST");
  }
  const source = await readFile(manifestPath, "utf8");
  return { manifest: parseInstallManifest(source), sha256: digest(source) };
}

async function inspectUninstallEntry(
  paths: InstallPaths,
  manifestEntry: InstallManifestEntry,
): Promise<UninstallPlanEntry> {
  // parseInstallManifest has already validated this path and the per-root allowlist.
  const targetRoot = rootPath(paths, manifestEntry.root);
  const targetPath = path.resolve(nativePath(targetRoot, manifestEntry.path));
  assertContained(targetRoot, targetPath, "Uninstall target");
  const parentIssue = await inspectInstallParentSafety(paths, targetRoot, targetPath);
  if (parentIssue !== null) {
    return {
      root: manifestEntry.root,
      relativePath: manifestEntry.path,
      targetPath,
      expectedSha256: manifestEntry.sha256,
      actualSha256: null,
      status: "unsafe",
      reason: parentIssue,
    };
  }
  const stats = await lstatOrNull(targetPath);
  if (stats === null) {
    return {
      root: manifestEntry.root,
      relativePath: manifestEntry.path,
      targetPath,
      expectedSha256: manifestEntry.sha256,
      actualSha256: null,
      status: "missing",
      reason: null,
    };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return {
      root: manifestEntry.root,
      relativePath: manifestEntry.path,
      targetPath,
      expectedSha256: manifestEntry.sha256,
      actualSha256: null,
      status: "unsafe",
      reason: "Owned path is no longer a regular file",
    };
  }
  const actualSha256 = await digestFile(targetPath);
  return {
    root: manifestEntry.root,
    relativePath: manifestEntry.path,
    targetPath,
    expectedSha256: manifestEntry.sha256,
    actualSha256,
    status: actualSha256 === manifestEntry.sha256 ? "remove" : "modified",
    reason: actualSha256 === manifestEntry.sha256 ? null : "File content differs from the install manifest",
  };
}

export async function planUninstall(options: InstallerOptions = {}): Promise<UninstallPlan> {
  const paths = resolveInstallPaths(options.userHome ?? os.homedir(), {
    ...(options.storyStackHome === undefined ? {} : { storyStackHome: options.storyStackHome }),
    ...(options.claudeSkillsRoot === undefined ? {} : { claudeSkillsRoot: options.claudeSkillsRoot }),
  });
  const loaded = await readManifestForUninstall(paths);
  if (loaded === null) {
    return {
      userHome: paths.userHome,
      storyRoot: paths.storyRoot,
      skillsRoot: paths.skillsRoot,
      manifestPath: paths.manifestPath,
      manifestFound: false,
      manifestSha256: null,
      packageVersion: null,
      entries: [],
      issues: [`Install manifest not found: ${paths.manifestPath}`],
      blocked: [{ targetPath: paths.manifestPath, reason: "Install manifest not found" }],
      canFullyUninstall: false,
    };
  }
  const entries: UninstallPlanEntry[] = [];
  for (const entry of loaded.manifest.entries) entries.push(await inspectUninstallEntry(paths, entry));
  const issues = entries
    .filter((entry) => entry.status === "modified" || entry.status === "unsafe")
    .map((entry) => `${entry.targetPath}: ${entry.reason ?? entry.status}`);
  const blocked = entries
    .filter((entry) => entry.status === "modified" || entry.status === "unsafe")
    .map((entry) => ({ targetPath: entry.targetPath, reason: entry.reason ?? entry.status }));
  return {
    userHome: paths.userHome,
    storyRoot: paths.storyRoot,
    skillsRoot: paths.skillsRoot,
    manifestPath: paths.manifestPath,
    manifestFound: true,
    manifestSha256: loaded.sha256,
    packageVersion: loaded.manifest.package_version,
    entries,
    issues,
    blocked,
    canFullyUninstall: issues.length === 0,
  };
}

function isUninstallPlan(
  value: UninstallPlan | InstallerOptions,
): value is UninstallPlan {
  return "manifestFound" in value && "entries" in value;
}

async function cleanupEmptyParents(targetPath: string, boundary: string): Promise<void> {
  let cursor = path.dirname(targetPath);
  while (cursor !== boundary && isContained(boundary, cursor)) {
    try {
      await rmdir(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Continue upward when a child directory was already absent.
      } else if (code === "ENOTEMPTY" || code === "EEXIST") {
        return;
      } else {
        return;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function manifestStillMatches(plan: UninstallPlan): Promise<boolean> {
  if (plan.manifestSha256 === null) return false;
  const stats = await lstatOrNull(plan.manifestPath);
  return stats !== null && stats.isFile() && !stats.isSymbolicLink() && (await digestFile(plan.manifestPath)) === plan.manifestSha256;
}

export async function applyUninstall(
  input: UninstallPlan | InstallerOptions = {},
): Promise<UninstallResult> {
  const suppliedPlan = isUninstallPlan(input) ? input : null;
  const freshPlan = await planUninstall(
    suppliedPlan === null
      ? input
      : {
          userHome: suppliedPlan.userHome,
          storyStackHome: suppliedPlan.storyRoot,
          claudeSkillsRoot: suppliedPlan.skillsRoot,
        },
  );
  if (!freshPlan.manifestFound || freshPlan.manifestSha256 === null) {
    throw new StoryStackError(`Install manifest not found: ${freshPlan.manifestPath}`, "INSTALL_MANIFEST_NOT_FOUND");
  }
  if (suppliedPlan !== null && suppliedPlan.manifestSha256 !== freshPlan.manifestSha256) {
    throw new StoryStackError("Install manifest changed after planning; create a new uninstall plan", "UNINSTALL_PLAN_STALE");
  }

  const paths = resolveInstallPaths(freshPlan.userHome, {
    storyStackHome: freshPlan.storyRoot,
    claudeSkillsRoot: freshPlan.skillsRoot,
  });
  const removed: string[] = [];
  const missing: string[] = [];
  const preserved: PreservedInstallFile[] = [];

  for (const plannedEntry of freshPlan.entries) {
    const liveEntry = await inspectUninstallEntry(paths, {
      root: plannedEntry.root,
      path: plannedEntry.relativePath,
      sha256: plannedEntry.expectedSha256,
    });
    if (liveEntry.status === "missing") {
      missing.push(liveEntry.targetPath);
      continue;
    }
    if (liveEntry.status !== "remove") {
      preserved.push({ targetPath: liveEntry.targetPath, reason: liveEntry.reason ?? liveEntry.status });
      continue;
    }
    try {
      await unlink(liveEntry.targetPath);
      removed.push(liveEntry.targetPath);
      await cleanupEmptyParents(
        liveEntry.targetPath,
        liveEntry.root === "story-stack" ? freshPlan.storyRoot : freshPlan.skillsRoot,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(liveEntry.targetPath);
      } else {
        preserved.push({ targetPath: liveEntry.targetPath, reason: `Removal failed: ${errorMessage(error)}` });
      }
    }
  }

  let manifestRemoved = false;
  if (preserved.length === 0) {
    if (await manifestStillMatches(freshPlan)) {
      try {
        await unlink(freshPlan.manifestPath);
        manifestRemoved = true;
        await cleanupEmptyParents(freshPlan.manifestPath, freshPlan.storyRoot);
        await rmdir(freshPlan.storyRoot).catch(() => undefined);
      } catch (error) {
        preserved.push({ targetPath: freshPlan.manifestPath, reason: `Manifest removal failed: ${errorMessage(error)}` });
      }
    } else {
      preserved.push({ targetPath: freshPlan.manifestPath, reason: "Manifest changed during uninstall" });
    }
  }

  return {
    removed,
    missing,
    preserved,
    blocked: preserved,
    manifestPath: freshPlan.manifestPath,
    manifestRemoved,
    complete: manifestRemoved && preserved.length === 0,
    statePreserved: true,
  };
}

export function formatUninstallPlan(plan: UninstallPlan): string {
  const lines = [
    "story-stack uninstall plan (no files removed)",
    `Manifest: ${plan.manifestPath}`,
  ];
  if (!plan.manifestFound) {
    lines.push("  MISSING install manifest; nothing can be safely identified as installer-owned.");
    return `${lines.join("\n")}\n`;
  }
  for (const entry of plan.entries) lines.push(`  ${entry.status.toUpperCase()} ${entry.targetPath}`);
  if (plan.issues.length > 0) {
    lines.push("Files marked MODIFIED or UNSAFE will be preserved, and the manifest will remain for recovery.");
  } else {
    lines.push("Only manifest-owned, hash-matching files will be removed.");
  }
  lines.push("Ticket checkpoints under the story-stack state directory are never removed.");
  return `${lines.join("\n")}\n`;
}
