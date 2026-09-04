import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  expandPlatformTarget,
  getPlatformAdapter,
  getPlatformAdapters,
  parseInstallScope,
  parsePlatformTarget,
  type AdapterPaths,
  type InstallScope,
  type PlatformTarget,
} from "../adapters/registry.js";
import { localSafetyHookCommand } from "../adapters/types.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MARKERS: Readonly<Record<PlatformTarget, string>> = {
  claude: ".claude",
  bob: ".bob",
  codex: ".codex",
};

function paths(): AdapterPaths {
  return {
    userHome: path.resolve("C:/Users/Sample Person"),
    projectRoot: path.resolve("C:/Workspaces/Example Project With Spaces"),
  };
}

test("target and scope parsers accept only supported values", () => {
  for (const target of ["claude", "bob", "codex", "all"] as const) {
    assert.equal(parsePlatformTarget(target), target);
  }
  for (const scope of ["project", "global"] as const) assert.equal(parseInstallScope(scope), scope);
  assert.throws(() => parsePlatformTarget("unknown"), /Target must be one of/u);
  assert.throws(() => parseInstallScope("machine"), /Scope must be one of/u);
});

test("all expands to every platform once in stable order", () => {
  assert.deepEqual(expandPlatformTarget("all"), ["claude", "bob", "codex"]);
  assert.deepEqual(
    getPlatformAdapters("all").map((adapter) => adapter.id),
    ["claude", "bob", "codex"],
  );
  assert.deepEqual(expandPlatformTarget("bob"), ["bob"]);
});

for (const target of ["claude", "bob", "codex"] as const) {
  for (const scope of ["project", "global"] as const) {
    test(`${target} resolves its exact ${scope} skills root, including paths with spaces`, () => {
      const value = paths();
      const base = scope === "project" ? value.projectRoot : value.userHome;
      assert.equal(getPlatformAdapter(target).skillRoot(scope, value), path.join(base, MARKERS[target], "skills"));
      assert.match(getPlatformAdapter(target).skillRoot(scope, value), /Sample Person|Example Project With Spaces/u);
    });
  }
}

test("configuration guidance is proposal-only and carries the permanent safety contract", () => {
  for (const adapter of getPlatformAdapters("all")) {
    const proposals = adapter.proposals("project", paths());
    assert.equal(proposals.length > 0, true);
    for (const item of proposals) {
      assert.equal(item.disposition, "proposal-only");
      assert.equal(item.applyAutomatically, false);
      assert.equal(path.isAbsolute(item.targetPath), true);
      assert.equal(item.summary.length > 20, true);
      assert.equal(item.snippet.length > 20, true);
    }
    assert.equal(
      proposals.some((item) => /git push/u.test(item.snippet)) &&
        proposals.some((item) => /remote (?:service|mutation)/iu.test(item.snippet)),
      true,
    );
  }
});

test("Bob and Codex doctor reminders disclose their required verification steps", () => {
  const bob = getPlatformAdapter("bob").doctorReminders("global", paths()).map((item) => item.message).join("\n");
  assert.match(bob, /Advanced mode/u);
  assert.match(bob, /\/list-skills/u);
  assert.match(bob, /not applied/u);

  const codex = getPlatformAdapter("codex").doctorReminders("project", paths()).map((item) => item.message).join("\n");
  assert.match(codex, /requested Codex skill root/u);
  assert.match(codex, /\.agents\/skills/u);
  assert.match(codex, /\.codex\/skills/u);
  assert.match(codex, /not applied/u);
});

