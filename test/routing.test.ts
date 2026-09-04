import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  assessRoutingTask,
  defaultRoutingPolicy,
  digestRoutingPolicy,
  emptyRoutingRecord,
  normalizeScope,
  parseRoutingPolicy,
  scopesOverlap,
  serializeRoutingRecord,
  validateRoutingRecord,
} from "../src/routing.js";

const NOW = "2026-09-04T12:00:00.000Z";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "routing-1",
    status: "declared",
    work_class: "medium",
    result: "recommended",
    recommendation: "standard",
    rationale: "Independent implementation work needs a bounded recommendation.",
    read_scopes: ["src/routing.ts"],
    write_scopes: ["src/routing.ts"],
    host: null,
    model: null,
    policy_digest: "a".repeat(64),
    low_usage_attestation: null,
    evidence: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test("routing policy is exact, bounded, and digestible", () => {
  const policy = defaultRoutingPolicy();
  assert.equal(policy.mode, "standard");
  assert.match(digestRoutingPolicy(policy), /^[a-f0-9]{64}$/u);
  assert.deepEqual(parseRoutingPolicy(JSON.stringify(policy)), policy);
  assert.throws(() => parseRoutingPolicy(JSON.stringify({ ...policy, unknown: true })), /unknown fields/u);
  assert.throws(() => parseRoutingPolicy(JSON.stringify({ ...policy, standard_slot_ceiling: 0 })), /1-32/u);
});

test("routing records reject unsafe content and preserve safe lifecycle evidence", () => {
  assert.deepEqual(validateRoutingRecord(emptyRoutingRecord()), emptyRoutingRecord());
  const record = validateRoutingRecord({
    schema_version: 1,
    tasks: [task({ evidence: [{ attempt_id: "attempt-1", approach: "inspect", outcome: "failed", rationale: "The interface is not present in the current module.", recorded_at: NOW }] })],
  });
  assert.match(serializeRoutingRecord(record), /attempt-1/u);
  assert.throws(() => validateRoutingRecord({ schema_version: 1, tasks: [task({ rationale: "api_key: unsafe" })] }), /unsafe content/u);
  assert.throws(() => validateRoutingRecord({ schema_version: 1, tasks: [task({ write_scopes: ["../outside"] })] }), /unsafe normalized scope/u);
});

test("scope normalization is repository-contained and detects segment overlap", () => {
  const root = path.resolve("routing scope repository");
  assert.equal(normalizeScope(root, path.join("src", "checkpoint")), "src/checkpoint");
  assert.equal(normalizeScope(root, "."), ".");
  assert.throws(() => normalizeScope(root, "../outside"), /escapes/u);
  assert.throws(() => normalizeScope(root, "src/*.ts"), /non-glob/u);
  assert.equal(scopesOverlap(["src/checkpoint"], ["src/checkpoint/store.ts"]), true);
  assert.equal(scopesOverlap(["src/app"], ["src/application"]), false);
});

test("assessment makes escalation and low-usage boundaries explicit", () => {
  const policy = defaultRoutingPolicy();
  const medium = { ...task(), evidence: undefined } as unknown as Parameters<typeof assessRoutingTask>[0];
  assert.equal(assessRoutingTask(medium, policy).result, "recommended");
  const heavy = { ...medium, work_class: "heavy" as const };
  assert.equal(assessRoutingTask(heavy, policy).result, "requires-user-approval");
  const lowUsage = { ...policy, mode: "low-usage" as const };
  assert.equal(assessRoutingTask(medium, lowUsage).result, "do-not-delegate");
  assert.equal(assessRoutingTask({ ...medium, low_usage_attestation: "A bounded review avoids duplicate exploration." }, lowUsage).result, "recommended");
});
