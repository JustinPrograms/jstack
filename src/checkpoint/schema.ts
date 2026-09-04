import { StoryStackError } from "../errors.js";
import path from "node:path";
import {
  SCHEMA_VERSION,
  TICKET_STATUSES,
  type CheckpointMetadata,
  type TicketStatus,
} from "./types.js";
import { assertProjectSlug, assertTicketKey } from "./identifiers.js";
import { assertSafeBranchName } from "./branch.js";

export const REQUIRED_SECTIONS = [
  "Objective",
  "Acceptance criteria",
  "Non-goals",
  "Approved plan",
  "Completed work",
  "Current work",
  "Exact next action",
  "Files inspected",
  "Files changed and why",
  "Decisions and rationale",
  "Assumptions",
  "Test and validation results",
  "Review feedback addressed",
  "Pending review feedback",
  "Blockers and questions",
  "Required user approvals",
] as const;

const METADATA_KEYS = [
  "schema_version",
  "project_slug",
  "ticket_key",
  "repository_path",
  "current_branch",
  "base_branch",
  "head_commit",
  "worktree_fingerprint",
  "ticket_status",
  "created_at",
  "updated_at",
  "git_dirty",
  "changed_file_summary",
  "changed_file_count",
  "untracked_files",
  "untracked_file_count",
  "last_validation_at",
  "last_validation_fingerprint",
] as const satisfies readonly (keyof CheckpointMetadata)[];

export const METADATA_KEY_ORDER: readonly (keyof CheckpointMetadata)[] = METADATA_KEYS;

function requireString(record: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new StoryStackError(`Checkpoint metadata '${key}' must be a non-empty string`, "INVALID_CHECKPOINT");
  }
  if (value.length > 4096 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    throw new StoryStackError(`Checkpoint metadata '${key}' contains unsupported characters or is too long`, "INVALID_CHECKPOINT");
  }
  return value;
}

function requireNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    throw new StoryStackError(`Checkpoint metadata '${key}' must be a string or null`, "INVALID_CHECKPOINT");
  }
  return value as string | null;
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new StoryStackError(`Checkpoint metadata '${key}' must be an array of strings`, "INVALID_CHECKPOINT");
  }
  if (value.length > 1000 || value.some((item) => item.length > 4096 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(item))) {
    throw new StoryStackError(`Checkpoint metadata '${key}' exceeds safe size or character limits`, "INVALID_CHECKPOINT");
  }
  return [...value] as string[];
}

function assertIsoTimestamp(value: string, key: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new StoryStackError(`Checkpoint metadata '${key}' must be an ISO-8601 UTC timestamp`, "INVALID_CHECKPOINT");
  }
}

function assertFingerprint(value: string | null, key: string): void {
  if (value !== null && !/^[a-f0-9]{64}$/.test(value)) {
    throw new StoryStackError(`Checkpoint metadata '${key}' must be a SHA-256 hex digest or null`, "INVALID_CHECKPOINT");
  }
}

