import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skills = ["jstack-plan", "jstack-plan-critic", "jstack-implement", "jstack-review", "jstack-test"];
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

async function skillHash(directory) {
  const records = [];
  async function walk(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (relative === ".jstack-managed") continue;
      assert.ok(!entry.isSymbolicLink(), `linked skill content: ${relative}`);
      if (entry.isDirectory()) {
        records.push([relative, `d:${relative}`]);
        await walk(path.join(folder, entry.name), relative);
      } else {
        assert.ok(entry.isFile(), `unsupported skill content: ${relative}`);
        const hash = createHash("sha256").update(await readFile(path.join(folder, entry.name))).digest("hex");
        records.push([relative, `f:${relative}:${hash}`]);
      }
    }
  }
  await walk(directory);
  records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(records.map(([, record]) => record).join("\n") + (records.length ? "\n" : "")).digest("hex");
}

async function checkInstalled(destination, { managed = false } = {}) {
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
    if (managed) {
      const metadata = Object.fromEntries(
        (await readFile(path.join(installed, ".jstack-managed"), "utf8")).trim().split("\n").map((line) => line.split("=", 2)),
      );
      const host = { ".claude": "claude", ".agents": "codex", ".bob": "bob" }[path.basename(path.dirname(destination))];
      assert.equal(metadata.version, JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version);
      assert.equal(metadata.commit, run("git", ["-C", root, "rev-parse", "HEAD"], root).stdout.trim());
      assert.equal(metadata.host, host);
      assert.equal(metadata.scope, "local");
      assert.equal(metadata.hash, await skillHash(source));
      assert.equal(metadata.hash, await skillHash(installed));
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
    await checkInstalled(path.join(project, hostRoot), { managed: true });
    // Simulate an older managed version with a retired package file.
    await writeFile(path.join(project, hostRoot, "jstack-plan", "SKILL.md"), "older version\n");
    await writeFile(path.join(project, hostRoot, "jstack-plan", "retired-file.md"), "remove me\n");
  }

  const second = run(command, args, project);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.deepEqual((await readdir(project)).sort(), [".agents", ".bob", ".claude", "README.md"].sort());
  assert.equal(await readFile(path.join(project, "README.md"), "utf8"), "unrelated project file\n");
  for (const hostRoot of hostRoots) {
    const destination = path.join(project, hostRoot);
    await checkInstalled(destination, { managed: true });
    assert.deepEqual((await readdir(destination)).sort(), [...skills, "user-skill"].sort());
    assert.equal(await readFile(path.join(destination, "user-skill", "SKILL.md"), "utf8"), "unrelated user skill\n");
    await assert.rejects(readFile(path.join(destination, "jstack-plan", "retired-file.md")), { code: "ENOENT" });
  }
}

async function checkCollisionSafety(t, command, args, forceFlag, dryRunFlag) {
  const directory = await workspace(t);
  const project = path.join(directory, "project");
  const destination = path.join(project, ".agents", "skills");
  const target = path.join(destination, "jstack-plan");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "custom skill\n");

  const refused = run(command, args, project);
  assert.notEqual(refused.status, 0);
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "custom skill\n");

  const preview = run(command, [...args, forceFlag, dryRunFlag], project);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "custom skill\n");

  const migrated = run(command, [...args, forceFlag], project);
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  await checkInstalled(destination, { managed: true });
  assert.equal(
    await readFile(path.join(destination, "jstack-plan.pre-jstack-backup", "SKILL.md"), "utf8"),
    "custom skill\n",
  );
}

