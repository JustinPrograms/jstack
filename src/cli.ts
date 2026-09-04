#!/usr/bin/env node
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CheckpointStore,
  assertTicketStatus,
  defaultLegacyStateRoot,
  defaultStoryStackHome,
} from "./checkpoint/store.js";
import { REQUIRED_SECTIONS } from "./checkpoint/schema.js";
import { packageRootFromModule } from "./checkpoint/template.js";
import { serializeCheckpoint } from "./checkpoint/frontmatter.js";
import { StoryStackError, errorMessage } from "./errors.js";
import {
  applyInstall,
  applyUninstall,
  formatInstallPlan,
  formatUninstallPlan,
  inspectPlatformInstallations,
  planInstall,
  planUninstall,
} from "./installer.js";
import { parseInstallScope, parsePlatformTarget, type InstallScope, type TargetSelection } from "../adapters/registry.js";
import { classifyCommand, hookCommandFromPayload } from "./safety.js";

const execFileAsync = promisify(execFile);
const BOOLEAN_OPTIONS = new Set([
  "json",
  "dry-run",
  "apply",
  "mark-validated",
  "allow-approval-change",
  "confirm-user-approved",
  "explicitly-requested",
  "permanent-only",
  "help",
]);

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string | true>;
}

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface CliContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  packageRoot?: string;
}

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const key = argument.slice(2, equals < 0 ? undefined : equals);
    if (key.length === 0 || options.has(key)) {
      throw new StoryStackError(`Invalid or duplicate option '${argument}'`, "INVALID_ARGUMENTS");
    }
    if (equals >= 0) {
      if (BOOLEAN_OPTIONS.has(key)) {
        throw new StoryStackError(`Boolean option --${key} does not accept a value`, "INVALID_ARGUMENTS");
      }
      const value = argument.slice(equals + 1);
      if (value.length === 0) throw new StoryStackError(`Option --${key} needs a value`, "INVALID_ARGUMENTS");
      options.set(key, value);
    } else if (BOOLEAN_OPTIONS.has(key)) {
      options.set(key, true);
    } else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new StoryStackError(`Option --${key} needs a value`, "INVALID_ARGUMENTS");
      }
      options.set(key, value);
      index += 1;
    }
  }
  return { positionals, options };
}

function assertAllowedOptions(parsed: ParsedArguments, allowed: readonly string[]): void {
  const accepted = new Set([...allowed, "json", "help"]);
  const unknown = [...parsed.options.keys()].filter((key) => !accepted.has(key));
  if (unknown.length > 0) throw new StoryStackError(`Unknown option(s): ${unknown.map((item) => `--${item}`).join(", ")}`, "INVALID_ARGUMENTS");
}

function stringOption(parsed: ParsedArguments, key: string): string | undefined {
  const value = parsed.options.get(key);
  if (value === true) throw new StoryStackError(`Option --${key} needs a value`, "INVALID_ARGUMENTS");
  return value;
}

function flag(parsed: ParsedArguments, key: string): boolean {
  return parsed.options.get(key) === true;
}

function emit(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? JSON.stringify(value, null, 2) : human);
}

