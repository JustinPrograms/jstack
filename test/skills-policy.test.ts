import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = ["story", "plan-eng-review", "implement-story", "jstack-review", "resume-story"] as const;
const OPTIONAL_FRONTMATTER = new Set(["license", "compatibility", "metadata", "allowed-tools"]);

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
  const topLevel = lines.filter((line) => line.length > 0 && !/^\s/u.test(line));
  const values = new Map(
    topLevel.map((line) => {
      const delimiter = line.indexOf(":");
      assert.notEqual(delimiter, -1, `Invalid frontmatter line: ${line}`);
      return [line.slice(0, delimiter), line.slice(delimiter + 1).trim()];
    }),
  );
  assert.equal(values.has("name"), true);
  assert.equal(values.has("description"), true);
  for (const key of values.keys()) {
    assert.equal(key === "name" || key === "description" || OPTIONAL_FRONTMATTER.has(key), true, `Unknown field: ${key}`);
  }
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
  const skillDirectories: string[] = [];
  for (const entry of await readdir(path.join(PACKAGE_ROOT, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(PACKAGE_ROOT, "skills", entry.name, "SKILL.md"), "utf8");
      skillDirectories.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  skillDirectories.sort();
  assert.deepEqual(skillDirectories, [...SKILLS].sort());

  for (const skill of SKILLS) {
    const skillRoot = path.join(PACKAGE_ROOT, "skills", skill);
    const source = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const parsed = frontmatter(source);
    assert.equal(parsed.name, skill);
    assert.match(parsed.name, /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/u);
    assert.equal(parsed.description.length >= 20, true);
    assert.equal(parsed.description.length <= 1024, true);
  assert.match(parsed.body, /JSTACK_HOME/u);
    assert.match(parsed.body, /STORY_STACK_HOME/u);
    assert.match(parsed.body, /bin\/jstack\.js/u);
    assert.match(parsed.body, /do not depend on `PATH`/u);
    assert.match(parsed.body, /policies\/checkpoint-protocol\.md/u);
    assert.match(parsed.body, /coordinating agent/iu);
    assert.doesNotMatch(source, /\b(?:TODO|FIXME|TBD)\b/u);
    assert.doesNotMatch(source, /(?:\.claude|\.bob|\.codex)[\\/]/iu);
    assert.doesNotMatch(source, /\b(?:Claude Code|IBM Bob|OpenAI Codex|allowed-tools)\b/iu);

    const topLevel = await readdir(skillRoot, { withFileTypes: true });
    for (const entry of topLevel) {
      assert.equal(
        entry.name === "SKILL.md" ||
          (["references", "scripts", "assets"].includes(entry.name) && entry.isDirectory()),
        true,
        `Unexpected canonical skill entry: ${skill}/${entry.name}`,
      );
    }
  }

  const adapterSkillCopies = (await walk(path.join(PACKAGE_ROOT, "adapters")))
    .filter((filePath) => path.basename(filePath).toLowerCase() === "skill.md");
  assert.deepEqual(adapterSkillCopies, []);
});

test("portable frontmatter accepts every optional Agent Skills field", () => {
  const parsed = frontmatter(`---
name: sample-skill
description: Exercise every standard optional field.
license: Apache-2.0
compatibility: Requires Node.js 20.
metadata:
  owner: jstack
allowed-tools: Read Bash(git:*)
---

# Sample
`);
  assert.equal(parsed.name, "sample-skill");
  assert.equal(parsed.description, "Exercise every standard optional field.");
});

test("report-only review leaves checkpoint writes opt-in and recovery discloses abrupt-cutoff limits", async () => {
  const review = await readFile(path.join(PACKAGE_ROOT, "skills", "jstack-review", "SKILL.md"), "utf8");
  assert.match(review, /if and only if the user authorizes local checkpoint writes/iu);
  assert.match(review, /review-only, read-only, or explicitly says not to write[\s\S]*leave the bundle unchanged/iu);

  const resume = await readFile(path.join(PACKAGE_ROOT, "skills", "resume-story", "SKILL.md"), "utf8");
  assert.match(resume, /latest successfully persisted checkpoint/iu);
  assert.match(resume, /abrupt usage-limit cutoff cannot run a final save hook reliably/iu);
  assert.match(resume, /not necessarily the moment the prior session ended/iu);
});

