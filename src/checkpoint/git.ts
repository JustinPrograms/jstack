import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StoryStackError } from "../errors.js";
import type { GitSnapshot } from "./types.js";
import { assertSafeBranchName } from "./branch.js";

const execFileAsync = promisify(execFile);
const ALLOWED_GIT_SUBCOMMANDS = new Set(["rev-parse", "symbolic-ref", "status", "diff", "show-ref"]);
const MAX_STORED_CHANGED_FILES = 200;

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function assertAllowedGitArgs(args: readonly string[]): void {
  const subcommand = args[0];
  if (subcommand === undefined || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new StoryStackError(`Git subcommand '${subcommand ?? ""}' is not allowed`, "UNSAFE_GIT_COMMAND");
  }
}

async function runGit(repoPath: string, args: readonly string[], allowFailure = false): Promise<GitResult> {
  assertAllowedGitArgs(args);
  try {
    const result = await execFileAsync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      env: gitEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const exitCode = typeof candidate.code === "number" ? candidate.code : 1;
    if (allowFailure) {
      return { stdout: candidate.stdout ?? "", stderr: candidate.stderr ?? "", exitCode };
    }
    if (candidate.code === "ENOENT") {
      throw new StoryStackError("Git is required but was not found on PATH", "GIT_NOT_FOUND");
    }
    throw new StoryStackError(
      `Local Git inspection failed: ${(candidate.stderr ?? candidate.message ?? "unknown error").trim()}`,
      "GIT_FAILED",
    );
  }
}

async function hashGitOutput(repoPath: string, args: readonly string[], hash: ReturnType<typeof createHash>): Promise<void> {
  assertAllowedGitArgs(args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", repoPath, ...args], {
      env: gitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) stderr.push(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new StoryStackError("Git is required but was not found on PATH", "GIT_NOT_FOUND")
          : new StoryStackError(`Unable to start local Git inspection: ${error.message}`, "GIT_FAILED"),
      );
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new StoryStackError(`Local Git diff failed: ${Buffer.concat(stderr).toString("utf8").trim()}`, "GIT_FAILED"));
    });
  });
}

interface ParsedStatus {
  changedFiles: string[];
  untrackedFiles: string[];
}

