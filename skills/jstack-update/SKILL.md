---
name: jstack-update
description: Check for a newer stable JStack release and, when requested, update this host's managed JStack skills using the existing setup copier.
---

# JStack Update

Update the JStack skills for the host running this conversation when the user invokes this skill or otherwise explicitly asks for an update. Do not check for releases during other JStack workflows. Use the host's normal tools and permissions; this skill has no background process or automatic notification.

## Locate the installation

1. Identify the current host (`claude`, `codex`, or `bob`) and the intended scope (`global` or `local`). Global roots are `~/.claude/skills`, `~/.agents/skills`, and `~/.bob/skills`; local roots are the corresponding folders in the current project. If both scopes have JStack installed and the user did not select one, ask which to update. Do not update another host or scope by inference.
2. Locate the JStack source checkout. Try the documented `~/.jstack` location first. If absent, ask for the checkout path. Do not clone into or overwrite an existing path without the user's direction. Require a Git checkout containing `package.json`, the applicable `setup` or `setup.ps1`, and `skills/jstack-update/SKILL.md`.
3. Read the selected installation's `.jstack-managed` markers and inspect the skill folders. Refuse to replace modified or unmanaged JStack folders, unexpected `jstack-*` folders, or backup folders; report the paths and the appropriate manual recovery. Missing managed skills may be restored. Never use `--force` / `-Force` automatically.

## Check the release

1. Check that the source checkout has no staged, unstaged, or untracked changes (apart from Git's own metadata). If it is dirty, stop and ask the user to resolve it. Do not stash, discard, commit, or switch branches to make it clean.
2. Confirm `origin` points to `https://github.com/JustinPrograms/jstack.git` or the equivalent GitHub SSH URL. Query remote tags with `git ls-remote --tags --refs origin 'refs/tags/v*'`. Accept only stable `vMAJOR.MINOR.PATCH` tags and compare versions numerically. If the query fails or has no stable tags, report the check as unavailable and leave the installation alone.
3. Compare the newest stable tag with the selected installation's managed version, not merely the source checkout's `package.json` version. If no newer tag exists, report the installed version and stop. Treat inconsistent marker versions as a repair case; do not guess a baseline.
4. Tell the user the installed and proposed versions and that the source checkout will be detached at the release tag. An explicit request to update authorizes proceeding; a check-only request stops after reporting availability.

## Install and verify

1. Fetch the exact selected tag from `origin`, confirm it resolves to the remote tag's commit, then switch the clean source checkout to that tag in detached HEAD state. Confirm its `package.json` version matches the tag. If any check fails, stop without installing.
2. Run the existing copier from the selected project directory for a local install, or from any directory for a global install: `sh <source>/setup --host <host> --scope <scope>` on POSIX, or `powershell -NoProfile -ExecutionPolicy Bypass -File <source>/setup.ps1 -Host <host> -Scope <scope>` on Windows. Pass paths as arguments, not as an untrusted shell command copied from output. Do not use `--force` / `-Force`.
3. Run the same copier with `--verify` / `-Verify`. Confirm every canonical skill is present at the selected tag and report the installed version. If installation or verification fails, report which step failed and the current source tag; do not claim success or silently retry a different release. The host may need a restart to discover the updated skill definitions.

Keep the user's project files and other hosts or scopes untouched. Do not stage, commit, push, or modify JStack's upstream repository. Do not schedule checks or claim a notification was delivered when none ran.