test("story composition keeps implementation, review, recovery, and completion ownership distinct", async () => {
  const sources = await Promise.all(
    ["story", "plan-eng-review", "implement-story", "jstack-review", "resume-story"].map((skill) =>
      readFile(path.join(PACKAGE_ROOT, "skills", skill, "SKILL.md"), "utf8"),
    ),
  );
  const [story, planReview, implementation, review, resume] = sources as [string, string, string, string, string];

  const phaseOrder = ["`plan-eng-review`", "`implement-story`", "`jstack-review`"]
    .map((phase) => story.indexOf(phase));
  assert.equal(phaseOrder.every((index) => index >= 0), true);
  assert.equal(phaseOrder[0]! < phaseOrder[1]! && phaseOrder[1]! < phaseOrder[2]!, true);
  assert.match(story, /Do not reproduce their worker instructions here/iu);
  assert.doesNotMatch(story, /workflow is planning-only|stop before implementation/iu);
  assert.match(story, /material scope[\s\S]*first checkpoint the story as `blocked`/iu);
  assert.match(story, /every blocker and should-fix finding is resolved/iu);

  assert.match(planReview, /implementation action for `implement-story`/iu);
  assert.match(implementation, /Plan approval and a request to resume are not by themselves authorization to edit source files/iu);
  assert.match(implementation, /current repository as the source of truth/iu);
  assert.match(implementation, /call sites[\s\S]*types, interfaces, tests/iu);
  assert.match(implementation, /search for existing helpers/iu);
  assert.match(implementation, /smallest coherent edit/iu);
  assert.match(implementation, /minor implementation-level difference[\s\S]*material plan problem/iu);
  assert.match(implementation, /implementation-time checks[\s\S]*final story validation/iu);
  assert.match(implementation, /low-usage-compatible path is one coordinating coding agent/iu);
  assert.match(implementation, /status `in-review`/iu);
  assert.match(implementation, /Do not use `state complete`/iu);

  assert.match(review, /reports findings and does not fix them|do not apply corrections/iu);
  assert.match(review, /return a no-findings or fully dispositioned review to `story`/iu);
  assert.match(resume, /state routing reconcile-resume/iu);
  assert.match(resume, /use `implement-story` for `ready` or `in-progress` implementation/iu);
  assert.match(resume, /return to the coordinating `story` workflow for final validation and completion gates/iu);
});

test("README documents platform-specific discovery and invocation without continuity overclaims", async () => {
  const readme = await readFile(path.join(PACKAGE_ROOT, "README.md"), "utf8");
  assert.match(readme, /<repo>\/\.agents\/skills\//u);
  assert.match(readme, /~\/\.agents\/skills\//u);
  assert.doesNotMatch(readme, /\.codex\/skills\//u);
  assert.match(readme, /CLAUDE_CONFIG_DIR/u);
  assert.match(readme, /\$jstack-review/u);
  assert.match(readme, /\$implement-story/u);
  assert.match(readme, /In Bob Shell, type `\$` and select the skill from the picker/iu);
  assert.match(readme, /or use `\/skills`/iu);
  assert.match(readme, /state commands never launch user-supplied programs/iu);
  assert.match(readme, /explicit coordinator attestation rather than cryptographic proof/iu);
  assert.doesNotMatch(readme, /\/list-skills/u);
  assert.match(readme, /abrupt cutoff[\s\S]*unsaved reasoning or progress is never promised/iu);
});

test("shared protocol defines the continuity, privacy, coordination, and safety contracts", async () => {
  const protocol = await readFile(path.join(PACKAGE_ROOT, "policies", "checkpoint-protocol.md"), "utf8");
  assert.match(protocol, /~\/\.jstack\/workspaces\/<workspace-id>\/stories\/<story-id>\//u);
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
  assert.match(protocol, /one-way repository identifier[\s\S]*does not store the absolute repository path or changed filenames/iu);
  assert.match(protocol, /Refuse a runtime\/state root located inside the active repository/iu);
  assert.match(protocol, /usage limit or process termination can arrive before any final hook runs/iu);
  assert.match(protocol, /Only the latest successfully completed bundle write is guaranteed to survive/iu);
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

test("repository agent instructions grant no standing commit or remote-mutation authority", async () => {
  for (const relativePath of ["AGENTS.md", "CLAUDE.md"]) {
    const source = await readFile(path.join(PACKAGE_ROOT, relativePath), "utf8");
    assert.doesNotMatch(source, /owner has authorized[\s\S]*(?:commit|push)/iu);
    assert.match(source, /(?:Never run `git push`|Never push)/iu);
    assert.match(source, /explicitly requests[\s\S]*current conversation/iu);
    for (const example of executableExamples(source)) assertNoMutatingExample(example, relativePath);
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
