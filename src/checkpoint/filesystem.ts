import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { StoryStackError } from "../errors.js";

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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
