import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serializeCheckpoint } from "../src/checkpoint/frontmatter.js";
import { repositoryIdentity } from "../src/checkpoint/identifiers.js";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { main, type CliIo } from "../src/cli.js";
import { createGitRepository, temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  return { io, stdout, stderr };
}

async function doesNotExist(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

test("CLI install target all in project scope is a true dry run", async (t) => {
  const root = await temporaryDirectory(t, "jstack CLI space ");
  const projectRoot = path.join(root, "project with spaces");
  const fakeHome = path.join(root, "home with spaces");
  const runtime = path.join(fakeHome, ".jstack");
  const output = captureIo();
  const code = await main(
    ["install", "--target", "all", "--scope", "project", "--project-root", projectRoot, "--json"],
    {
      cwd: projectRoot,
      packageRoot: PACKAGE_ROOT,
      env: { ...process.env, JSTACK_HOME: runtime, JSTACK_USER_HOME: fakeHome },
      io: output.io,
    },
  );
  assert.equal(code, 0);
  assert.equal(output.stderr.length, 0);
  const payload = JSON.parse(output.stdout[0] ?? "{}") as { dryRun?: boolean; plan?: { targets?: string[]; entries?: { targetPath: string }[] } };
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.plan?.targets, ["claude", "bob", "codex"]);
  const targets = (payload.plan?.entries ?? []).map((entry) => entry.targetPath);
  for (const platform of [".claude", ".bob", ".agents"]) {
    assert.equal(targets.some((target) => target.includes(path.join(projectRoot, platform, "skills"))), true);
    assert.equal(await doesNotExist(path.join(projectRoot, platform)), true);
  }
  assert.equal(targets.some((target) => target.endsWith(path.join("jstack-review", "SKILL.md"))), true);
  assert.equal(await doesNotExist(runtime), true);
});

test("implicit project scope resolves the Git top level while an explicit root remains exact", async (t) => {
  const fixture = await createGitRepository(t);
  const nested = path.join(fixture.root, "packages", "nested package");
  const fakeHome = await temporaryDirectory(t, "jstack-nested-home-");
  await mkdir(nested, { recursive: true });
  const context = {
    cwd: nested,
    packageRoot: PACKAGE_ROOT,
    env: {
      ...process.env,
      JSTACK_HOME: path.join(fakeHome, ".jstack"),
      JSTACK_USER_HOME: fakeHome,
    },
  };

  let output = captureIo();
  assert.equal(
    await main(["install", "--target", "codex", "--scope", "project", "--json"], { ...context, io: output.io }),
    0,
  );
  let payload = JSON.parse(output.stdout[0] ?? "{}") as {
    plan?: { projectRoot?: string; skillRoots?: { codex?: string } };
  };
  assert.equal(payload.plan?.projectRoot, fixture.root);
  assert.equal(payload.plan?.skillRoots?.codex, path.join(fixture.root, ".agents", "skills"));

  output = captureIo();
  assert.equal(
    await main(
      ["install", "--target", "codex", "--scope", "project", "--project-root", nested, "--json"],
      { ...context, io: output.io },
    ),
    0,
  );
  payload = JSON.parse(output.stdout[0] ?? "{}") as typeof payload;
  assert.equal(payload.plan?.projectRoot, nested);
  assert.equal(payload.plan?.skillRoots?.codex, path.join(nested, ".agents", "skills"));
});

test("implicit project scope falls back to the current directory outside Git", async (t) => {
  const root = await temporaryDirectory(t, "jstack-outside-git-");
  const cwd = path.join(root, "plain project");
  const fakeHome = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  const output = captureIo();
  assert.equal(
    await main(["install", "--target", "codex", "--scope", "project", "--json"], {
      cwd,
      packageRoot: PACKAGE_ROOT,
      env: {
        ...process.env,
        JSTACK_HOME: path.join(fakeHome, ".jstack"),
        JSTACK_USER_HOME: fakeHome,
      },
      io: output.io,
    }),
    0,
  );
  const payload = JSON.parse(output.stdout[0] ?? "{}") as {
    plan?: { projectRoot?: string; skillRoots?: { codex?: string } };
  };
  assert.equal(payload.plan?.projectRoot, cwd);
  assert.equal(payload.plan?.skillRoots?.codex, path.join(cwd, ".agents", "skills"));
});

