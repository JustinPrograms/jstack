import path from "node:path";
import {
  PERMANENT_SAFETY_INSTRUCTIONS,
  localSafetyHookCommand,
  proposal,
  resolveClaudeConfigDir,
  resolveContextBase,
  type AdapterPaths,
  type InstallScope,
  type PlatformAdapter,
} from "../types.js";

function settingsPath(scope: InstallScope, paths: AdapterPaths): string {
  return scope === "project"
    ? path.join(resolveContextBase(scope, paths), ".claude", "settings.local.json")
    : path.join(resolveClaudeConfigDir(paths), "settings.json");
}

function instructionsPath(scope: InstallScope, paths: AdapterPaths): string {
  return scope === "project"
    ? path.join(resolveContextBase(scope, paths), "CLAUDE.md")
    : path.join(resolveClaudeConfigDir(paths), "CLAUDE.md");
}

function claudeSkillRoot(scope: InstallScope, paths: AdapterPaths): string {
  return scope === "project"
    ? path.join(resolveContextBase(scope, paths), ".claude", "skills")
    : path.join(resolveClaudeConfigDir(paths), "skills");
}

export const claudeAdapter: PlatformAdapter = {
  id: "claude",
  label: "Claude Code",
  skillRoot: claudeSkillRoot,
  proposals(scope, paths) {
    const settings = settingsPath(scope, paths);
    const hookCommand = localSafetyHookCommand(paths);
    return [
      proposal({
        id: "claude-instructions",
        kind: "instructions",
        targetPath: instructionsPath(scope, paths),
        summary: "Propose adding JStack's permanent local-only safety contract to Claude instructions.",
        snippet: `## JStack safety\n\n${PERMANENT_SAFETY_INSTRUCTIONS}`,
      }),
      proposal({
        id: "claude-permissions",
        kind: "permissions",
        targetPath: settings,
        summary: "Propose Claude permission denials for remote mutations and unapproved Git history changes.",
        snippet: JSON.stringify(
          {
            permissions: {
              deny: [
                "Bash(git push *)",
                "PowerShell(git push *)",
                "Bash(gh pr create *)",
                "PowerShell(gh pr create *)",
                "Bash(gh pr merge *)",
                "PowerShell(gh pr merge *)",
                "Bash(glab mr create *)",
                "PowerShell(glab mr create *)",
                "Bash(glab mr merge *)",
                "PowerShell(glab mr merge *)",
              ],
            },
          },
          null,
          2,
        ),
      }),
      proposal({
        id: "claude-hooks",
        kind: "hooks",
        targetPath: settings,
        summary: "Propose a pre-tool safety hook as defense in depth.",
        snippet: JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "^(Bash|PowerShell)$",
                  hooks: [{ type: "command", command: hookCommand, timeout: 5 }],
                },
              ],
            },
          },
          null,
          2,
        ),
      }),
    ];
  },
  doctorReminders(scope, paths) {
    return [
      {
        id: "claude-skill-root",
        level: "info",
        message: `Verify Claude Code can discover skills from ${claudeSkillRoot(scope, paths)}.`,
      },
      {
        id: "claude-invocation",
        level: "info",
        message: "Invoke the review skill as /jstack-review in Claude Code; Claude may also load it automatically from its description.",
      },
      {
        id: "claude-proposals-not-applied",
        level: "info",
        message: "CLAUDE.md, permissions, and hook proposals are advisory and were not applied.",
      },
    ];
  },
};