export function validateMetadata(record: Record<string, unknown>): CheckpointMetadata {
  const unknown = Object.keys(record).filter((key) => !METADATA_KEYS.includes(key as keyof CheckpointMetadata));
  if (unknown.length > 0) {
    throw new StoryStackError(`Checkpoint has unknown metadata: ${unknown.join(", ")}`, "INVALID_CHECKPOINT");
  }
  const missing = METADATA_KEYS.filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new StoryStackError(`Checkpoint is missing metadata: ${missing.join(", ")}`, "INVALID_CHECKPOINT");
  }
  if (record.schema_version !== SCHEMA_VERSION) {
    throw new StoryStackError(
      `Unsupported checkpoint schema '${String(record.schema_version)}'; expected ${SCHEMA_VERSION}`,
      "UNSUPPORTED_SCHEMA",
    );
  }
  const projectSlug = requireString(record, "project_slug");
  const ticketKey = requireString(record, "ticket_key");
  assertProjectSlug(projectSlug);
  assertTicketKey(ticketKey);
  const repositoryPath = requireString(record, "repository_path");
  if (!pathIsAbsoluteNormalized(repositoryPath)) {
    throw new StoryStackError("Checkpoint repository_path must be an absolute normalized path", "INVALID_CHECKPOINT");
  }
  const currentBranch = requireString(record, "current_branch");
  const baseBranch = requireString(record, "base_branch");
  assertSafeBranchName(currentBranch, { allowDetached: true });
  assertSafeBranchName(baseBranch);
  const headCommit = requireNullableString(record, "head_commit");
  if (headCommit !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headCommit)) {
    throw new StoryStackError("Checkpoint head_commit must be a 40- or 64-character Git object id or null", "INVALID_CHECKPOINT");
  }
  const fingerprint = requireString(record, "worktree_fingerprint");
  assertFingerprint(fingerprint, "worktree_fingerprint");
  const ticketStatus = requireString(record, "ticket_status") as TicketStatus;
  if (!TICKET_STATUSES.includes(ticketStatus)) {
    throw new StoryStackError(`Checkpoint ticket_status '${ticketStatus}' is not supported`, "INVALID_CHECKPOINT");
  }
  const createdAt = requireString(record, "created_at");
  const updatedAt = requireString(record, "updated_at");
  assertIsoTimestamp(createdAt, "created_at");
  assertIsoTimestamp(updatedAt, "updated_at");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new StoryStackError("Checkpoint updated_at cannot be earlier than created_at", "INVALID_CHECKPOINT");
  }
  if (typeof record.git_dirty !== "boolean") {
    throw new StoryStackError("Checkpoint metadata 'git_dirty' must be a boolean", "INVALID_CHECKPOINT");
  }
  const changedFiles = requireStringArray(record, "changed_file_summary");
  if (!Number.isSafeInteger(record.changed_file_count) || (record.changed_file_count as number) < changedFiles.length) {
    throw new StoryStackError(
      "Checkpoint changed_file_count must be a non-negative integer at least as large as the stored summary",
      "INVALID_CHECKPOINT",
    );
  }
  const untrackedFiles = requireStringArray(record, "untracked_files");
  if (!Number.isSafeInteger(record.untracked_file_count) || (record.untracked_file_count as number) < untrackedFiles.length) {
    throw new StoryStackError(
      "Checkpoint untracked_file_count must be a non-negative integer at least as large as the stored name list",
      "INVALID_CHECKPOINT",
    );
  }
  if (
    record.git_dirty === false &&
    (changedFiles.length > 0 ||
      (record.changed_file_count as number) > 0 ||
      untrackedFiles.length > 0 ||
      (record.untracked_file_count as number) > 0)
  ) {
    throw new StoryStackError("A clean checkpoint cannot contain changed or untracked file metadata", "INVALID_CHECKPOINT");
  }
  const lastValidationAt = requireNullableString(record, "last_validation_at");
  const lastValidationFingerprint = requireNullableString(record, "last_validation_fingerprint");
  if ((lastValidationAt === null) !== (lastValidationFingerprint === null)) {
    throw new StoryStackError(
      "last_validation_at and last_validation_fingerprint must either both be set or both be null",
      "INVALID_CHECKPOINT",
    );
  }
  if (lastValidationAt !== null) assertIsoTimestamp(lastValidationAt, "last_validation_at");
  assertFingerprint(lastValidationFingerprint, "last_validation_fingerprint");

  return {
    schema_version: SCHEMA_VERSION,
    project_slug: projectSlug,
    ticket_key: ticketKey,
    repository_path: repositoryPath,
    current_branch: currentBranch,
    base_branch: baseBranch,
    head_commit: headCommit,
    worktree_fingerprint: fingerprint,
    ticket_status: ticketStatus,
    created_at: createdAt,
    updated_at: updatedAt,
    git_dirty: record.git_dirty,
    changed_file_summary: changedFiles,
    changed_file_count: record.changed_file_count as number,
    untracked_files: untrackedFiles,
    untracked_file_count: record.untracked_file_count as number,
    last_validation_at: lastValidationAt,
    last_validation_fingerprint: lastValidationFingerprint,
  };
}

