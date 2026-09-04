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

function bobRoot(scope: InstallScope, paths: AdapterPaths): string {
  return path.join(resolveContextBase(scope, paths), ".bob");
}

function bobSkillRoot(scope: InstallScope, paths: AdapterPaths): string {
  return path.join(bobRoot(scope, paths), "skills");
}

function bobSettingsPath(scope: InstallScope, paths: AdapterPaths): string {
  const root = bobRoot(scope, paths);
  return scope === "project" ? path.join(root, "settings.json") : path.join(root, "settings", "settings.json");
}

export const bobAdapter: PlatformAdapter = {
  id: "bob",
  label: "IBM Bob",
  skillRoot: bobSkillRoot,
  proposals(scope, paths) {
    const root = bobRoot(scope, paths);
    return [
      proposal({
        id: "bob-rules",
        kind: "rules",
        targetPath: path.join(root, "rules", "justinstack.md"),
        summary: "Propose a Bob rule containing JustinStack's permanent local-only safety contract.",
        snippet: `# JustinStack safety rule\n\n${PERMANENT_SAFETY_INSTRUCTIONS}`,
      }),
      proposal({
        id: "bob-lifecycle-hooks",
        kind: "hooks",
        targetPath: bobSettingsPath(scope, paths),
        summary: "Propose Bob lifecycle guards as defense in depth without changing Bob configuration.",
        snippet: JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: localSafetyHookCommand(paths),
                      timeout: 5,
                    },
                  ],
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
        id: "bob-advanced-mode",
        level: "warning",
        message: "IBM Bob skills require Advanced mode; enable it before trying JustinStack skills.",
      },
      {
        id: "bob-list-skills",
        level: "info",
        message: `Run /list-skills in Bob and verify it discovers skills from ${bobSkillRoot(scope, paths)}.`,
      },
      {
        id: "bob-proposals-not-applied",
        level: "info",
        message: "Bob rule and lifecycle-hook proposals are advisory and were not applied; verify the local Bob schema before using them.",
      },
    ];
  },
};
