#!/usr/bin/env node
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CheckpointStore, assertTicketStatus, defaultStoryStackHome } from "./checkpoint/store.js";
import { REQUIRED_SECTIONS } from "./checkpoint/schema.js";
import { packageRootFromModule } from "./checkpoint/template.js";
import { serializeCheckpoint } from "./checkpoint/frontmatter.js";
import { StoryStackError, errorMessage } from "./errors.js";
import {
  applyInstall,
  applyUninstall,
  formatInstallPlan,
  formatUninstallPlan,
  planInstall,
  planUninstall,
} from "./installer.js";

const execFileAsync = promisify(execFile);
const BOOLEAN_OPTIONS = new Set([
  "json",
  "dry-run",
  "apply",
  "mark-validated",
  "allow-approval-change",
  "confirm-user-approved",
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

function statusExitCode(status: string): number {
  if (status === "current") return 0;
  if (status === "stale-but-reconcilable") return 2;
  if (status === "different-branch") return 3;
  return 4;
}

function usage(): string {
  return [
    "story-stack <command>",
    "",
    "Commands:",
    "  doctor",
    "  state init --project <slug> --ticket <KEY> [--repo <path>] [--base-branch <name>] [--objective <text>]",
    "  state path|show|validate|snapshot|recovery|complete [--project <slug> --ticket <KEY>] [--repo <path>]",
    "  state update [identity] [--repo <path>] --body-file <path> [--section <heading>] [--status <status>]",
    "  state approve-plan [identity] [--repo <path>] --body-file <path> --confirm-user-approved",
    "  state list [--repo <path>]",
    "  install [--dry-run] [--apply] [--confirm-overwrite STORY-STACK]",
    "  uninstall [--dry-run] [--apply]",
    "",
    "All commands accept --json. Install and uninstall are dry-run unless --apply is explicit.",
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
  const stateRoot = path.join(storyHome, "state");
  const locks: string[] = [];
  let projects;
  try {
    projects = await readdir(stateRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return ["State directory could not be inspected for locks."];
  }
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const projectPath = path.join(stateRoot, project.name);
    let tickets;
    try {
      tickets = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ticket of tickets.filter((entry) => entry.isDirectory())) {
      const lockPath = path.join(projectPath, ticket.name, "context.md.lock");
      try {
        await access(lockPath, constants.F_OK);
        locks.push(lockPath);
      } catch {
        // No lock for this checkpoint.
      }
    }
  }
  return locks;
}

async function runDoctor(
  parsed: ParsedArguments,
  context: Required<Pick<CliContext, "cwd" | "env" | "io" | "packageRoot">>,
): Promise<number> {
  assertAllowedOptions(parsed, []);
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
  const checks = {
    node: { ok: major >= 20, version: process.versions.node, required: ">=20" },
    git: { ok: gitVersion !== null, version: gitVersion },
    checkpointTemplate: { ok: templateAvailable, path: templatePath },
    storyHome: { ok: writableAncestor !== null, path: storyHome, writableAncestor },
    checkpointLocks: { ok: checkpointLocks.length === 0, count: checkpointLocks.length, paths: checkpointLocks },
    networkChecksPerformed: false,
  };
  const ok = Object.values(checks).every((item) => typeof item !== "object" || !("ok" in item) || item.ok);
  const human = [
    `Node ${checks.node.ok ? "OK" : "FAIL"}: ${checks.node.version} (requires ${checks.node.required})`,
    `Git ${checks.git.ok ? "OK" : "FAIL"}: ${checks.git.version ?? "not found"}`,
    `Checkpoint template ${checks.checkpointTemplate.ok ? "OK" : "FAIL"}: ${checks.checkpointTemplate.path}`,
    `Story home ${checks.storyHome.ok ? "OK" : "FAIL"}: ${checks.storyHome.path}`,
    `Checkpoint locks ${checks.checkpointLocks.ok ? "OK" : "CHECK"}: ${checks.checkpointLocks.count}`,
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
  return store.resolveIdentity(stringOption(parsed, "project"), stringOption(parsed, "ticket"), repositoryPath);
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
  const knownActions = new Set(["init", "list", "path", "show", "validate", "snapshot", "update", "approve-plan", "complete", "recovery"]);
  if (!knownActions.has(action)) throw new StoryStackError(`Unknown state command '${action}'`, "INVALID_ARGUMENTS");
  const store = new CheckpointStore({
    stateRoot: path.join(defaultStoryStackHome(context.env), "state"),
    packageRoot: context.packageRoot,
  });
  const repositoryPath = path.resolve(stringOption(parsed, "repo") ?? context.cwd);
  const wantsJson = flag(parsed, "json");

  if (action === "init") {
    assertAllowedOptions(parsed, ["project", "ticket", "repo", "base-branch", "objective"]);
    const project = stringOption(parsed, "project");
    const ticket = stringOption(parsed, "ticket");
    if (!project || !ticket) throw new StoryStackError("state init requires --project and --ticket", "INVALID_ARGUMENTS");
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
    const results = await store.list(repoWasSupplied ? repositoryPath : undefined);
    const payload = results.map((item) => ({
      path: item.checkpointPath,
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
              : `${item.project}/${item.ticket} [${item.status}] ${safeDisplay(item.path)}`,
          )
          .join("\n");
    emit(context.io, wantsJson, { ok: true, checkpoints: payload }, human);
    return 0;
  }

  const actionOptions: Readonly<Record<string, readonly string[]>> = {
    path: ["project", "ticket", "repo"],
    show: ["project", "ticket", "repo"],
    validate: ["project", "ticket", "repo"],
    snapshot: ["project", "ticket", "repo", "mark-validated"],
    update: [
      "project",
      "ticket",
      "repo",
      "body-file",
      "section",
      "status",
      "mark-validated",
      "allow-approval-change",
    ],
    "approve-plan": ["project", "ticket", "repo", "body-file", "confirm-user-approved"],
    complete: ["project", "ticket", "repo"],
    recovery: ["project", "ticket", "repo"],
  };
  assertAllowedOptions(parsed, actionOptions[action] ?? []);
  const identity = await resolveIdentity(store, parsed, repositoryPath);

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
      `Completed work: ${summary.completedWork}`,
      `Current state: ${summary.currentState}`,
      `Next action: ${summary.nextAction}`,
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
  context: Required<Pick<CliContext, "env" | "io" | "packageRoot">>,
): Promise<number> {
  assertAllowedOptions(parsed, ["dry-run", "apply", "confirm-overwrite"]);
  if (parsed.positionals.length !== 1) {
    throw new StoryStackError(`${command} accepts no positional arguments`, "INVALID_ARGUMENTS");
  }
  if (flag(parsed, "dry-run") && flag(parsed, "apply")) {
    throw new StoryStackError("Choose either --dry-run or --apply", "INVALID_ARGUMENTS");
  }
  const apply = flag(parsed, "apply");
  const wantsJson = flag(parsed, "json");
  const userHome = os.homedir();
  const installerOptions = {
    packageRoot: context.packageRoot,
    userHome,
    storyStackHome: defaultStoryStackHome(context.env),
    ...(context.env.STORY_STACK_SKILLS_HOME
      ? { claudeSkillsRoot: path.resolve(context.env.STORY_STACK_SKILLS_HOME) }
      : {}),
  };
  if (command === "install") {
    const confirmation = stringOption(parsed, "confirm-overwrite");
    if (confirmation !== undefined && confirmation !== "STORY-STACK") {
      throw new StoryStackError("Overwrite confirmation must be exactly STORY-STACK", "INVALID_ARGUMENTS");
    }
    const plan = await planInstall(installerOptions);
    if (!apply) {
      const ready = plan.collisions.length === 0 && plan.safetyIssues.length === 0;
      emit(context.io, wantsJson, { ok: ready, dryRun: true, plan }, formatInstallPlan(plan));
      return ready ? 0 : 1;
    }
    const result = await applyInstall(plan, { confirmOverwrite: confirmation === "STORY-STACK" });
    emit(context.io, wantsJson, { ok: true, dryRun: false, result }, `Installed ${result.written.length} files.\nManifest: ${result.manifestPath}`);
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
  const result = await applyUninstall(plan);
  emit(context.io, wantsJson, { ok: result.blocked.length === 0, dryRun: false, result }, `Removed ${result.removed.length} files; preserved ${result.blocked.length}.`);
  return result.blocked.length === 0 ? 0 : 1;
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
