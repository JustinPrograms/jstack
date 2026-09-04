export type SafetyDisposition = "allow" | "require-explicit-request" | "deny";

export interface SafetyDecision {
  disposition: SafetyDisposition;
  reason: string;
  rule: string;
}

export function hookCommandFromPayload(source: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidates = [record.tool_input, record.input, record];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const command = (candidate as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim().length > 0) return command;
  }
  return null;
}

function normalizedCommand(command: string | readonly string[]): string {
  const source = typeof command === "string" ? command : command.join(" ");
  return source
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(
      /\bgit\s+(?:(?:-c|-C|--git-dir|--work-tree|--namespace)\s+[^\s]+\s+|(?:--git-dir|--work-tree|--namespace)=[^\s]+\s+)+/giu,
      "git ",
    );
}

const DENIED_RULES: readonly { pattern: RegExp; reason: string; rule: string }[] = [
  {
    pattern: /(?:^|[;&|()"']\s*)git\s+push(?:\s|$)/u,
    reason: "JustinStack never pushes Git changes.",
    rule: "git-push",
  },
  {
    pattern: /(?:^|[;&|()"']\s*)git\s+remote\s+(?:add|remove|rename|set-head|set-branches|set-url|update)(?:\s|$)/u,
    reason: "JustinStack never changes Git remotes.",
    rule: "git-remote-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)(?:gh\s+pr|glab\s+mr)\s+(?:create|edit|comment|close|merge|reopen|review|approve|ready)(?:\s|$)/u,
    reason: "JustinStack never creates or mutates pull or merge requests.",
    rule: "pull-request-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)(?:gh|glab)\s+(?:issue|api)\s+(?:create|edit|comment|close|reopen|delete|post|put|patch)(?:\s|$)/u,
    reason: "JustinStack never mutates tickets or remote service data.",
    rule: "remote-service-mutation",
  },
  {
    pattern: /(?:^|[;&|()]\s*)(?:jira|jira-cli)\s+(?:create|edit|assign|comment|close|transition|delete)(?:\s|$)/u,
    reason: "JustinStack never mutates Jira or another ticket service.",
    rule: "ticket-mutation",
  },
  {
    pattern: /\b(?:curl|wget|invoke-webrequest)\b[^\r\n]*(?:\s-x\s*(?:post|put|patch|delete)\b|--request\s+(?:post|put|patch|delete)\b|-method\s+(?:post|put|patch|delete)\b)/u,
    reason: "JustinStack never sends mutating HTTP requests to remote services.",
    rule: "http-mutation",
  },
  {
    pattern: /(?:^|[;&|()"']\s*)gh\s+api\b[^\r\n]*(?:--method|-x)\s+(?:post|put|patch|delete)\b/u,
    reason: "JustinStack never sends mutating GitHub API requests.",
    rule: "remote-service-mutation",
  },
];

const EXPLICIT_REQUEST_RULES: readonly { pattern: RegExp; reason: string; rule: string }[] = [
  {
    pattern: /(?:^|[;&|()]\s*)git\s+(?:add|commit)(?:\s|$)/u,
    reason: "Git staging and commits require an explicit request from the user in the current conversation.",
    rule: "git-write-requires-request",
  },
];

/**
 * Classifies a proposed command for defense-in-depth hooks. This deliberately
 * does not execute, parse, or rewrite the command. Skill instructions remain
 * authoritative because shell syntax and wrapper programs cannot be classified
 * perfectly without platform-specific enforcement.
 */
export function classifyCommand(command: string | readonly string[]): SafetyDecision {
  const normalized = normalizedCommand(command);
  if (normalized.length === 0) {
    return { disposition: "allow", reason: "No command was supplied.", rule: "empty-command" };
  }
  for (const candidate of DENIED_RULES) {
    if (candidate.pattern.test(normalized)) {
      return { disposition: "deny", reason: candidate.reason, rule: candidate.rule };
    }
  }
  for (const candidate of EXPLICIT_REQUEST_RULES) {
    if (candidate.pattern.test(normalized)) {
      return {
        disposition: "require-explicit-request",
        reason: candidate.reason,
        rule: candidate.rule,
      };
    }
  }
  return {
    disposition: "allow",
    reason: "No permanent JustinStack restriction matched. Normal user authorization still applies.",
    rule: "no-match",
  };
}
