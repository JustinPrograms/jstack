import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = ["story", "plan-eng-review", "review", "resume-story"] as const;

test("generated skill files contain no executable remote-capable commands", async () => {
  const prohibited = [
    /\bgit\s+(?:push|fetch|pull|clone|remote)\b/iu,
    /\b(?:gh|glab)\s+(?:pr|issue|api|repo)\b/iu,
    /\b(?:curl|wget)\b/iu,
    /\bInvoke-WebRequest\b/iu,
    /\b(?:jira|github|gitlab)\s+api\b/iu,
  ];
  for (const skill of SKILLS) {
    const source = await readFile(path.join(PACKAGE_ROOT, "skills", skill, "SKILL.md"), "utf8");
    assert.equal(source.startsWith("---\n"), true);
    const end = source.indexOf("\n---\n", 4);
    assert.notEqual(end, -1);
    const frontmatter = source.slice(4, end);
    const keys = frontmatter
      .split("\n")
      .map((line) => line.slice(0, line.indexOf(":")))
      .sort();
    assert.deepEqual(keys, ["description", "name"]);
    assert.match(source, new RegExp(`^name: ${skill}$`, "m"));
    assert.match(source, /^description: .{20,}$/mu);
    assert.doesNotMatch(source, /\b(?:TODO|FIXME|TBD)\b/u);
    for (const pattern of prohibited) assert.doesNotMatch(source, pattern, `${skill} contains ${pattern}`);
  }
});

test("authored documentation and fixtures remain generic and local", async () => {
  const relativeFiles = [
    "README.md",
    "policies/checkpoint-protocol.md",
    "templates/context.v1.md",
    "test/fixtures/sample-story.md",
    ...SKILLS.map((skill) => `skills/${skill}/SKILL.md`),
  ];
  for (const relativeFile of relativeFiles) {
    const source = await readFile(path.join(PACKAGE_ROOT, ...relativeFile.split("/")), "utf8");
    assert.doesNotMatch(source, /\b(?:corp(?:oration)?|inc(?:orporated)?)\s+(?:ticket|repository|reviewer)\b/iu);
  }
});
