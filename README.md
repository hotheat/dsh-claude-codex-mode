# dsh-claude-codex-mode

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that splits the work in two: Claude discusses, Codex edits.

- **Discussion** covers requirements, plans, architecture, docs, reading code, and judging whether a fix is worth making. Claude does all of this, either as the DSH model itself or through the Claude Code CLI.
- **Edits to code or config inside a Git repository** go to the [Codex CLI](https://github.com/openai/codex) through a bundled MCP server. They happen only after you say so ("开始吧 / 做吧 / 执行", that is, "go ahead"). DSH then reviews `git status`, `git diff`, and the test results itself before reporting back.

A write guard enforces this split. If the model tries to write a repository code file with a structured edit tool, the guard blocks it and tells the model how to hand the edit to Codex.

## Modes

You choose the mode in this plugin's form on the DSH **Plugins** page. Switching takes effect without restarting DSH.

| Mode | Who discusses | Who edits | MCP servers mounted |
|---|---|---|---|
| `api` (default) | The DSH model itself. You configure an Anthropic provider (API key) on the Models page and pick Claude | Codex | `codex-cli` |
| `claude-code-cli` | The DSH model forwards discussion to the Claude Code CLI in read-only `review` mode, using your Claude subscription login (no API key) | Codex, called by the DSH model | `codex-cli` + `claude-code` |

In `claude-code-cli` mode, Claude Code cannot see the DSH session. The routing prompt therefore tells the DSH model to:

- send your words and any needed context in each `mcp__claude-code__claude_code_run` call;
- continue a topic with `resumeSessionId`;
- relay Claude Code's conclusions faithfully.

### Preflight checks

Clicking **Check and save** runs a preflight check for the target mode first. If any blocking check fails, the save is refused, the current mode stays, and the form lists each failed check with a fix hint.

| Scope | Check | Level |
|---|---|---|
| All modes | Node.js ≥ 20 | Blocking |
| All modes | `codex --version` succeeds | Blocking |
| All modes | `codex login status` reports logged in | Blocking |
| All modes | Bundled `mcp/codex-cli/server.mjs` exists | Blocking |
| `api` | `llm-pi-ai` has an `anthropic` provider with at least one model | Blocking |
| `api` | The credential its `apiKeyEnv` points to exists (checked for presence only) | Blocking |
| `api` | The default model is not Claude | Warning |
| `claude-code-cli` | `claude --version` succeeds | Blocking |
| `claude-code-cli` | `claude auth status` reports `loggedIn: true` | Blocking |
| `claude-code-cli` | Bundled `mcp/claude-code/server.mjs` exists | Blocking |

About these checks:

- Every external command has a timeout.
- The output reports only whether a check passed. It never shows command output or credential values.
- The same checks run when DSH starts. At startup a failure only logs a warning.
- The same checks are available from the command line (see [Diagnostics](#diagnostics)).

## Requirements

- DSH `>=0.2.1-rc.2 <0.3.0`, Node.js ≥ 20.
- [Codex CLI](https://github.com/openai/codex) on `PATH` and logged in (`codex login`).
- For `api` mode: an Anthropic provider for `llm-pi-ai` with a saved API key (see [below](#configure-claude-for-api-mode)).
- For `claude-code-cli` mode: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on `PATH` and logged in (`claude auth login`).

The executables are found through the `PATH` of the DSH process. To point at a specific binary, set `CODEX_CLI_PATH` or `CLAUDE_CODE_CLI_PATH` before starting DSH.

## Install

```bash
dsh plugin --profile web add github:hotheat/dsh-claude-codex-mode
```

Then enable **dsh-claude-codex-mode** on the Plugins page. No build step is needed.

## Configure Claude for `api` mode

Add an Anthropic provider to your profile patch (for example `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: llm-pi-ai
  config:
    providers:
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        # baseURL: <optional relay base URL>
        models:
          - id: claude-sonnet-5-5
          - id: claude-opus-5-5
```

- Save the key on the Models page, or put it in the environment or in `~/.dsh/.env`. The patch should name only the environment variable, never the key itself.
- Pick Claude in the model selector and save it as the default model. The bundle cannot set the default model for you, because the profile's `agent-default-model` row is applied after bundles.
- Existing sessions keep their model. Switch them with `/model`.

## Write guard

The guard checks the path arguments of four structured file-writing tools: `write`, `edit`, `str_replace_editor`, and `apply_patch`.

- `str_replace_editor` with `command: "view"` is read-only and always allowed.
- `apply_patch` is listed for forward compatibility. DSH 0.2.1-rc.2 has no such tool.
- `bash` / `pwsh` are not checked. The routing prompt tells the model not to use `sed -i`, heredocs, or redirection to get around the guard, but nothing enforces that.

How each write is decided:

1. Read the tool's path argument.
2. Resolve it against the session's current working directory.
3. Find the nearest Git root and check for the bypass marker.
4. Allow the write, or deny it with Codex instructions.

Relative paths with no known session directory are denied, and the model is asked to use an absolute path.

The guard allows these writes directly:

- Files ending in `.md`, `.mdx`, `.markdown`, `.txt`, `.canvas`, `.base`, or `.rst` (case-insensitive). The exceptions are `requirements*.txt`, `constraints*.txt`, and `CMakeLists.txt`, which count as config.
- Anything under `~/.claude`.
- Files outside any Git repository.
- Repositories that contain `.claude/direct-edit` at their root.
- Every write, when DSH is started with `DSH_DIRECT_EDIT=1` or `CLAUDE_DIRECT_EDIT=1`.

If the Codex tools fail to come online, the guard stays active, and its deny message says that Codex is unavailable.

## Diagnostics

From a clone of this repository:

```bash
npm install
```

```bash
npm run doctor
```

```bash
npm run doctor -- --mode claude-code-cli --profile web
```

- `doctor` runs the same preflight checks offline and exits non-zero if a blocking check fails.
- In `api` mode it reads the selected profile's `cordis.patch.yml` without evaluating `!!js` expressions.
- It looks for the credential in the DSH credential store, the process environment, the project `.env`, and `~/.dsh/.env`.

Codex and Claude Code background job state is stored under `<DSH home>/claude-codex-mode/`.

## Development

```bash
npm test
```

```bash
node --test mcp/*/tests/*.test.mjs
```

`npm test` runs four suites:

- the policy tests;
- table-driven preflight tests with injected command results;
- the doctor and form tests;
- a real Cordis load test that switches modes both ways and checks how the MCP servers mount and unmount.

The load test finds Cordis through `DSH_CORDIS_PATH`, and failing that through a global `@deepseek-ai/dsh` install (`npm root -g`). If neither is found, it is skipped with a message.

## Attribution and license

The bundled MCP servers in `mcp/codex-cli` and `mcp/claude-code` come from the author's own earlier plugins. See [ATTRIBUTION.md](ATTRIBUTION.md) for where each part comes from.

[MIT](LICENSE) © 2026 Jiaoguo
