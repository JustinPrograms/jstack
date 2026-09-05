import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseContinuityBundleState } from "../src/checkpoint/bundle.js";
import { parseCheckpoint, serializeCheckpoint } from "../src/checkpoint/frontmatter.js";
import { repositoryIdentity } from "../src/checkpoint/identifiers.js";
import { CheckpointStore, defaultJustinStackHome, defaultLegacyStateRoot } from "../src/checkpoint/store.js";
import { replaceSection } from "../src/checkpoint/template.js";
import { CONTINUITY_BUNDLE_FILES } from "../src/checkpoint/types.js";
import { createGitRepository, temporaryDirectory } from "./helpers/git-fixture.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IDENTITY = { projectSlug: "sample-project", ticketKey: "DEMO-101" } as const;

function createStore(home: string): CheckpointStore {
  return new CheckpointStore({ stateRoot: path.join(home, "state"), packageRoot: PACKAGE_ROOT });
}

function asLegacyV1(source: string, repositoryPath: string): string {
  return source
    .replace("schema_version: 2", "schema_version: 1")
    .replace(/^repository_id:.*$/mu, `repository_path: ${JSON.stringify(path.resolve(repositoryPath))}`)
    .replace(/^changed_file_count:/mu, "changed_file_summary: []\nchanged_file_count:")
    .replace(/^untracked_file_count:/mu, "untracked_files: []\nuntracked_file_count:");
}

test("JustinStack home supports current and legacy environment names with stable precedence", () => {
  const preferred = path.resolve("preferred-justinstack-home");
  const alternate = path.resolve("alternate-justin-stack-home");
  const legacy = path.resolve("legacy-story-stack-home");
  assert.equal(
    defaultJustinStackHome({
      JUSTINSTACK_HOME: preferred,
      JUSTIN_STACK_HOME: alternate,
      STORY_STACK_HOME: legacy,
    }),
    preferred,
  );
  assert.equal(defaultJustinStackHome({ JUSTIN_STACK_HOME: alternate, STORY_STACK_HOME: legacy }), alternate);
  assert.equal(defaultJustinStackHome({ JUSTINSTACK_HOME: "", JUSTIN_STACK_HOME: alternate }), alternate);
  assert.equal(defaultJustinStackHome({ STORY_STACK_HOME: legacy }), legacy);
});

test("new and legacy default state roots remain distinct and independently overridable", () => {
  const expectedNewHome = path.join(os.homedir(), ".justin-stack");
  const expectedLegacyRoot = path.join(os.homedir(), ".story-stack", "state");
  assert.equal(defaultJustinStackHome({}), expectedNewHome);
  assert.equal(defaultLegacyStateRoot({}), expectedLegacyRoot);
  assert.notEqual(defaultLegacyStateRoot({}), path.join(defaultJustinStackHome({}), "state"));

  const newHome = path.resolve("isolated-new-home");
  const oldHome = path.resolve("isolated-old-home");
  const environment = { JUSTINSTACK_HOME: newHome, STORY_STACK_HOME: oldHome };
  assert.equal(defaultJustinStackHome(environment), newHome);
  assert.equal(defaultLegacyStateRoot(environment), path.join(oldHome, "state"));

  // Redirecting only the new home must never redirect or hide legacy lookup.
  assert.equal(defaultLegacyStateRoot({ JUSTINSTACK_HOME: newHome }), expectedLegacyRoot);
  assert.equal(new CheckpointStore({ justinStackHome: newHome }).stateRoot, expectedLegacyRoot);
  assert.equal(new CheckpointStore({ storyStackHome: oldHome }).stateRoot, path.join(oldHome, "state"));
});