function safeDisplay(value: string): string {
  return value.replace(/[\0-\x1f\x7f]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function aliasedStringOption(parsed: ParsedArguments, preferred: string, legacy: string): string | undefined {
  const preferredValue = stringOption(parsed, preferred);
  const legacyValue = stringOption(parsed, legacy);
  if (preferredValue !== undefined && legacyValue !== undefined && preferredValue !== legacyValue) {
    throw new StoryStackError(`--${preferred} and --${legacy} disagree`, "INVALID_ARGUMENTS");
  }
  return preferredValue ?? legacyValue;
}

function targetAndScope(parsed: ParsedArguments): { target: TargetSelection; scope: InstallScope } {
  try {
    return {
      target: parsePlatformTarget(stringOption(parsed, "target") ?? "claude"),
      scope: parseInstallScope(stringOption(parsed, "scope") ?? "global"),
    };
  } catch (error) {
    throw new StoryStackError(errorMessage(error), "INVALID_ARGUMENTS");
  }
}

function installerEnvironmentOptions(
  parsed: ParsedArguments,
  context: Required<Pick<CliContext, "cwd" | "env" | "packageRoot">>,
) {
  const { target, scope } = targetAndScope(parsed);
  const justinStackHome = defaultStoryStackHome(context.env);
  const projectRoot = path.resolve(stringOption(parsed, "project-root") ?? context.cwd);
  const skillRoots = {
    ...(context.env.JUSTINSTACK_CLAUDE_SKILLS_HOME || context.env.STORY_STACK_SKILLS_HOME
      ? { claude: path.resolve(context.env.JUSTINSTACK_CLAUDE_SKILLS_HOME ?? context.env.STORY_STACK_SKILLS_HOME ?? "") }
      : {}),
    ...(context.env.JUSTINSTACK_BOB_SKILLS_HOME
      ? { bob: path.resolve(context.env.JUSTINSTACK_BOB_SKILLS_HOME) }
      : {}),
    ...(context.env.JUSTINSTACK_CODEX_SKILLS_HOME
      ? { codex: path.resolve(context.env.JUSTINSTACK_CODEX_SKILLS_HOME) }
      : {}),
  };
  return {
    packageRoot: context.packageRoot,
    userHome: path.resolve(context.env.JUSTINSTACK_USER_HOME ?? os.homedir()),
    justinStackHome,
    target,
    scope,
    projectRoot,
    skillRoots,
  };
}

function statusExitCode(status: string): number {
  if (status === "current") return 0;
  if (status === "stale-but-reconcilable") return 2;
  if (status === "different-branch") return 3;
  return 4;
}

function usage(): string {
  return [
    "justinstack <command>",
    "",
    "Commands:",
    "  doctor --target <claude|bob|codex|all> --scope <project|global>",
    "  state init --workspace <slug> --story <KEY> [--repo <path>] [--base-branch <name>] [--objective <text>]",
    "  state path|show|validate|snapshot|bundle-status|repair|recovery|complete [--workspace <slug> --story <KEY>] [--repo <path>]",
    "  state migrate --workspace <slug> --story <KEY>",
    "  state update [identity] [--repo <path>] --body-file <path> [--section <heading>] [--status <status>]",
    "  state approve-plan [identity] [--repo <path>] --body-file <path> --confirm-user-approved",
    "  state list [--repo <path>]",
    "  install --target <claude|bob|codex|all> --scope <project|global> [--apply]",
    "  uninstall --target <claude|bob|codex|all> --scope <project|global> [--apply]",
    "  safety check --command <proposed-command>",
    "",
    "All commands accept --json. Install and uninstall are dry-run unless --apply is explicit.",
    "--project/--ticket and the story-stack executable remain deprecated compatibility aliases.",
  ].join("\n");
}

async function nearestWritableAncestor(target: string): Promise<string | null> {
  let cursor = path.resolve(target);
  for (;;) {
    try {
      await access(cursor, constants.W_OK);
      return cursor;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "EACCES" || code === "EPERM") return null;
      if (code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

async function findCheckpointLocks(storyHome: string): Promise<string[]> {
  const stateRoot = path.join(storyHome, "workspaces");
  const locks: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath, depth + 1);
      else if (entry.isFile() && /^\.[A-Z][A-Z0-9-]+\.lock$/u.test(entry.name)) locks.push(entryPath);
    }
  }
  try {
    await visit(stateRoot, 0);
  } catch {
    return ["Workspace directory could not be inspected for locks."];
  }
  return locks;
}

async function runDoctor(
  parsed: ParsedArguments,
  context: Required<Pick<CliContext, "cwd" | "env" | "io" | "packageRoot">>,
): Promise<number> {
  assertAllowedOptions(parsed, ["target", "scope", "project-root"]);
  if (parsed.positionals.length !== 1) throw new StoryStackError("doctor accepts no positional arguments", "INVALID_ARGUMENTS");
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  let gitVersion: string | null = null;
  try {
    const result = await execFileAsync("git", ["--version"], { encoding: "utf8", windowsHide: true });
    gitVersion = result.stdout.trim();
  } catch {
    gitVersion = null;
  }
  const storyHome = defaultStoryStackHome(context.env);
  const writableAncestor = await nearestWritableAncestor(storyHome);
  const templatePath = path.join(context.packageRoot, "templates", "context.v1.md");
  let templateAvailable = true;
  try {
    await access(templatePath, constants.R_OK);
  } catch {
    templateAvailable = false;
  }
  const checkpointLocks = await findCheckpointLocks(storyHome);
  const platforms = await inspectPlatformInstallations(installerEnvironmentOptions(parsed, context));
  const checks = {
    node: { ok: major >= 20, version: process.versions.node, required: ">=20" },
    git: { ok: gitVersion !== null, version: gitVersion },
    checkpointTemplate: { ok: templateAvailable, path: templatePath },
    storyHome: { ok: writableAncestor !== null, path: storyHome, writableAncestor },
    checkpointLocks: { ok: checkpointLocks.length === 0, count: checkpointLocks.length, paths: checkpointLocks },
    platforms,
    networkChecksPerformed: false,
  };
  const ok = major >= 20 && gitVersion !== null && templateAvailable && writableAncestor !== null &&
    checkpointLocks.length === 0 && platforms.every((platform) => platform.ok);
  const human = [
    `Node ${checks.node.ok ? "OK" : "FAIL"}: ${checks.node.version} (requires ${checks.node.required})`,
    `Git ${checks.git.ok ? "OK" : "FAIL"}: ${checks.git.version ?? "not found"}`,
    `Checkpoint template ${checks.checkpointTemplate.ok ? "OK" : "FAIL"}: ${checks.checkpointTemplate.path}`,
    `Story home ${checks.storyHome.ok ? "OK" : "FAIL"}: ${checks.storyHome.path}`,
    `Checkpoint locks ${checks.checkpointLocks.ok ? "OK" : "CHECK"}: ${checks.checkpointLocks.count}`,
    ...platforms.flatMap((platform) => [
      `${platform.displayName} ${platform.ok ? "OK" : "MISSING/STALE"}: ${platform.skillsRoot}`,
      `  installed=${platform.installed.length} missing=${platform.missing.length} stale=${platform.stale.length} obsolete=${platform.obsolete.length}`,
      ...platform.reminders.map((reminder) => `  ${reminder.level.toUpperCase()}: ${reminder.message}`),
      ...platform.configurationProposals.map((proposal) => `  PROPOSE ONLY ${proposal.kind}: ${proposal.targetPath}`),
    ]),
    "Network checks: none",
  ].join("\n");
  emit(context.io, flag(parsed, "json"), { ok, checks }, human);
  return ok ? 0 : 1;
}

async function resolveIdentity(
  store: CheckpointStore,
  parsed: ParsedArguments,
  repositoryPath: string,
) {
  return store.resolveIdentity(
    aliasedStringOption(parsed, "workspace", "project"),
    aliasedStringOption(parsed, "story", "ticket"),
    repositoryPath,
  );
}

async function runState(
  parsed: ParsedArguments,
  context: Required<Pick<CliContext, "cwd" | "env" | "io" | "packageRoot">>,
): Promise<number> {
  const action = parsed.positionals[1];
  if (!action || action === "help" || flag(parsed, "help")) {
    context.io.stdout(usage());
    return action ? 0 : 1;
  }
  if (parsed.positionals.length > 2) throw new StoryStackError("Too many positional arguments", "INVALID_ARGUMENTS");
  const knownActions = new Set(["init", "list", "path", "show", "validate", "snapshot", "bundle-status", "repair", "migrate", "update", "approve-plan", "complete", "recovery"]);
  if (!knownActions.has(action)) throw new StoryStackError(`Unknown state command '${action}'`, "INVALID_ARGUMENTS");
  const store = new CheckpointStore({
    storyStackHome: defaultStoryStackHome(context.env),
    legacyStateRoot: defaultLegacyStateRoot(context.env),
    packageRoot: context.packageRoot,
  });
  const repositoryPath = path.resolve(stringOption(parsed, "repo") ?? context.cwd);
  const wantsJson = flag(parsed, "json");

  if (action === "init") {
    assertAllowedOptions(parsed, ["workspace", "story", "project", "ticket", "repo", "base-branch", "objective"]);
    const project = aliasedStringOption(parsed, "workspace", "project");
    const ticket = aliasedStringOption(parsed, "story", "ticket");
    if (!project || !ticket) throw new StoryStackError("state init requires --workspace and --story", "INVALID_ARGUMENTS");
    const identity = store.normalizeIdentity(project, ticket);
    const baseBranch = stringOption(parsed, "base-branch");
    const objective = stringOption(parsed, "objective");
    const result = await store.create({
      ...identity,
      repositoryPath,
      ...(baseBranch === undefined ? {} : { baseBranch }),
      ...(objective === undefined ? {} : { objective }),
    });
    const existingValidation = result.changed ? null : await store.validate(identity, repositoryPath);
    emit(
      context.io,
      wantsJson,
      {
        ok: existingValidation === null || existingValidation.status === "current",
        created: result.changed,
        path: result.checkpointPath,
        metadata: result.checkpoint.metadata,
        ...(existingValidation === null ? {} : { reconciliation: existingValidation }),
      },
      `${result.changed ? "Created" : `Preserved existing (${existingValidation?.status ?? "unknown"})`} checkpoint: ${result.checkpointPath}`,
    );
    return existingValidation === null ? 0 : statusExitCode(existingValidation.status);
  }

  if (action === "list") {
    assertAllowedOptions(parsed, ["repo"]);
    const repoWasSupplied = stringOption(parsed, "repo") !== undefined;
    const repositoryFilter = repoWasSupplied ? repositoryPath : undefined;
    const current = await store.list(repositoryFilter);
    const legacy = await store.listLegacy(repositoryFilter);
    const payload = [
      ...current.map((item) => ({ ...item, layout: "bundle" as const })),
      ...legacy.map((item) => ({ ...item, layout: "legacy" as const })),
    ].map((item) => ({
      path: item.checkpointPath,
      layout: item.layout,
      ...(item.metadata
        ? {
            project: item.metadata.project_slug,
            ticket: item.metadata.ticket_key,
            repository: item.metadata.repository_path,
            branch: item.metadata.current_branch,
            status: item.metadata.ticket_status,
            updatedAt: item.metadata.updated_at,
          }
        : { error: item.error }),
    }));
    const human = payload.length === 0
      ? "No matching checkpoints."
      : payload
          .map((item) =>
            "error" in item
              ? `INVALID ${safeDisplay(item.path)}: ${safeDisplay(item.error ?? "unknown error")}`
              : `${item.project}/${item.ticket} [${item.status}; ${item.layout}] ${safeDisplay(item.path)}`,
          )
          .join("\n");
    emit(context.io, wantsJson, { ok: true, checkpoints: payload }, human);
    return 0;
  }

  const actionOptions: Readonly<Record<string, readonly string[]>> = {
    path: ["workspace", "story", "project", "ticket", "repo"],
    show: ["workspace", "story", "project", "ticket", "repo"],
    validate: ["workspace", "story", "project", "ticket", "repo"],
    snapshot: ["workspace", "story", "project", "ticket", "repo", "mark-validated"],
    "bundle-status": ["workspace", "story", "project", "ticket", "repo"],
    repair: ["workspace", "story", "project", "ticket", "repo"],
    migrate: ["workspace", "story", "project", "ticket", "repo"],
    update: [
      "project",
      "ticket",
      "workspace",
      "story",
      "repo",
      "body-file",
      "section",
      "status",
      "mark-validated",
      "allow-approval-change",
    ],
    "approve-plan": ["workspace", "story", "project", "ticket", "repo", "body-file", "confirm-user-approved"],
    complete: ["workspace", "story", "project", "ticket", "repo"],
    recovery: ["workspace", "story", "project", "ticket", "repo"],
  };
  assertAllowedOptions(parsed, actionOptions[action] ?? []);
  let identity;
  if (action === "migrate") {
    const workspace = aliasedStringOption(parsed, "workspace", "project");
    const story = aliasedStringOption(parsed, "story", "ticket");
    if ((workspace === undefined) !== (story === undefined)) {
      throw new StoryStackError("Provide both --workspace and --story, or neither", "INCOMPLETE_IDENTITY");
    }
    if (workspace !== undefined && story !== undefined) {
      identity = store.normalizeIdentity(workspace, story);
    } else {
      const matches = (await store.listLegacy(repositoryPath)).filter((item) => item.metadata !== undefined);
      if (matches.length !== 1) {
        throw new StoryStackError(
          matches.length === 0
            ? "No legacy checkpoint matches the active repository"
            : "Legacy checkpoint is ambiguous; specify --workspace and --story",
          matches.length === 0 ? "CHECKPOINT_NOT_FOUND" : "AMBIGUOUS_TICKET",
          4,
        );
      }
      const metadata = matches[0]?.metadata;
      if (!metadata) throw new StoryStackError("Matching legacy checkpoint is invalid", "INVALID_CHECKPOINT", 4);
      identity = { projectSlug: metadata.project_slug, ticketKey: metadata.ticket_key };
    }
  } else {
    identity = await resolveIdentity(store, parsed, repositoryPath);
  }

  if (action === "path") {
    const checkpoint = store.pathFor(identity);
    emit(context.io, wantsJson, { ok: true, path: checkpoint }, checkpoint);
    return 0;
  }
  if (action === "show") {
    const checkpointPath = store.pathFor(identity);
    const checkpoint = await store.load(identity);
    emit(
      context.io,
      wantsJson,
      { ok: true, path: checkpointPath, checkpoint },
      serializeCheckpoint(checkpoint).trimEnd(),
    );
    return 0;
  }
  if (action === "validate") {
    const result = await store.validate(identity, repositoryPath);
    const human = [
      `Checkpoint: ${result.status}`,
      `Validation freshness: ${result.validationIsCurrent ? "current" : "historical or not recorded"}`,
      ...result.reasons.map((reason) => `- ${safeDisplay(reason)}`),
    ].join("\n");
    emit(context.io, wantsJson, { ok: result.status === "current", ...result }, human);
    return statusExitCode(result.status);
  }
  if (action === "bundle-status") {
    const health = await store.bundleHealth(identity);
    emit(
      context.io,
      wantsJson,
      { ok: health.status === "current", ...health },
      [`Continuity bundle: ${health.status}`, ...health.reasons.map((reason) => `- ${safeDisplay(reason)}`)].join("\n"),
    );
    return health.status === "current" ? 0 : health.status === "repairable" ? 2 : 4;
  }
  if (action === "repair") {
    const result = await store.snapshot(identity, repositoryPath);
    const repairedFiles = result.repairedFiles ?? [];
    emit(
      context.io,
      wantsJson,
      { ok: true, changed: result.changed, repairedFiles, path: result.checkpointPath },
      repairedFiles.length === 0
        ? `Continuity bundle already current: ${result.checkpointPath}`
        : `Repaired continuity projections: ${repairedFiles.join(", ")}`,
    );
    return 0;
  }
  if (action === "migrate") {
    const result = await store.migrateLegacy(identity);
    emit(
      context.io,
      wantsJson,
      { ok: true, migrated: result.changed, path: result.checkpointPath, repairedFiles: result.repairedFiles ?? [] },
      `${result.changed ? "Migrated" : "Preserved matching"} legacy checkpoint at ${result.checkpointPath}; source retained.`,
    );
    return 0;
  }
  if (action === "snapshot") {
    const result = await store.snapshot(identity, repositoryPath, { markValidated: flag(parsed, "mark-validated") });
    emit(
      context.io,
      wantsJson,
      { ok: true, changed: result.changed, path: result.checkpointPath, metadata: result.checkpoint.metadata },
      `${result.changed ? "Refreshed" : "No meaningful change to"} checkpoint: ${result.checkpointPath}`,
    );
    return 0;
  }
  if (action === "update") {
    const bodyFile = stringOption(parsed, "body-file");
    if (!bodyFile) throw new StoryStackError("state update requires --body-file", "INVALID_ARGUMENTS");
    const sectionInput = stringOption(parsed, "section");
    let section: (typeof REQUIRED_SECTIONS)[number] | undefined;
    if (sectionInput !== undefined) {
      if (!REQUIRED_SECTIONS.includes(sectionInput as (typeof REQUIRED_SECTIONS)[number])) {
        throw new StoryStackError(`Unknown checkpoint section '${sectionInput}'`, "INVALID_ARGUMENTS");
      }
      section = sectionInput as (typeof REQUIRED_SECTIONS)[number];
    }
    const status = stringOption(parsed, "status");
    if (status !== undefined) assertTicketStatus(status);
    const body = await readFile(path.resolve(bodyFile), "utf8");
    const result = await store.update({
      ...identity,
      repositoryPath,
      body,
      ...(section === undefined ? {} : { section }),
      ...(status === undefined ? {} : { status }),
      markValidated: flag(parsed, "mark-validated"),
      allowApprovalChange: flag(parsed, "allow-approval-change"),
    });
    emit(
      context.io,
      wantsJson,
      { ok: true, changed: result.changed, path: result.checkpointPath, metadata: result.checkpoint.metadata },
      `${result.changed ? "Updated" : "No meaningful change to"} checkpoint: ${result.checkpointPath}`,
    );
    return 0;
  }
  if (action === "approve-plan") {
    if (!flag(parsed, "confirm-user-approved")) {
      throw new StoryStackError(
        "state approve-plan requires --confirm-user-approved after the user explicitly approves the reviewed plan",
        "PLAN_APPROVAL_REQUIRED",
      );
    }
    const bodyFile = stringOption(parsed, "body-file");
    if (!bodyFile) throw new StoryStackError("state approve-plan requires --body-file", "INVALID_ARGUMENTS");
    const body = await readFile(path.resolve(bodyFile), "utf8");
    const result = await store.approvePlan({ ...identity, repositoryPath, body });
    emit(
      context.io,
      wantsJson,
      { ok: true, changed: result.changed, path: result.checkpointPath, metadata: result.checkpoint.metadata },
      `${result.changed ? "Approved plan and marked ready" : "Plan already approved"}: ${result.checkpointPath}`,
    );
    return 0;
  }
  if (action === "complete") {
    const result = await store.complete(identity, repositoryPath);
    emit(
      context.io,
      wantsJson,
      { ok: true, changed: result.changed, path: result.checkpointPath, metadata: result.checkpoint.metadata },
      `${result.changed ? "Completed" : "Already completed"}: ${result.checkpointPath}`,
    );
    return 0;
  }
  if (action === "recovery") {
    const summary = await store.recovery(identity, repositoryPath);
    const human = [
      `Objective: ${summary.objective}`,
      `Acceptance criteria: ${summary.acceptanceCriteria}`,
      `Non-goals: ${summary.nonGoals}`,
      `Relevant files: ${summary.relevantFiles}`,
      `Decisions: ${summary.decisions}`,
      `Completed work: ${summary.completedWork}`,
      `Current work: ${summary.currentWork}`,
      `Current state: ${summary.currentState}`,
      `Current local diff: ${summary.currentLocalDiffSummary}`,
      `Tests and checks: ${summary.checks}`,
      `Failures and unresolved questions: ${summary.failuresAndUnresolvedQuestions}`,
      `Next action: ${summary.exactRecommendedNextStep}`,
      `Blockers: ${summary.blockers}`,
      `Required approval: ${summary.requiredApproval}`,
      `Last successful validation: ${summary.lastSuccessfulValidation}`,
    ].join("\n");
    emit(context.io, wantsJson, { ok: summary.reconciliation.status === "current", ...summary }, human);
    return statusExitCode(summary.reconciliation.status);
  }
  throw new StoryStackError(`Unknown state command '${action}'`, "INVALID_ARGUMENTS");
}

async function runInstallerCommand(
  command: "install" | "uninstall",
  parsed: ParsedArguments,
  context: Required<Pick<CliContext, "cwd" | "env" | "io" | "packageRoot">>,
): Promise<number> {
  assertAllowedOptions(parsed, ["dry-run", "apply", "confirm-overwrite", "target", "scope", "project-root"]);
  if (parsed.positionals.length !== 1) {
    throw new StoryStackError(`${command} accepts no positional arguments`, "INVALID_ARGUMENTS");
  }
  if (flag(parsed, "dry-run") && flag(parsed, "apply")) {
    throw new StoryStackError("Choose either --dry-run or --apply", "INVALID_ARGUMENTS");
  }
  const apply = flag(parsed, "apply");
  const wantsJson = flag(parsed, "json");
  const installerOptions = installerEnvironmentOptions(parsed, context);
  if (command === "install") {
    const confirmation = stringOption(parsed, "confirm-overwrite");
    if (confirmation !== undefined && confirmation !== "JUSTINSTACK" && confirmation !== "STORY-STACK") {
      throw new StoryStackError("Overwrite confirmation must be exactly JUSTINSTACK", "INVALID_ARGUMENTS");
    }
    const plan = await planInstall(installerOptions);
    if (!apply) {
      const ready = plan.collisions.length === 0 && plan.safetyIssues.length === 0;
      emit(context.io, wantsJson, { ok: ready, dryRun: true, plan }, formatInstallPlan(plan));
      return ready ? 0 : 1;
    }
    context.io.stdout(
      wantsJson
        ? JSON.stringify({ ok: plan.safetyIssues.length === 0, phase: "preflight", dryRun: false, plan })
        : formatInstallPlan(plan).replace("(dry-run; no files written)", "(preflight; writing follows)"),
    );
    const result = await applyInstall(plan, { confirmOverwrite: confirmation === "JUSTINSTACK" || confirmation === "STORY-STACK" });
    emit(
      context.io,
      wantsJson,
      { ok: true, dryRun: false, result },
      `Wrote ${result.written.length} files; removed ${result.removed.length} obsolete files; preserved ${result.preserved.length}; ${result.unchanged.length} unchanged.\nManifest: ${result.manifestPath}\nAgent configuration modified: no`,
    );
    return 0;
  }
  if (stringOption(parsed, "confirm-overwrite") !== undefined) {
    throw new StoryStackError("--confirm-overwrite only applies to install", "INVALID_ARGUMENTS");
  }
  const plan = await planUninstall(installerOptions);
  if (!apply) {
    emit(context.io, wantsJson, { ok: plan.blocked.length === 0, dryRun: true, plan }, formatUninstallPlan(plan));
    return plan.blocked.length === 0 ? 0 : 1;
  }
  context.io.stdout(
    wantsJson
      ? JSON.stringify({ ok: plan.blocked.length === 0, phase: "preflight", dryRun: false, plan })
      : formatUninstallPlan(plan).replace("(dry-run; no files removed)", "(preflight; removal follows)"),
  );
  const result = await applyUninstall(plan);
  emit(context.io, wantsJson, { ok: result.blocked.length === 0, dryRun: false, result }, `Removed ${result.removed.length} files; preserved ${result.blocked.length}.`);
  return result.blocked.length === 0 ? 0 : 1;
}

async function runSafety(
  parsed: ParsedArguments,
  context: Required<Pick<CliContext, "io">>,
): Promise<number> {
  assertAllowedOptions(parsed, ["command", "explicitly-requested", "permanent-only"]);
  const action = parsed.positionals[1];
  if (parsed.positionals.length !== 2 || (action !== "check" && action !== "hook")) {
    throw new StoryStackError("Use: justinstack safety check --command <command>, or safety hook", "INVALID_ARGUMENTS");
  }
  let command = stringOption(parsed, "command");
  if (action === "hook") {
    if (command !== undefined) throw new StoryStackError("safety hook reads JSON from stdin", "INVALID_ARGUMENTS");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > 1024 * 1024) throw new StoryStackError("Hook input is too large", "INVALID_ARGUMENTS");
      chunks.push(buffer);
    }
    command = hookCommandFromPayload(Buffer.concat(chunks).toString("utf8")) ?? undefined;
    if (command === undefined) return 0;
  }
  if (!command) throw new StoryStackError("safety check requires --command", "INVALID_ARGUMENTS");
  const decision = classifyCommand(command);
  const explicitlyRequested = flag(parsed, "explicitly-requested");
  const allowed = decision.disposition === "allow" ||
    (decision.disposition === "require-explicit-request" && (explicitlyRequested || flag(parsed, "permanent-only")));
  const human = `${allowed ? "ALLOW" : "REFUSE"} [${decision.rule}]: ${decision.reason}`;
  if (action === "check") {
    emit(context.io, flag(parsed, "json"), { ok: allowed, command, explicitlyRequested, decision }, human);
  } else if (!allowed) {
    context.io.stderr(human);
  }
  if (allowed) return 0;
  if (action === "hook") return 2;
  return decision.disposition === "deny" ? 3 : 2;
}

