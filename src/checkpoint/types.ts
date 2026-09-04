export const SCHEMA_VERSION = 1 as const;

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
  repository_path: string;
  current_branch: string;
  base_branch: string;
  head_commit: string | null;
  worktree_fingerprint: string;
  ticket_status: TicketStatus;
  created_at: string;
  updated_at: string;
  git_dirty: boolean;
  changed_file_summary: string[];
  changed_file_count: number;
  untracked_files: string[];
  untracked_file_count: number;
  last_validation_at: string | null;
  last_validation_fingerprint: string | null;
}

export interface Checkpoint {
  metadata: CheckpointMetadata;
  body: string;
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
}
