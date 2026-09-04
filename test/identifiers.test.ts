import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  checkpointBundlePaths,
  checkpointPath,
  sanitizeProjectSlug,
  sanitizeTicketKey,
} from "../src/checkpoint/identifiers.js";

test("project and ticket identifiers normalize conservatively", () => {
  assert.equal(sanitizeProjectSlug("  Sample_Project  "), "sample-project");
  assert.equal(sanitizeTicketKey("demo_101"), "DEMO-101");
  assert.equal(sanitizeTicketKey("demo-101"), "DEMO-101");
});

test("path-like, traversal, and reserved identifiers are rejected before normalization", () => {
  for (const value of ["../escape", "..\\escape", "C:\\escape", "/escape", "%2e%2e", "name\0tail", "CON"]) {
    assert.throws(() => sanitizeProjectSlug(value));
  }
  for (const value of ["../DEMO-1", "..\\DEMO-1", "C:\\DEMO-1", "%2fDEMO-1", "DEMO-0"]) {
    assert.throws(() => sanitizeTicketKey(value));
  }
});

test("checkpoint paths remain contained by the configured state root", () => {
  const workspacesRoot = path.resolve("safe-workspaces-root");
  const result = checkpointPath(workspacesRoot, "sample-project", "DEMO-101");
  const relative = path.relative(workspacesRoot, result);
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative.startsWith(".."), false);
  assert.equal(relative, path.join("sample-project", "stories", "DEMO-101", "context.md"));
  const bundle = checkpointBundlePaths(workspacesRoot, "sample-project", "DEMO-101");
  assert.deepEqual(
    [bundle.context, bundle.decisions, bundle.progress, bundle.checks, bundle.handoff, bundle.state].map((item) =>
      path.basename(item),
    ),
    ["context.md", "decisions.md", "progress.md", "checks.md", "handoff.md", "state.json"],
  );
  assert.equal(path.dirname(bundle.lock), path.dirname(bundle.directory));
  assert.throws(() => checkpointPath(workspacesRoot, "../outside", "DEMO-101"));
  assert.throws(() => checkpointPath(workspacesRoot, "sample-project", "../DEMO-101"));
});
