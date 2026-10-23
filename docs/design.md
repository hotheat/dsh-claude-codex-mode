# dsh-claude-codex-mode 设计

状态：已实现（2026-10-23，0.3.0）。

实现与设计的差异：

- MCP 由 host 用 `ctx.plugin(@deepseek-ai/dsh-mcp-client)` 挂为子 fiber，不再是 patch 行。`codex-cli` 常驻，`claude-code` 随模式挂载或卸载。
- 保存时，host 在 `internal/config` 钩子里再校验一次：没通过 preflight 的模式切换会被拒绝，因此绕过表单直接调用 settings API 也拦得住。
- MCP 启动失败不会让 host 失败。guard 和路由提示词保持生效，只记 warn。代价是：若 `claude-code` 挂载失败，模式仍会保存为 `claude-code-cli`，主模型这时调不到 `claude_code_run` 工具。
- `@deepseek-ai/dsh-mcp-client` 同时声明为 peer（范围）和 devDependency（固定 `0.2.1-rc.2`，与测试所用 DSH 版本一致）。

## 目标

把 `ai-skills-owner/plugins/dsh/dsh-claude-codex-mode`（0.2.0）迁成一个独立的公开 DSH bundle 仓库：

- 按 DSH 标准格式组织：仓库根目录就是包，`dsh plugin add github:hotheat/dsh-claude-codex-mode` 可直接安装，无需构建。
- 支持两种讨论模式，在 DSH 插件页的本插件配置表单里切换，默认 `api`。
- 切换前做前置检查，检查不通过时拒绝保存，保留当前模式，并逐项给出修复提示。
- 包内不写死任何本机路径。

## 两种模式

| 模式 | 讨论由谁完成 | 代码修改 | 挂载的 MCP |
|---|---|---|---|
| `api`（默认） | DSH 主模型本身。用户在模型页配置 Anthropic provider（API key），并选择 Claude | Codex | `codex-cli` |
| `claude-code-cli` | DSH 主模型把讨论转发给 Claude Code CLI（订阅登录，不需要 API key） | Codex（由 DSH 主模型调用） | `codex-cli` + `claude-code` |

两种模式下，写文件 guard 和「讨论阶段不动手」的纪律都生效。

`claude-code-cli` 模式的路由提示词要求：

- 讨论调用 `mcp__claude-code__claude_code_run`，参数为 `mode: "review"`（只读）和绝对 `cwd`。
- prompt 里带上用户原话和必要上下文，因为 Claude Code 看不到 DSH 会话。
- 同一话题用 `resumeSessionId` 续接。
- 如实转述 Claude Code 的结论，不自行改写。
- 用户说「开始吧 / 做吧 / 执行」后，按 `api` 模式的方式把修改交给 Codex。

## 仓库结构

```
dsh-claude-codex-mode/
  package.json          dsh.bundle + dsh.client, engines.node >=20, engines.dsh
  cordis.patch.yml      bundle 行
  lib/index.js          host 部分：Config(mode)、路由提示词、guard、MCP 挂载、preflight 路由
  lib/policy.js         写入分类（纯函数）
  lib/preflight.js      前置检查（纯逻辑，可注入 exec/fs/env，供 host 和 doctor 共用）
  lib/client.js         浏览器部分：插件页配置表单（纯 JS + React.createElement，不需要构建）
  mcp/codex-cli/        从 ai-skills-owner/plugins/codex-cli/mcp 原样复制
  mcp/claude-code/      从 ai-skills-owner/plugins/claude-code/mcp 原样复制
  scripts/doctor.mjs    npm run doctor
  test/                 policy / preflight / cordis 加载测试
  locale/en.json zh.json
  icon.svg LICENSE .gitignore
  README.md README.zh-CN.md ATTRIBUTION.md CHANGELOG.md   （由 Claude 编写）
```

两个 MCP server 只依赖 Node 内置模块，可以直接复制。

## 关键实现约定

