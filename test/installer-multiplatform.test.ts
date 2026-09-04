import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  INSTALLED_SKILLS,
  applyInstall,
  applyUninstall,
  formatInstallPlan,
  inspectPlatformInstallations,
  parseInstallManifest,
  planInstall,
  planUninstall,
  type InstallerOptions,
} from "../src/installer.js";
import type { InstallScope, PlatformTarget, TargetSelection } from "../adapters/registry.js";
import { temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLATFORM_MARKERS: Readonly<Record<PlatformTarget, string>> = {
  claude: ".claude",
  bob: ".bob",
  codex: ".codex",
};

interface InstallFixture {
  root: string;
  userHome: string;
  projectRoot: string;
  justinStackHome: string;
}

async function installFixture(t: TestContext, prefix: string): Promise<InstallFixture> {
  const root = await temporaryDirectory(t, prefix);
  const userHome = path.join(root, "User Home With Spaces");
  const projectRoot = path.join(root, "Project With Spaces");
  const justinStackHome = path.join(userHome, ".justin-stack");
  await mkdir(userHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  return { root, userHome, projectRoot, justinStackHome };
}

function options(
  fixture: InstallFixture,
  target: TargetSelection,
  scope: InstallScope,
): InstallerOptions {
  return {
    packageRoot: PACKAGE_ROOT,
    userHome: fixture.userHome,
    projectRoot: fixture.projectRoot,
    justinStackHome: fixture.justinStackHome,
    target,
    scope,
  };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function regularFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) results.push(entryPath);
    }
  }
  await visit(root);
  return results.sort((left, right) => left.localeCompare(right, "en"));
}

async function mutablePackageCopy(fixture: InstallFixture, directoryName: string): Promise<string> {
  const packageRoot = path.join(fixture.root, directoryName);
  await mkdir(packageRoot, { recursive: true });
  for (const relativePath of ["dist/src", "dist/adapters", "skills", "policies", "templates"] as const) {
    await cp(path.join(PACKAGE_ROOT, relativePath), path.join(packageRoot, relativePath), {
      recursive: true,
      errorOnExist: true,
    });
  }
  return packageRoot;
}

function versionedOptions(
  fixture: InstallFixture,
  packageRoot: string,
  version: string,
  target: PlatformTarget = "claude",
): InstallerOptions {
  return {
    ...options(fixture, target, "global"),
    packageRoot,
    version,
  };
}

async function assertCanonicalSkillsAreByteIdentical(
  fixture: InstallFixture,
  scope: "project" | "global",
): Promise<void> {
  const base = scope === "project" ? fixture.projectRoot : fixture.userHome;
  for (const target of ["claude", "bob", "codex"] as const) {
    const installedRoot = path.join(base, PLATFORM_MARKERS[target], "skills");
    for (const skill of INSTALLED_SKILLS) {
      const canonicalRoot = path.join(PACKAGE_ROOT, "skills", skill);
      for (const canonicalPath of await regularFiles(canonicalRoot)) {
        const relative = path.relative(canonicalRoot, canonicalPath);
        const installedPath = path.join(installedRoot, skill, relative);
        assert.deepEqual(
          await readFile(installedPath),
          await readFile(canonicalPath),
          `${target}/${skill}/${relative} must be copied without transformation`,
        );
      }
    }
  }

  const canonicalPolicy = await readFile(path.join(PACKAGE_ROOT, "policies", "checkpoint-protocol.md"));
  for (const installedPolicy of [
    path.join(fixture.justinStackHome, "policies", "checkpoint-protocol.md"),
    path.join(fixture.justinStackHome, "runtime", "policies", "checkpoint-protocol.md"),
  ]) {
    assert.deepEqual(
      await readFile(installedPolicy),
      canonicalPolicy,
      `${installedPolicy} must contain the canonical policy used by installed skills`,
    );
  }
}

