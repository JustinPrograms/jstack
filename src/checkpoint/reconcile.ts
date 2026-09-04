import path from "node:path";
import type { CheckpointMetadata, GitSnapshot, ReconciliationResult } from "./types.js";

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function reconcileCheckpoint(
  metadata: CheckpointMetadata,
  currentSnapshot: GitSnapshot,
): ReconciliationResult {
  if (comparablePath(metadata.repository_path) !== comparablePath(currentSnapshot.repositoryRoot)) {
    return {
      status: "missing-required-information",
      reasons: ["The checkpoint repository path does not match the active repository."],
      currentSnapshot,
      validationIsCurrent: false,
    };
  }
  if (metadata.current_branch !== currentSnapshot.currentBranch) {
    return {
      status: "different-branch",
      reasons: [`Recorded branch '${metadata.current_branch}' differs from current branch '${currentSnapshot.currentBranch}'.`],
      currentSnapshot,
      validationIsCurrent: false,
    };
  }
  const reasons: string[] = [];
  if (metadata.head_commit !== currentSnapshot.headCommit) reasons.push("HEAD changed after the checkpoint snapshot.");
  if (metadata.worktree_fingerprint !== currentSnapshot.worktreeFingerprint) {
    reasons.push("The worktree contents or index changed after the checkpoint snapshot.");
  }
  if (metadata.git_dirty !== currentSnapshot.dirty) reasons.push("Recorded clean/dirty state does not match Git.");
  if (JSON.stringify(metadata.changed_file_summary) !== JSON.stringify(currentSnapshot.changedFiles)) {
    reasons.push("Recorded changed-file summary does not match Git.");
  }
  if (metadata.changed_file_count !== currentSnapshot.changedFileCount) {
    reasons.push("Recorded changed-file count does not match Git.");
  }
  if (
    metadata.untracked_file_count !== currentSnapshot.untrackedFileCount ||
    JSON.stringify(metadata.untracked_files) !== JSON.stringify(currentSnapshot.untrackedFiles)
  ) {
    reasons.push("Recorded untracked-file summary does not match Git.");
  }
  const validationIsCurrent = metadata.last_validation_fingerprint === currentSnapshot.worktreeFingerprint;
  return {
    status: reasons.length === 0 ? "current" : "stale-but-reconcilable",
    reasons,
    currentSnapshot,
    validationIsCurrent,
  };
}