async function checkVerification(t, command, installArgs, verifyArgs) {
  const directory = await workspace(t);
  const baseline = path.join(directory, "baseline");
  await mkdir(baseline);
  const installed = run(command, installArgs, baseline);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const baselineRoot = path.join(baseline, ".agents", "skills");
  const marker = path.join(baselineRoot, "jstack-plan", ".jstack-managed");
  const before = await readFile(marker);
  const clean = run(command, verifyArgs, baseline);
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  assert.match(clean.stdout, /jstack-plan: present/u);
  assert.deepEqual(await readFile(marker), before, "verification must not rewrite metadata");

  const scenarios = [
    ["missing", async (root) => rm(path.join(root, "jstack-plan"), { recursive: true }), /jstack-plan: missing/u],
    ["modified", async (root) => writeFile(path.join(root, "jstack-plan", "SKILL.md"), "changed\n"), /jstack-plan: modified \(hash mismatch\)/u],
    ["unmanaged", async (root) => rm(path.join(root, "jstack-plan", ".jstack-managed")), /jstack-plan: unmanaged/u],
    ["backup", async (root) => mkdir(path.join(root, "jstack-plan.pre-jstack-backup")), /unexpected skill:.*jstack-plan\.pre-jstack-backup/u],
    ["unknown", async (root) => mkdir(path.join(root, "jstack-old")), /unexpected skill:.*jstack-old/u],
    ["outdated", async (root) => {
      const target = path.join(root, "jstack-plan", ".jstack-managed");
      await writeFile(target, (await readFile(target, "utf8")).replace(/^version=.*$/mu, "version=0.0.0"));
    }, /jstack-plan: outdated/u],
  ];
  for (const [name, change, expected] of scenarios) {
    const project = path.join(directory, name);
    await mkdir(project);
    const targetRoot = path.join(project, ".agents", "skills");
    await cp(baselineRoot, targetRoot, { recursive: true });
    await change(targetRoot);
    const result = run(command, verifyArgs, project);
    assert.equal(result.status, 1, `${name}: ${result.stderr || result.stdout}`);
    assert.match(result.stdout, expected, name);
  }
}