test("target all project install is a true dry-run and preserves proposal-only configuration", async (t) => {
  const fixture = await installFixture(t, "justinstack-all-project-");
  const sentinels = new Map<string, string>([
    [path.join(fixture.projectRoot, "CLAUDE.md"), "existing Claude instructions\n"],
    [path.join(fixture.projectRoot, ".claude", "settings.local.json"), "{\"existing\":true}\n"],
    [path.join(fixture.projectRoot, ".bob", "rules", "justinstack.md"), "existing Bob rule\n"],
    [path.join(fixture.projectRoot, ".bob", "settings.json"), "{\"existingHook\":true}\n"],
    [path.join(fixture.projectRoot, "AGENTS.md"), "existing Codex instructions\n"],
    [path.join(fixture.projectRoot, ".codex", "config.toml"), "existing = true\n"],
  ]);
  for (const [filePath, contents] of sentinels) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }

  const input = options(fixture, "all", "project");
  const plan = await planInstall(input);
  assert.deepEqual(plan.targets, ["claude", "bob", "codex"]);
  for (const target of plan.targets) {
    assert.equal(
      plan.skillRoots[target],
      path.join(fixture.projectRoot, PLATFORM_MARKERS[target], "skills"),
    );
  }
  assert.equal(plan.entries.every((entry) => entry.action === "create"), true);
  assert.equal(plan.configurationProposals.length >= sentinels.size, true);
  assert.equal(plan.configurationProposals.every((item) => item.disposition === "proposal-only"), true);
  assert.equal(plan.configurationProposals.every((item) => item.applyAutomatically === false), true);
  assert.equal(
    plan.configurationProposals
      .filter((item) => sentinels.has(item.targetPath))
      .every((item) => item.targetExists),
    true,
  );
  assert.equal(
    plan.configurationProposals.some((item) => item.id === "codex-rules" && !item.targetExists),
    true,
  );
  assert.equal(
    plan.entries.some((entry) => plan.configurationProposals.some((proposal) => proposal.targetPath === entry.targetPath)),
    false,
  );
  for (const proposal of plan.configurationProposals) {
    assert.match(proposal.diff, /proposal only/iu);
    assert.match(proposal.diff, /suggested addition/iu);
  }
  const formatted = formatInstallPlan(plan);
  assert.match(formatted, /PROPOSE ONLY/u);
  assert.match(formatted, /dry-run; no files written/u);
  assert.doesNotMatch(formatted, /existingHook|existing = true/u);

  assert.equal(await exists(plan.manifestPath), false);
  for (const target of plan.targets) {
    assert.equal(await exists(path.join(plan.skillRoots[target] ?? "", "story", "SKILL.md")), false);
  }
  for (const [filePath, contents] of sentinels) assert.equal(await readFile(filePath, "utf8"), contents);

  const first = await applyInstall(plan);
  assert.equal(first.configurationModified, false);
  assert.equal(first.written.length > 0, true);
  for (const [filePath, contents] of sentinels) assert.equal(await readFile(filePath, "utf8"), contents);
  await assertCanonicalSkillsAreByteIdentical(fixture, "project");

  const stableSkill = path.join(fixture.projectRoot, ".claude", "skills", "story", "SKILL.md");
  const stableDate = new Date("2020-01-02T03:04:05.000Z");
  await utimes(stableSkill, stableDate, stableDate);
  await utimes(first.manifestPath, stableDate, stableDate);
  const beforeSkillMtime = (await stat(stableSkill)).mtimeMs;
  const beforeManifestMtime = (await stat(first.manifestPath)).mtimeMs;

  const second = await applyInstall(input);
  assert.deepEqual(second.written, []);
  assert.equal(second.overwritten.length, 0);
  assert.equal(second.backups.length, 0);
  assert.equal(second.backupRoot, null);
  assert.equal(second.unchanged.length, (await planInstall(input)).entries.length);
  assert.equal((await stat(stableSkill)).mtimeMs, beforeSkillMtime);
  assert.equal((await stat(first.manifestPath)).mtimeMs, beforeManifestMtime);
});

test("hook proposals target the resolved custom JustinStack runtime home", async (t) => {
  const fixture = await installFixture(t, "justinstack-custom-runtime-hook-");
  const customRuntime = path.join(fixture.userHome, "Custom Runtime Home");
  const plan = await planInstall({
    ...options(fixture, "claude", "global"),
    justinStackHome: customRuntime,
  });
  const proposal = plan.configurationProposals.find((candidate) => candidate.id === "claude-hooks");
  assert.ok(proposal);
  const fragment = JSON.parse(proposal.snippet) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  const command = fragment.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
  const encoded = command.split(" ").at(-1) ?? "";
  assert.equal(
    Buffer.from(encoded, "base64url").toString("utf8"),
    pathToFileURL(path.join(customRuntime, "runtime", "dist", "src", "cli.js")).href,
  );
});