test("global platform roots honor CLAUDE_CONFIG_DIR and CODEX_HOME independently of skill discovery", async (t) => {
  const root = await temporaryDirectory(t, "jstack-external-config-");
  const userHome = path.join(root, "user home");
  const claudeConfigDir = path.join(root, "external Claude config");
  const codexHome = path.join(root, "external Codex config");
  const output = captureIo();
  assert.equal(
    await main(["install", "--target", "all", "--scope", "global", "--json"], {
      cwd: root,
      packageRoot: PACKAGE_ROOT,
      env: {
        ...process.env,
        JSTACK_HOME: path.join(root, "runtime"),
        JSTACK_USER_HOME: userHome,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CODEX_HOME: codexHome,
      },
      io: output.io,
    }),
    0,
  );
  const payload = JSON.parse(output.stdout[0] ?? "{}") as {
    plan?: {
      skillRoots?: { claude?: string; bob?: string; codex?: string };
      configurationProposals?: { id: string; targetPath: string }[];
    };
  };
  assert.equal(payload.plan?.skillRoots?.claude, path.join(claudeConfigDir, "skills"));
  assert.equal(payload.plan?.skillRoots?.bob, path.join(userHome, ".bob", "skills"));
  assert.equal(payload.plan?.skillRoots?.codex, path.join(userHome, ".agents", "skills"));
  const proposals = new Map(payload.plan?.configurationProposals?.map((item) => [item.id, item.targetPath]));
  assert.equal(proposals.get("claude-hooks"), path.join(claudeConfigDir, "settings.json"));
  assert.equal(proposals.get("codex-instructions"), path.join(codexHome, "AGENTS.md"));
  assert.equal(proposals.get("codex-rules"), path.join(codexHome, "rules", "jstack.rules"));
});

test("doctor target Bob is read-only and emits required verification reminders", async (t) => {
  const root = await temporaryDirectory(t, "jstack-doctor-");
  const output = captureIo();
  const code = await main(["doctor", "--target", "bob", "--scope", "global", "--json"], {
    cwd: root,
    packageRoot: PACKAGE_ROOT,
    env: {
      ...process.env,
      JSTACK_HOME: path.join(root, ".jstack"),
      JSTACK_USER_HOME: root,
    },
    io: output.io,
  });
  assert.equal(code, 1);
  const payload = JSON.parse(output.stdout[0] ?? "{}") as {
    checks?: { platforms?: { target: string; reminders: { message: string }[] }[] };
  };
  const bob = payload.checks?.platforms?.[0];
  assert.equal(bob?.target, "bob");
  const reminders = bob?.reminders.map((item) => item.message).join("\n") ?? "";
  assert.match(reminders, /Advanced mode/u);
  assert.match(reminders, /\/skills/u);
  assert.equal(await doesNotExist(path.join(root, ".bob")), true);
});

test("doctor reports legacy and queued checkpoint lock leases", async (t) => {
  const root = await temporaryDirectory(t, "jstack-doctor-locks-");
  const runtime = path.join(root, ".jstack");
  const stories = path.join(runtime, "workspaces", "sample-workspace", "stories");
  const token = "12345678-1234-1234-1234-123456789abc";
  await mkdir(stories, { recursive: true });
  const lockNames = [
    ".DEMO-41.lock",
    `.DEMO-42.lock.choosing.${token}`,
    `.DEMO-43.lock.ticket.1.${token}`,
  ];
  await Promise.all(lockNames.map((name) => writeFile(path.join(stories, name), "fixture\n", "utf8")));

  const output = captureIo();
  assert.equal(
    await main(["doctor", "--target", "bob", "--scope", "global", "--json"], {
      cwd: root,
      packageRoot: PACKAGE_ROOT,
      env: { ...process.env, JSTACK_HOME: runtime, JSTACK_USER_HOME: root },
      io: output.io,
    }),
    1,
  );
  const payload = JSON.parse(output.stdout[0] ?? "{}") as {
    checks?: { checkpointLocks?: { ok?: boolean; count?: number; paths?: string[] } };
  };
  assert.equal(payload.checks?.checkpointLocks?.ok, false);
  assert.equal(payload.checks?.checkpointLocks?.count, lockNames.length);
  assert.deepEqual(
    payload.checks?.checkpointLocks?.paths?.map((item) => path.basename(item)).sort(),
    [...lockNames].sort(),
  );
});

