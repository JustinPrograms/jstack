import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCommand, hookCommandFromPayload } from "../src/safety.js";

const COMPILED_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

async function runHook(payload: unknown): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPILED_CLI, "safety", "hook", "--permanent-only"], {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (stderr.length > 0 && code === 0) reject(new Error(stderr));
      else resolve(code);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("permanent remote-mutation restrictions are refused", () => {
  for (const command of [
    "git push origin feature",
    "git -C local-repo push origin feature",
    "git remote set-url origin https://example.invalid/repo.git",
    "gh pr create --title demo",
    "gh pr merge 42",
    "glab mr approve 42",
    "jira comment DEMO-42 done",
    "curl -X POST https://example.invalid/api",
    "gh api repos/example/demo --method DELETE",
  ]) {
    assert.equal(classifyCommand(command).disposition, "deny", command);
  }
});

test("staging and committing require an explicit current request", () => {
  assert.equal(classifyCommand(["git", "add", "src/example.ts"]).disposition, "require-explicit-request");
  assert.equal(classifyCommand("git commit -m local").disposition, "require-explicit-request");
});

test("read-only Git and remote retrieval remain available", () => {
  for (const command of [
    "git status --short",
    "git diff --stat",
    "git log -5",
    "git fetch --dry-run origin",
    "git ls-remote origin",
    "gh pr view 42",
    "glab mr list",
  ]) {
    assert.equal(classifyCommand(command).disposition, "allow", command);
  }
});

test("Claude and Bob hook payloads expose shell commands without platform coupling", () => {
  assert.equal(
    hookCommandFromPayload(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin demo" } })),
    "git push origin demo",
  );
  assert.equal(
    hookCommandFromPayload(JSON.stringify({ event: "PreToolUse", tool: "shell", input: { command: "git status" } })),
    "git status",
  );
  assert.equal(hookCommandFromPayload("not json"), null);
  assert.equal(hookCommandFromPayload(JSON.stringify({ input: { path: "src/example.ts" } })), null);
});

test("hook mode uses the blocking exit code required by Claude and Bob", async () => {
  assert.equal(
    await runHook({ tool_name: "Bash", tool_input: { command: "git push origin demo" } }),
    2,
  );
  assert.equal(
    await runHook({ event: "PreToolUse", tool: "shell", input: { command: "git status --short" } }),
    0,
  );
});
