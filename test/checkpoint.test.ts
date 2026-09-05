import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../src/checkpoint/atomic.js";
import { parseCheckpoint, serializeCheckpoint } from "../src/checkpoint/frontmatter.js";
import { repositoryIdentity } from "../src/checkpoint/identifiers.js";
import { REQUIRED_SECTIONS, extractSection } from "../src/checkpoint/schema.js";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { replaceSection } from "../src/checkpoint/template.js";
import { main, type CliIo } from "../src/cli.js";
import { createGitRepository, temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IDENTITY = { projectSlug: "sample-project", ticketKey: "DEMO-101" } as const;

async function currentValidationEvidence(store: CheckpointStore, repositoryPath: string) {
  const result = await store.validate(IDENTITY, repositoryPath);
  assert.equal(result.status, "current");
  assert.ok(result.currentSnapshot);
  return {
    expectedWorktreeFingerprint: result.currentSnapshot.worktreeFingerprint,
    confirmedSuccessful: true as const,
  };
}

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
  assert.equal(checkpoint.metadata.schema_version, 2);
  assert.equal(checkpoint.metadata.project_slug, IDENTITY.projectSlug);
  assert.equal(checkpoint.metadata.ticket_key, IDENTITY.ticketKey);
  assert.equal(checkpoint.metadata.repository_id, repositoryIdentity(await gitRoot(fixture.root)));
  assert.equal("repository_path" in checkpoint.metadata, false);
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
  assert.throws(() => parseCheckpoint(source.replace("schema_version: 2", "schema_version: 99")), /Unsupported checkpoint schema/u);
  assert.throws(() => parseCheckpoint(source.replace(/^ticket_key:.*\n/mu, "")), /missing metadata/u);
  assert.throws(() => parseCheckpoint(source.replace("## Non-goals", "## Unexpected section")), /unsupported level-2/u);
  assert.throws(() => parseCheckpoint(source.replace("Not recorded.", "See https://internal.invalid/item")), /cannot contain URLs/u);
  assert.throws(() => parseCheckpoint(source.replace("Not recorded.", "api_key: example-secret-value")), /credential/u);
  const roundTrip = parseCheckpoint(serializeCheckpoint(parseCheckpoint(source)));
  assert.equal(roundTrip.metadata.repository_id, parseCheckpoint(source).metadata.repository_id);
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
  body = replaceSection(body, "Exact next action", "- Implement the approved local change.");
  body = replaceSection(body, "Test and validation results", "- PASS: focused local checks completed.");
  await assert.rejects(
    store.update({ ...IDENTITY, repositoryPath: fixture.root, body, status: "ready" }),
    /approvePlan/u,
  );
  assert.equal((await store.load(IDENTITY)).metadata.ticket_status, "planning");
  checkpoint = (
    await store.approvePlan({ ...IDENTITY, repositoryPath: fixture.root, body })
  ).checkpoint;
  checkpoint = (
    await store.update({
      ...IDENTITY,
      repositoryPath: fixture.root,
      body: checkpoint.body,
      status: "in-progress",
    })
  ).checkpoint;
  checkpoint = (
    await store.recordValidation({
      ...IDENTITY,
      repositoryPath: fixture.root,
      summary: "- PASS: focused local checks completed.",
      ...(await currentValidationEvidence(store, fixture.root)),
    })
  ).checkpoint;
  checkpoint = (
    await store.update({ ...IDENTITY, repositoryPath: fixture.root, body: checkpoint.body, status: "in-review" })
  ).checkpoint;
  await assert.rejects(
    store.update({ ...IDENTITY, repositoryPath: fixture.root, body: checkpoint.body, status: "completed" }),
    /complete/u,
  );
  assert.equal((await store.load(IDENTITY)).metadata.ticket_status, "in-review");
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

test("validation freshness requires explicit current evidence and is cleared by later result edits", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-validation-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  const created = await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const originalSource = await readFile(created.checkpointPath, "utf8");

  await assert.rejects(
    store.snapshot(IDENTITY, fixture.root, { markValidated: true }),
    /Snapshot cannot mark validation/u,
  );
  assert.equal(await readFile(created.checkpointPath, "utf8"), originalSource);

  await assert.rejects(
    store.recordValidation({
      ...IDENTITY,
      repositoryPath: fixture.root,
      summary: "- PASS: planning must not become validated.",
      ...(await currentValidationEvidence(store, fixture.root)),
    }),
    /Planning checkpoints cannot record code validation/u,
  );
  const planningCheckpoint = await store.load(IDENTITY);
  await store.update({
    ...IDENTITY,
    repositoryPath: fixture.root,
    body: planningCheckpoint.body,
    status: "blocked",
  });

  for (const summary of [
    "- FAIL: unit tests failed.",
    "- PASS: lint passed.\n- FAIL: unit tests failed.",
    "- SKIPPED: tests were not run.",
    "- INCONCLUSIVE: results unavailable.",
    "- PARTIAL: only lint passed.",
    "- MIXED: lint passed but other results are unavailable.",
    "- INTERRUPTED: test process stopped.",
    "- PENDING: validation will run later.",
    "- PASS: lint passed.\n- Unit test status: N/A.",
    "- Tests were executed.",
  ]) {
    await assert.rejects(
      store.recordValidation({
        ...IDENTITY,
        repositoryPath: fixture.root,
        summary,
        ...(await currentValidationEvidence(store, fixture.root)),
      }),
      /successful current test or validation summary/u,
      summary,
    );
  }

  const beforeFailure = await readFile(created.checkpointPath, "utf8");
  await assert.rejects(
    store.recordValidation({
      ...IDENTITY,
      repositoryPath: fixture.root,
      summary: "- PASS: focused checks passed locally.",
      expectedWorktreeFingerprint: created.checkpoint.metadata.worktree_fingerprint,
      confirmedSuccessful: false,
    }),
    /explicit confirmation/u,
  );
  assert.equal(await readFile(created.checkpointPath, "utf8"), beforeFailure);

  await assert.rejects(
    store.recordValidation({
      ...IDENTITY,
      repositoryPath: fixture.root,
      summary: "- PASS: all focused checks passed locally.",
      expectedWorktreeFingerprint: "0".repeat(64),
      confirmedSuccessful: true,
    }),
    /no longer matches the fingerprint/u,
  );
  assert.equal(await readFile(created.checkpointPath, "utf8"), beforeFailure);

  const parserOutput: string[] = [];
  const parserErrors: string[] = [];
  const forbiddenArtifact = path.join(fixture.root, "validation-runner-must-not-exist.tmp");
  assert.equal(
    await main(
      [
        "state",
        "record-validation",
        "--",
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(forbiddenArtifact)}, 'unexpected')`,
      ],
      {
        cwd: fixture.root,
        packageRoot: PACKAGE_ROOT,
        io: { stdout: (line) => parserOutput.push(line), stderr: (line) => parserErrors.push(line) },
      },
    ),
    1,
  );
  assert.deepEqual(parserOutput, []);
  assert.match(parserErrors.join("\n"), /Unexpected arguments after '--'/u);
  await assert.rejects(readFile(forbiddenArtifact, "utf8"), /ENOENT/u);

  const accepted = await store.recordValidation({
    ...IDENTITY,
    repositoryPath: fixture.root,
    summary: "- PASS: all focused checks passed locally.",
    ...(await currentValidationEvidence(store, fixture.root)),
  });
  assert.equal(accepted.checkpoint.metadata.last_validation_fingerprint, accepted.checkpoint.metadata.worktree_fingerprint);
  const contradicted = await store.update({
    ...IDENTITY,
    repositoryPath: fixture.root,
    section: "Test and validation results",
    body: "- FAIL: focused checks now fail.",
  });
  assert.equal(contradicted.checkpoint.metadata.last_validation_at, null);
  assert.equal(contradicted.checkpoint.metadata.last_validation_fingerprint, null);
  assert.equal((await store.validate(IDENTITY, fixture.root)).validationIsCurrent, false);
});

test("approved plan fields and completed checkpoints cannot be changed through generic mutations", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-immutable-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main", objective: "Keep state gated." });
  let checkpoint = await store.load(IDENTITY);
  let body = replaceSection(checkpoint.body, "Acceptance criteria", "- State gates remain enforced.");
  body = replaceSection(body, "Approved plan", "- Implement only the approved local behavior.");
  body = replaceSection(body, "Exact next action", "- Run the focused local check.");
  checkpoint = (await store.approvePlan({ ...IDENTITY, repositoryPath: fixture.root, body })).checkpoint;

  checkpoint = (await store.recordValidation({
    ...IDENTITY,
    repositoryPath: fixture.root,
    summary: "- PASS: the originally approved plan was validated.",
    ...(await currentValidationEvidence(store, fixture.root)),
  })).checkpoint;
  let reapprovedBody = replaceSection(checkpoint.body, "Approved plan", "- Implement the revised approved local behavior.");
  reapprovedBody = replaceSection(reapprovedBody, "Test and validation results", "- FAIL: the revised plan has not passed validation.");
  checkpoint = (await store.approvePlan({ ...IDENTITY, repositoryPath: fixture.root, body: reapprovedBody })).checkpoint;
  assert.equal(checkpoint.metadata.last_validation_at, null);
  assert.equal(checkpoint.metadata.last_validation_fingerprint, null);
  assert.equal((await store.validate(IDENTITY, fixture.root)).validationIsCurrent, false);

  const changedPlan = replaceSection(checkpoint.body, "Approved plan", "- Quietly replace the approved plan.");
  await assert.rejects(
    store.update({ ...IDENTITY, repositoryPath: fixture.root, body: changedPlan }),
    /dedicated approve-plan workflow/u,
  );

  checkpoint = (await store.update({ ...IDENTITY, repositoryPath: fixture.root, body: checkpoint.body, status: "in-progress" })).checkpoint;
  checkpoint = (await store.recordValidation({
    ...IDENTITY,
    repositoryPath: fixture.root,
    summary: "- PASS: focused checks passed.",
    ...(await currentValidationEvidence(store, fixture.root)),
  })).checkpoint;
  checkpoint = (await store.update({ ...IDENTITY, repositoryPath: fixture.root, body: checkpoint.body, status: "in-review" })).checkpoint;
  checkpoint = (await store.complete(IDENTITY, fixture.root)).checkpoint;

  const changedProgress = replaceSection(checkpoint.body, "Current work", "- Mutated after completion.");
  await assert.rejects(
    store.update({ ...IDENTITY, repositoryPath: fixture.root, body: changedProgress }),
    /Completed checkpoints are immutable/u,
  );
  await assert.rejects(
    store.recordValidation({
      ...IDENTITY,
      repositoryPath: fixture.root,
      summary: "- PASS: replacement validation.",
      ...(await currentValidationEvidence(store, fixture.root)),
    }),
    /Completed checkpoints are immutable/u,
  );
});

async function gitRoot(repository: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(repository);
}
