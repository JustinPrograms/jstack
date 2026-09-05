# Claude Code instructions

Read and follow [AGENTS.md](AGENTS.md) for the repository's complete contribution workflow. It is the shared source of truth for Claude Code, Codex, and other coding agents.

In particular, make changes in a dedicated `.worktree/<topic>` checkout on an `agent/<topic>` branch rather than the primary checkout, and preserve unrelated dirty files. The repository-local `.worktree/` directory is ignored. Never push or mutate a remote service. Do not stage, commit, remove a worktree, or delete a branch unless the user explicitly requests that exact local action in the current conversation.
