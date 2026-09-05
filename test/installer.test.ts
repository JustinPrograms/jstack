import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applyInstall,
  applyUninstall,
  parseInstallManifest,
  planInstall,
  planUninstall,
} from "../src/installer.js";
import { main, type CliIo } from "../src/cli.js";
import { temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

function targets(root: string) {
  return {
    packageRoot: PACKAGE_ROOT,
    userHome: root,
    storyStackHome: path.join(root, "runtime-home"),
    claudeSkillsRoot: path.join(root, "claude-skills"),
  };
}

test("installer planning is a true dry run and lists every target", async (t) => {
  const root = await temporaryDirectory(t, "story-stack-install-plan-");
  const options = targets(root);
  const plan = await planInstall(options);
  assert.equal(plan.entries.length > 10, true);
  assert.equal(plan.collisions.length, 0);
  assert.equal(plan.safetyIssues.length, 0);
  assert.equal(
    plan.entries.some((entry) => entry.targetPath === path.join(options.claudeSkillsRoot, "plan-eng-review", "SKILL.md")),
    true,
  );
  assert.equal(
    plan.entries.some((entry) => entry.targetPath === path.join(options.claudeSkillsRoot, "implement-story", "SKILL.md")),
    true,
  );
  await assert.rejects(readFile(plan.manifestPath, "utf8"), /ENOENT/u);
  for (const entry of plan.entries) await assert.rejects(readFile(entry.targetPath), /ENOENT/u);
});

test("install command defaults to dry-run without creating target roots", async (t) => {
  const root = await temporaryDirectory(t, "story-stack-install-cli-");
  const options = targets(root);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const code = await main(["install", "--json"], {
    cwd: PACKAGE_ROOT,
    packageRoot: PACKAGE_ROOT,
    env: {
      ...process.env,
      STORY_STACK_HOME: options.storyStackHome,
      STORY_STACK_SKILLS_HOME: options.claudeSkillsRoot,
    },
    io,
  });
  assert.equal(code, 0);
  assert.equal(stderr.length, 0);
  const payload = JSON.parse(stdout[0] ?? "{}");
  assert.equal(payload.dryRun, true);
  await assert.rejects(readFile(path.join(options.storyStackHome, "install-manifest.json")), /ENOENT/u);
  await assert.rejects(readFile(path.join(options.claudeSkillsRoot, "story", "SKILL.md")), /ENOENT/u);
});

test("installer detects collisions and refuses before any partial writes", async (t) => {
  const root = await temporaryDirectory(t, "story-stack-install-collision-");
  const options = targets(root);
  const sentinelPath = path.join(options.storyStackHome, "policies", "checkpoint-protocol.md");
  await mkdir(path.dirname(sentinelPath), { recursive: true });
  await writeFile(sentinelPath, "user-owned sentinel\n", "utf8");
  const plan = await planInstall(options);
  assert.equal(plan.collisions.some((item) => item.targetPath === sentinelPath), true);
  await assert.rejects(applyInstall(plan), /explicit overwrite confirmation/u);
  assert.equal(await readFile(sentinelPath, "utf8"), "user-owned sentinel\n");
  assert.equal(
    plan.entries.filter((entry) => entry.targetPath !== sentinelPath).every((entry) => entry.collision === null),
    true,
  );
  await assert.rejects(readFile(plan.manifestPath, "utf8"), /ENOENT/u);
});

test("uninstall manifests reject path traversal before resolving targets", () => {
  const malicious = JSON.stringify({
    schema_version: 1,
    package_version: "0.1.0",
    entries: [{ root: "story-stack", path: "../outside.txt", sha256: "0".repeat(64) }],
  });
  assert.throws(() => parseInstallManifest(malicious), /unsafe relative path/u);
});

test("legacy schema-v2 installations without destination roots remain parseable after normalization", () => {
  const legacyV2 = JSON.stringify({
    schema_version: 2,
    package_version: "0.2.0",
    runtime_entries: [],
    installations: [{
      key: "global:claude",
      target: "claude",
      scope: "global",
      workspace_id: null,
      entries: [],
    }],
  });
  const normalized = parseInstallManifest(legacyV2);
  assert.equal(normalized.schema_version, 2);
  if (normalized.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  assert.equal(normalized.installations[0]?.destination_root, null);
  assert.doesNotThrow(() => parseInstallManifest(JSON.stringify(normalized)));
});

test("manifest uninstall removes unchanged files but preserves modified files and ticket state", async (t) => {
  const root = await temporaryDirectory(t, "story-stack-install-apply-");
  const options = targets(root);
  const install = await applyInstall(options);
  assert.equal(install.written.length > 10, true);
  const manifest = await readFile(install.manifestPath, "utf8");
  assert.match(manifest, /"schema_version": 2/u);
  const launcherResult = await execFileAsync(
    process.execPath,
    [path.join(options.storyStackHome, "bin", "story-stack.js"), "doctor", "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        STORY_STACK_HOME: options.storyStackHome,
        STORY_STACK_SKILLS_HOME: options.claudeSkillsRoot,
      },
      windowsHide: true,
    },
  );
  assert.equal(JSON.parse(launcherResult.stdout).ok, true);
  const modifiedSkill = path.join(options.claudeSkillsRoot, "story", "SKILL.md");
  await writeFile(modifiedSkill, "locally modified skill\n", "utf8");
  const stateFile = path.join(options.storyStackHome, "state", "sample-project", "DEMO-101", "context.md");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, "private ticket state\n", "utf8");

  const uninstallPlan = await planUninstall(options);
  assert.equal(uninstallPlan.blocked.some((item) => item.targetPath === modifiedSkill), true);
  const result = await applyUninstall(uninstallPlan);
  assert.equal(result.manifestRemoved, false);
  assert.equal(await readFile(modifiedSkill, "utf8"), "locally modified skill\n");
  assert.equal(await readFile(stateFile, "utf8"), "private ticket state\n");
  assert.equal((await readFile(install.manifestPath, "utf8")).length > 0, true);
  assert.equal(result.removed.length > 0, true);
});