test("apply emits a complete preflight record before its first write", async (t) => {
  const root = await temporaryDirectory(t, "jstack-apply-preview-");
  const runtime = path.join(root, ".jstack");
  const skill = path.join(root, ".bob", "skills", "story", "SKILL.md");
  const records: unknown[] = [];
  const io: CliIo = {
    stdout: (line) => {
      records.push(JSON.parse(line));
      if (records.length === 1) assert.equal(existsSync(skill), false);
    },
    stderr: (line) => assert.fail(line),
  };
  assert.equal(
    await main(["install", "--target", "bob", "--scope", "global", "--apply", "--json"], {
      cwd: root,
      packageRoot: PACKAGE_ROOT,
      env: { ...process.env, JSTACK_HOME: runtime, JSTACK_USER_HOME: root },
      io,
    }),
    0,
  );
  assert.equal(records.length, 2);
  assert.equal((records[0] as { phase?: string }).phase, "preflight");
  assert.equal(existsSync(skill), true);
});

test("CLI safety check refuses permanent mutations without executing them", async () => {
  let output = captureIo();
  assert.equal(
    await main(["safety", "check", "--command", "git push origin feature", "--json"], { io: output.io }),
    3,
  );
  assert.equal(JSON.parse(output.stdout[0] ?? "{}").decision.disposition, "deny");

  output = captureIo();
  assert.equal(await main(["safety", "check", "--command", "git status --short"], { io: output.io }), 0);
  assert.match(output.stdout.join("\n"), /^ALLOW/u);
});

test("CLI discovers, labels, and non-destructively migrates a legacy checkpoint", async (t) => {
  const fixture = await createGitRepository(t);
  const root = await temporaryDirectory(t, "jstack-legacy-cli-");
  const newHome = path.join(root, "new home", ".jstack");
  const oldHome = path.join(root, "old home", ".story-stack");
  const seedHome = path.join(root, "checkpoint seed");
  const identity = { projectSlug: "sample-workspace", ticketKey: "DEMO-202" } as const;
  const seedStore = new CheckpointStore({
    jstackHome: seedHome,
    legacyStateRoot: path.join(seedHome, "legacy state"),
    packageRoot: PACKAGE_ROOT,
  });
  const source = await seedStore.create({
    ...identity,
    repositoryPath: fixture.root,
    baseBranch: "main",
    objective: "Recover a generic local story.",
  });
  const legacySource = serializeCheckpoint(source.checkpoint);
  const legacyPath = path.join(oldHome, "state", identity.projectSlug, identity.ticketKey, "context.md");
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, legacySource, "utf8");

  const env = {
    ...process.env,
    JSTACK_HOME: newHome,
    // The compatibility override identifies a non-default old installation.
    STORY_STACK_HOME: oldHome,
  };
  let output = captureIo();
  assert.equal(
    await main(["state", "list", "--repo", fixture.root, "--json"], {
      cwd: fixture.root,
      packageRoot: PACKAGE_ROOT,
      env,
      io: output.io,
    }),
    0,
  );
  let listPayload = JSON.parse(output.stdout[0] ?? "{}") as {
    checkpoints?: { path: string; layout: string; project?: string; ticket?: string }[];
  };
  assert.deepEqual(listPayload.checkpoints, [
    {
      path: legacyPath,
      layout: "legacy",
      project: identity.projectSlug,
      ticket: identity.ticketKey,
      repositoryId: repositoryIdentity(fixture.root),
      branch: "main",
      status: "planning",
      updatedAt: source.checkpoint.metadata.updated_at,
    },
  ]);

  output = captureIo();
  assert.equal(
    await main(["state", "migrate", "--repo", fixture.root, "--json"], {
      cwd: fixture.root,
      packageRoot: PACKAGE_ROOT,
      env,
      io: output.io,
    }),
    0,
  );
  const migrated = JSON.parse(output.stdout[0] ?? "{}") as { migrated?: boolean; path?: string };
  const currentPath = path.join(
    newHome,
    "workspaces",
    identity.projectSlug,
    "stories",
    identity.ticketKey,
    "context.md",
  );
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.path, currentPath);
  assert.equal(await readFile(legacyPath, "utf8"), legacySource);
  assert.equal(await readFile(currentPath, "utf8"), legacySource);

  output = captureIo();
  assert.equal(
    await main(["state", "list", "--repo", fixture.root, "--json"], {
      cwd: fixture.root,
      packageRoot: PACKAGE_ROOT,
      env,
      io: output.io,
    }),
    0,
  );
  listPayload = JSON.parse(output.stdout[0] ?? "{}") as typeof listPayload;
  assert.deepEqual(listPayload.checkpoints?.map((item) => item.layout).sort(), ["bundle", "legacy"]);

  output = captureIo();
  assert.equal(
    await main(
      [
        "state",
        "migrate",
        "--workspace",
        identity.projectSlug,
        "--story",
        identity.ticketKey,
        "--repo",
        fixture.root,
        "--json",
      ],
      { cwd: fixture.root, packageRoot: PACKAGE_ROOT, env, io: output.io },
    ),
    0,
  );
  assert.equal(JSON.parse(output.stdout[0] ?? "{}").migrated, false);

  const secondIdentity = { projectSlug: "sample-workspace", ticketKey: "DEMO-203" } as const;
  const second = await seedStore.create({
    ...secondIdentity,
    repositoryPath: fixture.root,
    baseBranch: "main",
  });
  const secondLegacyPath = path.join(
    oldHome,
    "state",
    secondIdentity.projectSlug,
    secondIdentity.ticketKey,
    "context.md",
  );
  await mkdir(path.dirname(secondLegacyPath), { recursive: true });
  await writeFile(secondLegacyPath, serializeCheckpoint(second.checkpoint), "utf8");

  output = captureIo();
  assert.equal(
    await main(["state", "migrate", "--repo", fixture.root, "--json"], {
      cwd: fixture.root,
      packageRoot: PACKAGE_ROOT,
      env,
      io: output.io,
    }),
    4,
  );
  assert.equal(JSON.parse(output.stderr[0] ?? "{}").error?.code, "AMBIGUOUS_TICKET");
});

