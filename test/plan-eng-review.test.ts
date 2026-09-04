import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main, type CliIo } from "../src/cli.js";
import { extractSection } from "../src/checkpoint/schema.js";
import { CheckpointStore } from "../src/checkpoint/store.js";
import { replaceSection } from "../src/checkpoint/template.js";
import { createGitRepository, temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IDENTITY = { projectSlug: "sample-project", ticketKey: "DEMO-201" } as const;

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  return { io, stdout, stderr };
}

function reviewedBody(source: string): string {
  let body = replaceSection(source, "Acceptance criteria", "- The reviewed behavior is testable locally.");
  body = replaceSection(body, "Approved plan", "1. Reuse the existing local boundary.\n2. Add focused behavior and tests.");
  body = replaceSection(body, "Exact next action", "Implement the first approved local change.");
  body = replaceSection(body, "Blockers and questions", "- None.");
  return body;
}

test("plan approval requires explicit confirmation and atomically marks a current ticket ready", async (t) => {
  const fixture = await createGitRepository(t);
  const isolatedHome = await temporaryDirectory(t, "story-stack-plan-review-");
  const storyHome = path.join(isolatedHome, "story-home");
  const store = new CheckpointStore({ stateRoot: path.join(storyHome, "state"), packageRoot: PACKAGE_ROOT });
  await store.create({
    ...IDENTITY,
    repositoryPath: fixture.root,
    baseBranch: "main",
    objective: "Deliver a reviewed local behavior.",
  });
  const original = await store.load(IDENTITY);
  const bodyFile = path.join(isolatedHome, "reviewed-checkpoint.md");
  await writeFile(bodyFile, reviewedBody(original.body), "utf8");
  const identityArguments = [
    "--project",
    IDENTITY.projectSlug,
    "--ticket",
    IDENTITY.ticketKey,
    "--repo",
    fixture.root,
    "--body-file",
    bodyFile,
  ];
  const context = {
    cwd: fixture.root,
    packageRoot: PACKAGE_ROOT,
    env: { ...process.env, STORY_STACK_HOME: storyHome },
  };

  let output = captureIo();
  assert.equal(await main(["state", "approve-plan", ...identityArguments], { ...context, io: output.io }), 1);
  assert.match(output.stderr.join("\n"), /explicitly approves/u);
  assert.equal((await store.load(IDENTITY)).metadata.ticket_status, "planning");

  output = captureIo();
  assert.equal(
    await main(["state", "approve-plan", ...identityArguments, "--confirm-user-approved", "--json"], {
      ...context,
      io: output.io,
    }),
    0,
  );
  const payload = JSON.parse(output.stdout[0] ?? "{}");
  assert.equal(payload.changed, true);
  const approved = await store.load(IDENTITY);
  assert.equal(approved.metadata.ticket_status, "ready");
  assert.match(extractSection(approved.body, "Approved plan"), /Reuse the existing local boundary/u);

  output = captureIo();
  assert.equal(
    await main(["state", "approve-plan", ...identityArguments, "--confirm-user-approved", "--json"], {
      ...context,
      io: output.io,
    }),
    0,
  );
  assert.equal(JSON.parse(output.stdout[0] ?? "{}").changed, false);
});

test("plan approval refuses stale worktrees, unresolved blockers, and removed approval gates", async (t) => {
  const fixture = await createGitRepository(t);
  const stateParent = await temporaryDirectory(t, "story-stack-plan-guards-");
  const store = new CheckpointStore({ stateRoot: path.join(stateParent, "state"), packageRoot: PACKAGE_ROOT });
  await store.create({
    ...IDENTITY,
    repositoryPath: fixture.root,
    baseBranch: "main",
    objective: "Deliver a reviewed local behavior.",
  });
  let checkpoint = await store.load(IDENTITY);
  let body = reviewedBody(checkpoint.body);
  body = replaceSection(body, "Blockers and questions", "- Decide the public behavior.");
  await assert.rejects(store.approvePlan({ ...IDENTITY, repositoryPath: fixture.root, body }), /Resolve material blockers/u);

  const gatedBody = replaceSection(checkpoint.body, "Required user approvals", "- Confirm a later gated operation.");
  checkpoint = (
    await store.update({
      ...IDENTITY,
      repositoryPath: fixture.root,
      body: gatedBody,
      allowApprovalChange: true,
    })
  ).checkpoint;
  const removedGate = reviewedBody(checkpoint.body).replace(
    "- Confirm a later gated operation.",
    "- None.",
  );
  await assert.rejects(
    store.approvePlan({ ...IDENTITY, repositoryPath: fixture.root, body: removedGate }),
    /must preserve existing Required user approvals/u,
  );

  await writeFile(fixture.file, "repository changed after review\n", "utf8");
  await assert.rejects(
    store.approvePlan({ ...IDENTITY, repositoryPath: fixture.root, body: reviewedBody(checkpoint.body) }),
    /requires a current checkpoint \(stale-but-reconcilable\)/u,
  );
});
