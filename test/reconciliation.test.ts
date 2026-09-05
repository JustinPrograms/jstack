import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { createGitRepository, git, temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IDENTITY = { projectSlug: "sample-project", ticketKey: "DEMO-101" } as const;

test("staleness, refresh, validation freshness, and branch mismatches remain distinct", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-reconcile-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  assert.equal((await store.validate(IDENTITY, fixture.root)).status, "current");

  await assert.rejects(store.snapshot(IDENTITY, fixture.root, { markValidated: true }), /successful current test/u);
  const planningCheckpoint = await store.load(IDENTITY);
  await store.update({
    ...IDENTITY,
    repositoryPath: fixture.root,
    body: planningCheckpoint.body,
    status: "blocked",
  });
  const testUpdate = await store.recordValidation({
    ...IDENTITY,
    repositoryPath: fixture.root,
    summary: "- PASS: focused unit checks completed locally.",
    expectedWorktreeFingerprint: (await store.validate(IDENTITY, fixture.root)).currentSnapshot?.worktreeFingerprint ?? "",
    confirmedSuccessful: true,
  });
  assert.equal(testUpdate.checkpoint.metadata.last_validation_fingerprint, testUpdate.checkpoint.metadata.worktree_fingerprint);
  assert.equal((await store.validate(IDENTITY, fixture.root)).validationIsCurrent, true);

  await writeFile(fixture.file, "changed after validation\n", "utf8");
  const stale = await store.validate(IDENTITY, fixture.root);
  assert.equal(stale.status, "stale-but-reconcilable");
  assert.equal(stale.validationIsCurrent, false);
  await store.snapshot(IDENTITY, fixture.root);
  const refreshed = await store.validate(IDENTITY, fixture.root);
  assert.equal(refreshed.status, "current");
  assert.equal(refreshed.validationIsCurrent, false);

  await git(fixture.root, "switch", "-c", "different-local-branch");
  const branchMismatch = await store.validate(IDENTITY, fixture.root);
  assert.equal(branchMismatch.status, "different-branch");
  await assert.rejects(store.snapshot(IDENTITY, fixture.root), /Refusing to refresh checkpoint/u);
});

test("missing checkpoints map to missing-required-information", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-missing-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  const result = await store.validate(IDENTITY, fixture.root);
  assert.equal(result.status, "missing-required-information");
  assert.equal(result.currentSnapshot, null);
});
