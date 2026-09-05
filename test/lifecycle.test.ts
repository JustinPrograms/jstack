import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main, type CliIo } from "../src/cli.js";
import { createGitRepository, temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  return { io, stdout, stderr };
}

test("CLI lifecycle initializes, detects drift, refreshes, and produces a recovery summary", async (t) => {
  const fixture = await createGitRepository(t);
  const isolatedHome = await temporaryDirectory(t, "story-stack-lifecycle-");
  const env = {
    ...process.env,
    STORY_STACK_HOME: path.join(isolatedHome, "story-home"),
    STORY_STACK_SKILLS_HOME: path.join(isolatedHome, "skills-home"),
  };
  const common = { cwd: fixture.root, env, packageRoot: PACKAGE_ROOT };
  const identity = ["--project", "sample-project", "--ticket", "DEMO-101", "--repo", fixture.root];
  const demonstratedSteps: string[] = [];

  let output = captureIo();
  assert.equal(
    await main(
      ["state", "init", ...identity, "--base-branch", "main", "--objective", "Remember a generic local preference."],
      { ...common, io: output.io },
    ),
    0,
  );
  assert.match(output.stdout.join("\n"), /Created checkpoint/u);
  demonstratedSteps.push("1. init: checkpoint created");

  output = captureIo();
  assert.equal(await main(["state", "path", ...identity, "--json"], { ...common, io: output.io }), 0);
  assert.match(JSON.parse(output.stdout[0] ?? "{}").path, /context\.md$/u);
  output = captureIo();
  assert.equal(await main(["state", "show", ...identity, "--json"], { ...common, io: output.io }), 0);
  const shownCheckpoint = JSON.parse(output.stdout[0] ?? "{}").checkpoint as { metadata: { ticket_key: string }; body: string };
  assert.equal(shownCheckpoint.metadata.ticket_key, "DEMO-101");
  const blockedBody = path.join(isolatedHome, "blocked-body.md");
  await writeFile(blockedBody, shownCheckpoint.body, "utf8");
  output = captureIo();
  assert.equal(
    await main(["state", "update", ...identity, "--body-file", blockedBody, "--status", "blocked"], { ...common, io: output.io }),
    0,
  );
  output = captureIo();
  assert.equal(
    await main(["state", "list", "--repo", fixture.root, "--json"], { ...common, io: output.io }),
    0,
  );
  assert.equal(JSON.parse(output.stdout[0] ?? "{}").checkpoints.length, 1);

  const validationSummary = path.join(isolatedHome, "validation-summary.md");
  await writeFile(validationSummary, "- PASS: generic focused checks completed locally.\n", "utf8");
  output = captureIo();
  assert.equal(await main(["state", "validate", ...identity, "--json"], { ...common, io: output.io }), 0);
  const preValidationFingerprint = JSON.parse(output.stdout[0] ?? "{}").currentSnapshot.worktreeFingerprint as string;
  output = captureIo();
  assert.equal(
    await main(
      [
        "state",
        "record-validation",
        ...identity,
        "--body-file",
        validationSummary,
        "--expected-fingerprint",
        preValidationFingerprint,
        "--confirm-validation-succeeded",
      ],
      { ...common, io: output.io },
    ),
    0,
  );

  output = captureIo();
  assert.equal(await main(["state", "validate", ...identity, "--json"], { ...common, io: output.io }), 0);
  assert.equal(JSON.parse(output.stdout[0] ?? "{}").status, "current");
  demonstratedSteps.push("2. capture/validate: current; validation fingerprint recorded");

  await writeFile(fixture.file, "local implementation change\n", "utf8");
  output = captureIo();
  assert.equal(await main(["state", "validate", ...identity, "--json"], { ...common, io: output.io }), 2);
  assert.equal(JSON.parse(output.stdout[0] ?? "{}").status, "stale-but-reconcilable");
  demonstratedSteps.push("3. modify file: stale-but-reconcilable detected");

  output = captureIo();
  assert.equal(await main(["state", "snapshot", ...identity], { ...common, io: output.io }), 0);
  assert.match(output.stdout.join("\n"), /Refreshed checkpoint/u);
  demonstratedSteps.push("4. snapshot: Git-derived metadata refreshed atomically");
  output = captureIo();
  assert.equal(await main(["state", "validate", ...identity, "--json"], { ...common, io: output.io }), 0);
  const refreshed = JSON.parse(output.stdout[0] ?? "{}");
  assert.equal(refreshed.status, "current");
  assert.equal(refreshed.validationIsCurrent, false);
  demonstratedSteps.push("5. validate: checkpoint current; earlier validation correctly historical");

  output = captureIo();
  assert.equal(await main(["state", "recovery", ...identity], { ...common, io: output.io }), 0);
  const recovery = output.stdout.join("\n");
  for (const heading of [
    "Objective:",
    "Completed work:",
    "Current state:",
    "Next action:",
    "Blockers:",
    "Required approval:",
    "Last successful validation:",
  ]) {
    assert.match(recovery, new RegExp(heading, "u"));
  }
  assert.match(recovery, /Remember a generic local preference/u);
  assert.match(recovery, /historical; repository state changed/u);
  demonstratedSteps.push("6. recovery: objective, progress, next action, blockers, approval, and validation summarized");
  t.diagnostic(`Lifecycle demonstration:\n${demonstratedSteps.join("\n")}`);
});
