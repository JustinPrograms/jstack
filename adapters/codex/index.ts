import path from "node:path";
import {
  PERMANENT_SAFETY_INSTRUCTIONS,
  proposal,
  resolveContextBase,
  type AdapterPaths,
  type InstallScope,
  type PlatformAdapter,
} from "../types.js";

function codexRoot(scope: InstallScope, paths: AdapterPaths): string {
  return path.join(resolveContextBase(scope, paths), ".codex");
}

function instructionsPath(scope: InstallScope, paths: AdapterPaths): string {
  const base = resolveContextBase(scope, paths);
  return scope === "project" ? path.join(base, "AGENTS.md") : path.join(codexRoot(scope, paths), "AGENTS.md");
}

function codexSkillRoot(scope: InstallScope, paths: AdapterPaths): string {
  return path.join(codexRoot(scope, paths), "skills");
}

export const codexAdapter: PlatformAdapter = {
  id: "codex",
  label: "OpenAI Codex",
  skillRoot: codexSkillRoot,
  proposals(scope, paths) {
    return [
      proposal({
        id: "codex-instructions",
        kind: "instructions",
        targetPath: instructionsPath(scope, paths),
        summary: "Propose adding JustinStack's permanent local-only safety contract to Codex instructions.",
        snippet: `## JustinStack safety\n\n${PERMANENT_SAFETY_INSTRUCTIONS}`,
      }),
      proposal({
        id: "codex-rules",
        kind: "rules",
        targetPath: path.join(codexRoot(scope, paths), "rules", "justinstack.rules"),
        summary: "Propose Codex prefix rules that forbid permanent remote mutations and prompt for local Git writes.",
        snippet: `# JustinStack defense in depth: forbid git push and remote mutation commands.
prefix_rule(pattern = ["git", "push"], decision = "forbidden", justification = "Stop locally; the user handles pushes.")
prefix_rule(pattern = ["git", "remote", ["add", "remove", "rename", "set-url"]], decision = "forbidden", justification = "Do not modify Git remotes.")
prefix_rule(pattern = ["gh", "pr", ["create", "edit", "comment", "close", "merge", "review"]], decision = "forbidden", justification = "Do not mutate pull requests.")
prefix_rule(pattern = ["glab", "mr", ["create", "edit", "comment", "close", "merge", "approve"]], decision = "forbidden", justification = "Do not mutate merge requests.")
prefix_rule(pattern = ["git", ["add", "commit"]], decision = "prompt", justification = "Only proceed after an explicit user request.")`,
      }),
    ];
  },
  doctorReminders(scope, paths) {
    return [
      {
        id: "codex-requested-skill-root",
        level: "warning",
        message: `JustinStack honors the requested Codex skill root ${codexSkillRoot(scope, paths)}. Current Codex discovery conventions may use .agents/skills instead, so verify this Codex version discovers .codex/skills.`,
      },
      {
        id: "codex-proposals-not-applied",
        level: "info",
        message: "AGENTS.md and Codex configuration proposals are advisory and were not applied.",
      },
    ];
  },
};
