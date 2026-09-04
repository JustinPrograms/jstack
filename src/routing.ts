import { createHash } from "node:crypto";
import path from "node:path";
import { StoryStackError } from "./errors.js";

export const ROUTING_POLICY_SCHEMA_VERSION = 1 as const;
export const ROUTING_RECORD_SCHEMA_VERSION = 1 as const;
export const WORK_CLASSES = ["light", "medium", "heavy"] as const;
export const EXECUTION_MODES = ["standard", "low-usage"] as const;
export const ROUTING_RESULTS = [
  "recommended",
  "manual-choice-required",
  "requires-user-approval",
  "policy-exception",
  "do-not-delegate",
] as const;
export const ROUTING_TASK_STATUSES = ["declared", "unknown-after-resume", "completed", "abandoned"] as const;
export const ATTEMPT_OUTCOMES = ["failed", "inconclusive", "succeeded"] as const;
export const APPROACH_CATEGORIES = ["inspect", "implement", "test", "review", "alternative-design"] as const;

export type WorkClass = (typeof WORK_CLASSES)[number];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type RoutingResult = (typeof ROUTING_RESULTS)[number];
export type RoutingTaskStatus = (typeof ROUTING_TASK_STATUSES)[number];
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export type ApproachCategory = (typeof APPROACH_CATEGORIES)[number];

export interface RoutingPolicy {
  schema_version: typeof ROUTING_POLICY_SCHEMA_VERSION;
  mode: ExecutionMode;
  standard_slot_ceiling: number;
  low_usage_delegate_ceiling: number;
  escalation: "automatic" | "requires-user-approval" | "prohibited";
  host_mappings: Record<string, Record<"low_cost" | "standard" | "high_reasoning", string>>;
}

export interface RoutingPolicyProvenance {
  source: "default" | "user" | "project";
  digest: string;
  policy: RoutingPolicy;
}

export interface RoutingEvidence {
  attempt_id: string;
  approach: ApproachCategory;
  outcome: AttemptOutcome;
  rationale: string;
  recorded_at: string;
}

export interface RoutingTask {
  id: string;
  status: RoutingTaskStatus;
  work_class: WorkClass;
  result: RoutingResult;
  recommendation: "low_cost" | "standard" | "high_reasoning";
  rationale: string;
  read_scopes: string[];
  write_scopes: string[];
  host: string | null;
  model: string | null;
  policy_digest: string;
  low_usage_attestation: string | null;
  evidence: RoutingEvidence[];
  created_at: string;
  updated_at: string;
}

export interface RoutingRecord {
  schema_version: typeof ROUTING_RECORD_SCHEMA_VERSION;
  tasks: RoutingTask[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SENSITIVE_PATTERN = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]|-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----|\b(?:ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~-]{20,})/iu;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./iu;
const SOURCE_LIKE_PATTERN = /(?:^|\n)\s*(?:import |export |function |class |const |let |var |diff --git|@@ )/u;

export function defaultRoutingPolicy(): RoutingPolicy {
  return {
    schema_version: ROUTING_POLICY_SCHEMA_VERSION,
    mode: "standard",
    standard_slot_ceiling: 3,
    low_usage_delegate_ceiling: 1,
    escalation: "requires-user-approval",
    host_mappings: {},
  };
}