- **MCP 路径**：由 host 根据 `import.meta.url` 计算 `mcp/*/server.mjs`，`command` 使用 `process.execPath`。
  - 不再写死 `PATH`，子进程继承父进程环境。
  - Codex 和 Claude 可执行文件分别用 `CODEX_CLI_PATH`、`CLAUDE_CODE_CLI_PATH` 覆盖。
- **任务状态目录**：`CODEX_CLI_PLUGIN_STATE_DIR` 和 `CODEX_CLAUDE_CODE_STATE_DIR` 指向 DSH home 下的 `claude-codex-mode/` 子目录。
- **模式配置**：host 导出 Schemastery `Config`。
  - `mode: union(['api','claude-code-cli']).default('api').volatile()`。
  - 表单只能编辑 volatile 字段，见 deepseek-harness `packages/settings/settings/README.md`。
  - 切换模式后无需重启 dsh：MCP 挂载和路由提示词随模式更新（volatile 更新，或由 host 自行重挂）。
- **插件页表单**：浏览器部分注册到 `plugins.bundle.config`，key 为包名。
  - 先读 `ctx.remote.settings.describe()` 拿到当前值和 revision。
  - 再请求 host 的 preflight 路由，通过后调用 `ctx.remote.settings.update(<entry id>, { mode }, revision)`。
  - 参照 `ai-skills-owner/plugins/dsh/dsh-design-canvas` 的纯 JS client 写法和 `ctx.webServer.register` 路由写法。
- **前置检查**：所有外部命令都设超时，结果只报告是否存在、通过与否，不输出任何密钥值。

  | 范围 | 检查项 | 级别 |
  |---|---|---|
  | 公共 | Node ≥ 20 | 阻断 |
  | 公共 | codex 可执行文件可用，`codex --version` | 阻断 |
  | 公共 | `codex login status` 为已登录 | 阻断 |
  | 公共 | 包内 codex server 文件存在 | 阻断 |
  | `api` | `llm-pi-ai` 配置了 anthropic provider 且至少有一个模型 | 阻断 |
  | `api` | 该 provider `apiKeyEnv` 指向的凭据存在（环境变量或 DSH 凭据存储，只查是否存在） | 阻断 |
  | `api` | 默认模型不是 Claude | 仅提示 |
  | `claude-code-cli` | claude 可执行文件可用，`claude --version` | 阻断 |
  | `claude-code-cli` | `claude auth status` 为已登录 | 阻断 |
  | `claude-code-cli` | 包内 claude-code server 文件存在 | 阻断 |

  - 启动时也对当前模式跑一次检查，失败只记 warn 日志。
  - `npm run doctor [--mode <m>]` 复用同一份检查逻辑。

## 随迁移一起修复的问题

1. 对 `str_replace_editor` 的 `command: "view"` 放行；它是只读操作。
2. `.txt` 白名单排除 `requirements*.txt`、`constraints*.txt`、`CMakeLists.txt`。
3. `test/cordis-load.mjs` 不再写死 cordis 的绝对路径。改为先用 `DSH_CORDIS_PATH`，再用 `npm root -g` 推导；都找不到时明确提示并跳过。
4. guard 的拒绝消息和 Codex 未上线提示保持现有语义，提示里的 MCP 行名改为当前实现中实际使用的名字。
5. `apply_patch` 仍保留在拦截集合里（DSH 0.2.1-rc.2 中没有这个工具），README 不再写成已覆盖。

## 验收

- `npm test` 全部通过，包括 policy、preflight（注入 exec 的表驱动用例）和 cordis 加载（含模式切换）。
- `node --check` 检查所有 `lib/*.js` 和 `scripts/*.mjs`。
- 复制过来的 MCP 自带测试：`node --test mcp/*/tests/*.test.mjs`，或测试实际所在的目录。
- 用隔离的 DSH home 安装本地目录并 `--dump-config`，能看到本 bundle 的层。不碰用户真实的 `~/.dsh`。
- `npm run doctor` 在本机两种模式下都输出可读结果。
- `grep -rn '/Users/\|/opt/homebrew' .` 只在文档示例里命中（如果有）。
