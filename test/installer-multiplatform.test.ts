import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  INSTALL_TRANSACTION_FILENAME,
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
const execFileAsync = promisify(execFile);
const PLATFORM_MARKERS: Readonly<Record<PlatformTarget, string>> = {
  claude: ".claude",
  bob: ".bob",
  codex: ".agents",
};

interface InstallFixture {
  root: string;
  userHome: string;
  projectRoot: string;
  jstackHome: string;
}

async function installFixture(t: TestContext, prefix: string): Promise<InstallFixture> {
  const root = await temporaryDirectory(t, prefix);
  const userHome = path.join(root, "User Home With Spaces");
  const projectRoot = path.join(root, "Project With Spaces");
  const jstackHome = path.join(userHome, ".jstack");
  await mkdir(userHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  return { root, userHome, projectRoot, jstackHome };
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
    jstackHome: fixture.jstackHome,
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
    path.join(fixture.jstackHome, "policies", "checkpoint-protocol.md"),
    path.join(fixture.jstackHome, "runtime", "policies", "checkpoint-protocol.md"),
  ]) {
    assert.deepEqual(
      await readFile(installedPolicy),
      canonicalPolicy,
      `${installedPolicy} must contain the canonical policy used by installed skills`,
    );
  }
}

test("target all project install is a true dry-run and preserves proposal-only configuration", async (t) => {
  const fixture = await installFixture(t, "jstack-all-project-");
  const sentinels = new Map<string, string>([
    [path.join(fixture.projectRoot, "CLAUDE.md"), "existing Claude instructions\n"],
    [path.join(fixture.projectRoot, ".claude", "settings.local.json"), "{\"existing\":true}\n"],
    [path.join(fixture.projectRoot, ".bob", "rules", "jstack.md"), "existing Bob rule\n"],
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

test("hook proposals target the resolved custom JStack runtime home", async (t) => {
  const fixture = await installFixture(t, "jstack-custom-runtime-hook-");
  const customRuntime = path.join(fixture.userHome, "Custom Runtime Home");
  const plan = await planInstall({
    ...options(fixture, "claude", "global"),
    jstackHome: customRuntime,
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
    const fixture = await installFixture(t, `jstack-${target}-global-`);
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
  const fixture = await installFixture(t, "jstack-sequential-global-");
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

test("unmanaged skill collision reports only hashes and metadata and refuses before partial writes", async (t) => {
  const fixture = await installFixture(t, "jstack-collision-diff-");
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
  assert.match(collisionEntry?.diff ?? "", /content-metadata-only/u);
  assert.match(collisionEntry?.diff ?? "", /sha256:/u);
  assert.doesNotMatch(collisionEntry?.diff ?? "", /user-owned sentinel/u);
  const formatted = formatInstallPlan(plan);
  assert.match(formatted, /Unmanaged existing files require --confirm-overwrite JSTACK/u);
  assert.doesNotMatch(formatted, /user-owned sentinel/u);

  await assert.rejects(applyInstall(plan), /explicit overwrite confirmation/u);
  assert.equal(await readFile(collisionPath, "utf8"), "user-owned sentinel\n");
  assert.equal(await exists(plan.manifestPath), false);
  assert.equal(await exists(path.join(fixture.jstackHome, "bin", "jstack.js")), false);
});

test("an explicitly replaced file receives a durable pre-image backup", async (t) => {
  const fixture = await installFixture(t, "jstack-durable-backup-");
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
  const fixture = await installFixture(t, "jstack-identical-unowned-");
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
  const fixture = await installFixture(t, "jstack-recorded-root-");
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

test("Claude installs outside user home through CLAUDE_CONFIG_DIR can be uninstalled", async (t) => {
  const fixture = await installFixture(t, "jstack-external-claude-config-");
  const claudeConfigDir = path.join(fixture.root, "External Claude Config");
  const installOptions: InstallerOptions = {
    ...options(fixture, "claude", "global"),
    claudeConfigDir,
  };
  const installed = await applyInstall(installOptions);
  const installedSkill = path.join(claudeConfigDir, "skills", "story", "SKILL.md");
  assert.equal(await exists(installedSkill), true);

  const uninstallPlan = await planUninstall(installOptions);
  assert.equal(uninstallPlan.blocked.length, 0);
  assert.equal(uninstallPlan.entries.some((entry) => entry.targetPath === installedSkill && entry.status === "remove"), true);

  const result = await applyUninstall(uninstallPlan);
  assert.equal(result.blocked.length, 0);
  assert.equal(await exists(installedSkill), false);
  assert.equal(await exists(installed.manifestPath), false);
});

test("a removed canonical file is planned and removed when its installed hash still matches", async (t) => {
  const fixture = await installFixture(t, "jstack-obsolete-clean-");
  const packageRoot = await mutablePackageCopy(fixture, "Mutable Package Clean");
  const canonicalObsolete = path.join(packageRoot, "skills", "story", "references", "removed-in-v2.md");
  await mkdir(path.dirname(canonicalObsolete), { recursive: true });
  await writeFile(canonicalObsolete, "generic version-one fixture\n", "utf8");
  const v1 = versionedOptions(fixture, packageRoot, "1.0.0");
  await applyInstall(v1);

  const installedSkill = path.join(fixture.userHome, ".claude", "skills", "story", "references", "removed-in-v2.md");
  const installedRuntime = path.join(fixture.jstackHome, "runtime", "skills", "story", "references", "removed-in-v2.md");
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
  const fixture = await installFixture(t, "jstack-obsolete-modified-");
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
  const fixture = await installFixture(t, "jstack-link-trap-");
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
  const fixture = await installFixture(t, "jstack-concurrent-uninstall-");
  await applyInstall(options(fixture, "all", "global"));

  const [claudeResult, bobResult] = await Promise.all([
    applyUninstall(options(fixture, "claude", "global")),
    applyUninstall(options(fixture, "bob", "global")),
  ]);
  assert.equal(claudeResult.manifestRemoved, false);
  assert.equal(bobResult.manifestRemoved, false);

  const manifestPath = path.join(fixture.jstackHome, "install-manifest.json");
  const manifest = parseInstallManifest(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  assert.deepEqual(manifest.installations.map((entry) => entry.key), ["global:codex"]);
  assert.equal(await exists(path.join(fixture.userHome, ".claude", "skills", "story", "SKILL.md")), false);
  assert.equal(await exists(path.join(fixture.userHome, ".bob", "skills", "story", "SKILL.md")), false);
  assert.equal(await exists(path.join(fixture.userHome, ".agents", "skills", "story", "SKILL.md")), true);
  assert.equal(await exists(path.join(fixture.jstackHome, "bin", "jstack.js")), true);
});

test("collision diffs are bounded and terminal control characters are escaped", async (t) => {
  const fixture = await installFixture(t, "jstack-safe-diff-");
  const skillsRoot = path.join(fixture.userHome, ".bob", "skills");
  const largePath = path.join(skillsRoot, "story", "SKILL.md");
  const controlledPath = path.join(skillsRoot, "jstack-review", "SKILL.md");
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
  assert.match(largeDiff, /content-metadata-only/u);
  assert.equal(Buffer.byteLength(largeDiff, "utf8") < 1024, true);
  assert.doesNotMatch(controlledDiff, /\\u001b|\\u0007/u);
  assert.doesNotMatch(controlledDiff, /visible|example\.invalid|link/u);
  const terminalControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u;
  assert.doesNotMatch(largeDiff, terminalControls);
  assert.doesNotMatch(controlledDiff, terminalControls);
  assert.doesNotMatch(formatInstallPlan(plan), terminalControls);
  assert.deepEqual(await readFile(largePath), largeBytes);
  assert.deepEqual(await readFile(controlledPath), controlledBytes);
});

test("skill packages preserve optional frontmatter and recursive references, scripts, and assets", async (t) => {
  const fixture = await installFixture(t, "jstack-skill-resources-");
  const packageRoot = await mutablePackageCopy(fixture, "Package With Skill Resources");
  const storyRoot = path.join(packageRoot, "skills", "story");
  await writeFile(path.join(storyRoot, "SKILL.md"), `---
name: story
description: >
  Portable fixture exercising all standard optional
  frontmatter fields.
license: Apache-2.0
compatibility: |-
  Requires Node.js 20.
metadata:
  owner: >-
    jstack-test
  note: ""
allowed-tools: Read Bash(git:*)
---

# Story fixture
`, "utf8");
  const resources = new Map([
    ["references/deep/guide.md", "reference fixture\n"],
    ["scripts/check.js", "console.log('fixture');\n"],
    ["assets/templates/example.txt", "asset fixture\n"],
  ]);
  for (const [relativePath, contents] of resources) {
    const sourcePath = path.join(storyRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, contents, "utf8");
  }

  const input = versionedOptions(fixture, packageRoot, "3.0.0");
  const result = await applyInstall(input);
  const manifest = parseInstallManifest(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  for (const [relativePath, contents] of resources) {
    const manifestPath = `story/${relativePath}`;
    assert.equal(manifest.installations[0]?.entries.some((entry) => entry.path === manifestPath), true);
    assert.equal(manifest.runtime_entries.some((entry) => entry.path === `runtime/skills/${manifestPath}`), true);
    assert.equal(
      await readFile(path.join(fixture.userHome, ".claude", "skills", "story", ...relativePath.split("/")), "utf8"),
      contents,
    );
  }
});

test("skill package validation rejects names that mismatch the directory or contain consecutive hyphens", async (t) => {
  const fixture = await installFixture(t, "jstack-invalid-skill-name-");
  const packageRoot = await mutablePackageCopy(fixture, "Package With Invalid Skill");
  const skillPath = path.join(packageRoot, "skills", "story", "SKILL.md");
  await writeFile(skillPath, `---
name: invalid--story
description: This invalid name must be rejected before any install target is written.
---

# Invalid
`, "utf8");
  const input = versionedOptions(fixture, packageRoot, "3.0.0");
  await assert.rejects(planInstall(input), /name must match its directory/iu);
  assert.equal(await exists(fixture.jstackHome), false);

  await writeFile(skillPath, `---
name: story
description: Metadata without a mapping must be rejected.
metadata:
---

# Invalid metadata
`, "utf8");
  await assert.rejects(planInstall(input), /metadata must be a string mapping, not null/iu);
  assert.equal(await exists(fixture.jstackHome), false);
});

test("a journaled pre-manifest crash adopts only entries with durable applied markers", async (t) => {
  const fixture = await installFixture(t, "jstack-journal-recovery-");
  const input = options(fixture, "bob", "global");
  const unownedPath = path.join(fixture.userHome, ".bob", "skills", "resume-story", "SKILL.md");
  const canonicalUnowned = await readFile(path.join(PACKAGE_ROOT, "skills", "resume-story", "SKILL.md"));
  await mkdir(path.dirname(unownedPath), { recursive: true });
  await writeFile(unownedPath, canonicalUnowned);

  const plan = await planInstall(input);
  const beforeManifestMutation = plan.entries.filter((entry) =>
    entry.kind !== "manifest" && (entry.action === "create" || entry.action === "replace" || entry.action === "remove")).length;
  assert.equal(beforeManifestMutation > 0, true);
  await assert.rejects(
    applyInstall(input, { testOnlyAbortAfterMutations: beforeManifestMutation }),
    /Simulated abrupt installer termination/u,
  );
  const journalPath = path.join(fixture.jstackHome, INSTALL_TRANSACTION_FILENAME);
  assert.equal(await exists(journalPath), true);
  assert.equal(await exists(plan.manifestPath), false);

  const retry = await applyInstall(input);
  assert.equal(await exists(journalPath), false);
  assert.deepEqual(retry.written, []);
  const manifest = parseInstallManifest(await readFile(retry.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  const bob = manifest.installations.find((entry) => entry.key === "global:bob");
  assert.ok(bob);
  assert.equal(bob.entries.some((entry) => entry.path === "story/SKILL.md"), true);
  assert.equal(bob.entries.some((entry) => entry.path === "resume-story/SKILL.md"), false);
  assert.deepEqual(await readFile(unownedPath), canonicalUnowned);
});

test("recovery revalidates applied targets before committing its manifest", async (t) => {
  const fixture = await installFixture(t, "jstack-recovery-manifest-race-");
  const input = options(fixture, "bob", "global");
  const plan = await planInstall(input);
  const beforeManifestMutation = plan.entries.filter((entry) =>
    entry.kind !== "manifest" && (entry.action === "create" || entry.action === "replace" || entry.action === "remove")).length;
  await assert.rejects(
    applyInstall(input, { testOnlyAbortAfterMutations: beforeManifestMutation }),
    /Simulated abrupt installer termination/u,
  );
  const journalPath = path.join(fixture.jstackHome, INSTALL_TRANSACTION_FILENAME);
  const victim = plan.entries.find((entry) => entry.kind !== "manifest" && entry.action === "create");
  assert.ok(victim);
  const externalBytes = "external recovery writer\n";

  await assert.rejects(
    applyInstall(input, {
      testOnlyBeforeRecoveryManifest: async () => writeFile(victim.targetPath, externalBytes, "utf8"),
    }),
    /manifest could be committed/u,
  );

  assert.equal(await readFile(victim.targetPath, "utf8"), externalBytes);
  assert.equal(await exists(plan.manifestPath), false);
  assert.equal(await exists(journalPath), true);
});

test("a non-cooperating target edit is detected before manifest commit and preserved", async (t) => {
  const fixture = await installFixture(t, "jstack-pre-manifest-race-");
  const input = options(fixture, "claude", "global");
  const plan = await planInstall(input);
  const victim = plan.entries.find((entry) => entry.kind !== "manifest" && entry.action === "create");
  assert.ok(victim);
  const externalBytes = "external writer won the race\n";

  await assert.rejects(
    applyInstall(plan, {
      testOnlyBeforeManifest: async () => writeFile(victim.targetPath, externalBytes, "utf8"),
    }),
    /manifest could be committed|rollback was incomplete/u,
  );

  assert.equal(await readFile(victim.targetPath, "utf8"), externalBytes);
  assert.equal(await exists(plan.manifestPath), false);
});

test("an unmarked pending create that independently appears is preserved and remains unowned", async (t) => {
  const fixture = await installFixture(t, "jstack-journal-ambiguous-");
  const input = options(fixture, "claude", "global");
  const initialPlan = await planInstall(input);
  const orderedTargets = initialPlan.entries.filter((entry) =>
    entry.kind !== "manifest" && entry.action !== "remove" &&
    (entry.action === "create" || entry.action === "replace"));
  const pendingEntry = orderedTargets[1];
  assert.ok(pendingEntry);
  await assert.rejects(
    applyInstall(input, { testOnlyAbortBeforeMutation: 2 }),
    /Simulated abrupt installer termination/u,
  );
  assert.equal(await exists(pendingEntry.targetPath), false);
  const independentBytes = pendingEntry.sourcePath === null
    ? Buffer.from(pendingEntry.generatedContents ?? "", "utf8")
    : await readFile(pendingEntry.sourcePath);
  await mkdir(path.dirname(pendingEntry.targetPath), { recursive: true });
  await writeFile(pendingEntry.targetPath, independentBytes);

  await applyInstall(input);
  assert.deepEqual(await readFile(pendingEntry.targetPath), independentBytes);
  const manifest = parseInstallManifest(await readFile(initialPlan.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  const owned = pendingEntry.root === "jstack"
    ? manifest.runtime_entries
    : manifest.installations.find((entry) => entry.key === pendingEntry.installationKey)?.entries ?? [];
  assert.equal(owned.some((entry) => entry.path === pendingEntry.relativePath), false);
});

test("executable mode is established before an atomic target rename", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable modes are not meaningful on Windows");
    return;
  }
  const fixture = await installFixture(t, "jstack-pre-rename-mode-");
  const input = options(fixture, "claude", "global");
  const plan = await planInstall(input);
  const ordered = [
    ...plan.entries.filter((entry) => entry.kind !== "manifest" && entry.action !== "remove" &&
      (entry.action === "create" || entry.action === "replace")),
    ...plan.entries.filter((entry) => entry.action === "remove"),
    ...plan.entries.filter((entry) => entry.kind === "manifest" &&
      (entry.action === "create" || entry.action === "replace")),
  ];
  const launcher = path.join(fixture.jstackHome, "bin", "jstack");
  const launcherIndex = ordered.findIndex((entry) => entry.targetPath === launcher);
  assert.notEqual(launcherIndex, -1);
  await assert.rejects(
    applyInstall(input, { testOnlyAbortAfterMutations: launcherIndex + 1 }),
    /Simulated abrupt installer termination/u,
  );
  assert.equal((await stat(launcher)).mode & 0o777, 0o755);
  await applyInstall(input);
  assert.equal((await stat(launcher)).mode & 0o777, 0o755);
});

test("stale dead-pid installer locks are reclaimed without deleting live contenders", async (t) => {
  const fixture = await installFixture(t, "jstack-stale-installer-lock-");
  const lockBase = path.join(
    path.dirname(fixture.jstackHome),
    `.${path.basename(fixture.jstackHome)}.installer.lock`,
  );
  await writeFile(lockBase, `${JSON.stringify({
    pid: 2_147_483_647,
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`, "utf8");
  const staleToken = "00000000-0000-4000-8000-000000000001";
  await writeFile(`${lockBase}.ticket.1.${staleToken}`, `${JSON.stringify({
    pid: 2_147_483_647,
    created_at: "2000-01-01T00:00:00.000Z",
    token: staleToken,
  })}\n`, "utf8");

  const [first, second] = await Promise.all([
    applyInstall(options(fixture, "claude", "global")),
    applyInstall(options(fixture, "bob", "global")),
  ]);
  assert.equal(first.written.length > 0, true);
  assert.equal(second.written.length > 0, true);
  assert.equal(await exists(lockBase), false);
  const lockArtifacts = (await readdir(path.dirname(lockBase)))
    .filter((name) => name.startsWith(`${path.basename(lockBase)}.`));
  assert.deepEqual(lockArtifacts, []);
  const manifest = parseInstallManifest(await readFile(first.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  assert.deepEqual(manifest.installations.map((entry) => entry.key).sort(), ["global:bob", "global:claude"]);
});

test("malformed installer queue artifacts block while fresh and recover only after aging", async (t) => {
  const fixture = await installFixture(t, "jstack-malformed-installer-lock-");
  const lockBase = path.join(
    path.dirname(fixture.jstackHome),
    `.${path.basename(fixture.jstackHome)}.installer.lock`,
  );
  const token = "11111111-1111-4111-8111-111111111111";
  const ticket = `${lockBase}.ticket.1.${token}`;
  await writeFile(ticket, "not-json", "utf8");

  await assert.rejects(applyInstall(options(fixture, "claude", "global")), /lock cannot be safely inspected/u);
  assert.equal(await exists(ticket), true);

  const old = new Date("2000-01-01T00:00:00.000Z");
  await utimes(ticket, old, old);
  await applyInstall(options(fixture, "claude", "global"));
  assert.equal(await exists(ticket), false);

  await writeFile(lockBase, "truncated", "utf8");
  await assert.rejects(applyInstall(options(fixture, "bob", "global")), /lock cannot be safely inspected/u);
  assert.equal(await exists(lockBase), true);
  await utimes(lockBase, old, old);
  await applyInstall(options(fixture, "bob", "global"));
  assert.equal(await exists(lockBase), false);

  const choosing = `${lockBase}.choosing.${token}`;
  await writeFile(choosing, "", "utf8");
  await utimes(choosing, old, old);
  await applyInstall(options(fixture, "bob", "global"));
  assert.equal(await exists(choosing), false);
});

test("doctor validates runtime bytes, types, modes, and manifest ownership completeness", async (t) => {
  const fixture = await installFixture(t, "jstack-doctor-runtime-");
  const input = options(fixture, "claude", "global");
  const install = await applyInstall(input);
  const [healthy] = await inspectPlatformInstallations(input);
  assert.equal(healthy?.ok, true);
  assert.equal(healthy?.installed.some((entry) => entry.startsWith(`${fixture.jstackHome}${path.sep}`)), true);

  const runtimePackage = path.join(fixture.jstackHome, "runtime", "package.json");
  const runtimePackageBytes = await readFile(runtimePackage);
  await writeFile(runtimePackage, "{\"tampered\":true}\n", "utf8");
  const [wrongBytes] = await inspectPlatformInstallations(input);
  assert.equal(wrongBytes?.stale.includes(runtimePackage), true);
  assert.equal(wrongBytes?.installed.includes(runtimePackage), false);
  await writeFile(runtimePackage, runtimePackageBytes);

  const manifest = parseInstallManifest(await readFile(install.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  const ownershipPath = "bin/jstack.js";
  const ownershipTarget = path.join(fixture.jstackHome, ...ownershipPath.split("/"));
  manifest.runtime_entries = manifest.runtime_entries.filter((entry) => entry.path !== ownershipPath);
  await writeFile(install.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const [ownershipBroken] = await inspectPlatformInstallations(input);
  assert.equal(ownershipBroken?.ok, false);
  assert.equal(ownershipBroken?.stale.includes(install.manifestPath), true);
  assert.equal(ownershipBroken?.stale.includes(ownershipTarget), true);

  const missingTarget = runtimePackage;
  await rm(missingTarget);
  const [missingRuntime] = await inspectPlatformInstallations(input);
  assert.equal(missingRuntime?.missing.includes(missingTarget), true);

  const typeTarget = path.join(fixture.jstackHome, "runtime", "templates", "context.v1.md");
  await rm(typeTarget);
  await mkdir(typeTarget);
  const [wrongType] = await inspectPlatformInstallations(input);
  assert.equal(wrongType?.stale.includes(typeTarget), true);

  if (process.platform !== "win32") {
    const launcher = path.join(fixture.jstackHome, "bin", "jstack");
    await chmod(launcher, 0o644);
    const [wrongMode] = await inspectPlatformInstallations(input);
    assert.equal(wrongMode?.stale.includes(launcher), true);
  }
});

test("legacy managed review paths remain parseable and are removed only when their hashes match", async (t) => {
  const fixture = await installFixture(t, "jstack-legacy-review-");
  const input = options(fixture, "claude", "global");
  const install = await applyInstall(input);
  const legacyBytes = Buffer.from("legacy managed review fixture\n", "utf8");
  const legacyHash = createHash("sha256").update(legacyBytes).digest("hex");
  const skillPath = path.join(fixture.userHome, ".claude", "skills", "review", "SKILL.md");
  const runtimePath = path.join(fixture.jstackHome, "runtime", "skills", "review", "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(skillPath, legacyBytes);
  await writeFile(runtimePath, legacyBytes);
  const manifest = parseInstallManifest(await readFile(install.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, 2);
  if (manifest.schema_version !== 2) assert.fail("expected schema-v2 manifest");
  manifest.runtime_entries.push({ path: "runtime/skills/review/SKILL.md", sha256: legacyHash });
  const record = manifest.installations.find((entry) => entry.key === "global:claude");
  assert.ok(record);
  record.entries.push({ path: "review/SKILL.md", sha256: legacyHash });
  await writeFile(install.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const plan = await planInstall(input);
  assert.equal(plan.entries.some((entry) => entry.targetPath === skillPath && entry.action === "remove"), true);
  assert.equal(plan.entries.some((entry) => entry.targetPath === runtimePath && entry.action === "remove"), true);
  await applyInstall(input);
  assert.equal(await exists(skillPath), false);
  assert.equal(await exists(runtimePath), false);
});

test("omitted projectRoot resolves the enclosing Git top-level from a nested directory", async (t) => {
  const fixture = await installFixture(t, "jstack-nested-git-root-");
  await execFileAsync("git", ["init", fixture.projectRoot], { windowsHide: true });
  const nested = path.join(fixture.projectRoot, "packages", "nested");
  await mkdir(nested, { recursive: true });
  const plan = await planInstall({
    packageRoot: PACKAGE_ROOT,
    userHome: fixture.userHome,
    jstackHome: fixture.jstackHome,
    target: "bob",
    scope: "project",
    cwd: nested,
  });
  assert.equal(plan.projectRoot, fixture.projectRoot);
  assert.equal(plan.skillRoots.bob, path.join(fixture.projectRoot, ".bob", "skills"));
});

test("implicit project-root discovery falls back only outside Git and surfaces unrelated Git failures", async (t) => {
  const fixture = await installFixture(t, "jstack-project-root-errors-");
  const outsideGit = path.join(fixture.root, "Outside Git");
  await mkdir(outsideGit);
  const plan = await planInstall({
    packageRoot: PACKAGE_ROOT,
    userHome: fixture.userHome,
    jstackHome: fixture.jstackHome,
    target: "codex",
    scope: "project",
    cwd: outsideGit,
  });
  assert.equal(plan.projectRoot, path.resolve(outsideGit));

  await assert.rejects(
    planInstall({
      packageRoot: PACKAGE_ROOT,
      userHome: fixture.userHome,
      jstackHome: fixture.jstackHome,
      target: "codex",
      scope: "project",
      cwd: path.join(fixture.root, "missing-directory"),
    }),
    /project-root discovery failed/u,
  );
});
