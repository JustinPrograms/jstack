import path from "node:path";
import {
  PERMANENT_SAFETY_INSTRUCTIONS,
  localSafetyHookCommand,
  proposal,
  resolveContextBase,
  type AdapterPaths,
  type InstallScope,
  type PlatformAdapter,
} from "../types.js";

function settingsPath(scope: InstallScope, paths: AdapterPaths): string {
  const base = resolveContextBase(scope, paths);
  return scope === "project"
    ? path.join(base, ".claude", "settings.local.json")
    : path.join(base, ".claude", "settings.json");
}

function instructionsPath(scope: InstallScope, paths: AdapterPaths): string {
  const base = resolveContextBase(scope, paths);
  return scope === "project" ? path.join(base, "CLAUDE.md") : path.join(base, ".claude", "CLAUDE.md");
}

function claudeSkillRoot(scope: InstallScope, paths: AdapterPaths): string {
  return path.join(resolveContextBase(scope, paths), ".claude", "skills");
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
        summary: "Propose adding JustinStack's permanent local-only safety contract to Claude instructions.",
        snippet: `## JustinStack safety\n\n${PERMANENT_SAFETY_INSTRUCTIONS}`,
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
                "Bash(gh pr create *)",
                "Bash(gh pr merge *)",
                "Bash(glab mr create *)",
                "Bash(glab mr merge *)",
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
                  matcher: "Bash|PowerShell",
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
        id: "claude-proposals-not-applied",
        level: "info",
        message: "CLAUDE.md, permissions, and hook proposals are advisory and were not applied.",
      },
    ];
  },
};
