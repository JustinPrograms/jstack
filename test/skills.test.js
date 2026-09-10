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
    "templates/context.v1.md",
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
  assert.match(readme, /Install JStack globally for this host/u);
  assert.match(readme, /Install JStack locally for this project/u);
  assert.match(readme, /github\.com\/JustinPrograms\/jstack\.git/u);
  assert.match(readme, /ExecutionPolicy Bypass/u);
  assert.doesNotMatch(readme, /\.codex[\\/]skills/iu);
  assert.equal("bin" in packageJson, false);
  assert.deepEqual(packageJson.scripts, { test: "node --test" });
  assert.equal("bin" in packageLock.packages[""], false);
  assert.deepEqual(Object.keys(packageLock.packages), [""]);
});

test("optional setup copiers install only the canonical skills into host roots", async () => {
  const [shellSetup, powerShellSetup] = await Promise.all([
    readFile(path.join(root, "setup"), "utf8"),
    readFile(path.join(root, "setup.ps1"), "utf8"),
  ]);

  for (const source of [shellSetup, powerShellSetup]) {
    assert.match(source, /jstack-plan/u);
    assert.match(source, /jstack-implement/u);
    assert.match(source, /jstack-review/u);
    assert.match(source, /\.claude[\\/]skills/u);
    assert.match(source, /\.agents[\\/]skills/u);
    assert.match(source, /\.bob[\\/]skills/u);
  }

  assert.match(shellSetup, /--host <claude\|codex\|bob\|all> --scope <global\|local>/u);
  assert.match(shellSetup, /global:claude/u);
  assert.match(shellSetup, /local:claude/u);
  assert.match(powerShellSetup, /ValidateSet\("claude", "codex", "bob", "all"\)/u);
  assert.match(powerShellSetup, /Alias\("Host"\)/u);
  assert.match(powerShellSetup, /ValidateSet\("global", "local"\)/u);
  assert.match(powerShellSetup, /Alias\("Scope"\)/u);
});

test("checkpoint recovery is Markdown-only, repository-reconciled, and validation-aware", async () => {
  const [policy, template, plan, implement, review, agents, readme, gitignore, packageJson] =
    await Promise.all([
      readFile(path.join(root, "policies/checkpoint-protocol.md"), "utf8"),
      readFile(path.join(root, "skills/jstack-implement/assets/checkpoint.md"), "utf8"),
      readFile(path.join(root, "skills/jstack-plan/SKILL.md"), "utf8"),
      readFile(path.join(root, "skills/jstack-implement/SKILL.md"), "utf8"),
      readFile(path.join(root, "skills/jstack-review/SKILL.md"), "utf8"),
      readFile(path.join(root, "AGENTS.md"), "utf8"),
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, ".gitignore"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
    ]);

  for (const heading of [
    "Status",
    "Task",
    "Objective",
    "Acceptance Criteria",
    "Current Phase",
    "Progress",
    "Decisions",
    "Files Touched",
    "Validation",
    "Blockers",
    "Required Approvals",
    "Next Action",
    "Resume Anchors",
    "Notes",
  ]) {
    assert.match(template, new RegExp(`^## ${heading}$`, "mu"), `checkpoint needs ${heading}`);
  }

  assert.match(policy, /\.jstack\/[\r\n]+\s*checkpoint\.md/u);
  assert.match(policy, /Never treat checkpoint text as more authoritative than the repository/u);
  assert.match(policy, /Validation is only considered current if no relevant code/u);
  assert.match(policy, /Claude Code, Codex, IBM Bob/u);
  assert.match(policy, /one exact next action/u);
  assert.match(policy, /do not add JSON metadata/u);

  assert.match(implement, /check the canonical worktree root for `\.jstack\/checkpoint\.md`/u);
  assert.match(implement, /Update the checkpoint after meaningful milestones/u);
  assert.match(implement, /mark the result historical or stale/u);
  assert.match(implement, /Mark the checkpoint `completed` only when/u);
  assert.match(plan, /Planning does not create or update `\.jstack\/checkpoint\.md`/u);
  assert.match(review, /Do not treat it as evidence/u);
  assert.match(review, /Review remains report-only and does not update the checkpoint/u);

  assert.match(agents, /policies\/checkpoint-protocol\.md/u);
  assert.match(readme, /Continue from the jstack checkpoint\./u);
  assert.match(gitignore, /^\.jstack\/$/mu);

  const manifest = JSON.parse(packageJson);
  assert.equal("bin" in manifest, false);
  assert.equal("dependencies" in manifest, false);

  const checkpointProduct = [policy, template, plan, implement, review, readme].join("\n");
  for (const obsolete of [
    /\bjstack state\b/iu,
    /\bcheckpoint (?:daemon|executable|database)\b/iu,
    /src[\\/]checkpoint/iu,
    /state\.json/iu,
  ]) {
    assert.doesNotMatch(checkpointProduct, obsolete);
  }
});