test("checkpoint reconciliation JSON exposes counts and identity without repository paths or filenames", async (t) => {
  const fixture = await createGitRepository(t);
  const stateHome = await temporaryDirectory(t, "jstack-private-cli-state-");
  const identity = ["--workspace", "sample-workspace", "--story", "DEMO-304", "--repo", fixture.root] as const;
  const context = {
    cwd: fixture.root,
    packageRoot: PACKAGE_ROOT,
    env: { ...process.env, JSTACK_HOME: stateHome, STORY_STACK_HOME: undefined },
  };

  let output = captureIo();
  assert.equal(
    await main(["state", "init", ...identity, "--base-branch", "main", "--json"], { ...context, io: output.io }),
    0,
  );

  output = captureIo();
  assert.equal(
    await main(["state", "snapshot", ...identity, "--mark-validated", "--json"], { ...context, io: output.io }),
    1,
  );
  assert.equal(JSON.parse(output.stderr[0] ?? "{}").error?.code, "INVALID_ARGUMENTS");

  await writeFile(fixture.file, "private local change\n", "utf8");

  for (const command of [
    ["state", "validate", ...identity, "--json"],
    ["state", "recovery", ...identity, "--json"],
    ["state", "init", ...identity, "--json"],
  ] as const) {
    output = captureIo();
    assert.equal(await main(command, { ...context, io: output.io }), 2, command.join(" "));
    const payload = JSON.parse(output.stdout[0] ?? "{}") as {
      currentSnapshot?: Record<string, unknown> | null;
      reconciliation?: {
        currentSnapshot?: Record<string, unknown> | null;
      };
    };
    const snapshot = payload.reconciliation?.currentSnapshot ?? payload.currentSnapshot;
    assert.ok(snapshot, command.join(" "));
    assert.equal(snapshot.repositoryId, repositoryIdentity(fixture.root));
    assert.equal(snapshot.changedFileCount, 1);
    assert.equal(snapshot.untrackedFileCount, 0);
    assert.equal("repositoryRoot" in snapshot, false);
    assert.equal("changedFiles" in snapshot, false);
    assert.equal("untrackedFiles" in snapshot, false);
    assert.equal(JSON.stringify(payload).includes(path.basename(fixture.file)), false);
  }
});
