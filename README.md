# dsh-claude-codex-mode

English | [简体中文](README.zh-CN.md)

**Discuss / Execute Split** is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that splits the work in two: discussion stays read-only, and every repository code edit goes to Codex.

- **Discussion** covers requirements, plans, architecture, docs, reading code, and judging whether a fix is worth making. The DSH model does this itself, or forwards it to the Claude Code CLI. The bundle is designed with Claude in mind, so in `api` mode pick a Claude model as the DSH default.
- **Edits to code or config inside a Git repository** go to the [Codex CLI](https://github.com/openai/codex) through in-process host tools backed by DSH background jobs.
  They happen only after you say so ("开始吧 / 做吧 / 执行", that is, "go ahead").
  DSH then reviews `git status`, `git diff`, and the test results itself before reporting back.

A write guard enforces this split. If the model tries to write a repository code file with a structured edit tool, the guard blocks it and tells the model how to hand the edit to Codex.

## Modes

You choose the mode in this plugin's form on the DSH **Plugins** page. Switching takes effect without restarting DSH.

| Mode | Who discusses | Who edits | MCP servers mounted |
|---|---|---|---|
| `api` (default) | The DSH model itself. You configure an Anthropic provider (API key) on the Models page and pick Claude | Codex host tools | None |
| `claude-code-cli` | The DSH model forwards discussion to the Claude Code CLI in read-only `review` mode, using your Claude subscription login (no API key) | Codex host tools, called by the DSH model | `claude-code` |

In `claude-code-cli` mode, Claude Code cannot see the DSH session. The routing prompt therefore tells the DSH model to:

- send your words and any needed context in each `mcp__claude-code__claude_code_run` call;
- continue a topic with `resumeSessionId`;
- relay Claude Code's conclusions faithfully.

### Codex execution

The host registers `codex_cli_setup`, `codex_cli_run` and `codex_cli_review` directly, sharing schemas and the runner with the bundled standalone MCP fallback.
`codex_cli_setup` probes the executable and login asynchronously.
Runs stream JSONL events through the host into `ctx.jobs`, so the session header's Background jobs panel shows live output, progress, duration and a stop button.

Foreground calls are jobs too: they wait up to `timeoutMs` (four minutes by default), return the canonical Codex result on settlement and remove the collected row.
If that wait expires, the process continues and the call returns a `jobId`; the row stays available after completion.
Set `background: true` for an immediate handle; `timeoutMs` above 240000 also selects background execution and remains the process deadline.
Use DSH `job_output` to read/wait, `job_list` to list and `job_kill` to stop a job; continue Codex with `resumeSessionId`.
Caller abort kills and collects a foreground job before throwing; stopping from the panel terminates the whole Codex process group.

The task panel requires `@deepseek-ai/dsh-jobs-local` and `@deepseek-ai/dsh-tool-jobs` in the composition.
Without the registry, foreground calls run directly with a timeout and background calls fail with a mount hint.
If registration is refused because the session has no job controller or has reached its job cap, the host logs a warning and runs foreground calls directly; background calls report the admission error.

### Codex output

In the plugin's **Discussion mode** form, **Codex output** controls where runs appear:

- `jobs` (default): use `dsh-better-sidebar`'s built-in **Background jobs** drawer; the Codex tab is not registered.
- `tab`: register a dedicated **Codex** sidebar page; requires `dsh-better-sidebar`.

Changing this option saves immediately, without preflight checks or a page reload.
With `tab` selected, open the right sidebar's **+** menu and pick **Codex** to list this session's Codex runs and stream the selected run's output live.
The tab also supports copying output and stopping a running job with a second confirmation click.
The `tab` option remains selectable when the sidebar plugin is absent, and the form shows an installation hint.

### Preflight checks

When the form opens, it checks the current mode and shows the result:

- If the current mode passes, the form says so and lists any warnings.
- If it fails, the form lists each failed check with a fix hint and also checks the other mode. If the other mode passes, its card says it can be switched to.
- Clicking the card of the other mode checks that mode right away and shows the result. The click only selects the mode; it does not save it.
- The mode never changes automatically.

When the API card is selected, the form also shows the Anthropic provider settings DSH is using:

- the base URL;
- the name of the key variable, and where the key comes from (saved in DSH, the environment, or missing);
- the configured models and the default model.

These are read-only here. To change them, open **Settings → Models**. A plugin form cannot open that page for you.

**Test connection** asks the provider for its model list (`GET /v1/models`) with the current key, so it uses no tokens.

- The result tells apart a rejected key, an unreachable address, a timeout, and configured models missing from the list.
- Some relays don't offer a model list. Then the test can't tell whether the key works, and it shows a warning instead of a failure.
- The test runs only when you click the button.
- Redirects are refused, so the key is never sent to a second address.

Clicking **Check and save** runs a preflight check for the target mode first. If any blocking check fails, the save is refused, the current mode stays, and the form lists each failed check with a fix hint.

| Scope | Check | Level |
|---|---|---|
| All modes | Node.js ≥ 20 | Blocking |
| All modes | `codex --version` succeeds | Blocking |
| All modes | `codex login status` reports logged in | Blocking |
| All modes | Bundled standalone MCP fallback `mcp/codex-cli/server.mjs` exists | Blocking |
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

Then enable it on the Plugins page. It is listed as **Discuss / Execute Split**, or **讨论执行分工 (claude-codex-mode)** in Chinese. No build step is needed.

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

Codex runs use the process-local DSH job registry.
Claude Code MCP job state is stored under `<DSH home>/claude-codex-mode/claude-code/`.

## Development

```bash
npm test
```

```bash
node --test mcp/*/tests/*.test.mjs
```

`npm test` covers:

- the policy tests;
- table-driven preflight tests with injected command results;
- the doctor and form tests;
- shared schema validation and incremental Codex event rendering;
- host tools with a real local DSH job registry and fake CLI subprocesses, including timeout promotion, live output, cancellation and admission fallback;
- a real Cordis load test that switches modes both ways, keeps Codex host tools registered and mounts/unmounts only the Claude MCP server.

The load test finds Cordis through `DSH_CORDIS_PATH`, and failing that through a global `@deepseek-ai/dsh` install (`npm root -g`). If neither is found, it is skipped with a message.

## Attribution and license

The bundled MCP servers in `mcp/codex-cli` and `mcp/claude-code` come from the author's own earlier plugins. See [ATTRIBUTION.md](ATTRIBUTION.md) for where each part comes from.

[MIT](LICENSE) © 2026 Jiaoguo