async function checkUpdateNotification(t, command, installArgs, verifyArgs) {
  const directory = await workspace(t);
  const project = path.join(directory, "project");
  const sourceClone = path.join(directory, "source");
  const releaseRepo = path.join(directory, "releases");
  await mkdir(project);
  assert.equal(run("git", ["clone", "-q", "--no-hardlinks", root, sourceClone], directory).status, 0);
  assert.equal(run("git", ["clone", "-q", "--bare", root, releaseRepo], directory).status, 0);
  const head = run("git", ["-C", root, "rev-parse", "HEAD"], directory).stdout.trim();
  assert.equal(run("git", ["--git-dir", releaseRepo, "update-ref", "refs/tags/v9.0.0", head], directory).status, 0);
  for (const script of ["setup", "setup.ps1"]) {
    await cp(path.join(root, script), path.join(sourceClone, script));
  }
  assert.equal(run("git", ["-C", sourceClone, "remote", "set-url", "origin", releaseRepo], directory).status, 0);
  const clonedArgs = (args) => args.map((arg) => {
    if (arg.endsWith("/setup")) return path.join(sourceClone, "setup").replaceAll("\\", "/");
    if (arg.endsWith("/setup.ps1") || arg.endsWith("\\setup.ps1")) return path.join(sourceClone, "setup.ps1");
    return arg;
  });
  assert.equal(run(command, clonedArgs(installArgs), project).status, 0);
  const marker = path.join(project, ".agents", "skills", "jstack-plan", ".jstack-managed");
  const before = await readFile(marker);
  const update = run(command, clonedArgs(verifyArgs), project);
  assert.equal(update.status, 1, update.stderr || update.stdout);
  assert.match(update.stdout, /Update available: v9\.0\.0/u);
  assert.match(update.stdout, /fetch --tags origin/u);
  assert.match(update.stdout, /switch --detach "?v9\.0\.0/u);
  assert.deepEqual(await readFile(marker), before);

  assert.equal(run("git", ["-C", sourceClone, "remote", "set-url", "origin", path.join(directory, "absent")], directory).status, 0);
  const offline = run(command, clonedArgs(verifyArgs), project);
  assert.equal(offline.status, 2, offline.stderr || offline.stdout);
  assert.match(offline.stdout + offline.stderr, /Update check unavailable/u);
  assert.deepEqual(await readFile(marker), before);
}

test("POSIX setup installs and updates all local host packages without changing unrelated files", async (t) => {
  const command = shellCommand();
  if (!command) return t.skip("POSIX shell unavailable");
  await checkCopier(t, command, [path.join(root, "setup").replaceAll("\\", "/"), "--host", "all", "--scope", "local"]);
});

test("POSIX verification reports installation drift without repairing it", async (t) => {
  const command = shellCommand();
  if (!command) return t.skip("POSIX shell unavailable");
  const script = path.join(root, "setup").replaceAll("\\", "/");
  await checkVerification(t, command, [script, "--host", "codex", "--scope", "local"], [script, "--host", "codex", "--scope", "local", "--verify"]);
});

test("POSIX update check notifies for a newer tag and handles offline remotes", async (t) => {
  const command = shellCommand();
  if (!command) return t.skip("POSIX shell unavailable");
  const script = path.join(root, "setup").replaceAll("\\", "/");
  await checkUpdateNotification(
    t,
    command,
    [script, "--host", "codex", "--scope", "local"],
    [script, "--host", "codex", "--scope", "local", "--verify", "--check-updates"],
  );
});

test("POSIX setup rejects invalid hosts before creating destinations", async (t) => {
  const command = shellCommand();
  if (!command) return t.skip("POSIX shell unavailable");
  const directory = await workspace(t);
  const result = run(command, [path.join(root, "setup").replaceAll("\\", "/"), "--host", "invalid", "--scope", "local"], directory);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("POSIX setup previews changes and preserves unmanaged collisions", async (t) => {
  const command = shellCommand();
  if (!command) return t.skip("POSIX shell unavailable");
  await checkCollisionSafety(
    t,
    command,
    [path.join(root, "setup").replaceAll("\\", "/"), "--host", "codex", "--scope", "local"],
    "--force",
    "--dry-run",
  );
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

test("PowerShell verification reports installation drift without repairing it", async (t) => {
  const command = powerShellCommand();
  if (!command) return t.skip("PowerShell unavailable");
  const policy = run(command, ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"], root);
  if (["Restricted", "AllSigned"].includes(policy.stdout.trim())) {
    return t.skip(`PowerShell execution policy ${policy.stdout.trim()} prevents running the unsigned setup script`);
  }
  const script = path.join(root, "setup.ps1");
  await checkVerification(
    t,
    command,
    ["-NoProfile", "-NonInteractive", "-File", script, "-Host", "codex", "-Scope", "local"],
    ["-NoProfile", "-NonInteractive", "-File", script, "-Host", "codex", "-Scope", "local", "-Verify"],
  );
});

test("PowerShell update check notifies for a newer tag and handles offline remotes", async (t) => {
  const command = powerShellCommand();
  if (!command) return t.skip("PowerShell unavailable");
  const policy = run(command, ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"], root);
  if (["Restricted", "AllSigned"].includes(policy.stdout.trim())) {
    return t.skip(`PowerShell execution policy ${policy.stdout.trim()} prevents running the unsigned setup script`);
  }
  const script = path.join(root, "setup.ps1");
  await checkUpdateNotification(
    t,
    command,
    ["-NoProfile", "-NonInteractive", "-File", script, "-Host", "codex", "-Scope", "local"],
    ["-NoProfile", "-NonInteractive", "-File", script, "-Host", "codex", "-Scope", "local", "-Verify", "-CheckUpdates"],
  );
});

test("PowerShell setup previews changes and preserves unmanaged collisions", async (t) => {
  const command = powerShellCommand();
  if (!command) return t.skip("PowerShell unavailable");
  const policy = run(command, ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"], root);
  assert.equal(policy.status, 0, policy.stderr);
  if (["Restricted", "AllSigned"].includes(policy.stdout.trim())) {
    return t.skip(`PowerShell execution policy ${policy.stdout.trim()} prevents running the unsigned setup script`);
  }
  await checkCollisionSafety(
    t,
    command,
    ["-NoProfile", "-NonInteractive", "-File", path.join(root, "setup.ps1"), "-Host", "codex", "-Scope", "local"],
    "-Force",
    "-DryRun",
  );
});

