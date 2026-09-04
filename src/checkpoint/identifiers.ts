import path from "node:path";
import { StoryStackError } from "../errors.js";

const PROJECT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,11}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PATH_LIKE = /[\\/\0-\x1f\x7f:%]/;

function rejectPathLikeInput(value: string, label: string): void {
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    PATH_LIKE.test(candidate) ||
    candidate.includes("..") ||
    candidate.startsWith("~") ||
    path.isAbsolute(candidate) ||
    /^[a-zA-Z]:/.test(candidate) ||
    candidate.endsWith(".")
  ) {
    throw new StoryStackError(`${label} contains unsafe path syntax`, "UNSAFE_IDENTIFIER");
  }
}

export function sanitizeProjectSlug(value: string): string {
  rejectPathLikeInput(value, "Project slug");
  const result = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  assertProjectSlug(result);
  return result;
}

export function sanitizeTicketKey(value: string): string {
  rejectPathLikeInput(value, "Ticket key");
  const result = value
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  assertTicketKey(result);
  return result;
}

export function assertProjectSlug(value: string): void {
  if (!PROJECT_PATTERN.test(value) || WINDOWS_RESERVED.test(value)) {
    throw new StoryStackError(
      "Project slug must be 1-63 lowercase letters, digits, or interior hyphens and cannot be a reserved device name",
      "INVALID_PROJECT_SLUG",
    );
  }
}

export function assertTicketKey(value: string): void {
  if (!TICKET_PATTERN.test(value)) {
    throw new StoryStackError(
      "Ticket key must look like STORY-123 using uppercase letters/digits and a positive numeric suffix",
      "INVALID_TICKET_KEY",
    );
  }
}

export function resolveContained(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...segments);
  const relative = path.relative(resolvedBase, target);
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    return target;
  }
  throw new StoryStackError("Resolved path escapes the story-stack state root", "PATH_TRAVERSAL");
}

export function checkpointPath(stateRoot: string, projectSlug: string, ticketKey: string): string {
  assertProjectSlug(projectSlug);
  assertTicketKey(ticketKey);
  return resolveContained(stateRoot, projectSlug, ticketKey, "context.md");
}
