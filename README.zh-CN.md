# dsh-claude-codex-mode

[English](README.md) | 简体中文

**讨论执行分工**是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）bundle：讨论阶段只读，修改仓库代码一律交给 Codex。

- **讨论**：需求、计划、架构、文档、读代码、判断问题是否值得修，由 DSH 主模型完成，也可以由主模型转给 Claude Code CLI。本插件按 Claude 设计，`api` 模式下请把 DSH 默认模型设为 Claude。
- **修改 Git 仓库里的代码或配置**：通过包内的 MCP server 交给 [Codex CLI](https://github.com/openai/codex)。只有你明确说「开始吧 / 做吧 / 执行」后才会执行。DSH 会自己检查 `git status`、`git diff` 和测试结果，再向你汇报。

写文件 guard 负责落实这条分工：模型用结构化写文件工具改仓库代码时，guard 会拦下这次写入，并告诉模型怎样交给 Codex。

## 模式

在 DSH **插件**页本插件的表单里切换模式，无需重启 DSH。

| 模式 | 讨论由谁完成 | 代码修改 | 挂载的 MCP |
|---|---|---|---|
| `api`（默认） | DSH 主模型本身。在模型页配置 Anthropic provider（API key）并选择 Claude | Codex | `codex-cli` |
| `claude-code-cli` | DSH 主模型把讨论转发给 Claude Code CLI，用只读 `review` 模式和订阅登录，不需要 API key | Codex（由 DSH 主模型调用） | `codex-cli` + `claude-code` |

`claude-code-cli` 模式下，Claude Code 看不到 DSH 会话。因此路由提示词要求 DSH 主模型：

- 每次调用 `mcp__claude-code__claude_code_run` 时带上你的原话和必要上下文；
- 同一话题用 `resumeSessionId` 续接；
- 如实转述 Claude Code 的结论。

### 前置检查

打开表单时，会先检查当前模式并显示结果：

- 当前模式通过时，显示通过，并列出提示项。
- 当前模式不通过时，逐项列出失败原因和修复提示，并检查另一种模式。另一种模式通过时，它的卡片会标出「可切换」。
- 点击另一种模式的卡片时，会立即检查该模式并显示结果。点击只会选中，不会保存。
- 模式不会自动切换。

选中 API 卡片时，表单还会显示 DSH 当前使用的 Anthropic provider 配置：

- Base URL；
- 密钥对应的变量名，以及密钥来源（保存在 DSH、来自环境变量，或未配置）；
- 已配置的模型和默认模型。

这些内容在表单里只读。修改请打开**设置 → 模型**；插件表单无法替你打开该页面。

**测试连接**会用当前密钥请求 provider 的模型列表（`GET /v1/models`），不消耗 token。

- 结果会区分：密钥被拒绝、地址不通、超时，以及已配置的模型不在列表里。
- 有些中转站不提供模型列表。这时测试无法判断密钥是否可用，只显示提示，不算失败。
- 只有点击按钮才会发起测试。
- 拒绝重定向，因此密钥不会被发到第二个地址。

点击**检查并保存**后，会先对目标模式做前置检查。任何阻断项不通过时拒绝保存，保留当前模式，并在表单里逐项列出修复提示。

| 范围 | 检查项 | 级别 |
|---|---|---|
| 所有模式 | Node.js ≥ 20 | 阻断 |
| 所有模式 | `codex --version` 可用 | 阻断 |
| 所有模式 | `codex login status` 为已登录 | 阻断 |
| 所有模式 | 包内 `mcp/codex-cli/server.mjs` 存在 | 阻断 |
| `api` | `llm-pi-ai` 配置了 `anthropic` provider，且至少有一个模型 | 阻断 |
| `api` | provider 的 `apiKeyEnv` 指向的凭据存在（只查是否存在） | 阻断 |
| `api` | 默认模型不是 Claude | 仅提示 |
| `claude-code-cli` | `claude --version` 可用 | 阻断 |
| `claude-code-cli` | `claude auth status` 返回 `loggedIn: true` | 阻断 |
| `claude-code-cli` | 包内 `mcp/claude-code/server.mjs` 存在 | 阻断 |

检查的规则：

- 所有外部命令都设了超时。
- 结果只报告是否通过，不输出命令原文或凭据值。
- DSH 启动时也会对当前模式检查一次，失败只记 warn 日志。
- 也可以在命令行运行同一套检查，见[诊断](#诊断)。

## 前提

- DSH `>=0.2.1-rc.2 <0.3.0`，Node.js ≥ 20。
- [Codex CLI](https://github.com/openai/codex) 在 `PATH` 中，且已登录（`codex login`）。
- `api` 模式：为 `llm-pi-ai` 配置 Anthropic provider 并保存 API key，见[下文](#为-api-模式配置-claude)。
- `claude-code-cli` 模式：[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 在 `PATH` 中，且已登录（`claude auth login`）。

可执行文件按 DSH 进程的 `PATH` 查找。如需指定具体路径，在启动 DSH 前设置 `CODEX_CLI_PATH` 或 `CLAUDE_CODE_CLI_PATH`。

## 安装

```bash
dsh plugin --profile web add github:hotheat/dsh-claude-codex-mode
```

然后在插件页启用它，列表里显示为**讨论执行分工 (claude-codex-mode)**，英文界面显示为 **Discuss / Execute Split**。无需构建。

## 为 `api` 模式配置 Claude

在 profile patch（例如 `~/.dsh/profiles/web/cordis.patch.yml`）中添加 Anthropic provider：

```yaml
- id: llm-pi-ai
  config:
    providers:
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        # baseURL: <可选的中转地址>
        models:
          - id: claude-sonnet-5-5
          - id: claude-opus-5-5
```

- 密钥可以在模型页保存，也可以放进环境变量或 `~/.dsh/.env`。patch 里只写环境变量名，不要写密钥。
- 在模型选择器选择 Claude，并保存为默认模型。profile 的 `agent-default-model` 行在 bundle 之后应用，所以 bundle 无法替你设置默认模型。
- 已有会话保留原模型，需要在会话内用 `/model` 切换。

## 写文件 guard

guard 检查四个结构化写文件工具的路径参数：`write`、`edit`、`str_replace_editor`、`apply_patch`。

- `str_replace_editor` 的 `command: "view"` 是只读操作，始终放行。
- `apply_patch` 只是为将来预留，DSH 0.2.1-rc.2 中没有这个工具。
- `bash` / `pwsh` 不受检查。路由提示词要求模型不要用 `sed -i`、heredoc、重定向绕过 guard，但这一点没有机械强制。

每次写入的判断步骤：

1. 读取工具的路径参数。
2. 按会话当前工作目录解析路径。
3. 查找最近的 Git 根，并检查旁路标记。
4. 放行，或拒绝并给出 Codex 指引。

相对路径在拿不到会话目录时会被拒绝，并要求模型改用绝对路径。

以下写入直接放行：

- 后缀为 `.md`、`.mdx`、`.markdown`、`.txt`、`.canvas`、`.base`、`.rst` 的文件（忽略大小写）。`requirements*.txt`、`constraints*.txt`、`CMakeLists.txt` 例外，它们按配置文件处理。
- `~/.claude` 下的文件。
- 不在任何 Git 仓库里的文件。
- 根目录存在 `.claude/direct-edit` 的仓库。
- 用 `DSH_DIRECT_EDIT=1` 或 `CLAUDE_DIRECT_EDIT=1` 启动 DSH 时的所有写入。

Codex 工具未能上线时，guard 仍然生效，拒绝消息会提示 Codex 当前不可用。

## 诊断

在本仓库的克隆目录中运行：

```bash
npm install
```

```bash
npm run doctor
```

```bash
npm run doctor -- --mode claude-code-cli --profile web
```

- `doctor` 离线运行同一套前置检查。有阻断项失败时以非零码退出。
- `api` 模式下读取所选 profile 的 `cordis.patch.yml`，不执行其中的 `!!js` 表达式。
- 凭据按以下位置查找：DSH 凭据存储、进程环境变量、项目 `.env`、`~/.dsh/.env`。

Codex 和 Claude Code 的后台任务状态保存在 `<DSH home>/claude-codex-mode/` 下。

## 开发

```bash
npm test
```

```bash
node --test mcp/*/tests/*.test.mjs
```

`npm test` 包含：

- policy 测试；
- 注入命令结果的表驱动 preflight 测试；
- doctor 和表单测试；
- 真实的 Cordis 加载测试：双向切换模式，并检查 MCP 的挂载与卸载。

加载测试先用 `DSH_CORDIS_PATH` 查找 Cordis，再查全局安装的 `@deepseek-ai/dsh`（`npm root -g`）。都找不到时会提示并跳过。

## 来源与许可证

`mcp/codex-cli` 和 `mcp/claude-code` 两个 MCP server 来自作者此前的插件。各部分来源见 [ATTRIBUTION.md](ATTRIBUTION.md)。

[MIT](LICENSE) © 2026 Jiaoguo
