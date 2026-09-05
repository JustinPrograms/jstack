import path from "node:path";
import {
  PERMANENT_SAFETY_INSTRUCTIONS,
  proposal,
  resolveCodexHome,
  resolveContextBase,
  type AdapterPaths,
  type InstallScope,
  type PlatformAdapter,
} from "../types.js";

function codexRoot(scope: InstallScope, paths: AdapterPaths): string {
  return scope === "project"
    ? path.join(resolveContextBase(scope, paths), ".codex")
    : resolveCodexHome(paths);
}

function instructionsPath(scope: InstallScope, paths: AdapterPaths): string {
  const base = resolveContextBase(scope, paths);
  return scope === "project" ? path.join(base, "AGENTS.md") : path.join(codexRoot(scope, paths), "AGENTS.md");
}

function codexSkillRoot(scope: InstallScope, paths: AdapterPaths): string {
  return path.join(resolveContextBase(scope, paths), ".agents", "skills");
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
        summary: "Propose adding JStack's permanent local-only safety contract to Codex instructions.",
        snippet: `## JStack safety\n\n${PERMANENT_SAFETY_INSTRUCTIONS}`,
      }),
      proposal({
        id: "codex-rules",
        kind: "rules",
        targetPath: path.join(codexRoot(scope, paths), "rules", "jstack.rules"),
        summary: "Propose Codex outside-sandbox escalation rules for common remote mutations and local Git writes.",
        snippet: `# JStack defense in depth for commands requesting execution outside the sandbox.
# These rules do not govern commands already permitted inside the sandbox or non-shell tools, MCP, and API actions.
prefix_rule(pattern = ["git", "push"], decision = "forbidden", justification = "Stop locally; the user handles pushes.")
prefix_rule(pattern = ["git.exe", "push"], decision = "forbidden", justification = "Stop locally; the user handles pushes.")
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
        id: "codex-skill-root",
        level: "info",
        message: `Invoke the review skill as $jstack-review in Codex, or select it through /skills. Skills are installed at ${codexSkillRoot(scope, paths)}.`,
      },
      {
        id: "codex-rules-scope",
        level: "warning",
        message: "Codex prefix rules only decide whether shell commands may run outside the sandbox; they do not govern already-permitted sandbox commands or non-shell tools, MCP, and API actions.",
      },
      {
        id: "codex-proposals-not-applied",
        level: "info",
        message: "AGENTS.md and Codex configuration proposals are advisory and were not applied.",
      },
    ];
  },
};
