import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteHooks {
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void> | void;
  rename?: (temporaryPath: string, targetPath: string) => Promise<void>;
}

export async function writeFileAtomic(
  targetPath: string,
  contents: string | Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.(temporaryPath, targetPath);
    await (hooks.rename ?? rename)(temporaryPath, targetPath);
    let directoryHandle;
    try {
      directoryHandle = await open(directory, "r");
      await directoryHandle.sync();
    } catch {
      // Directory fsync is not supported consistently on Windows. The file itself
      // was already flushed before the atomic rename.
    } finally {
      if (directoryHandle !== undefined) await directoryHandle.close().catch(() => undefined);
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
