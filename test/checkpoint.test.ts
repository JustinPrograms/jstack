import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../src/checkpoint/atomic.js";
import { parseCheckpoint, serializeCheckpoint } from "../src/checkpoint/frontmatter.js";
import { REQUIRED_SECTIONS, extractSection } from "../src/checkpoint/schema.js";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { replaceSection } from "../src/checkpoint/template.js";
import { main, type CliIo } from "../src/cli.js";
import { createGitRepository, temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IDENTITY = { projectSlug: "sample-project", ticketKey: "DEMO-101" } as const;

test("checkpoint creation is versioned, complete, and idempotent", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-state-");
  const clock = () => new Date("2026-01-02T03:04:05.000Z");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT, clock });
  const first = await store.create({
    ...IDENTITY,
    repositoryPath: fixture.root,
    baseBranch: "main",
    objective: "Add a generic local preference.",
  });
  assert.equal(first.changed, true);
  const originalBytes = await readFile(first.checkpointPath, "utf8");
  const checkpoint = parseCheckpoint(originalBytes);
  assert.equal(checkpoint.metadata.schema_version, 1);
  assert.equal(checkpoint.metadata.project_slug, IDENTITY.projectSlug);
  assert.equal(checkpoint.metadata.ticket_key, IDENTITY.ticketKey);
  assert.equal(checkpoint.metadata.repository_path, await gitRoot(fixture.root));
  assert.equal(extractSection(checkpoint.body, "Objective"), "Add a generic local preference.");
  for (const section of REQUIRED_SECTIONS) assert.match(checkpoint.body, new RegExp(`^## ${section}$`, "m"));

  const second = await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  assert.equal(second.changed, false);
  assert.equal(await readFile(first.checkpointPath, "utf8"), originalBytes);

  const noOp = await store.update({ ...IDENTITY, repositoryPath: fixture.root, body: checkpoint.body });
  assert.equal(noOp.changed, false);
  assert.equal(await readFile(first.checkpointPath, "utf8"), originalBytes);
});

test("full checkpoint updates preserve approval gates unless explicitly acknowledged", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-approval-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const current = await store.load(IDENTITY);
  const changedApproval = current.body.replace("## Required user approvals\n\n- None.", "## Required user approvals\n\n- Confirm the local behavior.");
  await assert.rejects(
    store.update({ ...IDENTITY, repositoryPath: fixture.root, body: changedApproval }),
    /allow-approval-change/u,
  );
  const accepted = await store.update({
    ...IDENTITY,
    repositoryPath: fixture.root,
    body: changedApproval,
    allowApprovalChange: true,
  });
  assert.equal(extractSection(accepted.checkpoint.body, "Required user approvals"), "- Confirm the local behavior.");
});

test("atomic writer exposes only old then new content and cleans up after failure", async (t) => {
  const directory = await temporaryDirectory(t, "story-stack-atomic-");
  const target = path.join(directory, "context.md");
  await writeFile(target, "old-complete", "utf8");
  let observedTemporary = "";
  await writeFileAtomic(target, "new-complete", {
    beforeRename: async (temporaryPath) => {
      assert.equal(await readFile(target, "utf8"), "old-complete");
      observedTemporary = await readFile(temporaryPath, "utf8");
    },
  });
  assert.equal(observedTemporary, "new-complete");
  assert.equal(await readFile(target, "utf8"), "new-complete");
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);

  await assert.rejects(
    writeFileAtomic(target, "never-visible", {
      beforeRename: () => {
        throw new Error("injected rename barrier failure");
      },
    }),
    /injected rename barrier/u,
  );
  assert.equal(await readFile(target, "utf8"), "new-complete");
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("schema and privacy validation reject malformed or unsafe checkpoint content", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-schema-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  const created = await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const source = await readFile(created.checkpointPath, "utf8");
  assert.throws(() => parseCheckpoint(source.replace("schema_version: 1", "schema_version: 99")), /Unsupported checkpoint schema/u);
  assert.throws(() => parseCheckpoint(source.replace(/^ticket_key:.*\n/mu, "")), /missing metadata/u);
  assert.throws(() => parseCheckpoint(source.replace("## Non-goals", "## Unexpected section")), /unsupported level-2/u);
  assert.throws(() => parseCheckpoint(source.replace("Not recorded.", "See https://internal.invalid/item")), /cannot contain URLs/u);
  assert.throws(() => parseCheckpoint(source.replace("Not recorded.", "api_key: example-secret-value")), /credential/u);
  const roundTrip = parseCheckpoint(serializeCheckpoint(parseCheckpoint(source)));
  assert.equal(roundTrip.metadata.repository_path, parseCheckpoint(source).metadata.repository_path);
});

test("completion requires a reviewed, approved, and currently validated checkpoint", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-complete-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  await store.create({
    ...IDENTITY,
    repositoryPath: fixture.root,
    baseBranch: "main",
    objective: "Deliver the generic behavior.",
  });
  let checkpoint = await store.load(IDENTITY);
  let body = replaceSection(checkpoint.body, "Acceptance criteria", "- The generic behavior is covered.");
  body = replaceSection(body, "Approved plan", "- Make the smallest local change and test it.");
  body = replaceSection(body, "Test and validation results", "- PASS: focused local checks completed.");
  checkpoint = (
    await store.update({
      ...IDENTITY,
      repositoryPath: fixture.root,
      body,
      status: "ready",
      markValidated: true,
    })
  ).checkpoint;
  checkpoint = (
    await store.update({ ...IDENTITY, repositoryPath: fixture.root, body: checkpoint.body, status: "in-progress" })
  ).checkpoint;
  checkpoint = (
    await store.update({ ...IDENTITY, repositoryPath: fixture.root, body: checkpoint.body, status: "in-review" })
  ).checkpoint;
  const stdout: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => assert.fail(line) };
  const completeArguments = [
    "state",
    "complete",
    "--project",
    IDENTITY.projectSlug,
    "--ticket",
    IDENTITY.ticketKey,
    "--repo",
    fixture.root,
  ];
  assert.equal(
    await main(completeArguments, {
      cwd: fixture.root,
      packageRoot: PACKAGE_ROOT,
      env: { ...process.env, STORY_STACK_HOME: stateParent },
      io,
    }),
    0,
  );
  assert.match(stdout[0] ?? "", /Completed:/u);
  assert.equal((await store.load(IDENTITY)).metadata.ticket_status, "completed");
  assert.equal((await store.complete(IDENTITY, fixture.root)).changed, false);
});

async function gitRoot(repository: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(repository);
}