function parsePorcelainV1Z(output: string): ParsedStatus {
  const records = output.split("\0");
  const changedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new StoryStackError("Git returned an unsupported status record", "GIT_STATUS_PARSE_FAILED");
    }
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (status === "??") {
      untrackedFiles.push(filePath);
      continue;
    }
    if (status.includes("R") || status.includes("C")) {
      const originalPath = records[index + 1];
      if (!originalPath) throw new StoryStackError("Git returned an incomplete rename record", "GIT_STATUS_PARSE_FAILED");
      index += 1;
      changedFiles.push(`${status} ${originalPath} -> ${filePath}`);
    } else {
      changedFiles.push(`${status} ${filePath}`);
    }
  }
  changedFiles.sort((a, b) => a.localeCompare(b, "en"));
  untrackedFiles.sort((a, b) => a.localeCompare(b, "en"));
  return { changedFiles, untrackedFiles };
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function escapeMetadataText(value: string): string {
  return value.replace(/[\0-\x1f\x7f]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function hashFileOrLink(filePath: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink()) {
    hash.update("symlink\0");
    hash.update(await readlink(filePath));
    return;
  }
  if (!stats.isFile()) {
    hash.update(`non-file:${stats.mode}\0`);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
}

export async function findRepositoryRoot(repoPath: string): Promise<string> {
  const candidate = path.resolve(repoPath);
  const result = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
  const reported = result.stdout.trim();
  if (reported.length === 0) throw new StoryStackError(`${candidate} is not inside a Git repository`, "NOT_A_REPOSITORY");
  return realpath(reported);
}

export async function captureGitSnapshot(repoPath: string): Promise<GitSnapshot> {
  const repositoryRoot = await findRepositoryRoot(repoPath);
  return captureStableSnapshot(repositoryRoot, 0);
}

async function captureStableSnapshot(repositoryRoot: string, attempt: number): Promise<GitSnapshot> {
  const branchResult = await runGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  const reportedBranch = branchResult.stdout.trim();
  const currentBranch = branchResult.exitCode === 0 && reportedBranch.length > 0 ? reportedBranch : "(detached)";
  const headResult = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"], true);
  const headCommit = headResult.exitCode === 0 ? headResult.stdout.trim().toLowerCase() : null;
  const statusResult = await runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const status = parsePorcelainV1Z(statusResult.stdout);

  const hash = createHash("sha256");
  hash.update("story-stack-worktree-v1\0");
  hash.update(currentBranch);
  hash.update("\0");
  hash.update(headCommit ?? "unborn");
  hash.update("\0");
  hash.update(statusResult.stdout);
  hash.update("\0index-diff\0");
  await hashGitOutput(repositoryRoot, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--cached", "--"], hash);
  hash.update("\0worktree-diff\0");
  await hashGitOutput(repositoryRoot, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--"], hash);
  hash.update("\0untracked-content\0");
  for (const relativePath of status.untrackedFiles) {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    if (!isContained(repositoryRoot, absolutePath)) {
      throw new StoryStackError("Git reported an untracked path outside the repository", "GIT_PATH_ESCAPE");
    }
    hash.update(relativePath);
    hash.update("\0");
    try {
      await hashFileOrLink(absolutePath, hash);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") hash.update("vanished");
      else throw error;
    }
    hash.update("\0");
  }
  const fingerprint = hash.digest("hex");
  const endingBranch = await runGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  const endingHead = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"], true);
  const endingStatus = await runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const reportedEndingBranch = endingBranch.stdout.trim();
  const endingBranchName =
    endingBranch.exitCode === 0 && reportedEndingBranch.length > 0 ? reportedEndingBranch : "(detached)";
  const endingHeadCommit = endingHead.exitCode === 0 ? endingHead.stdout.trim().toLowerCase() : null;
  if (
    endingBranchName !== currentBranch ||
    endingHeadCommit !== headCommit ||
    endingStatus.stdout !== statusResult.stdout
  ) {
    if (attempt < 1) return captureStableSnapshot(repositoryRoot, attempt + 1);
    throw new StoryStackError("Repository changed while its snapshot was being captured; retry", "GIT_STATE_CHANGED", 2);
  }

  return {
    repositoryRoot,
    currentBranch: currentBranch || "(unknown)",
    headCommit,
    dirty: status.changedFiles.length > 0 || status.untrackedFiles.length > 0,
    changedFiles: status.changedFiles.slice(0, MAX_STORED_CHANGED_FILES).map(escapeMetadataText),
    changedFileCount: status.changedFiles.length,
    // Names are intentionally omitted from persisted snapshot metadata by
    // default; the count and content-sensitive fingerprint are sufficient for
    // reconciliation without retaining potentially sensitive names.
    untrackedFiles: [],
    untrackedFileCount: status.untrackedFiles.length,
    worktreeFingerprint: fingerprint,
  };
}

export async function detectBaseBranch(repositoryRoot: string, currentBranch: string): Promise<string> {
  if (currentBranch === "main" || currentBranch === "master") return currentBranch;
  for (const candidate of ["main", "master"]) {
    const result = await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], true);
    if (result.exitCode === 0) return candidate;
  }
  throw new StoryStackError(
    `Cannot infer a base branch for '${currentBranch}'; provide --base-branch explicitly`,
    "BASE_BRANCH_REQUIRED",
  );
}

export async function validateBaseBranch(
  repositoryRoot: string,
  baseBranch: string,
  snapshot: Pick<GitSnapshot, "currentBranch" | "headCommit">,
): Promise<void> {
  assertSafeBranchName(baseBranch);
  if (baseBranch === snapshot.currentBranch) return;
  const result = await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${baseBranch}`], true);
  if (result.exitCode !== 0) {
    throw new StoryStackError(
      `Base branch '${baseBranch}' is not a local branch; create it locally or choose an existing base`,
      "INVALID_BASE_BRANCH",
    );
  }
}

export const gitSubcommandAllowlist = Object.freeze([...ALLOWED_GIT_SUBCOMMANDS]);