for (const target of ["claude", "bob", "codex"] as const) {
  test(`${target} global install uses the exact requested root and remains target-isolated`, async (t) => {
    const fixture = await installFixture(t, `justinstack-${target}-global-`);
    const input = options(fixture, target, "global");
    const plan = await planInstall(input);
    const expectedRoot = path.join(fixture.userHome, PLATFORM_MARKERS[target], "skills");
    assert.equal(plan.skillRoots[target], expectedRoot);
    assert.equal(plan.entries.some((entry) => entry.root === `${target}-skills`), true);
    for (const other of ["claude", "bob", "codex"] as const) {
      if (other === target) continue;
      assert.equal(plan.skillRoots[other], undefined);
      assert.equal(plan.entries.some((entry) => entry.root === `${other}-skills`), false);
    }

    await applyInstall(plan);
    assert.equal(await exists(path.join(expectedRoot, "story", "SKILL.md")), true);
    for (const other of ["claude", "bob", "codex"] as const) {
      if (other !== target) {
        assert.equal(await exists(path.join(fixture.userHome, PLATFORM_MARKERS[other])), false);
      }
    }
    for (const proposal of plan.configurationProposals) assert.equal(await exists(proposal.targetPath), false);

    const manifest = parseInstallManifest(await readFile(plan.manifestPath, "utf8"));
    assert.equal(manifest.schema_version, 2);
    if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
    assert.deepEqual(manifest.installations.map((item) => item.key), [`global:${target}`]);
  });
}

test("sequential global target installs preserve earlier manifest records and files", async (t) => {
  const fixture = await installFixture(t, "justinstack-sequential-global-");
  const expectedKeys: string[] = [];
  for (const target of ["claude", "bob", "codex"] as const) {
    const result = await applyInstall(options(fixture, target, "global"));
    expectedKeys.push(`global:${target}`);
    const manifest = parseInstallManifest(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.schema_version, 2);
    if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
    assert.deepEqual(
      manifest.installations.map((item) => item.key).sort((left, right) => left.localeCompare(right, "en")),
      [...expectedKeys].sort((left, right) => left.localeCompare(right, "en")),
    );
    for (const installedTarget of ["claude", "bob", "codex"] as const) {
      const shouldExist = expectedKeys.includes(`global:${installedTarget}`);
      assert.equal(
        await exists(path.join(fixture.userHome, PLATFORM_MARKERS[installedTarget], "skills", "story", "SKILL.md")),
        shouldExist,
      );
    }
    for (const priorTarget of ["claude", "bob", "codex"] as const) {
      if (priorTarget !== target) {
        const priorRoot = path.join(fixture.userHome, PLATFORM_MARKERS[priorTarget], "skills");
        assert.equal(result.written.some((filePath) => filePath.startsWith(`${priorRoot}${path.sep}`)), false);
      }
    }
  }
  await assertCanonicalSkillsAreByteIdentical(fixture, "global");
});

test("unmanaged skill collision includes a diff and refuses before partial writes", async (t) => {
  const fixture = await installFixture(t, "justinstack-collision-diff-");
  const collisionPath = path.join(fixture.userHome, ".bob", "skills", "story", "SKILL.md");
  await mkdir(path.dirname(collisionPath), { recursive: true });
  await writeFile(collisionPath, "user-owned sentinel\n", "utf8");

  const plan = await planInstall(options(fixture, "bob", "global"));
  const collisionEntry = plan.entries.find((entry) => entry.targetPath === collisionPath);
  assert.equal(collisionEntry?.action, "replace");
  assert.equal(collisionEntry?.managed, false);
  assert.equal(collisionEntry?.collision?.kind, "file");
  assert.match(collisionEntry?.diff ?? "", /--- .+SKILL\.md/u);
  assert.match(collisionEntry?.diff ?? "", /\+\+\+ .+SKILL\.md \(proposed\)/u);
  assert.match(collisionEntry?.diff ?? "", /-user-owned sentinel/u);
  assert.match(formatInstallPlan(plan), /Unmanaged existing files require --confirm-overwrite JUSTINSTACK/u);

  await assert.rejects(applyInstall(plan), /explicit overwrite confirmation/u);
  assert.equal(await readFile(collisionPath, "utf8"), "user-owned sentinel\n");
  assert.equal(await exists(plan.manifestPath), false);
  assert.equal(await exists(path.join(fixture.justinStackHome, "bin", "justinstack.js")), false);
});