test("continuity creation publishes exactly six consistent files and is idempotent", async (t) => {
  const fixture = await createGitRepository(t);
  const home = await temporaryDirectory(t, "justin stack bundle ");
  const store = createStore(home);
  const created = await store.create({
    ...IDENTITY,
    repositoryPath: fixture.root,
    baseBranch: "main",
    objective: "Preserve a generic preference.",
  });

  assert.equal(
    created.checkpointPath,
    path.join(home, "workspaces", "sample-project", "stories", "DEMO-101", "context.md"),
  );
  const paths = store.bundlePathsFor(IDENTITY);
  assert.deepEqual((await readdir(paths.directory)).sort(), [...CONTINUITY_BUNDLE_FILES].sort());
  assert.equal((await store.bundleHealth(IDENTITY)).status, "current");
  for (const platform of ["claude", "bob", "codex"]) {
    const sharedReader = createStore(home);
    assert.equal((await sharedReader.load(IDENTITY)).metadata.ticket_key, IDENTITY.ticketKey, platform);
    assert.equal((await sharedReader.bundleHealth(IDENTITY)).status, "current", platform);
  }
  assert.match(await readFile(paths.decisions, "utf8"), /^# Story decisions$/mu);
  assert.match(await readFile(paths.progress, "utf8"), /^## Completed work$/mu);
  assert.match(await readFile(paths.checks, "utf8"), /^## Test and validation results$/mu);
  assert.match(await readFile(paths.handoff, "utf8"), /^## Exact recommended next step$/mu);

  const state = parseContinuityBundleState(await readFile(paths.state, "utf8"));
  assert.equal(state.workspace_id, IDENTITY.projectSlug);
  assert.equal(state.story_id, IDENTITY.ticketKey);
  assert.equal(state.generation, state.files["context.md"]);
  assert.throws(
    () => parseContinuityBundleState(`${JSON.stringify({ ...state, unexpected: true })}\n`),
    /missing or unknown fields/u,
  );

  const before = new Map(
    await Promise.all(
      CONTINUITY_BUNDLE_FILES.map(async (fileName) => {
        const filePath = path.join(paths.directory, fileName);
        return [fileName, { source: await readFile(filePath, "utf8"), modified: (await stat(filePath)).mtimeMs }] as const;
      }),
    ),
  );
  const repeated = await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.repairedFiles, []);
  for (const fileName of CONTINUITY_BUNDLE_FILES) {
    const filePath = path.join(paths.directory, fileName);
    assert.equal(await readFile(filePath, "utf8"), before.get(fileName)?.source);
    assert.equal((await stat(filePath)).mtimeMs, before.get(fileName)?.modified);
  }
});

test("derived drift is repairable without rewriting canonical context", async (t) => {
  const fixture = await createGitRepository(t);
  const home = await temporaryDirectory(t, "justin-stack-repair-");
  const store = createStore(home);
  await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const paths = store.bundlePathsFor(IDENTITY);
  const contextBefore = await readFile(paths.context, "utf8");
  const contextModifiedBefore = (await stat(paths.context)).mtimeMs;

  await writeFile(paths.decisions, "locally drifted projection\n", "utf8");
  const stale = await store.validate(IDENTITY, fixture.root);
  assert.equal(stale.status, "stale-but-reconcilable");
  assert.equal(stale.bundleHealth?.status, "repairable");

  const repaired = await store.snapshot(IDENTITY, fixture.root);
  assert.equal(repaired.changed, false);
  assert.deepEqual(repaired.repairedFiles, ["decisions.md"]);
  assert.equal(await readFile(paths.context, "utf8"), contextBefore);
  assert.equal((await stat(paths.context)).mtimeMs, contextModifiedBefore);
  assert.equal((await store.bundleHealth(IDENTITY)).status, "current");

  await unlink(paths.handoff);
  await mkdir(paths.handoff);
  const unsafe = await store.validate(IDENTITY, fixture.root);
  assert.equal(unsafe.status, "missing-required-information");
  await assert.rejects(store.snapshot(IDENTITY, fixture.root), /regular file/u);
});

test("initial publication refuses a pre-existing story directory without replacing its files", async (t) => {
  const fixture = await createGitRepository(t);
  const home = await temporaryDirectory(t, "justin-stack-existing-story-");
  const store = createStore(home);
  const paths = store.bundlePathsFor(IDENTITY);
  await mkdir(paths.directory, { recursive: true });
  const marker = path.join(paths.directory, "existing-note.txt");
  await writeFile(marker, "preserve me\n", "utf8");

  await assert.rejects(
    store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" }),
    /story directory already exists/u,
  );
  assert.equal(await readFile(marker, "utf8"), "preserve me\n");
  await assert.rejects(readFile(paths.context, "utf8"), /ENOENT/u);
  assert.deepEqual(
    (await readdir(path.dirname(paths.directory))).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")),
    [],
  );
});

test("recovery exposes the complete cross-agent handoff contract from current Git state", async (t) => {
  const fixture = await createGitRepository(t);
  const home = await temporaryDirectory(t, "justin-stack-recovery-");
  const store = createStore(home);
  await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main", objective: "Keep local work resumable." });
  let checkpoint = await store.load(IDENTITY);
  let body = replaceSection(checkpoint.body, "Acceptance criteria", "- Another agent can restore the work.");
  body = replaceSection(body, "Non-goals", "- No remote mutation.");
  body = replaceSection(body, "Decisions and rationale", "- Keep context canonical for atomic recovery.");
  body = replaceSection(body, "Completed work", "- Defined the bundle layout.");
  body = replaceSection(body, "Current work", "- Exercising recovery output.");
  body = replaceSection(body, "Files inspected", "- src/checkpoint/store.ts: owns continuity state.");
  body = replaceSection(body, "Files changed and why", "- context.md: concise state snapshot.");
  body = replaceSection(body, "Test and validation results", "- FAIL: one generic check needs a retry.");
  body = replaceSection(body, "Blockers and questions", "- Confirm the retry scope.");
  body = replaceSection(body, "Exact next action", "- Retry the focused local check.");
  checkpoint = (await store.update({ ...IDENTITY, repositoryPath: fixture.root, body })).checkpoint;
  await writeFile(fixture.file, "changed after checkpoint\n", "utf8");

  const recovery = await store.recovery(IDENTITY, fixture.root);
  assert.equal(recovery.workspace, IDENTITY.projectSlug);
  assert.equal(recovery.story, IDENTITY.ticketKey);
  assert.equal(recovery.objective, "Keep local work resumable.");
  assert.match(recovery.acceptanceCriteria, /Another agent/u);
  assert.match(recovery.nonGoals, /No remote mutation/u);
  assert.match(recovery.relevantFiles, /store\.ts/u);
  assert.match(recovery.decisions, /context canonical/u);
  assert.match(recovery.completedWork, /bundle layout/u);
  assert.match(recovery.currentWork, /recovery output/u);
  assert.match(recovery.currentLocalDiffSummary, /Changed-file count: 1/u);
  assert.doesNotMatch(recovery.currentLocalDiffSummary, /sample\.txt/u);
  assert.match(recovery.checks, /FAIL/u);
  assert.match(recovery.failures, /needs a retry/u);
  assert.match(recovery.unresolvedQuestions, /retry scope/u);
  assert.match(recovery.failuresAndUnresolvedQuestions, /Unresolved questions/u);
  assert.equal(recovery.exactRecommendedNextStep, recovery.nextAction);
  assert.equal(recovery.reconciliation.status, "stale-but-reconcilable");
});

test("legacy migration creates a bundle without deleting or silently replacing the source", async (t) => {
  const fixture = await createGitRepository(t);
  const sourceHome = await temporaryDirectory(t, "justin-stack-source-");
  const sourceStore = createStore(sourceHome);
  const source = await sourceStore.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const legacySource = asLegacyV1(serializeCheckpoint(source.checkpoint), fixture.root);

  const destinationHome = await temporaryDirectory(t, "justin-stack-migration-");
  const store = createStore(destinationHome);
  const legacyPath = store.legacyPathFor(IDENTITY);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, legacySource, "utf8");
  assert.equal((await store.listLegacy(fixture.root)).length, 1);
  assert.equal((await store.list(fixture.root)).length, 0);

  const migrated = await store.migrateLegacy(IDENTITY, fixture.root);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.checkpoint.metadata.schema_version, 2);
  assert.equal(migrated.checkpoint.metadata.repository_id, repositoryIdentity(fixture.root));
  assert.equal(await readFile(legacyPath, "utf8"), legacySource);
  assert.doesNotMatch(await readFile(migrated.checkpointPath, "utf8"), /repository_path|changed_file_summary|untracked_files/u);
  assert.deepEqual((await readdir(store.bundlePathsFor(IDENTITY).directory)).sort(), [...CONTINUITY_BUNDLE_FILES].sort());
  assert.equal((await store.migrateLegacy(IDENTITY, fixture.root)).changed, false);

  const legacyCheckpoint = parseCheckpoint(legacySource);
  const changedLegacy = {
    ...legacyCheckpoint,
    body: replaceSection(legacyCheckpoint.body, "Objective", "A conflicting legacy objective."),
  };
  await writeFile(legacyPath, serializeCheckpoint(changedLegacy), "utf8");
  await assert.rejects(store.migrateLegacy(IDENTITY, fixture.root), /differ; refusing/u);
});

test("checkpoint bundles persist repository identity and Git summaries without paths or file names", async (t) => {
  const fixture = await createGitRepository(t, { initialFile: "sensitive-client-plan.txt" });
  await writeFile(fixture.file, "locally changed fixture content\n", "utf8");
  const home = await temporaryDirectory(t, "justin-stack-private-state-");
  const store = createStore(home);
  const created = await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const paths = store.bundlePathsFor(IDENTITY);
  const rawRepositoryPath = path.resolve(fixture.root);
  const jsonEscapedRepositoryPath = JSON.stringify(rawRepositoryPath).slice(1, -1);

  assert.equal(created.checkpoint.metadata.repository_id, repositoryIdentity(fixture.root));
  assert.equal(created.checkpoint.metadata.repository_id.length, 64);
  assert.equal("repository_path" in created.checkpoint.metadata, false);
  assert.equal("changed_file_summary" in created.checkpoint.metadata, false);
  assert.equal("untracked_files" in created.checkpoint.metadata, false);

  for (const fileName of CONTINUITY_BUNDLE_FILES) {
    const source = await readFile(path.join(paths.directory, fileName), "utf8");
    assert.equal(source.includes(rawRepositoryPath), false, fileName);
    assert.equal(source.includes(jsonEscapedRepositoryPath), false, fileName);
    assert.doesNotMatch(source, /sensitive-client-plan\.txt/u, fileName);
  }

  const recovery = await store.recovery(IDENTITY, fixture.root);
  assert.match(recovery.currentLocalDiffSummary, /Changed-file count: 1/u);
  assert.doesNotMatch(recovery.currentLocalDiffSummary, /sensitive-client-plan\.txt/u);
});

test("explicit story identity is enforced on every canonical read and mutation path", async (t) => {
  const fixture = await createGitRepository(t);
  const home = await temporaryDirectory(t, "justin-stack-identity-");
  const store = createStore(home);
  const firstIdentity = { projectSlug: "sample-project", ticketKey: "DEMO-101" } as const;
  const secondIdentity = { projectSlug: "sample-project", ticketKey: "DEMO-202" } as const;
  const first = await store.create({ ...firstIdentity, repositoryPath: fixture.root, baseBranch: "main" });
  const second = await store.create({ ...secondIdentity, repositoryPath: fixture.root, baseBranch: "main" });
  const secondCheckpoint = await store.load(secondIdentity);

  const legacyPath = store.legacyPathFor(firstIdentity);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, await readFile(first.checkpointPath, "utf8"), "utf8");

  const firstPaths = store.bundlePathsFor(firstIdentity);
  const secondPaths = store.bundlePathsFor(secondIdentity);
  for (const fileName of CONTINUITY_BUNDLE_FILES) {
    await copyFile(path.join(secondPaths.directory, fileName), path.join(firstPaths.directory, fileName));
  }
  const preserved = new Map<string, string>();
  for (const [label, paths] of [["first", firstPaths], ["second", secondPaths]] as const) {
    for (const fileName of CONTINUITY_BUNDLE_FILES) {
      preserved.set(`${label}/${fileName}`, await readFile(path.join(paths.directory, fileName), "utf8"));
    }
  }

  const operations: readonly [string, () => Promise<unknown>][] = [
    ["load", () => store.load(firstIdentity)],
    ["bundle health", () => store.bundleHealth(firstIdentity)],
    ["recovery", () => store.recovery(firstIdentity, fixture.root)],
    ["create", () => store.create({ ...firstIdentity, repositoryPath: fixture.root, baseBranch: "main" })],
    ["snapshot", () => store.snapshot(firstIdentity, fixture.root)],
    ["update", () => store.update({ ...firstIdentity, repositoryPath: fixture.root, body: secondCheckpoint.body })],
    ["approve plan", () => store.approvePlan({ ...firstIdentity, repositoryPath: fixture.root, body: secondCheckpoint.body })],
    ["complete", () => store.complete(firstIdentity, fixture.root)],
    ["legacy migration", () => store.migrateLegacy(firstIdentity, fixture.root)],
  ];
  for (const [label, operation] of operations) {
    await assert.rejects(operation(), /identity does not match its state directory/u, label);
  }

  const validation = await store.validate(firstIdentity, fixture.root);
  assert.equal(validation.status, "missing-required-information");
  assert.match(validation.reasons.join(" "), /identity does not match its state directory/u);

  for (const [label, paths] of [["first", firstPaths], ["second", secondPaths]] as const) {
    for (const fileName of CONTINUITY_BUNDLE_FILES) {
      assert.equal(
        await readFile(path.join(paths.directory, fileName), "utf8"),
        preserved.get(`${label}/${fileName}`),
        `${label}/${fileName}`,
      );
    }
  }
});

