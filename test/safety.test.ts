import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCommand, hookCommandFromPayload } from "../src/safety.js";

const COMPILED_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

async function runHook(payload: unknown, options: { raw?: boolean } = {}): Promise<number | null> {
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
    child.stdin.end(options.raw ? String(payload) : JSON.stringify(payload));
  });
}

test("permanent remote-mutation restrictions are refused", () => {
  for (const command of [
    "git push origin feature",
    "git status\ngit push origin feature",
    "echo ok\r\ngh pr merge 42",
    "git 'push' origin feature",
    "'git' \"push\" origin feature",
    "git.exe push origin feature",
    "git -C local-repo push origin feature",
    "sudo git push origin feature",
    "! git push origin feature",
    "exec git push origin feature",
    "time git push origin feature",
    "{ git push origin feature; }",
    "echo `git push origin feature`",
    "echo $(git push origin feature)",
    "echo \"$(git push origin feature)\"",
    "echo \"`git push origin feature`\"",
    "cat < \"$(git push origin feature)\"",
    "echo \"<(git push origin feature)\"",
    "env EXAMPLE=1 git push origin feature",
    "/usr/bin/env EXAMPLE=1 git push origin feature",
    "cmd /c git.exe push origin feature",
    "cmd.exe /c git push origin feature",
    "cmd /d /s /c git push origin feature",
    "bash.exe -lc \"git push origin feature\"",
    "bash --noprofile -c \"git push origin feature\"",
    "bash --rcfile /dev/null -c \"git push origin feature\"",
    "bash -O extglob -c \"git push origin feature\"",
    "bash --noprofile 2>/dev/null -c \"git push origin feature\"",
    "env -u SAMPLE git push origin feature",
    "env --argv0 git git push origin feature",
    "env -S \"git push origin feature\"",
    "sudo -u root git push origin feature",
    "sudo -p prompt git push origin feature",
    "sudo -D /tmp git push origin feature",
    "sudo --host host git push origin feature",
    "sudo -R /tmp git push origin feature",
    "sudo -T 1 git push origin feature",
    "sudo SAMPLE=value git push origin feature",
    "doas -a style git push origin feature",
    "command -p git push origin feature",
    "command git push -v origin feature",
    "command -p git push -v origin feature",
    "exec -a harmless git push origin feature",
    "time -f format git push origin feature",
    "2>/dev/null git push origin feature",
    "2>&1 git push origin feature",
    "3>&1 git push origin feature",
    ">|/dev/null git push origin feature",
    ">| /dev/null git push origin feature",
    "<<< input git push origin feature",
    "git < <(echo input) push origin feature",
    "cat <(git push origin feature)",
    "git status < <(git push origin feature)",
    "git &>/dev/null push origin feature",
    "git &>>/dev/null push origin feature",
    "git *> $null push origin feature",
    "git {output}>/dev/null push origin feature",
    "git 2>/dev/null push origin feature",
    "2>/dev/null sudo git push origin feature",
    "sudo -u 2>/dev/null root git push origin feature",
    "cmd /d 2>nul /c git push origin feature",
    "gh 2>/dev/null pr create --title demo",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"git push origin feature\"",
    "powershell -NoProfile -Co \"git push origin feature\"",
    `powershell -EncodedCommand ${Buffer.from("git push origin feature", "utf16le").toString("base64")}`,
    "cmd /cgit push origin feature",
    "cmd /c ^git push origin feature",
    "cmd /c @git push origin feature",
    "cmd /c call git push origin feature",
    "cmd /c \"echo ok & @git push origin feature\"",
    "cmd /c g^it push origin feature",
    "cmd /c git pu^sh origin feature",
    "cmd /c @g^it push origin feature",
    "cmd /c call gi^t push origin feature",
    "git --% push origin feature",
    "g`it push origin feature",
    "git pu`sh origin feature",
    `${"env ".repeat(33)}git push origin feature`,
    "git -C. push origin feature",
    "git -cfoo.bar=baz push origin feature",
    "git --no-pager push origin feature",
    "git -p push origin feature",
    "git --bare push origin feature",
    "git --no-replace-objects push origin feature",
    "git --exec-path=/tmp push origin feature",
    "/usr/bin/git push origin feature",
    "\"C:\\Program Files\\Git\\cmd\\git.exe\" push origin feature",
    "git -c alias.ship=push ship origin feature",
    "git -calias.ship=push ship origin feature",
    "git --config-env=alias.ship=JSTACK_ALIAS ship origin feature",
    "git send-pack origin HEAD:refs/heads/feature",
    "git remote set-url origin https://example.invalid/repo.git",
    "git config --global user.email sample@example.invalid",
    "git config --unset remote.origin.pushurl",
    "git config set user.email sample@example.invalid",
    "git config unset remote.origin.pushurl",
    "gh pr create --title demo",
    "gh -R example/demo pr create --title demo",
    "gh pr -R example/demo create --title demo",
    "gh pr -Rexample/demo create --title demo",
    "gh pr merge 42",
    "gh pr 'merge' 42",
    "gh issue transfer 42 example/other",
    "glab mr approve 42",
    "glab --repo example/demo mr approve 42",
    "glab mr update 42 --title changed",
    "glab mr note 42 --message done",
    "jira comment DEMO-42 done",
    "jira issue transition DEMO-42 Done",
    "curl -X POST https://example.invalid/api",
    "curl --config upload.conf",
    "curl -X 'POST' https://example.invalid/api",
    "curl --data value https://example.invalid/api",
    "curl -F file=@sample.txt https://example.invalid/api",
    "curl -T sample.txt https://example.invalid/api",
    "curl -dfoo=bar https://example.invalid/api",
    "curl -Ffile=@sample.txt https://example.invalid/api",
    "curl -Tsample.txt https://example.invalid/api",
    "curl -XMKCOL https://example.invalid/collection",
    "Invoke-RestMethod -Method Post https://example.invalid/api",
    "irm -Me Post https://example.invalid/api",
    "Invoke-WebRequest -Method 'Patch' https://example.invalid/api",
    "iwr -Method DELETE https://example.invalid/api",
    "Invoke-RestMethod -Body '{\"sample\":true}' https://example.invalid/api",
    "gh api repos/example/demo --method DELETE",
    "gh api repos/example/demo --method 'DELETE'",
    "gh api repos/example/demo/issues -f title=demo",
    "glab api projects/1/issues/2 --method PUT -f title=demo",
    "glab api projects/1/issues/2 --method \"PUT\" -f title=demo",
    "gh release create v1.0.0",
    "gh gist create sample.txt",
    "gh cache delete 123",
    "gh codespace create --repo example/demo",
    "gh project create --owner example --title demo",
    "gh repo edit example/demo --enable-issues=false",
    "gh workflow run release.yml",
    "glab variable set EXAMPLE value",
    "glab snippet create --title demo",
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
    "git remote update",
    "git --no-pager remote update",
    "git 2>/dev/null status --short",
    "git &>/dev/null status --short",
    "git < <(echo input) status --short",
    "cat <(git status --short)",
    "git status < <(git status --short)",
    "git *> $null status --short",
    ">|/dev/null git status --short",
    "<<< input git status --short",
    "git config --global --get user.email",
    "git config --list --show-origin",
    "git config get user.email",
    "git config list",
    "gh pr view 42",
    "gh -R example/demo pr view 42",
    "gh pr -R example/demo view 42",
    "gh 2>/dev/null pr view 42",
    "gh api repos/example/demo --method GET -f per_page=10",
    "glab mr list",
    "gh gist list",
    "gh cache list",
    "gh codespace list",
    "gh project list",
    "glab snippet list",
    "curl -f https://example.invalid/api",
    "curl -G --data query=value https://example.invalid/api",
    "bash --rcfile /dev/null -c \"git status --short\"",
    "env --argv0 git git status --short",
    "command -v git",
    "command git status -v",
    "command -p git status -v",
    "sudo SAMPLE=value git status --short",
    "cmd /cgit status --short",
    "cmd /c \"echo ok & @git status --short\"",
    "cmd /c g^it status --short",
    "git --% status --short",
    "g`it status --short",
    "exec -a harmless git status --short",
    "time -f format git status --short",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"git status --short\"",
  ]) {
    assert.equal(classifyCommand(command).disposition, "allow", command);
  }
});

