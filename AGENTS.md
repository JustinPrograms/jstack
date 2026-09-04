# Agent contribution guide

This repository is maintained with parallel AI-assisted work. Treat each implementation task as an isolated, reviewable change.

## Scope and safety

- Work only on the task you were given. Preserve all existing staged, unstaged, and untracked files that are outside that task.
- Never "clean up" a dirty checkout with `git reset --hard`, `git checkout --`, `git clean`, or by deleting files you did not create for the task.
- Do not work directly on `main`. Do not amend, rebase, force-push, or overwrite another agent's branch unless the task explicitly requires it.
- Run the narrowest relevant checks before each commit; run the full test suite when the change or task warrants it.
- Follow the repository's existing code, test, and documentation conventions. Keep changes small and avoid unrelated refactors.

## Required worktree workflow

For code or documentation changes, use a dedicated worktree and branch. The primary checkout may contain another agent's in-progress work and must be treated as read-only.

1. From the primary checkout, inspect `git status --short --branch` and fetch the target base branch.
2. Create a uniquely named branch and worktree outside the primary checkout, based on the current target branch. For example, for `main`:

   ```powershell
   git fetch origin main
   New-Item -ItemType Directory -Force ..\justinstack-worktrees | Out-Null
   git worktree add -b agent/<topic> ..\justinstack-worktrees\<topic> origin/main
   ```

3. Make, test, and inspect changes only inside that worktree. Keep generated artifacts out of commits unless the repository convention requires them.
4. Before committing, inspect the exact staged diff with `git diff --cached`, verify `git diff --check`, and confirm `git status --short` contains only task files.

## Commit and push policy

The repository owner has authorized agents performing implementation work here to create atomic commits and push their own task branches as progress reaches a tested, coherent checkpoint.

- Use concise conventional commit messages, such as `feat: add checkpoint bundle validation` or `docs: document agent worktree workflow`.
- Do not bundle unrelated work into a commit. Never stage another agent's changes.
- Push each completed checkpoint with `git push -u origin agent/<topic>`. Later commits can use `git push`.
- Report the branch name, commit SHA, checks run, and any checks not run. A push is not a merge.
- Do not create, merge, approve, close, or modify a pull request unless the current task explicitly asks for that remote action. Never force-push.

## Merge verification and cleanup

Keep the worktree after pushing so the branch remains available for review and follow-up. Remove it only after its commits have been merged into the intended remote target and that merge has been independently verified:

```powershell
git fetch origin main
git merge-base --is-ancestor agent/<topic> origin/main
```

If the command succeeds, from any checkout outside the task worktree remove only that exact worktree and then prune stale metadata:

```powershell
git worktree remove ..\justinstack-worktrees\<topic>
git worktree prune
```

If it has not merged, leave the worktree and branch intact. Do not delete a branch merely because it was pushed. After a verified merge, delete the local branch only when it is fully merged and no longer needed:

```powershell
git branch -d agent/<topic>
```

## JustinStack-specific guidance

The product's shipped skills have their own safety contract. Do not change their canonical policy merely to accommodate this contributor workflow. This file governs repository-maintenance agents acting under the owner's explicit authorization; installed end-user workflows must retain their documented safety guarantees.
