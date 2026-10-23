# Changelog

## 0.3.0 - 2026-10-23

First public release as a standalone DSH bundle.

### Added

- Two discussion modes, `api` (default) and `claude-code-cli`. You switch between them in this plugin's form on the Plugins page, without restarting DSH.
- A preflight check before every switch. A failed blocking check refuses the save, keeps the current mode, and shows a fix hint for each failure. The same check runs once at startup, where a failure only logs a warning.
- `npm run doctor [-- --mode <mode>] [-- --profile <profile>]`, which runs the same checks offline.
- The `codex-cli` and `claude-code` MCP servers ship inside the package. Their paths are computed at runtime, so the bundle contains no machine-specific paths.

### Changed

- The bundle host now mounts the Codex MCP server itself. It was previously a separate patch row with hardcoded `command`, `args`, and `PATH`.
- Background job state for both servers moved to `<DSH home>/claude-codex-mode/`.

### Fixed

- `str_replace_editor` with `command: "view"` is no longer blocked.
- `requirements*.txt`, `constraints*.txt`, and `CMakeLists.txt` are no longer treated as documents.
- The Cordis load test no longer hardcodes an install path.
- A failed MCP startup no longer disables the write guard.

## 0.2.0

Private version, kept in the author's own repository. It had one mode, with the Claude provider configured by hand and Codex mounted through a fixed local path.
