import path from "node:path";
import { pathToFileURL } from "node:url";

export const PLATFORM_TARGETS = ["claude", "bob", "codex"] as const;
export const TARGET_SELECTIONS = [...PLATFORM_TARGETS, "all"] as const;
export const INSTALL_SCOPES = ["project", "global"] as const;

export type PlatformTarget = (typeof PLATFORM_TARGETS)[number];
export type TargetSelection = (typeof TARGET_SELECTIONS)[number];
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export type ProposalKind = "instructions" | "permissions" | "rules" | "hooks" | "configuration";
export type DoctorReminderLevel = "info" | "warning";

export interface AdapterPaths {
  userHome: string;
  projectRoot: string;
  /** Resolved shared runtime root; defaults to <userHome>/.jstack. */
  jstackHome?: string;
  /** Resolved Claude personal configuration root; defaults to <userHome>/.claude. */
  claudeConfigDir?: string;
  /** Resolved Codex configuration root; defaults to <userHome>/.codex. */
  codexHome?: string;
}

/** A platform configuration suggestion. Install never applies these entries. */
export interface PlatformProposal {
  id: string;
  kind: ProposalKind;
  targetPath: string;
  summary: string;
  snippet: string;
  disposition: "proposal-only";
  applyAutomatically: false;
}

export interface DoctorReminder {
  id: string;
  level: DoctorReminderLevel;
  message: string;
}

export interface PlatformAdapter {
  id: PlatformTarget;
  label: string;
  skillRoot(scope: InstallScope, paths: AdapterPaths): string;
  proposals(scope: InstallScope, paths: AdapterPaths): readonly PlatformProposal[];
  doctorReminders(scope: InstallScope, paths: AdapterPaths): readonly DoctorReminder[];
}

export const PERMANENT_SAFETY_INSTRUCTIONS = [
  "Never run git push.",
  "Never create, submit, update, approve, close, comment on, or merge a pull request or merge request.",
  "Never mutate Jira, GitHub, GitLab, or another remote service.",
  "Do not stage or commit unless the user explicitly requests it.",
  "Read-only Git operations and remote retrieval are allowed.",
  "Make local edits and run tests only when the user requests them.",
  "Stop locally and let the user perform remote actions.",
].join("\n");

export function resolveContextBase(scope: InstallScope, paths: AdapterPaths): string {
  const candidate = scope === "project" ? paths.projectRoot : paths.userHome;
  const label = scope === "project" ? "project root" : "user home";
  if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.includes("\0")) {
    throw new TypeError(`Adapter ${label} must be a non-empty path without NUL bytes`);
  }
  return path.resolve(candidate);
}

function resolveOptionalRoot(candidate: string | undefined, fallback: string, label: string): string {
  const selected = candidate ?? fallback;
  if (typeof selected !== "string" || selected.trim().length === 0 || selected.includes("\0")) {
    throw new TypeError(`Adapter ${label} must be a non-empty path without NUL bytes`);
  }
  return path.resolve(selected);
}

export function resolveClaudeConfigDir(paths: AdapterPaths): string {
  return resolveOptionalRoot(paths.claudeConfigDir, path.join(resolveContextBase("global", paths), ".claude"), "Claude config root");
}

export function resolveCodexHome(paths: AdapterPaths): string {
  return resolveOptionalRoot(paths.codexHome, path.join(resolveContextBase("global", paths), ".codex"), "Codex home");
}

export function proposal(
  value: Omit<PlatformProposal, "disposition" | "applyAutomatically">,
): PlatformProposal {
  return {
    ...value,
    disposition: "proposal-only",
    applyAutomatically: false,
  };
}

/*
 * Keep the shell-visible command independent of the installation path. Quoting
 * an absolute path cannot be made portable across POSIX shells, cmd.exe, and
 * PowerShell: each expands a different set of metacharacters inside quotes.
 * A base64url file URL is a single shell-safe token, while the fixed bootstrap
 * deliberately contains none of $, `, %, !, &, |, <, or ^.
 */
const SAFETY_HOOK_BOOTSTRAP =
  "import(Buffer.from(process.argv[1],'base64url').toString('utf8')).then(m=>m.main(['safety','hook','--permanent-only'])).then(c=>{process.exitCode=c}).catch(e=>{console.error(e);process.exitCode=2})";

/** Portable command fragment for a proposal-only PreToolUse guard. */
export function localSafetyHookCommand(paths: AdapterPaths): string {
  const runtimeRoot = paths.jstackHome === undefined
    ? path.join(resolveContextBase("global", paths), ".jstack")
    : path.resolve(paths.jstackHome);
  const runtimeCli = path.join(
    runtimeRoot,
    "runtime",
    "dist",
    "src",
    "cli.js",
  );
  const encodedRuntimeUrl = Buffer.from(pathToFileURL(runtimeCli).href, "utf8").toString("base64url");
  return `node -e "${SAFETY_HOOK_BOOTSTRAP}" ${encodedRuntimeUrl}`;
}