test("platform enforcement proposals use documented local configuration shapes", () => {
  const value = paths();
  const claudeHook = getPlatformAdapter("claude").proposals("project", value)
    .find((item) => item.id === "claude-hooks");
  assert.ok(claudeHook);
  const claudeFragment = JSON.parse(claudeHook.snippet) as {
    hooks?: { PreToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] };
  };
  assert.equal(claudeFragment.hooks?.PreToolUse?.[0]?.matcher, "Bash|PowerShell");
  assert.match(
    claudeFragment.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? "",
    /'safety','hook','--permanent-only'/u,
  );

  const bobHook = getPlatformAdapter("bob").proposals("global", value)
    .find((item) => item.id === "bob-lifecycle-hooks");
  assert.ok(bobHook);
  assert.equal(bobHook.targetPath, path.join(value.userHome, ".bob", "settings", "settings.json"));
  assert.doesNotThrow(() => JSON.parse(bobHook.snippet));

  const codexRules = getPlatformAdapter("codex").proposals("project", value)
    .find((item) => item.id === "codex-rules");
  assert.ok(codexRules);
  assert.equal(codexRules.targetPath, path.join(value.projectRoot, ".codex", "rules", "justinstack.rules"));
  assert.match(codexRules.snippet, /decision = "forbidden"/u);
  assert.match(codexRules.snippet, /decision = "prompt"/u);
});

test("hook commands encode metacharacter-rich install paths instead of shell-quoting them", () => {
  const userHome = path.resolve("C:/Users/Sample $HOME & (100%) ! caret^ tick` semi; quote'");
  const value = { userHome, projectRoot: path.resolve("C:/Workspaces/Example") };
  const command = localSafetyHookCommand(value);
  const match = /^node -e "([^"]+)" ([A-Za-z0-9_-]+)$/u.exec(command);

  assert.ok(match);
  const bootstrap = match[1];
  const encodedRuntimeUrl = match[2];
  assert.ok(bootstrap);
  assert.ok(encodedRuntimeUrl);
  assert.doesNotMatch(command, /Sample|\$HOME|100%|tick|semi|quote/u);
  assert.doesNotMatch(bootstrap, /[$`%!&|<^]/u);

  const decodedUrl = Buffer.from(encodedRuntimeUrl, "base64url").toString("utf8");
  assert.equal(
    decodedUrl,
    pathToFileURL(path.join(userHome, ".justin-stack", "runtime", "dist", "src", "cli.js")).href,
  );
});

test("hook commands execute through the host shell when the runtime path contains metacharacters", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "justinstack hook $ & (100%) ! "));
  const runtimeCli = path.join(fixtureRoot, ".justin-stack", "runtime", "dist", "src", "cli.js");
  await mkdir(path.dirname(runtimeCli), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, ".justin-stack", "runtime", "package.json"),
    '{"type":"module"}\n',
    "utf8",
  );
  await writeFile(
    runtimeCli,
    "export async function main(args) { console.log(JSON.stringify(args)); return 0; }\n",
    "utf8",
  );

  try {
    const command = localSafetyHookCommand({ userHome: fixtureRoot, projectRoot: fixtureRoot });
    const result = await execAsync(command, {
      shell: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      windowsHide: true,
    });
    assert.notEqual(result.stdout.trim(), "", JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.stdout.trim()), ["safety", "hook", "--permanent-only"]);

    if (process.platform === "win32") {
      const powershell = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true },
      );
      assert.deepEqual(JSON.parse(powershell.stdout.trim()), ["safety", "hook", "--permanent-only"]);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Claude and Bob hook proposals retain valid JSON around the encoded command", () => {
  const value = paths();
  const expected = localSafetyHookCommand(value);
  const claude = getPlatformAdapter("claude").proposals("project", value)
    .find((item) => item.id === "claude-hooks");
  const bob = getPlatformAdapter("bob").proposals("global", value)
    .find((item) => item.id === "bob-lifecycle-hooks");
  assert.ok(claude);
  assert.ok(bob);

  const claudeJson = JSON.parse(claude.snippet) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  const bobJson = JSON.parse(bob.snippet) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  assert.equal(claudeJson.hooks.PreToolUse[0]?.hooks[0]?.command, expected);
  assert.equal(bobJson.hooks.PreToolUse[0]?.hooks[0]?.command, expected);
});

test("adapter contexts reject empty and NUL-containing bases", () => {
  const adapter = getPlatformAdapter("claude");
  assert.throws(
    () => adapter.skillRoot("project", { userHome: "C:/Users/Example", projectRoot: "" }),
    /project root/u,
  );
  assert.throws(
    () => adapter.skillRoot("global", { userHome: "bad\0home", projectRoot: "C:/Project" }),
    /user home/u,
  );
});
