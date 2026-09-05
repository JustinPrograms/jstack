import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = ["story", "plan-eng-review", "review", "resume-story"] as const;

async function walk(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function frontmatter(source: string): { name: string; description: string; body: string } {
  const normalized = source.replace(/\r\n?/gu, "\n");
  assert.equal(normalized.startsWith("---\n"), true);
  const end = normalized.indexOf("\n---\n", 4);
  assert.notEqual(end, -1);
  const lines = normalized.slice(4, end).split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf(":"))).sort(),
    ["description", "name"],
  );
  const values = new Map(lines.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  return {
    name: values.get("name") ?? "",
    description: values.get("description") ?? "",
    body: normalized.slice(end + 5),
  };
}

function executableExamples(source: string): string[] {
  const examples: string[] = [];
  const fence = /^\x60\x60\x60(?:bash|sh|shell|powershell|pwsh|cmd|console)\s*\n([\s\S]*?)^\x60\x60\x60\s*$/gimu;
  for (const match of source.matchAll(fence)) examples.push(match[1] ?? "");
  for (const line of source.split("\n")) {
    if (/^\s{4}(?:git|gh|glab|jira|curl|wget)\b/iu.test(line)) examples.push(line.trim());
    if (/^\s*(?:\$|>)\s+(?:git|gh|glab|jira|curl|wget)\b/iu.test(line)) examples.push(line.trim());
  }
  return examples;
}

function assertNoMutatingExample(example: string, label: string): void {
  const prohibited = [
    /(?:^|\n)\s*(?:\$|>)?\s*git\s+push\b/iu,
    /(?:^|\n)\s*(?:\$|>)?\s*git\s+(?:add|commit)\b/iu,
    /(?:^|\n)\s*(?:\$|>)?\s*git\s+config\b/iu,
    /(?:^|\n)\s*(?:\$|>)?\s*git\s+remote\s+(?:add|remove|rm|rename|set-url)\b/iu,
    /(?:^|\n)\s*(?:\$|>)?\s*(?:gh\s+pr|glab\s+mr)\s+(?:create|edit|update|review|approve|merge|close|comment|reopen)\b/iu,
    /(?:^|\n)\s*(?:\$|>)?\s*jira\b.*\b(?:create|edit|update|assign|transition|comment|close)\b/iu,
    /(?:^|\n)\s*(?:\$|>)?\s*(?:curl|wget)\b.*(?:--request|-X)\s*(?:POST|PUT|PATCH|DELETE)\b/iu,
  ];
  for (const pattern of prohibited) assert.doesNotMatch(example, pattern, `${label} contains executable mutation ${pattern}`);
}

test("canonical skills have portable frontmatter and no platform-specific source copies", async () => {
  const skillDirectories = (await readdir(path.join(PACKAGE_ROOT, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(skillDirectories, [...SKILLS].sort());

  for (const skill of SKILLS) {
    const skillRoot = path.join(PACKAGE_ROOT, "skills", skill);
    const source = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const parsed = frontmatter(source);
    assert.equal(parsed.name, skill);
    assert.equal(parsed.description.length >= 20, true);
    assert.match(parsed.body, /~\/\.justin-stack\/policies\/checkpoint-protocol\.md/u);
    assert.match(parsed.body, /coordinating agent/iu);
    assert.doesNotMatch(source, /\b(?:TODO|FIXME|TBD)\b/u);
    assert.doesNotMatch(source, /(?:\.claude|\.bob|\.codex)[\\/]/iu);
    assert.doesNotMatch(source, /\b(?:Claude Code|IBM Bob|OpenAI Codex|allowed-tools)\b/iu);

    const topLevel = await readdir(skillRoot, { withFileTypes: true });
    for (const entry of topLevel) {
      assert.equal(
        entry.name === "SKILL.md" || (entry.name === "references" && entry.isDirectory()),
        true,
        `Unexpected canonical skill entry: ${skill}/${entry.name}`,
      );
    }
  }

  const adapterSkillCopies = (await walk(path.join(PACKAGE_ROOT, "adapters")))
    .filter((filePath) => path.basename(filePath).toLowerCase() === "skill.md");
  assert.deepEqual(adapterSkillCopies, []);
});

test("shared protocol defines the continuity, privacy, coordination, and safety contracts", async () => {
  const protocol = await readFile(path.join(PACKAGE_ROOT, "policies", "checkpoint-protocol.md"), "utf8");
  assert.match(protocol, /~\/\.justin-stack\/workspaces\/<workspace-id>\/stories\/<story-id>\//u);
  for (const filename of ["context.md", "decisions.md", "progress.md", "checks.md", "handoff.md", "state.json"]) {
    assert.equal(protocol.includes(`\`${filename}\``), true);
  }
  assert.match(protocol, /Only the coordinating agent may update the canonical bundle/iu);
  assert.match(protocol, /Never run \x60git push\x60/iu);
  assert.match(protocol, /Never create, submit, update, approve, close, comment on, or merge a pull request or merge request/iu);
  assert.match(protocol, /Never mutate Jira, GitHub, GitLab/iu);
  assert.match(protocol, /Never stage or commit changes unless the user explicitly requests/iu);
  assert.match(protocol, /Read-only local Git operations and read-only remote retrieval are allowed/iu);
  assert.match(protocol, /Stop locally.*user perform every remote mutation/isu);
  assert.match(protocol, /must not contain:[\s\S]*secrets[\s\S]*internal URLs[\s\S]*customer information/iu);
  assert.match(protocol, /state\.json.*written last/isu);
});

test("shared protocol enforces the ticket-first engineering doctrine", async () => {
  const protocol = await readFile(path.join(PACKAGE_ROOT, "policies", "checkpoint-protocol.md"), "utf8");
  const requiredRules = [
    /Derive scope from the ticket/iu,
    /Search before writing/iu,
    /Understand the execution path/iu,
    /Prefer the smallest complete change/iu,
    /Do not future-proof without evidence/iu,
    /Preserve repository architecture/iu,
    /Avoid parallel implementations/iu,
    /Separate required work from optional findings/iu,
    /Make tests prove the ticket/iu,
    /Review against the ticket/iu,
  ];
  for (const rule of requiredRules) assert.match(protocol, rule);
  assert.match(protocol, /every changed file is necessary/iu);
  assert.match(protocol, /no simpler correct change is available/iu);
});

test("canonical skills contain no executable remote or Git mutation examples", async () => {
  assert.deepEqual(executableExamples("Never run \x60git push\x60."), []);
  assert.equal(executableExamples("\x60\x60\x60sh\ngit push origin main\n\x60\x60\x60").length, 1);

  for (const skill of SKILLS) {
    const filePath = path.join(PACKAGE_ROOT, "skills", skill, "SKILL.md");
    const source = await readFile(filePath, "utf8");
    for (const example of executableExamples(source)) assertNoMutatingExample(example, skill);
  }
});

test("canonical skill and policy content remains local and free of private fixture data", async () => {
  const files = [
    path.join(PACKAGE_ROOT, "policies", "checkpoint-protocol.md"),
    ...SKILLS.map((skill) => path.join(PACKAGE_ROOT, "skills", skill, "SKILL.md")),
  ];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /https?:\/\//iu);
    assert.doesNotMatch(source, /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/iu);
  }
});
