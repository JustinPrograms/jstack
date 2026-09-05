import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { StoryStackError } from "../errors.js";
import { writeFileAtomic } from "./atomic.js";
import { assertSafeWritePath, lstatOrNull, readRegularFileOrNull } from "./filesystem.js";
import { serializeCheckpoint } from "./frontmatter.js";
import { assertProjectSlug, assertTicketKey } from "./identifiers.js";
import { extractSection, validateMetadata, validatePrivacySafeMarkdown } from "./schema.js";
import {
  CONTINUITY_BUNDLE_FILES,
  CONTINUITY_BUNDLE_SCHEMA_VERSION,
  CONTINUITY_MARKDOWN_FILES,
  type Checkpoint,
  type ContinuityBundleFile,
  type ContinuityBundleHealth,
  type ContinuityBundlePaths,
  type ContinuityBundleState,
  type ContinuityMarkdownFile,
} from "./types.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_BUNDLE_STATE_BYTES = 256 * 1024;

export interface RenderedContinuityBundle {
  checkpoint: Checkpoint;
  state: ContinuityBundleState;
  files: Record<ContinuityBundleFile, string>;
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function renderProjection(
  title: string,
  checkpoint: Checkpoint,
  sections: readonly Parameters<typeof extractSection>[1][],
): string {
  const blocks = sections.map((section) => `## ${section}\n\n${extractSection(checkpoint.body, section)}`);
  return validatePrivacySafeMarkdown(
    `# ${title}\n\nGenerated from the canonical context checkpoint. Update it through the local checkpoint CLI.\n\n${blocks.join("\n\n")}`,
  );
}

function recordedDiffSummary(checkpoint: Checkpoint): string {
  const metadata = checkpoint.metadata;
  if (!metadata.git_dirty) return "Clean at the recorded checkpoint snapshot.";
  return [
    `Recorded changed-file count: ${metadata.changed_file_count}.`,
    `Recorded untracked-file count: ${metadata.untracked_file_count}.`,
  ].join("\n");
}

function recordedValidation(checkpoint: Checkpoint): string {
  const metadata = checkpoint.metadata;
  if (metadata.last_validation_at === null) return "None recorded.";
  const freshness = metadata.last_validation_fingerprint === metadata.worktree_fingerprint ? "current at snapshot" : "historical";
  return `${metadata.last_validation_at} (${freshness})\n\n${extractSection(checkpoint.body, "Test and validation results")}`;
}

function renderHandoff(checkpoint: Checkpoint): string {
  return validatePrivacySafeMarkdown(
    [
      "# Story handoff",
      "",
      "Generated from the canonical context checkpoint. Validate against the repository before continuing.",
      "",
      "## Objective",
      "",
      extractSection(checkpoint.body, "Objective"),
      "",
      "## Completed work",
      "",
      extractSection(checkpoint.body, "Completed work"),
      "",
      "## Current work",
      "",
      extractSection(checkpoint.body, "Current work"),
      "",
      "## Current local diff summary",
      "",
      recordedDiffSummary(checkpoint),
      "",
      "## Exact recommended next step",
      "",
      extractSection(checkpoint.body, "Exact next action"),
      "",
      "## Failures and unresolved questions",
      "",
      `Tests and checks:\n${extractSection(checkpoint.body, "Test and validation results")}\n\nUnresolved questions:\n${extractSection(checkpoint.body, "Blockers and questions")}`,
      "",
      "## Required user approvals",
      "",
      extractSection(checkpoint.body, "Required user approvals"),
      "",
      "## Last successful validation",
      "",
      recordedValidation(checkpoint),
    ].join("\n"),
  );
}

function cloneMetadata(metadata: Checkpoint["metadata"]): Checkpoint["metadata"] {
  return { ...metadata };
}

function serializeBundleState(state: ContinuityBundleState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function renderContinuityBundle(checkpoint: Checkpoint): RenderedContinuityBundle {
  const context = serializeCheckpoint(checkpoint);
  const decisions = renderProjection("Story decisions", checkpoint, [
    "Decisions and rationale",
    "Assumptions",
    "Required user approvals",
  ]);
  const progress = renderProjection("Story progress", checkpoint, [
    "Approved plan",
    "Completed work",
    "Current work",
    "Files inspected",
    "Files changed and why",
  ]);
  const checks = renderProjection("Story checks", checkpoint, [
    "Test and validation results",
    "Review feedback addressed",
    "Pending review feedback",
  ]);
  const handoff = renderHandoff(checkpoint);
  const markdownFiles: Record<ContinuityMarkdownFile, string> = {
    "context.md": context,
    "decisions.md": decisions,
    "progress.md": progress,
    "checks.md": checks,
    "handoff.md": handoff,
  };
  const hashes = Object.fromEntries(
    CONTINUITY_MARKDOWN_FILES.map((fileName) => [fileName, digest(markdownFiles[fileName])]),
  ) as Record<ContinuityMarkdownFile, string>;
  const state: ContinuityBundleState = {
    schema_version: CONTINUITY_BUNDLE_SCHEMA_VERSION,
    workspace_id: checkpoint.metadata.project_slug,
    story_id: checkpoint.metadata.ticket_key,
    generation: hashes["context.md"],
    checkpoint_metadata: cloneMetadata(checkpoint.metadata),
    files: hashes,
  };
  const stateSource = serializeBundleState(state);
  return {
    checkpoint,
    state,
    files: {
      ...markdownFiles,
      "state.json": stateSource,
    },
  };
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new StoryStackError(`${label} has missing or unknown fields`, "INVALID_BUNDLE_STATE");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new StoryStackError(`${label} must be a SHA-256 hex digest`, "INVALID_BUNDLE_STATE");
  }
  return value;
}

export function parseContinuityBundleState(source: string): ContinuityBundleState {
  if (Buffer.byteLength(source, "utf8") > MAX_BUNDLE_STATE_BYTES) {
    throw new StoryStackError("Continuity state exceeds the 256 KiB limit", "INVALID_BUNDLE_STATE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new StoryStackError("Continuity state is not valid JSON", "INVALID_BUNDLE_STATE");
  }
  if (!isRecord(parsed)) throw new StoryStackError("Continuity state must be a JSON object", "INVALID_BUNDLE_STATE");
  assertExactKeys(
    parsed,
    ["schema_version", "workspace_id", "story_id", "generation", "checkpoint_metadata", "files"],
    "Continuity state",
  );
  if (parsed.schema_version !== CONTINUITY_BUNDLE_SCHEMA_VERSION) {
    throw new StoryStackError(
      `Unsupported continuity state schema '${String(parsed.schema_version)}'`,
      "INVALID_BUNDLE_STATE",
    );
  }
  if (typeof parsed.workspace_id !== "string") {
    throw new StoryStackError("Continuity state workspace_id must be a string", "INVALID_BUNDLE_STATE");
  }
  if (typeof parsed.story_id !== "string") {
    throw new StoryStackError("Continuity state story_id must be a string", "INVALID_BUNDLE_STATE");
  }
  assertProjectSlug(parsed.workspace_id);
  assertTicketKey(parsed.story_id);
  const generation = requireHash(parsed.generation, "Continuity state generation");
  if (!isRecord(parsed.checkpoint_metadata)) {
    throw new StoryStackError("Continuity checkpoint_metadata must be an object", "INVALID_BUNDLE_STATE");
  }
  const metadata = validateMetadata(parsed.checkpoint_metadata);
  if (metadata.project_slug !== parsed.workspace_id || metadata.ticket_key !== parsed.story_id) {
    throw new StoryStackError("Continuity state identity does not match checkpoint metadata", "INVALID_BUNDLE_STATE");
  }
  if (!isRecord(parsed.files)) {
    throw new StoryStackError("Continuity state files must be an object", "INVALID_BUNDLE_STATE");
  }
  const filesRecord = parsed.files;
  assertExactKeys(filesRecord, CONTINUITY_MARKDOWN_FILES, "Continuity state files");
  const files = Object.fromEntries(
    CONTINUITY_MARKDOWN_FILES.map((fileName) => [
      fileName,
      requireHash(filesRecord[fileName], `Continuity state hash for ${fileName}`),
    ]),
  ) as Record<ContinuityMarkdownFile, string>;
  if (generation !== files["context.md"]) {
    throw new StoryStackError("Continuity generation must match the context hash", "INVALID_BUNDLE_STATE");
  }
  return {
    schema_version: CONTINUITY_BUNDLE_SCHEMA_VERSION,
    workspace_id: parsed.workspace_id,
    story_id: parsed.story_id,
    generation,
    checkpoint_metadata: metadata,
    files,
  };
}

function filePath(paths: ContinuityBundlePaths, fileName: ContinuityBundleFile): string {
  switch (fileName) {
    case "context.md": return paths.context;
    case "decisions.md": return paths.decisions;
    case "progress.md": return paths.progress;
    case "checks.md": return paths.checks;
    case "handoff.md": return paths.handoff;
    case "state.json": return paths.state;
  }
}

export async function inspectContinuityBundle(
  paths: ContinuityBundlePaths,
  checkpoint: Checkpoint,
): Promise<ContinuityBundleHealth> {
  const expected = renderContinuityBundle(checkpoint);
  const files: ContinuityBundleHealth["files"] = {};
  const reasons: string[] = [];
  let unsafe = false;
  for (const fileName of CONTINUITY_BUNDLE_FILES) {
    try {
      const source = await readRegularFileOrNull(filePath(paths, fileName));
      if (source === null) {
        files[fileName] = "missing";
        reasons.push(`${fileName} is missing from the continuity bundle.`);
      } else if (source !== expected.files[fileName]) {
        files[fileName] = "different";
        reasons.push(`${fileName} does not match the canonical checkpoint generation.`);
      } else {
        if (fileName === "state.json") parseContinuityBundleState(source);
        files[fileName] = "current";
      }
    } catch (error) {
      files[fileName] = "unsafe";
      unsafe = true;
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    status: unsafe ? "missing-required-information" : reasons.length > 0 ? "repairable" : "current",
    reasons,
    files,
  };
}

export async function writeBundleFileIfDifferent(
  safetyRoot: string,
  paths: ContinuityBundlePaths,
  rendered: RenderedContinuityBundle,
  fileName: ContinuityBundleFile,
  beforeRename?: () => Promise<void>,
): Promise<boolean> {
  const target = filePath(paths, fileName);
  await assertSafeWritePath(safetyRoot, target);
  const current = await readRegularFileOrNull(target);
  if (current === rendered.files[fileName]) return false;
  await writeFileAtomic(target, rendered.files[fileName], {
    ...(beforeRename === undefined ? {} : { beforeRename }),
  });
  return true;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported Windows filesystems.
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

export async function publishInitialContinuityBundle(
  safetyRoot: string,
  paths: ContinuityBundlePaths,
  rendered: RenderedContinuityBundle,
): Promise<void> {
  await assertSafeWritePath(safetyRoot, paths.context);
  const parent = path.dirname(paths.directory);
  await mkdir(parent, { recursive: true });
  await assertSafeWritePath(safetyRoot, paths.context);
  if ((await lstatOrNull(paths.directory)) !== null) {
    throw new StoryStackError(`Continuity story directory already exists: ${paths.directory}`, "CHECKPOINT_CONFLICT");
  }
  const temporaryDirectory = path.join(parent, `.${path.basename(paths.directory)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(temporaryDirectory, { mode: 0o700 });
  let published = false;
  try {
    for (const fileName of CONTINUITY_BUNDLE_FILES) {
      await writeFileAtomic(path.join(temporaryDirectory, fileName), rendered.files[fileName]);
    }
    await rename(temporaryDirectory, paths.directory);
    published = true;
    await syncDirectory(parent);
  } finally {
    if (!published) {
      for (const fileName of CONTINUITY_BUNDLE_FILES) {
        await unlink(path.join(temporaryDirectory, fileName)).catch(() => undefined);
      }
      await rmdir(temporaryDirectory).catch(() => undefined);
    }
  }
}