export function digestRoutingPolicy(policy: RoutingPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function parseRoutingPolicy(source: string): RoutingPolicy {
  return validateRoutingPolicy(parseJson(source, "Routing policy"));
}

export function validateRoutingPolicy(value: unknown): RoutingPolicy {
  const record = requireRecord(value, "Routing policy");
  assertExactKeys(record, ["schema_version", "mode", "standard_slot_ceiling", "low_usage_delegate_ceiling", "escalation", "host_mappings"], "Routing policy");
  if (record.schema_version !== ROUTING_POLICY_SCHEMA_VERSION) throw invalid("Unsupported routing policy schema");
  if (!EXECUTION_MODES.includes(record.mode as ExecutionMode)) throw invalid("Routing policy mode is invalid");
  if (!Number.isSafeInteger(record.standard_slot_ceiling) || (record.standard_slot_ceiling as number) < 1 || (record.standard_slot_ceiling as number) > 32) throw invalid("Routing policy standard_slot_ceiling must be 1-32");
  if (!Number.isSafeInteger(record.low_usage_delegate_ceiling) || (record.low_usage_delegate_ceiling as number) < 0 || (record.low_usage_delegate_ceiling as number) > 1) throw invalid("Routing policy low_usage_delegate_ceiling must be 0 or 1");
  if (!["automatic", "requires-user-approval", "prohibited"].includes(String(record.escalation))) throw invalid("Routing policy escalation is invalid");
  const mappings = requireRecord(record.host_mappings, "Routing policy host_mappings");
  const hostMappings: RoutingPolicy["host_mappings"] = {};
  for (const [host, mapping] of Object.entries(mappings)) {
    assertSafeShortString(host, "Routing policy host");
    const tiers = requireRecord(mapping, "Routing policy host mapping");
    assertExactKeys(tiers, ["low_cost", "standard", "high_reasoning"], "Routing policy host mapping");
    hostMappings[host] = {
      low_cost: requireShortString(tiers.low_cost, "Routing policy low_cost mapping"),
      standard: requireShortString(tiers.standard, "Routing policy standard mapping"),
      high_reasoning: requireShortString(tiers.high_reasoning, "Routing policy high_reasoning mapping"),
    };
  }
  return { schema_version: ROUTING_POLICY_SCHEMA_VERSION, mode: record.mode as ExecutionMode, standard_slot_ceiling: record.standard_slot_ceiling as number, low_usage_delegate_ceiling: record.low_usage_delegate_ceiling as number, escalation: record.escalation as RoutingPolicy["escalation"], host_mappings: hostMappings };
}

export function emptyRoutingRecord(): RoutingRecord {
  return { schema_version: ROUTING_RECORD_SCHEMA_VERSION, tasks: [] };
}

export function parseRoutingRecord(source: string): RoutingRecord {
  return validateRoutingRecord(parseJson(source, "Routing record"));
}

export function serializeRoutingRecord(record: RoutingRecord): string {
  return `${JSON.stringify(validateRoutingRecord(record), null, 2)}\n`;
}

export function validateRoutingRecord(value: unknown): RoutingRecord {
  const record = requireRecord(value, "Routing record");
  assertExactKeys(record, ["schema_version", "tasks"], "Routing record");
  if (record.schema_version !== ROUTING_RECORD_SCHEMA_VERSION) throw invalid("Unsupported routing record schema");
  if (!Array.isArray(record.tasks) || record.tasks.length > 100) throw invalid("Routing record tasks must contain at most 100 entries");
  const tasks = record.tasks.map(validateRoutingTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw invalid("Routing record task IDs must be unique");
  return { schema_version: ROUTING_RECORD_SCHEMA_VERSION, tasks };
}

export function validateRoutingTask(value: unknown): RoutingTask {
  const task = requireRecord(value, "Routing task");
  assertExactKeys(task, ["id", "status", "work_class", "result", "recommendation", "rationale", "read_scopes", "write_scopes", "host", "model", "policy_digest", "low_usage_attestation", "evidence", "created_at", "updated_at"], "Routing task");
  const id = requireShortString(task.id, "Routing task id");
  if (!ID_PATTERN.test(id)) throw invalid("Routing task id is invalid");
  if (!ROUTING_TASK_STATUSES.includes(task.status as RoutingTaskStatus)) throw invalid("Routing task status is invalid");
  if (!WORK_CLASSES.includes(task.work_class as WorkClass)) throw invalid("Routing task work_class is invalid");
  if (!ROUTING_RESULTS.includes(task.result as RoutingResult)) throw invalid("Routing task result is invalid");
  if (!["low_cost", "standard", "high_reasoning"].includes(String(task.recommendation))) throw invalid("Routing task recommendation is invalid");
  const evidence = requireArray(task.evidence, "Routing task evidence", 32).map(validateEvidence);
  const readScopes = requireSafeScopes(task.read_scopes, "Routing task read_scopes");
  const writeScopes = requireSafeScopes(task.write_scopes, "Routing task write_scopes");
  const createdAt = requireTimestamp(task.created_at, "Routing task created_at");
  const updatedAt = requireTimestamp(task.updated_at, "Routing task updated_at");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw invalid("Routing task updated_at cannot precede created_at");
  const policyDigest = requireShortString(task.policy_digest, "Routing task policy_digest");
  if (!/^[a-f0-9]{64}$/u.test(policyDigest)) throw invalid("Routing task policy_digest must be a SHA-256 digest");
  return { id, status: task.status as RoutingTaskStatus, work_class: task.work_class as WorkClass, result: task.result as RoutingResult, recommendation: task.recommendation as RoutingTask["recommendation"], rationale: requireSafeRationale(task.rationale, "Routing task rationale"), read_scopes: readScopes, write_scopes: writeScopes, host: nullableShortString(task.host, "Routing task host"), model: nullableShortString(task.model, "Routing task model"), policy_digest: policyDigest, low_usage_attestation: nullableRationale(task.low_usage_attestation, "Routing task low_usage_attestation"), evidence, created_at: createdAt, updated_at: updatedAt };
}

export function recommendationFor(workClass: WorkClass): RoutingTask["recommendation"] {
  return workClass === "light" ? "low_cost" : workClass === "medium" ? "standard" : "high_reasoning";
}

export function assessRoutingTask(input: Omit<RoutingTask, "result" | "recommendation" | "policy_digest" | "evidence" | "status" | "created_at" | "updated_at"> & { evidence?: RoutingEvidence[] }, policy: RoutingPolicy): Pick<RoutingTask, "result" | "recommendation" | "rationale"> {
  const recommendation = recommendationFor(input.work_class);
  if (policy.mode === "low-usage" && input.low_usage_attestation === null) return { result: "do-not-delegate", recommendation, rationale: "Low-usage mode requires a concise delegate benefit/cost attestation." };
  if (input.work_class === "heavy" && policy.escalation === "prohibited") return { result: "manual-choice-required", recommendation, rationale: "Policy prohibits high-reasoning escalation." };
  if (input.work_class === "heavy" && policy.escalation === "requires-user-approval") return { result: "requires-user-approval", recommendation, rationale: "High-reasoning escalation crosses the configured approval boundary." };
  if (input.host !== null && policy.host_mappings[input.host] === undefined) return { result: "manual-choice-required", recommendation, rationale: "No configured mapping exists for the supplied host." };
  return { result: "recommended", recommendation, rationale: "The task is within the configured advisory policy." };
}

export function normalizeScope(repositoryRoot: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512 || /[\0-\x1f\x7f]/u.test(candidate)) throw invalid("Routing scope is invalid");
  if (/[\*?\[\]{}]/u.test(candidate) || path.isAbsolute(candidate)) throw invalid("Routing scope must be a non-glob repository-relative path");
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(root, candidate);
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw invalid("Routing scope escapes the repository");
  return relative.length === 0 ? "." : relative.split(path.sep).join("/").toLocaleLowerCase();
}

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function validateEvidence(value: unknown): RoutingEvidence {
  const evidence = requireRecord(value, "Routing evidence");
  assertExactKeys(evidence, ["attempt_id", "approach", "outcome", "rationale", "recorded_at"], "Routing evidence");
  const attemptId = requireShortString(evidence.attempt_id, "Routing evidence attempt_id");
  if (!ID_PATTERN.test(attemptId)) throw invalid("Routing evidence attempt_id is invalid");
  if (!APPROACH_CATEGORIES.includes(evidence.approach as ApproachCategory)) throw invalid("Routing evidence approach is invalid");
  if (!ATTEMPT_OUTCOMES.includes(evidence.outcome as AttemptOutcome)) throw invalid("Routing evidence outcome is invalid");
  return { attempt_id: attemptId, approach: evidence.approach as ApproachCategory, outcome: evidence.outcome as AttemptOutcome, rationale: requireSafeRationale(evidence.rationale, "Routing evidence rationale"), recorded_at: requireTimestamp(evidence.recorded_at, "Routing evidence recorded_at") };
}

function requireSafeScopes(value: unknown, label: string): string[] {
  const scopes = requireArray(value, label, 32).map((scope) => requireShortString(scope, label));
  if (scopes.some((scope) => scope !== "." && (scope.startsWith("/") || scope.includes("\\") || scope.includes("..") || /[\*?\[\]{}]/u.test(scope)))) throw invalid(`${label} contains an unsafe normalized scope`);
  return [...new Set(scopes)].sort();
}

function requireArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(`${label} must be an array with at most ${maximum} entries`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseJson(source: string, label: string): unknown {
  if (Buffer.byteLength(source, "utf8") > 128 * 1024) throw invalid(`${label} exceeds the 128 KiB limit`);
  try { return JSON.parse(source) as unknown; } catch { throw invalid(`${label} is not valid JSON`); }
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...expected].sort())) throw invalid(`${label} has missing or unknown fields`);
}

function requireShortString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw invalid(`${label} must be a safe non-empty string`);
  return value;
}

function assertSafeShortString(value: string, label: string): void { void requireShortString(value, label); }
function nullableShortString(value: unknown, label: string): string | null { return value === null ? null : requireShortString(value, label); }
function requireTimestamp(value: unknown, label: string): string { const timestamp = requireShortString(value, label); if (!ISO_PATTERN.test(timestamp) || new Date(timestamp).toISOString() !== timestamp) throw invalid(`${label} must be an ISO UTC timestamp`); return timestamp; }
function nullableRationale(value: unknown, label: string): string | null { return value === null ? null : requireSafeRationale(value, label); }
function requireSafeRationale(value: unknown, label: string): string { const text = requireShortString(value, label); if (text.includes("\n") || SENSITIVE_PATTERN.test(text) || URL_PATTERN.test(text) || SOURCE_LIKE_PATTERN.test(text)) throw invalid(`${label} contains unsafe content`); return text; }
function invalid(message: string): StoryStackError { return new StoryStackError(message, "INVALID_ROUTING"); }