test("an explicitly replaced file receives a durable pre-image backup", async (t) => {
  const fixture = await installFixture(t, "justinstack-durable-backup-");
  const collisionPath = path.join(fixture.userHome, ".claude", "skills", "story", "SKILL.md");
  await mkdir(path.dirname(collisionPath), { recursive: true });
  await writeFile(collisionPath, "user-owned pre-image\n", "utf8");

  const plan = await planInstall(options(fixture, "claude", "global"));
  assert.equal(plan.backupOperations.length, 1);
  const backupOperation = plan.backupOperations[0];
  assert.ok(backupOperation);
  assert.equal(backupOperation.sourcePath, collisionPath);
  assert.equal(backupOperation.action, "create");
  assert.equal(
    formatInstallPlan(plan).includes(`CREATE ${backupOperation.targetPath} <= ${collisionPath}`),
    true,
    "preflight must disclose the exact durable backup path before writing",
  );

  const result = await applyInstall(plan, { confirmOverwrite: true });
  assert.equal(result.backupRoot !== null, true);
  assert.deepEqual(result.backups, [backupOperation.targetPath]);
  assert.equal(await readFile(result.backups[0] ?? "", "utf8"), "user-owned pre-image\n");
  assert.deepEqual(
    await readFile(collisionPath),
    await readFile(path.join(PACKAGE_ROOT, "skills", "story", "SKILL.md")),
  );
});

