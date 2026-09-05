export const LEGACY_SCHEMA_VERSION = 1 as const;
export const SCHEMA_VERSION = 2 as const;

export const TICKET_STATUSES = [
  "planning",
  "ready",
  "in-progress",
  "in-review",
  "blocked",
  "completed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface CheckpointMetadata {
  schema_version: typeof SCHEMA_VERSION;
  project_slug: string;
  ticket_key: string;
  repository_id: string;
  current_branch: string;
  base_branch: string;
  head_commit: string | null;
  worktree_fingerprint: string;
  ticket_status: TicketStatus;
  created_at: string;
  updated_at: string;
  git_dirty: boolean;
  changed_file_count: number;
  untracked_file_count: number;
  last_validation_at: string | null;
  last_validation_fingerprint: string | null;
}

export interface Checkpoint {
  metadata: CheckpointMetadata;
  body: string;
}

export const CONTINUITY_BUNDLE_SCHEMA_VERSION = 1 as const;

export const CONTINUITY_MARKDOWN_FILES = [
  "context.md",
  "decisions.md",
  "progress.md",
  "checks.md",
  "handoff.md",
] as const;

export const CONTINUITY_BUNDLE_FILES = [...CONTINUITY_MARKDOWN_FILES, "state.json"] as const;

export type ContinuityMarkdownFile = (typeof CONTINUITY_MARKDOWN_FILES)[number];
export type ContinuityBundleFile = (typeof CONTINUITY_BUNDLE_FILES)[number];

export interface ContinuityBundleState {
  schema_version: typeof CONTINUITY_BUNDLE_SCHEMA_VERSION;
  workspace_id: string;
  story_id: string;
  generation: string;
  checkpoint_metadata: CheckpointMetadata;
  files: Record<ContinuityMarkdownFile, string>;
}

export interface ContinuityBundlePaths {
  directory: string;
  lock: string;
  context: string;
  decisions: string;
  progress: string;
  checks: string;
  handoff: string;
  /** Engine-owned advisory routing record; absent until explicitly initialized. */
  routing: string;
  state: string;
}

export type ContinuityBundleHealthStatus = "current" | "repairable" | "missing-required-information";

export interface ContinuityBundleHealth {
  status: ContinuityBundleHealthStatus;
  reasons: string[];
  files: Partial<Record<ContinuityBundleFile, "current" | "missing" | "different" | "unsafe">>;
}

export interface GitSnapshot {
  repositoryRoot: string;
  currentBranch: string;
  headCommit: string | null;
  dirty: boolean;
  changedFiles: string[];
  changedFileCount: number;
  untrackedFiles: string[];
  untrackedFileCount: number;
  worktreeFingerprint: string;
}

export type ReconciliationStatus =
  | "current"
  | "stale-but-reconcilable"
  | "different-branch"
  | "missing-required-information";

export interface ReconciliationResult {
  status: ReconciliationStatus;
  reasons: string[];
  currentSnapshot: GitSnapshot | null;
  validationIsCurrent: boolean;
  bundleHealth?: ContinuityBundleHealth;
}
