import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skills = ["jstack-plan", "jstack-plan-critic", "jstack-implement", "jstack-review"];
const hostRoots = [".claude/skills", ".agents/skills", ".bob/skills"];

async function workspace(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, "jstack-packages-"));
  t.after(async () => {
    // Remove only this test's exact temporary directory, never a supplied path.
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith("jstack-packages-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function filesIn(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `package must not depend on a symlink: ${relative}`);
    if (entry.isDirectory()) {
      files.push(...await filesIn(path.join(directory, entry.name), relative));
    } else {
      assert.ok(entry.isFile(), `unsupported package entry: ${relative}`);
      files.push(relative);
    }
  }
  return files.sort();
}

async function checkResources(directory) {
  const packageRoot = await realpath(directory);
  let links = 0;
  for (const file of await filesIn(directory)) {
    if (!file.endsWith(".md")) continue;
    const source = await readFile(path.join(directory, file), "utf8");
    for (const [, target] of source.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/gu)) {
      if (/^(?:https?:|#)/iu.test(target)) continue;
      const relativeTarget = decodeURIComponent(target.split("#")[0]);
      assert.ok(!path.isAbsolute(relativeTarget), `absolute resource link: ${target}`);
      const resolved = await realpath(path.resolve(directory, path.dirname(file), relativeTarget));
      const relative = path.relative(packageRoot, resolved);
      assert.ok(
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `resource escapes installed skill: ${target}`,
      );
      links += 1;
    }
  }
  return links;
}

async function checkInstalled(destination) {
  for (const skill of skills) {
    const source = path.join(root, "skills", skill);
    const installed = path.join(destination, skill);
    for (const file of await filesIn(source)) {
      assert.deepEqual(
        await readFile(path.join(installed, file)),
        await readFile(path.join(source, file)),
        `installed content differs: ${skill}/${file}`,
      );
    }
    const links = await checkResources(installed);
    if (skill === "jstack-implement") {
      assert.ok(links > 0, "implementation must link to its bundled checkpoint schema");
    }
  }
}

test("each manually copied skill resolves its own bundled resources", async (t) => {
  const directory = await workspace(t);
  for (const skill of skills) {
    await cp(path.join(root, "skills", skill), path.join(directory, skill), { recursive: true });
  }
  await checkInstalled(directory);
});

test("package validation rejects missing and out-of-package resources", async (t) => {
  const directory = await workspace(t);
  const skill = path.join(directory, "fixture-skill");
  await mkdir(skill);
  await writeFile(path.join(skill, "SKILL.md"), "[schema](missing.md)\n");
  await assert.rejects(checkResources(skill), { code: "ENOENT" });
  await writeFile(path.join(directory, "outside.md"), "not an installed resource\n");
  await writeFile(path.join(skill, "SKILL.md"), "[schema](../outside.md)\n");
  await assert.rejects(checkResources(skill), /resource escapes installed skill/u);
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 15000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function shellCommand() {
  const candidates = ["sh"];
  if (process.platform === "win32" && process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "sh.exe"));
  }
  return candidates.find((command) => {
    const result = spawnSync(command, ["-c", "exit 0"], { timeout: 5000, windowsHide: true });
    return !result.error && result.status === 0;
  });
}

function powerShellCommand() {
  return ["pwsh", "powershell"].find((command) => {
    const result = spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      timeout: 5000,
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  });
}

async function checkCopier(t, command, args) {
  const directory = await workspace(t);
  const project = path.join(directory, "project with spaces café");
  await mkdir(project);
  await writeFile(path.join(project, "README.md"), "unrelated project file\n");
  for (const hostRoot of hostRoots) {
    const userSkill = path.join(project, hostRoot, "user-skill");
    await mkdir(userSkill, { recursive: true });
    await writeFile(path.join(userSkill, "SKILL.md"), "unrelated user skill\n");
  }

  const first = run(command, args, project);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  for (const hostRoot of hostRoots) {
    await checkInstalled(path.join(project, hostRoot));
    // Simulate an older installed version while preserving a user-owned extra file.
    await writeFile(path.join(project, hostRoot, "jstack-plan", "SKILL.md"), "older version\n");
    await writeFile(path.join(project, hostRoot, "jstack-plan", "user-notes.md"), "keep my notes\n");
  }

  const second = run(command, args, project);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.deepEqual((await readdir(project)).sort(), [".agents", ".bob", ".claude", "README.md"].sort());
  assert.equal(await readFile(path.join(project, "README.md"), "utf8"), "unrelated project file\n");
  for (const hostRoot of hostRoots) {
    const destination = path.join(project, hostRoot);
    await checkInstalled(destination);
    assert.deepEqual((await readdir(destination)).sort(), [...skills, "user-skill"].sort());
    assert.equal(await readFile(path.join(destination, "user-skill", "SKILL.md"), "utf8"), "unrelated user skill\n");
    assert.equal(await readFile(path.join(destination, "jstack-plan", "user-notes.md"), "utf8"), "keep my notes\n");
  }
}

test("POSIX setup installs and updates all local host packages without changing unrelated files", async (t) => {
  const command = shellCommand();
  if (!command) return t.skip("POSIX shell unavailable");
  await checkCopier(t, command, [path.join(root, "setup").replaceAll("\\", "/"), "--host", "all", "--scope", "local"]);
});

test("POSIX setup rejects invalid hosts before creating destinations", async (t) => {
  const command = shellCommand();
  if (!command) return t.skip("POSIX shell unavailable");
  const directory = await workspace(t);
  const result = run(command, [path.join(root, "setup").replaceAll("\\", "/"), "--host", "invalid", "--scope", "local"], directory);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("PowerShell setup installs and updates all local host packages without changing unrelated files", async (t) => {
  const command = powerShellCommand();
  if (!command) return t.skip("PowerShell unavailable");
  const policy = run(command, ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"], root);
  assert.equal(policy.status, 0, policy.stderr);
  if (["Restricted", "AllSigned"].includes(policy.stdout.trim())) {
    return t.skip(`PowerShell execution policy ${policy.stdout.trim()} prevents running the unsigned setup script`);
  }
  await checkCopier(t, command, ["-NoProfile", "-NonInteractive", "-File", path.join(root, "setup.ps1"), "-Host", "all", "-Scope", "local"]);
});