test("a pre-existing byte-identical file is never silently adopted as installer-owned", async (t) => {
  const fixture = await installFixture(t, "justinstack-identical-unowned-");
  const existingSkill = path.join(fixture.userHome, ".claude", "skills", "story", "SKILL.md");
  const canonicalBytes = await readFile(path.join(PACKAGE_ROOT, "skills", "story", "SKILL.md"));
  await mkdir(path.dirname(existingSkill), { recursive: true });
  await writeFile(existingSkill, canonicalBytes);

  const installOptions = options(fixture, "claude", "global");
  const plan = await planInstall(installOptions);
  const entry = plan.entries.find((candidate) => candidate.targetPath === existingSkill);
  assert.equal(entry?.action, "unchanged");
  assert.equal(entry?.managed, false);
  assert.match(formatInstallPlan(plan), /left unowned/iu);

  const result = await applyInstall(plan);
  const manifest = parseInstallManifest(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  assert.equal(
    manifest.installations[0]?.entries.some((candidate) => candidate.path === "story/SKILL.md"),
    false,
  );

  await applyUninstall(installOptions);
  assert.deepEqual(await readFile(existingSkill), canonicalBytes);
});

test("uninstall uses the recorded custom root and never guesses the current default root", async (t) => {
  const fixture = await installFixture(t, "justinstack-recorded-root-");
  const customRoot = path.join(fixture.userHome, "Custom Global Claude Skills");
  const installOptions: InstallerOptions = {
    ...options(fixture, "claude", "global"),
    skillRoots: { claude: customRoot },
  };
  const install = await applyInstall(installOptions);
  const customSkill = path.join(customRoot, "story", "SKILL.md");
  assert.equal(await exists(customSkill), true);

  const defaultSentinel = path.join(fixture.userHome, ".claude", "skills", "story", "SKILL.md");
  // This deliberately matches the manifest hash. A root-guessing uninstaller
  // would delete it even though the custom-root installation never owned it.
  const sentinelBytes = await readFile(path.join(PACKAGE_ROOT, "skills", "story", "SKILL.md"));
  await mkdir(path.dirname(defaultSentinel), { recursive: true });
  await writeFile(defaultSentinel, sentinelBytes);

  const uninstallOptions = options(fixture, "claude", "global");
  const uninstallPlan = await planUninstall(uninstallOptions);
  assert.equal(uninstallPlan.entries.some((entry) => entry.targetPath === customSkill), true);
  assert.equal(uninstallPlan.entries.some((entry) => entry.targetPath === defaultSentinel), false);

  const result = await applyUninstall(uninstallOptions);
  assert.equal(result.manifestRemoved, true);
  assert.equal(await exists(customSkill), false);
  assert.deepEqual(await readFile(defaultSentinel), sentinelBytes);
  assert.equal(await exists(install.manifestPath), false);
});

test("a removed canonical file is planned and removed when its installed hash still matches", async (t) => {
  const fixture = await installFixture(t, "justinstack-obsolete-clean-");
  const packageRoot = await mutablePackageCopy(fixture, "Mutable Package Clean");
  const canonicalObsolete = path.join(packageRoot, "skills", "story", "references", "removed-in-v2.md");
  await mkdir(path.dirname(canonicalObsolete), { recursive: true });
  await writeFile(canonicalObsolete, "generic version-one fixture\n", "utf8");
  const v1 = versionedOptions(fixture, packageRoot, "1.0.0");
  await applyInstall(v1);

  const installedSkill = path.join(fixture.userHome, ".claude", "skills", "story", "references", "removed-in-v2.md");
  const installedRuntime = path.join(fixture.justinStackHome, "runtime", "skills", "story", "references", "removed-in-v2.md");
  assert.equal(await exists(installedSkill), true);
  assert.equal(await exists(installedRuntime), true);
  await rm(canonicalObsolete);

  const v2 = versionedOptions(fixture, packageRoot, "2.0.0");
  const plan = await planInstall(v2);
  for (const obsoletePath of [installedSkill, installedRuntime]) {
    const entry = plan.entries.find((candidate) => candidate.targetPath === obsoletePath);
    assert.equal(entry?.kind, "obsolete");
    assert.equal(entry?.action, "remove");
  }
  const result = await applyInstall(v2);
  assert.equal(result.removed.includes(installedSkill), true);
  assert.equal(result.removed.includes(installedRuntime), true);
  assert.equal(await exists(installedSkill), false);
  assert.equal(await exists(installedRuntime), false);

  const manifest = parseInstallManifest(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  assert.equal(manifest.runtime_entries.some((entry) => entry.path.endsWith("removed-in-v2.md")), false);
  assert.equal(
    manifest.installations[0]?.entries.some((entry) => entry.path.endsWith("removed-in-v2.md")),
    false,
  );
});

test("a modified obsolete canonical file is preserved, retained in the manifest, and reported by doctor", async (t) => {
  const fixture = await installFixture(t, "justinstack-obsolete-modified-");
  const packageRoot = await mutablePackageCopy(fixture, "Mutable Package Modified");
  const canonicalObsolete = path.join(packageRoot, "skills", "story", "references", "removed-in-v2.md");
  await mkdir(path.dirname(canonicalObsolete), { recursive: true });
  await writeFile(canonicalObsolete, "generic version-one fixture\n", "utf8");
  const v1 = versionedOptions(fixture, packageRoot, "1.0.0");
  await applyInstall(v1);

  const installedSkill = path.join(fixture.userHome, ".claude", "skills", "story", "references", "removed-in-v2.md");
  const localBytes = Buffer.from("locally changed obsolete fixture\n", "utf8");
  await writeFile(installedSkill, localBytes);
  await rm(canonicalObsolete);

  const v2 = versionedOptions(fixture, packageRoot, "2.0.0");
  const plan = await planInstall(v2);
  const obsolete = plan.entries.find((entry) => entry.targetPath === installedSkill);
  assert.equal(obsolete?.kind, "obsolete");
  assert.equal(obsolete?.action, "preserve");
  const result = await applyInstall(v2);
  assert.equal(result.preserved.some((entry) => entry.targetPath === installedSkill), true);
  assert.deepEqual(await readFile(installedSkill), localBytes);

  const manifest = parseInstallManifest(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  assert.equal(
    manifest.installations[0]?.entries.some((entry) => entry.path === "story/references/removed-in-v2.md"),
    true,
  );

  const [doctor] = await inspectPlatformInstallations(v2);
  assert.equal(doctor?.ok, false);
  assert.equal(doctor?.obsolete.includes(installedSkill), true);
});

test("dry-run refuses an intermediate link under a default skill destination without traversing it", async (t) => {
  const fixture = await installFixture(t, "justinstack-link-trap-");
  const trapRoot = path.join(fixture.root, "Link Trap");
  const linkPath = path.join(fixture.userHome, ".claude", "skills");
  const sentinelPath = path.join(trapRoot, "story", "SKILL.md");
  const sentinelBytes = Buffer.from("do not inspect or replace through this link\n", "utf8");
  await mkdir(path.dirname(sentinelPath), { recursive: true });
  await mkdir(path.dirname(linkPath), { recursive: true });
  await writeFile(sentinelPath, sentinelBytes);
  try {
    await symlink(trapRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      t.skip(`filesystem denied test link creation (${code})`);
      return;
    }
    throw error;
  }

  const plan = await planInstall(options(fixture, "claude", "global"));
  const trappedEntry = plan.entries.find((entry) => entry.targetPath === linkPath + path.sep + "story" + path.sep + "SKILL.md");
  assert.equal(trappedEntry?.action, "unsafe");
  assert.equal(trappedEntry?.collision, null);
  assert.equal(trappedEntry?.previousSha256, null);
  assert.equal(
    plan.safetyIssues.some((issue) => issue.message.includes("symbolic link or junction")),
    true,
  );
  assert.deepEqual(await readFile(sentinelPath), sentinelBytes);
  assert.deepEqual(await regularFiles(trapRoot), [sentinelPath]);
  assert.equal(await exists(plan.manifestPath), false);
});

test("concurrent different-target uninstalls serialize manifest updates without losing the remaining record", async (t) => {
  const fixture = await installFixture(t, "justinstack-concurrent-uninstall-");
  await applyInstall(options(fixture, "all", "global"));

  const [claudeResult, bobResult] = await Promise.all([
    applyUninstall(options(fixture, "claude", "global")),
    applyUninstall(options(fixture, "bob", "global")),
  ]);
  assert.equal(claudeResult.manifestRemoved, false);
  assert.equal(bobResult.manifestRemoved, false);

  const manifestPath = path.join(fixture.justinStackHome, "install-manifest.json");
  const manifest = parseInstallManifest(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  assert.deepEqual(manifest.installations.map((entry) => entry.key), ["global:codex"]);
  assert.equal(await exists(path.join(fixture.userHome, ".claude", "skills", "story", "SKILL.md")), false);
  assert.equal(await exists(path.join(fixture.userHome, ".bob", "skills", "story", "SKILL.md")), false);
  assert.equal(await exists(path.join(fixture.userHome, ".codex", "skills", "story", "SKILL.md")), true);
  assert.equal(await exists(path.join(fixture.justinStackHome, "bin", "justinstack.js")), true);
});

test("collision diffs are bounded and terminal control characters are escaped", async (t) => {
  const fixture = await installFixture(t, "justinstack-safe-diff-");
  const skillsRoot = path.join(fixture.userHome, ".bob", "skills");
  const largePath = path.join(skillsRoot, "story", "SKILL.md");
  const controlledPath = path.join(skillsRoot, "review", "SKILL.md");
  const largeBytes = Buffer.concat([
    Buffer.from("large collision with terminal control: \u001b[31m", "utf8"),
    Buffer.alloc(64 * 1024, 0x41),
  ]);
  const controlledBytes = Buffer.from("visible\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\n", "utf8");
  await mkdir(path.dirname(largePath), { recursive: true });
  await mkdir(path.dirname(controlledPath), { recursive: true });
  await writeFile(largePath, largeBytes);
  await writeFile(controlledPath, controlledBytes);

  const plan = await planInstall(options(fixture, "bob", "global"));
  const largeDiff = plan.entries.find((entry) => entry.targetPath === largePath)?.diff ?? "";
  const controlledDiff = plan.entries.find((entry) => entry.targetPath === controlledPath)?.diff ?? "";
  assert.match(largeDiff, /binary-or-large-file/u);
  assert.equal(Buffer.byteLength(largeDiff, "utf8") < 1024, true);
  assert.match(controlledDiff, /\\u001b/u);
  assert.match(controlledDiff, /\\u0007/u);
  const terminalControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u;
  assert.doesNotMatch(largeDiff, terminalControls);
  assert.doesNotMatch(controlledDiff, terminalControls);
  assert.doesNotMatch(formatInstallPlan(plan), terminalControls);
  assert.deepEqual(await readFile(largePath), largeBytes);
  assert.deepEqual(await readFile(controlledPath), controlledBytes);
});
