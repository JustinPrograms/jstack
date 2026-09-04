import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serializeCheckpoint } from "../src/checkpoint/frontmatter.js";
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
  const root = await temporaryDirectory(t, "justinstack CLI space ");
  const projectRoot = path.join(root, "project with spaces");
  const fakeHome = path.join(root, "home with spaces");
  const runtime = path.join(fakeHome, ".justin-stack");
  const output = captureIo();
  const code = await main(
    ["install", "--target", "all", "--scope", "project", "--project-root", projectRoot, "--json"],
    {
      cwd: projectRoot,
      packageRoot: PACKAGE_ROOT,
      env: { ...process.env, JUSTINSTACK_HOME: runtime, JUSTINSTACK_USER_HOME: fakeHome },
      io: output.io,
    },
  );
  assert.equal(code, 0);
  assert.equal(output.stderr.length, 0);
  const payload = JSON.parse(output.stdout[0] ?? "{}") as { dryRun?: boolean; plan?: { targets?: string[]; entries?: { targetPath: string }[] } };
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.plan?.targets, ["claude", "bob", "codex"]);
  const targets = (payload.plan?.entries ?? []).map((entry) => entry.targetPath);
  for (const platform of [".claude", ".bob", ".codex"]) {
    assert.equal(targets.some((target) => target.includes(path.join(projectRoot, platform, "skills"))), true);
    assert.equal(await doesNotExist(path.join(projectRoot, platform)), true);
  }
  assert.equal(await doesNotExist(runtime), true);
});

test("doctor target Bob is read-only and emits required verification reminders", async (t) => {
  const root = await temporaryDirectory(t, "justinstack-doctor-");
  const output = captureIo();
  const code = await main(["doctor", "--target", "bob", "--scope", "global", "--json"], {
    cwd: root,
    packageRoot: PACKAGE_ROOT,
    env: {
      ...process.env,
      JUSTINSTACK_HOME: path.join(root, ".justin-stack"),
      JUSTINSTACK_USER_HOME: root,
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
  assert.match(reminders, /\/list-skills/u);
  assert.equal(await doesNotExist(path.join(root, ".bob")), true);
});

test("apply emits a complete preflight record before its first write", async (t) => {
  const root = await temporaryDirectory(t, "justinstack-apply-preview-");
  const runtime = path.join(root, ".justin-stack");
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
      env: { ...process.env, JUSTINSTACK_HOME: runtime, JUSTINSTACK_USER_HOME: root },
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
  const root = await temporaryDirectory(t, "justinstack-legacy-cli-");
  const newHome = path.join(root, "new home", ".justin-stack");
  const oldHome = path.join(root, "old home", ".story-stack");
  const seedHome = path.join(root, "checkpoint seed");
  const identity = { projectSlug: "sample-workspace", ticketKey: "DEMO-202" } as const;
  const seedStore = new CheckpointStore({
    justinStackHome: seedHome,
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
    JUSTINSTACK_HOME: newHome,
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
      repository: fixture.root,
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