test("state roots inside the active repository are rejected before checkpoint writes", async (t) => {
  const fixture = await createGitRepository(t);
  const outside = await temporaryDirectory(t, "justin-stack-safe-root-");
  const unsafeWorkspacesRoot = path.join(fixture.root, ".justin-stack-state");
  const unsafeLegacyRoot = path.join(fixture.root, ".legacy-state");
  const canonicalStore = new CheckpointStore({
    justinStackHome: outside,
    workspacesRoot: unsafeWorkspacesRoot,
    legacyStateRoot: path.join(outside, "legacy"),
    packageRoot: PACKAGE_ROOT,
  });

  await assert.rejects(
    canonicalStore.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" }),
    /state root must be outside the active repository/u,
  );
  await assert.rejects(stat(unsafeWorkspacesRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const validation = await canonicalStore.validate(IDENTITY, fixture.root);
  assert.equal(validation.status, "missing-required-information");

  const legacyStore = new CheckpointStore({
    justinStackHome: outside,
    workspacesRoot: path.join(outside, "workspaces"),
    legacyStateRoot: unsafeLegacyRoot,
    packageRoot: PACKAGE_ROOT,
  });
  await assert.rejects(
    legacyStore.migrateLegacy(IDENTITY, fixture.root),
    /state root must be outside the active repository/u,
  );
  await assert.rejects(stat(unsafeLegacyRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("concurrent stale-lock reclaimers cannot remove a newly elected writer lease", async (t) => {
  const fixture = await createGitRepository(t);
  const home = await temporaryDirectory(t, "justin-stack-lock-election-");
  const store = createStore(home);
  await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const paths = store.bundlePathsFor(IDENTITY);

  await unlink(paths.handoff);
  await writeFile(
    paths.lock,
    `${JSON.stringify({ pid: 2_147_483_647, created_at: "2000-01-01T00:00:00.000Z" })}\n`,
    "utf8",
  );
  const attempts = await Promise.allSettled(
    Array.from({ length: 4 }, async () => store.snapshot(IDENTITY, fixture.root)),
  );
  assert.ok(attempts.some((attempt) => attempt.status === "fulfilled"));
  assert.ok(attempts.some((attempt) => attempt.status === "rejected"));
  for (const attempt of attempts) {
    if (attempt.status === "rejected") assert.match(String(attempt.reason), /lock|changed during the update/u);
  }

  assert.equal((await store.bundleHealth(IDENTITY)).status, "current");
  const lockPrefix = path.basename(paths.lock);
  assert.deepEqual(
    (await readdir(path.dirname(paths.lock))).filter((name) => name.startsWith(lockPrefix)),
    [],
  );
});

test("aged malformed choosing and ticket artifacts are reclaimed without deleting fresh contenders", async (t) => {
  const fixture = await createGitRepository(t);
  const home = await temporaryDirectory(t, "justin-stack-malformed-lock-");
  const store = createStore(home);
  await store.create({ ...IDENTITY, repositoryPath: fixture.root, baseBranch: "main" });
  const paths = store.bundlePathsFor(IDENTITY);
  const token = "11111111-1111-4111-8111-111111111111";
  const choosing = `${paths.lock}.choosing.${token}`;
  const ticket = `${paths.lock}.ticket.1.${token}`;

  await unlink(paths.handoff);
  await writeFile(choosing, "", "utf8");
  await assert.rejects(store.snapshot(IDENTITY, fixture.root), /lock election did not settle/u);
  assert.equal((await stat(choosing)).isFile(), true);

  const old = new Date("2000-01-01T00:00:00.000Z");
  await utimes(choosing, old, old);
  await store.snapshot(IDENTITY, fixture.root);
  await assert.rejects(stat(choosing), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  await unlink(paths.handoff);
  await writeFile(ticket, "not-json", "utf8");
  await utimes(ticket, old, old);
  await store.snapshot(IDENTITY, fixture.root);
  await assert.rejects(stat(ticket), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal((await store.bundleHealth(IDENTITY)).status, "current");
});
