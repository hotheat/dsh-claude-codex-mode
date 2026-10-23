# Changelog

## 0.3.5 - 2026-10-23

### Changed

- The plugin's display name is now **讨论执行分工 (claude-codex-mode)** in Chinese and **Discuss / Execute Split** in English. The old name, "Claude 讨论 / Codex 执行", promised Claude, but in `api` mode the discussion runs on whatever the DSH default model is. The new description says what the plugin enforces: discussion stays read-only, and every repository code edit goes to Codex. The package name `dsh-claude-codex-mode` is unchanged, so installs and paths keep working.

## 0.3.4 - 2026-10-23

### Changed

- A mode card that passes with a warning now says what the warning is, for example "有提示 · 默认模型不是 Claude" (Warning · Default model isn't Claude). With more than one warning, it shows how many. Before this, the card only said "有提示" (Warning), and you had to scroll to the check panel to find out why.

## 0.3.3 - 2026-10-23

### Added

- When the API card is selected, the form shows the current Anthropic provider settings: the base URL, the name of the key variable, and where the key comes from (saved in DSH, the environment, or missing). It also shows the configured models and the default model. Nothing here is editable. A hint points to **Settings → Models**, where these are changed. A plugin form cannot open that page itself.
- A **Test connection** button in that panel. It asks the provider for its model list (`GET /v1/models`) with the current key. It does not use tokens. The result tells apart a rejected key, an unreachable address, a timeout, and an endpoint that cannot list models. That last case is only a warning: some relays don't offer a model list, which doesn't mean the key is bad. The test runs only when you click the button. Redirects are refused, so the key is never sent to a second address.
- Clicking the card of a mode that isn't active now checks that mode at once and shows the result. Before this, you saw the result only after clicking **Check and save**. This check is read-only and does not allow a save. Saving still runs its own check.
- New read-only routes `GET /claude-codex-mode/check?mode=` and `POST /claude-codex-mode/test-connection`. `GET /claude-codex-mode/status` now also returns the API settings summary. None of these routes allow a mode change, and all of them refuse cross-origin requests.

## 0.3.2 - 2026-10-23

### Changed

- The plugin form has been redesigned. Two mode cards replace the dropdown. Each card shows who discusses and who edits (for example, DSH model → Codex), what the mode needs, and a check badge based on real check results.
- The check results are listed in panels. The panels use DSH's design tokens, so they follow the light or dark theme. Failed checks are listed first, and passed checks are folded into one line.
- **Check and save** is now a filled primary button. If the selected mode is already active, a note says so, instead of the button just looking disabled.

### Fixed

- Right after the plugin is enabled, the form no longer gets stuck on "Configuration is unavailable". It retries reading the settings with backoff, for about 4.5 seconds. If every attempt fails, it shows a **Retry** button.

## 0.3.1 - 2026-10-23

### Added

- The plugin form now checks the current mode as soon as it opens. It shows whether the mode passes, with a hint for each failed check and each warning. Before this, problems with the initial `api` mode showed up only as warnings in the DSH log.
- If the current mode fails and the other mode passes, the form says so and offers a button that selects the other mode. The button only changes the selection. Nothing is saved until you click **Check and save**.
- If both modes fail, the form lists what is wrong with each.
- New read-only route `GET /claude-codex-mode/status`. It never approves a mode change and refuses cross-origin requests.

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
