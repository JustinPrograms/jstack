# Agent contribution guide

This repository is maintained with parallel AI-assisted work. Treat each implementation task as an isolated, reviewable change.

## Scope and safety

- Work only on the task you were given. Preserve all existing staged, unstaged, and untracked files that are outside that task.
- Never "clean up" a dirty checkout with `git reset --hard`, `git checkout --`, `git clean`, or by deleting files you did not create for the task.
- Do not work directly on `main`. Do not amend, rebase, force-push, or overwrite another agent's branch.
- Run the narrowest relevant checks before handoff; run the full test suite when the change or task warrants it.
- Follow the repository's existing code, test, and documentation conventions. Keep changes small and avoid unrelated refactors.

## Required worktree workflow

For code or documentation changes, use a dedicated worktree and branch beneath the repository-local `.worktree/` directory. The primary checkout may contain another agent's in-progress work and must be treated as read-only.

1. From the primary checkout, inspect `git status --short --branch`. Remote retrieval such as `git fetch` is read-only but must still be relevant to the current request and allowed by the active environment.
2. Create a uniquely named branch and worktree beneath `.worktree/`, based on the intended local target branch. For example, for `main`:

   ```powershell
   New-Item -ItemType Directory -Force .worktree | Out-Null
   git worktree add -b agent/<topic> .worktree/<topic> main
   ```

3. Make, test, and inspect changes only inside that worktree. `.worktree/` is ignored and must never be committed. Keep generated artifacts out of commits unless the repository convention requires them.
4. Before handoff, inspect the exact working-tree diff, run `git diff --check`, and confirm `git status --short` contains only task files. Do not stage as part of this check.

## Commit and remote policy

There is no standing authorization to write Git history or mutate a remote. A request to implement, review, verify, resume, or finish work is not permission to stage, commit, or push.

- Never run `git push` or mutate a remote repository, pull request, merge request, ticket, or other remote service.
- Stage or commit only when the user explicitly requests that exact local Git action in the current conversation.
- If a commit is explicitly requested, use a concise conventional message, stage only intentional files, and inspect the exact staged diff first.
- Report the worktree path, branch, changed files, checks run, and checks not run. Let the user perform every remote action.

## Merge verification and cleanup

Keep the worktree after handoff so the branch remains available for review and follow-up. Do not remove a worktree, delete a branch, or perform post-merge cleanup unless the user explicitly requests that exact local action and the target has been verified.

When cleanup is explicitly requested, run it only from a checkout outside the task worktree and target the exact verified `.worktree/<topic>` path:

```powershell
git worktree remove .worktree/<topic>
git worktree prune
```

Leave the branch intact unless the user separately asks to remove it after verifying it is no longer needed.

## JStack-specific guidance

The product's shipped skills have their own safety contract. Do not change their canonical policy merely to accommodate this contributor workflow. This file governs repository-maintenance agents acting under the owner's explicit authorization; installed end-user workflows must retain their documented safety guarantees.
