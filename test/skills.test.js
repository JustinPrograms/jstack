import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedSkills = [
  "jstack-implement",
  "jstack-plan",
  "jstack-review",
];

async function pathExists(relativePath) {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".worktree", "node_modules"].includes(entry.name)) continue;
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(directory, entry.name), relativePath)));
    } else {
      files.push(relativePath.replaceAll(path.sep, "/"));
    }
  }
  return files;
}

function parseSkill(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");

  const metadata = Object.fromEntries(
    match[1]
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        assert.notEqual(separator, -1, `invalid frontmatter line: ${line}`);
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );

  return { metadata, body: match[2] };
}

test("ships exactly three canonical Markdown skills", async () => {
  const entries = await readdir(path.join(root, "skills"), { withFileTypes: true });
  const directories = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) =>
          (await pathExists(path.join("skills", entry.name, "SKILL.md"))) ? entry.name : null,
        ),
    )
  )
    .filter(Boolean)
    .sort();

  assert.deepEqual(directories, expectedSkills);

  for (const skill of expectedSkills) {
    const source = await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8");
    const { metadata, body } = parseSkill(source);

    assert.deepEqual(Object.keys(metadata).sort(), ["description", "name"]);
    assert.equal(metadata.name, skill);
    assert.ok(metadata.description.length > 20);
    assert.ok(body.trim().length > 0);
  }
});

test("skill packages do not depend on the retired executable architecture", async () => {
  const forbidden = [
    /dist[\\/]src[\\/]cli/iu,
    /bin[\\/]jstack/iu,
    /\bjstack\s+(?:install|uninstall|doctor|state|safety)\b/iu,
    /\b(?:JSTACK_HOME|JSTACK_HOME|STORY_STACK_HOME)\b/u,
    /\brouting\.json\b/iu,
  ];

  for (const retiredPath of [
    "src/cli.ts",
    "src/installer.ts",
    "src/routing.ts",
    "src/checkpoint/store.ts",
    "adapters/registry.ts",
    "tsconfig.json",
  ]) {
    assert.equal(await pathExists(retiredPath), false, `${retiredPath} must remain retired`);
  }

  const files = await listFiles(root);
  const productTextFiles = files.filter(
    (file) => !file.startsWith("test/") && /(?:\.md|\.json)$/u.test(file),
  );
  const productText = (
    await Promise.all(productTextFiles.map((file) => readFile(path.join(root, file), "utf8")))
  ).join("\n");
  for (const pattern of forbidden) assert.doesNotMatch(productText, pattern);

  for (const prefix of ["adapters/", "bin/", "runtime/", "src/"]) {
    assert.equal(
      files.some((file) => file.startsWith(prefix)),
      false,
      `${prefix} must not contain product files`,
    );
  }
});

test("each skill keeps its phase boundary and permanent remote boundary", async () => {
  const skills = Object.fromEntries(
    await Promise.all(
      expectedSkills.map(async (skill) => [
        skill,
        await readFile(path.join(root, "skills", skill, "SKILL.md"), "utf8"),
      ]),
    ),
  );

  for (const [name, source] of Object.entries(skills)) {
    assert.match(source, /Never run `git push`/u, `${name} must forbid pushes`);
    assert.match(source, /Never stage or commit unless/u, `${name} must protect Git history`);
    assert.match(source, /Never mutate a ticket system/u, `${name} must forbid remote mutations`);
    assert.match(source, /Follow system and host instructions/u, `${name} must honor host instructions`);
    assert.match(source, /canonical repository or worktree root/u, `${name} must anchor handoffs`);
    assert.match(source, /current branch or detached state/u, `${name} must record branch state`);
    assert.match(source, /explicitly mark any non-Git workspace/u, `${name} must support non-Git work`);
  }

  assert.match(skills["jstack-plan"], /Keep this workflow read-only/u);
  assert.match(skills["jstack-implement"], /must clearly ask for implementation/u);
  assert.match(skills["jstack-implement"], /request to implement or fix authorizes/u);
  assert.match(skills["jstack-implement"], /pre-edit Git status and diff baseline/u);
  assert.match(skills["jstack-implement"], /Never use `git reset`, `git checkout`, `git clean`/u);
  assert.match(skills["jstack-review"], /Report findings only/u);
  assert.match(skills["jstack-review"], /committed branch changes from the chosen merge base/u);
  assert.match(skills["jstack-review"], /no reliable base exists/u);
});

test("documentation uses native host discovery paths", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));

  assert.match(readme, /\.claude\/skills/u);
  assert.match(readme, /\.bob\/skills/u);
  assert.match(readme, /<repo>\/\.agents\/skills\//u);
  assert.match(readme, /~\/\.agents\/skills\//u);
  assert.doesNotMatch(readme, /\.codex[\\/]skills/iu);
  assert.equal("bin" in packageJson, false);
  assert.deepEqual(packageJson.scripts, { test: "node --test" });
  assert.equal("bin" in packageLock.packages[""], false);
  assert.deepEqual(Object.keys(packageLock.packages), [""]);
});
