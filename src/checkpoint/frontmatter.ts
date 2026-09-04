import { StoryStackError } from "../errors.js";
import { METADATA_KEY_ORDER, validateMarkdownBody, validateMetadata } from "./schema.js";
import type { Checkpoint, CheckpointMetadata } from "./types.js";

function parseYamlScalar(raw: string, key: string): unknown {
  const value = raw.trim();
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
  if (value.startsWith('"') || value.startsWith("[")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new StoryStackError(`Checkpoint metadata '${key}' is not valid JSON-style YAML`, "INVALID_CHECKPOINT");
    }
  }
  throw new StoryStackError(`Checkpoint metadata '${key}' must use an explicit JSON-style scalar`, "INVALID_CHECKPOINT");
}

function serializeYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function parseCheckpoint(source: string): Checkpoint {
  if (Buffer.byteLength(source, "utf8") > 256 * 1024) {
    throw new StoryStackError("Checkpoint exceeds the 256 KiB file limit", "CHECKPOINT_TOO_LARGE");
  }
  const normalized = source.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new StoryStackError("Checkpoint must begin with YAML frontmatter", "INVALID_CHECKPOINT");
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new StoryStackError("Checkpoint YAML frontmatter is not terminated", "INVALID_CHECKPOINT");
  }
  const rawMetadata = normalized.slice(4, end);
  const record: Record<string, unknown> = {};
  for (const line of rawMetadata.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new StoryStackError(`Unsupported YAML frontmatter line: ${line}`, "INVALID_CHECKPOINT");
    }
    if (match[1] in record) {
      throw new StoryStackError(`Duplicate checkpoint metadata '${match[1]}'`, "INVALID_CHECKPOINT");
    }
    record[match[1]] = parseYamlScalar(match[2], match[1]);
  }
  const body = validateMarkdownBody(normalized.slice(end + 5));
  return { metadata: validateMetadata(record), body };
}

export function serializeCheckpoint(checkpoint: Checkpoint): string {
  const metadata = validateMetadata(checkpoint.metadata as unknown as Record<string, unknown>);
  const body = validateMarkdownBody(checkpoint.body);
  const lines = METADATA_KEY_ORDER.map((key) => `${key}: ${serializeYamlScalar(metadata[key])}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

export function metadataEqualsExceptUpdatedAt(a: CheckpointMetadata, b: CheckpointMetadata): boolean {
  const left = { ...a, updated_at: "" };
  const right = { ...b, updated_at: "" };
  return JSON.stringify(left) === JSON.stringify(right);
}
