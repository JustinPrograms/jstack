import type { CheckpointMetadata, GitSnapshot, ReconciliationResult } from "./types.js";
import { repositoryIdentity } from "./identifiers.js";

export function reconcileCheckpoint(
  metadata: CheckpointMetadata,
  currentSnapshot: GitSnapshot,
): ReconciliationResult {
  if (metadata.repository_id !== repositoryIdentity(currentSnapshot.repositoryRoot)) {
    return {
      status: "missing-required-information",
      reasons: ["The checkpoint repository identity does not match the active repository."],
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
  if (metadata.changed_file_count !== currentSnapshot.changedFileCount) {
    reasons.push("Recorded changed-file count does not match Git.");
  }
  if (metadata.untracked_file_count !== currentSnapshot.untrackedFileCount) {
    reasons.push("Recorded untracked-file count does not match Git.");
  }
  const validationIsCurrent = metadata.last_validation_fingerprint === currentSnapshot.worktreeFingerprint;
  return {
    status: reasons.length === 0 ? "current" : "stale-but-reconcilable",
    reasons,
    currentSnapshot,
    validationIsCurrent,
  };
}
