import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { StoryStackError } from "../errors.js";

export async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readRegularFileOrNull(filePath: string): Promise<string | null> {
  const stats = await lstatOrNull(filePath);
  if (stats === null) return null;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new StoryStackError(`State path must be a regular file, not a link or directory: ${filePath}`, "UNSAFE_STATE_FILE");
  }
  return readFile(filePath, "utf8");
}

export async function assertSafeWritePath(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new StoryStackError("Write target escapes the configured story-stack root", "PATH_TRAVERSAL");
  }
  const parsed = path.parse(resolvedTarget);
  let cursor = parsed.root;
  const components = resolvedTarget.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components.slice(0, -1)) {
    cursor = path.join(cursor, component);
    const stats = await lstatOrNull(cursor);
    if (stats === null) break;
    if (stats.isSymbolicLink()) {
      throw new StoryStackError(`Refusing to write through symbolic link or junction: ${cursor}`, "SYMLINK_WRITE_REFUSED");
    }
    if (!stats.isDirectory()) {
      throw new StoryStackError(`Checkpoint parent is not a directory: ${cursor}`, "INVALID_STATE_PATH");
    }
  }
  const rootStats = await lstatOrNull(resolvedRoot);
  if (rootStats !== null) {
    const canonicalRoot = await realpath(resolvedRoot);
    const existingParent = await findExistingParent(path.dirname(resolvedTarget));
    const canonicalParent = await realpath(existingParent);
    const canonicalRelative = path.relative(canonicalRoot, canonicalParent);
    if (path.isAbsolute(canonicalRelative) || canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`)) {
      throw new StoryStackError("Checkpoint parent resolves outside the configured state root", "PATH_TRAVERSAL");
    }
  }
  const targetStats = await lstatOrNull(resolvedTarget);
  if (targetStats !== null && (targetStats.isSymbolicLink() || !targetStats.isFile())) {
    throw new StoryStackError(`Refusing to replace a non-regular state file: ${resolvedTarget}`, "UNSAFE_STATE_FILE");
  }
}

/**
 * Refuse state roots that resolve to the repository itself or anywhere below
 * it. Otherwise, writing a checkpoint changes the worktree it is describing
 * and can make every snapshot stale immediately.
 */
export async function assertStateRootOutsideRepository(stateRoot: string, repositoryRoot: string): Promise<void> {
  const canonicalRepository = await canonicalizeProspectivePath(repositoryRoot);
  const canonicalStateRoot = await canonicalizeProspectivePath(stateRoot);
  const relative = path.relative(canonicalRepository, canonicalStateRoot);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new StoryStackError(
      "Checkpoint state root must be outside the active repository",
      "STATE_ROOT_INSIDE_REPOSITORY",
      4,
    );
  }
}

async function canonicalizeProspectivePath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const existing = await findExistingParent(resolved);
  const canonicalExisting = await realpath(existing);
  const remainder = path.relative(existing, resolved);
  return path.resolve(canonicalExisting, remainder);
}

async function findExistingParent(start: string): Promise<string> {
  let cursor = start;
  for (;;) {
    const stats = await lstatOrNull(cursor);
    if (stats !== null) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}
