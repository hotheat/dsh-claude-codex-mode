# Attribution

This file records where each part of this repository comes from: what was written from scratch, what was inspired by outside work, and what was adapted.

## Conventions

- `Original`: written from scratch.
- `Inspired`: shaped by an idea, structure, article, or external reference, but rewritten.
- `Adapted`: rewritten from an existing skill, plugin, or internal document with substantial changes.
- `Forked`: mostly reused from another project with small changes.

## Bundle

### dsh-claude-codex-mode (`lib/`, `cordis.patch.yml`, `scripts/`, `test/`)

- Status: Original
- Built on:
  - The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle, settings, plugin-manager, system-prompt, tool-guard, and MCP client plugin APIs. Checked against DSH 0.2.1-rc.2 on 2026-10-23.
  - The author's earlier private DSH plugin of the same name (0.2.0). That plugin is the source of the write guard and the routing prompt.
- Notes:
  - It ports the author's own Claude Code working agreement ("Claude discusses, Codex edits") to DSH.
  - It adds two modes, switchable from the Plugins page: `api` (default) and `claude-code-cli`. Every switch runs a preflight check first.
  - The bundle ships the MCP servers below, so installing it needs no other repository.

## Bundled MCP servers

Both servers are copied from the author's private plugin repository at the 2026-10-23 revision, with their tests. They depend only on Node.js built-in modules.

### mcp/codex-cli

- Status: Adapted
- Sources and references:
  - The author's local Claude Code skill `codex-cli`, for context pre-loading, session reuse, parallel runs, and prompt structure.
  - The author's earlier Kimi CLI MCP plugin, for the MCP server, background job persistence, worker, and process-group cancellation.
  - The `codex exec`, `exec resume`, and `exec review` help output and `--json` event stream of `codex-cli` 0.162.1, tested locally on 2026-10-12.
- Changes:
  - The old skill used `--full-auto` and `resume --last "prompt"`, which no longer work in the current CLI. They are replaced with an explicit `-c sandbox_mode`, `approval_policy="never"`, and passing the prompt over stdin. `danger-full-access` and the bypass flags are refused.
  - New in this version:
    - validation of Codex review targets;
    - structured results through `--output-schema`;
    - `--worktree` isolation, with `worktreePath` filled in from the session rollout;
    - classification of retryable errors;
    - parallel waiting with `codex_cli_wait`.
  - Codex credentials and config are left to Codex's own `CODEX_HOME`. Tests use a fake Codex CLI.

### mcp/claude-code

- Status: Inspired
- Inspiration:
  - [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), consulted on 2026-07-17.
- Changes:
  - It takes that project's product boundary (local CLI delegation, foreground and background jobs, status/result/cancel controls) and reverses it, so that other hosts can call the local Claude Code CLI.
  - No upstream command, hook, agent, or app-server broker code was copied.
  - Environment variables are resolved in this order: the process environment, then the project `.env`, then an explicit `settingsFile` or the default `~/.claude/settings.json`. Diagnostics show only variable names and their sources, never values.
  - New in this version:
    - read-only review mode;
    - task permission modes;
    - session resume;
    - background job persistence;
    - process-group cancellation.
  - Tests use a fake Claude CLI.

## License

Everything in this repository is released under the MIT License (see `LICENSE`).
