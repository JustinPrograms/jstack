# Claude Code instructions

Read and follow [AGENTS.md](AGENTS.md) for the repository's complete contribution workflow. It is the shared source of truth for Claude Code, Codex, and other coding agents.

In particular, make changes in a dedicated `agent/<topic>` worktree rather than the primary checkout, commit and push tested task checkpoints, preserve unrelated dirty files, and remove the worktree only after the remote merge has been verified. Do not merge or otherwise alter pull requests unless the current task explicitly requests it.
