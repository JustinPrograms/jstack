import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";

const execFileAsync = promisify(execFile);

export async function temporaryDirectory(t: TestContext, prefix = "story-stack-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) {
      throw new Error(`Refusing to remove unexpected test path: ${resolved}`);
    }
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

export async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    windowsHide: true,
  });
  return result.stdout.trim();
}

export async function createGitRepository(
  t: TestContext,
  options: { committed?: boolean; initialFile?: string } = {},
): Promise<{ root: string; file: string }> {
  const parent = await temporaryDirectory(t, "story-stack-git-");
  const root = path.join(parent, "sample-repository");
  await mkdir(root);
  await git(root, "init", "--initial-branch=main");
  const file = path.join(root, options.initialFile ?? "sample.txt");
  if (options.committed !== false) {
    await writeFile(file, "initial fixture content\n", "utf8");
    await git(root, "add", path.basename(file));
    await git(
      root,
      "-c",
      "user.name=Fixture Developer",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture baseline",
    );
  }
  return { root, file };
}