test("forbidden examples in harmless command arguments are not treated as executable actions", () => {
  for (const command of [
    'rg -n "git push origin" .',
    'Select-String -Pattern "git push origin" README.md',
    'echo "git push origin main"',
    'echo "git status\ngit push origin main"',
    'node -e "console.log(\'git push origin main\')"',
    "echo '$(git push origin main)'",
    "echo '`git push origin main`'",
    "echo 'g`it push origin main'",
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
  assert.equal(
    hookCommandFromPayload(JSON.stringify({ tool_name: "execute_command", tool_input: { command: "git status" } })),
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
    await runHook({ tool_name: "Bash", tool_input: { command: "git status\ngit push origin demo" } }),
    2,
  );
  for (const command of [
    "cmd /d /s /c git push origin feature",
    'bash --noprofile -c "git push origin feature"',
    'bash --rcfile /dev/null -c "git push origin feature"',
    'bash -O extglob -c "git push origin feature"',
    'bash --noprofile 2>/dev/null -c "git push origin feature"',
    "env -u SAMPLE git push origin feature",
    "env --argv0 git git push origin feature",
    'env -S "git push origin feature"',
    "sudo -u root git push origin feature",
    "sudo -p prompt git push origin feature",
    "sudo -D /tmp git push origin feature",
    "sudo SAMPLE=value git push origin feature",
    "command -p git push origin feature",
    "exec -a harmless git push origin feature",
    "2>/dev/null git push origin feature",
    "2>&1 git push origin feature",
    "3>&1 git push origin feature",
    ">|/dev/null git push origin feature",
    "<<< input git push origin feature",
    "git < <(echo input) push origin feature",
    "cat <(git push origin feature)",
    "git status < <(git push origin feature)",
    "git &>/dev/null push origin feature",
    "git *> $null push origin feature",
    "git 2>/dev/null push origin feature",
    "2>/dev/null sudo git push origin feature",
    "cmd /d 2>nul /c git push origin feature",
    "gh 2>/dev/null pr create --title demo",
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "git push origin feature"',
    'powershell -NoProfile -Co "git push origin feature"',
    `powershell -EncodedCommand ${Buffer.from("git push origin feature", "utf16le").toString("base64")}`,
    "cmd /cgit push origin feature",
    "cmd /c ^git push origin feature",
    "cmd /c @git push origin feature",
    "cmd /c call git push origin feature",
    'cmd /c "echo ok & @git push origin feature"',
    'echo "$(git push origin feature)"',
    'echo "`git push origin feature`"',
    "cmd /c g^it push origin feature",
    "cmd /c git pu^sh origin feature",
    "git --% push origin feature",
    "g`it push origin feature",
    "git -C. push origin feature",
    "git -cfoo.bar=baz push origin feature",
  ]) {
    assert.equal(await runHook({ tool_name: "Bash", tool_input: { command } }), 2, command);
  }
  assert.equal(
    await runHook({ event: "PreToolUse", tool: "shell", input: { command: "git status --short" } }),
    0,
  );
  assert.equal(await runHook({ tool_name: "Bash", tool_input: {} }), 2);
  assert.equal(await runHook({ tool_name: "execute_command", tool_input: { command: "" } }), 2);
  assert.equal(await runHook("not json", { raw: true }), 2);
  assert.equal(await runHook("x".repeat(1024 * 1024 + 1), { raw: true }), 2);
});
