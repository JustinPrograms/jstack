import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { captureGitSnapshot } from "../src/checkpoint/git.js";
import { createGitRepository, git } from "./helpers/git-fixture.js";

test("Git snapshots detect clean, tracked, and repeatedly edited content", async (t) => {
  const fixture = await createGitRepository(t);
  const clean = await captureGitSnapshot(fixture.root);
  const repeated = await captureGitSnapshot(fixture.root);
  assert.equal(clean.currentBranch, "main");
  assert.match(clean.headCommit ?? "", /^[a-f0-9]{40,64}$/u);
  assert.equal(clean.dirty, false);
  assert.equal(clean.changedFileCount, 0);
  assert.equal(clean.worktreeFingerprint, repeated.worktreeFingerprint);

  await writeFile(fixture.file, "first dirty value\n", "utf8");
  const firstDirty = await captureGitSnapshot(fixture.root);
  assert.equal(firstDirty.dirty, true);
  assert.equal(firstDirty.changedFileCount, 1);
  assert.match(firstDirty.changedFiles[0] ?? "", /sample\.txt/u);

  await writeFile(fixture.file, "second dirty value\n", "utf8");
  const secondDirty = await captureGitSnapshot(fixture.root);
  assert.notEqual(secondDirty.worktreeFingerprint, firstDirty.worktreeFingerprint);
});

test("untracked contents affect fingerprints while only their count is retained", async (t) => {
  const fixture = await createGitRepository(t);
  const untracked = path.join(fixture.root, "generic ünicode note.txt");
  await writeFile(untracked, "one\n", "utf8");
  const first = await captureGitSnapshot(fixture.root);
  assert.equal(first.untrackedFileCount, 1);
  assert.deepEqual(first.untrackedFiles, []);
  await writeFile(untracked, "two\n", "utf8");
  const second = await captureGitSnapshot(fixture.root);
  assert.equal(second.untrackedFileCount, 1);
  assert.notEqual(second.worktreeFingerprint, first.worktreeFingerprint);
});

test("unborn repositories are valid snapshots", async (t) => {
  const fixture = await createGitRepository(t, { committed: false });
  const empty = await captureGitSnapshot(fixture.root);
  assert.equal(empty.currentBranch, "main");
  assert.equal(empty.headCommit, null);
  assert.equal(empty.dirty, false);
  await mkdir(path.join(fixture.root, "src"));
  await writeFile(path.join(fixture.root, "src", "new.txt"), "new\n", "utf8");
  const dirty = await captureGitSnapshot(fixture.root);
  assert.equal(dirty.headCommit, null);
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.untrackedFileCount, 1);
  assert.equal(await git(fixture.root, "remote"), "");
});