export function normalizeMarkdownBody(body: string): string {
  return `${body.replace(/\r\n?/g, "\n").trim()}\n`;
}

export function validatePrivacySafeMarkdown(body: string): string {
  const normalized = normalizeMarkdownBody(body);
  if (normalized.startsWith("---\n")) {
    throw new StoryStackError("Provide only the Markdown body; YAML frontmatter is engine-owned", "INVALID_CHECKPOINT");
  }
  if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(normalized)) {
    throw new StoryStackError("Checkpoint body contains unsupported control characters", "INVALID_CHECKPOINT");
  }
  if (/```|~~~/u.test(normalized)) {
    throw new StoryStackError("Checkpoint bodies cannot contain fenced code blocks; summarize code changes instead", "PRIVACY_GUARD");
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\//iu.test(normalized) || /\bwww\./iu.test(normalized)) {
    throw new StoryStackError("Checkpoint bodies cannot contain URLs; record a generic reference instead", "PRIVACY_GUARD");
  }
  if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/u.test(normalized)) {
    throw new StoryStackError("Checkpoint body appears to contain credential material", "PRIVACY_GUARD");
  }
  if (/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/iu.test(normalized)) {
    throw new StoryStackError("Checkpoint body appears to contain a credential or secret", "PRIVACY_GUARD");
  }
  if (/\b(?:ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/u.test(normalized)) {
    throw new StoryStackError("Checkpoint body appears to contain a credential or access token", "PRIVACY_GUARD");
  }
  if (Buffer.byteLength(normalized, "utf8") > 128 * 1024) {
    throw new StoryStackError("Checkpoint body exceeds the 128 KiB snapshot limit", "CHECKPOINT_TOO_LARGE");
  }
  return normalized;
}

export function validateMarkdownBody(body: string): string {
  const normalized = validatePrivacySafeMarkdown(body);
  let previousIndex = -1;
  const allowedHeadings = new Set<string>(REQUIRED_SECTIONS);
  const observedHeadings = [...normalized.matchAll(/^## (.+)$/gmu)].map((match) => match[1] ?? "");
  const extraHeadings = observedHeadings.filter((heading) => !allowedHeadings.has(heading));
  if (extraHeadings.length > 0) {
    throw new StoryStackError(`Checkpoint body has unsupported level-2 headings: ${extraHeadings.join(", ")}`, "INVALID_CHECKPOINT");
  }
  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "gmu");
    const matches = [...normalized.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new StoryStackError(`Checkpoint body must contain exactly one '## ${section}' heading`, "INVALID_CHECKPOINT");
    }
    const index = matches[0]?.index ?? -1;
    if (index <= previousIndex) {
      throw new StoryStackError("Checkpoint sections must remain in template order", "INVALID_CHECKPOINT");
    }
    previousIndex = index;
  }
  return normalized;
}

function pathIsAbsoluteNormalized(value: string): boolean {
  if (/[\0-\x1f\x7f]/u.test(value) || !path.isAbsolute(value)) return false;
  return path.normalize(value) === value && !/(?:^|[\\/])\.\.?(?:[\\/]|$)/u.test(value);
}

export function extractSection(body: string, section: (typeof REQUIRED_SECTIONS)[number]): string {
  const lines = normalizeMarkdownBody(body).split("\n");
  const heading = `## ${section}`;
  const start = lines.findIndex((line) => line === heading);
  if (start < 0) return "Not recorded.";
  const content: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.startsWith("## ")) break;
    content.push(line ?? "");
  }
  const result = content.join("\n").trim();
  return result.length > 0 ? result : "Not recorded.";
}