export async function main(argv: readonly string[] = process.argv.slice(2), supplied: CliContext = {}): Promise<number> {
  const context = {
    cwd: supplied.cwd ?? process.cwd(),
    env: supplied.env ?? process.env,
    io: supplied.io ?? defaultIo,
    packageRoot: supplied.packageRoot ?? packageRootFromModule(),
  };
  let parsed: ParsedArguments | undefined;
  try {
    parsed = parseArguments(argv);
    const command = parsed.positionals[0];
    if (!command || command === "help" || flag(parsed, "help")) {
      context.io.stdout(usage());
      return command ? 0 : 1;
    }
    if (command === "doctor") return await runDoctor(parsed, context);
    if (command === "state") return await runState(parsed, context);
    if (command === "install" || command === "uninstall") return await runInstallerCommand(command, parsed, context);
    if (command === "safety") return await runSafety(parsed, context);
    throw new StoryStackError(`Unknown command '${command}'`, "INVALID_ARGUMENTS");
  } catch (error) {
    const storyError = error instanceof StoryStackError ? error : new StoryStackError(errorMessage(error), "UNEXPECTED_ERROR");
    const json = parsed ? flag(parsed, "json") : argv.includes("--json");
    context.io.stderr(
      json
        ? JSON.stringify({ ok: false, error: { code: storyError.code, message: storyError.message } }, null, 2)
        : `Error [${storyError.code}]: ${storyError.message}`,
    );
    return storyError.exitCode;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
