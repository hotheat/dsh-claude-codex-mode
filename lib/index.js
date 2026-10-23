/** Main-model discussion, with repository edits routed to Codex CLI. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { MODES, SERVER_PATHS, preflight } from './preflight.js'
import { classifyEdit } from './policy.js'

export const name = 'claude-codex-mode'

export const inject = ['systemPrompt', 'tools']

export const Config = Schema.object({
  mode: Schema.union(MODES).default('api').volatile(),
})

const EDIT_TOOLS = new Set(['edit', 'write', 'str_replace_editor', 'apply_patch'])
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath']

const ROUTING = `## 工作模式：讨论与执行

- **讨论**（需求、计划、架构、文档、判断问题是否值得修、读代码）由你直接完成，不需要调用其它代理。
- **修改 Git 仓库里的代码或配置**：交给 \`mcp__codex-cli__codex_cli_run\`，传绝对 \`cwd\`、\`sandbox: "workspace-write"\`，以及完整简报：目标、已确认约束、相关文件、验收方式。Codex 看不到本会话；预计超过 4 分钟用 \`background: true\`，再用 \`mcp__codex-cli__codex_cli_wait\` 等待；续聊用 \`resumeSessionId\`。
- **验收**：Codex 完成后由你自己看 \`git status\`、\`git diff\`、跑测试再汇报；Codex 的总结只作参考。
- **直接写入范围**：Markdown/文本/方案、笔记、\`~/.claude\` 配置、非 Git 目录文件。guard 只拦结构化写文件工具（\`write\`、\`edit\`、\`str_replace_editor\`、\`apply_patch\`）；\`bash\` / \`pwsh\` 不受机械拦截，但不要用它们（\`sed -i\`、heredoc、重定向）绕过。
- **阶段纪律**：讨论阶段不动手，用户明确说「开始吧 / 做吧 / 执行」后再进入执行。`

export function routing(mode) {
  if (mode === 'api') return ROUTING
  return ROUTING.replace(
    '- **讨论**（需求、计划、架构、文档、判断问题是否值得修、读代码）由你直接完成，不需要调用其它代理。',
    '- **讨论**（需求、计划、架构、文档、判断问题是否值得修、读代码）调用 `mcp__claude-code__claude_code_run`，传 `mode: "review"`（只读）和绝对 `cwd`。prompt 必须带上用户原话和必要上下文，因为 Claude Code 看不到 DSH 会话。同一话题用 `resumeSessionId` 续接。如实转述 Claude Code 的结论，不自行改写。用户说「开始吧 / 做吧 / 执行」后，由你按下面规则调用 Codex 完成修改。',
  )
}

/** Optional host services are read at check time, so model/key edits apply immediately. */
export function hostFacts(ctx, mode) {
  const rows = ctx.get('configEditor')?.entries() ?? []
  const providers = Object.assign({}, ...rows
    .filter(row => row.fiber?.runtime?.name === 'llm-pi-ai')
    .map(row => row.fiber.config.providers.get()))
  return {
    mode,
    providers,
    defaultModel: ctx.get('agentDefaultModel')?.currentSelection(),
    credentialPresent: async ref => {
      const credentials = ctx.get('credentials')
      if (credentials) return (await credentials.describe(ref)).configured
      const environment = ctx.get('launchEnvironment')
      return Boolean(environment ? environment.get(ref)?.value : process.env[ref])
    },
  }
}

// Tests may override server paths to exercise real MCP startup failures without changing vendored files.
export async function apply(ctx, config, serverPaths = SERVER_PATHS) {
  const dshHome = ctx.get('profileContext')?.home ?? resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  let approved
  let promptOff
  let claude
  let activeMode
  let closed = false
  let transition = Promise.resolve()
  const check = mode => preflight(hostFacts(ctx, mode))
  const mount = async serverName => {
    let child
    try {
      child = ctx.plugin(McpClient, {
        serverName, transport: 'stdio', command: process.execPath, args: [serverPaths[serverName]],
        env: { [serverName === 'codex-cli' ? 'CODEX_CLI_PLUGIN_STATE_DIR' : 'CODEX_CLAUDE_CODE_STATE_DIR']:
          join(dshHome, 'claude-codex-mode', serverName) },
        toolCallTimeoutMs: 600000, failOnStartupError: true,
      })
      return await child
    } catch {
      // Await rethrows startup errors after rollback; dispose removes the failed fiber and drains cleanup.
      // Keep that failure local so the host's guard and routing remain available without MCP tools.
      await child?.dispose()
      ctx.logger.warn(`claude-codex-mode: ${serverName} MCP 启动失败；请检查包内 mcp/${serverName}/server.mjs、Node 环境和 DSH 日志，修复后重新启用本插件。`)
    }
  }
  // Programmatic child fibers share the host's scope and dispose with it.
  // Loader's volatile event updates only the optional Claude fiber and prompt; Codex stays mounted.
  const codex = mount('codex-cli')
  const changeMode = async mode => {
    if (closed) return
    if (mode === 'claude-code-cli' && !claude) {
      claude = await mount('claude-code')
    } else if (mode === 'api' && claude) {
      await claude.dispose()
      claude = undefined
    }
    if (closed) return
    promptOff?.()
    promptOff = ctx.systemPrompt.section({
      name: 'mode:claude-codex-routing', order: 3050, text: routing(mode), interpolate: false,
    })
    activeMode = mode
  }
  ctx.effect(() => async () => {
    closed = true
    await transition.catch(() => {})
    promptOff?.()
  })
  ctx.on('internal/config', function (_raw, next) {
    const raw = next()
    if (this !== ctx.fiber) return raw
    const mode = Config(raw).mode.get()
    if (mode !== config.mode.get() && approved !== mode) {
      throw new Error('请在本插件配置表单运行前置检查；检查通过后才能保存新模式。')
    }
    return raw
  })
  ctx.on('loader/volatile-update', () => {
    approved = undefined
    const mode = config.mode.get()
    transition = transition.catch(() => {}).then(() => changeMode(mode))
    // The HTTP state read awaits the same promise and reports unexpected transition failures to the form.
    void transition.catch(() => ctx.logger.warn('claude-codex-mode: MCP 模式切换失败，请检查本插件的 MCP 子实例。'))
  })
  ctx.inject(['settings'], c => {
    c.effect(() => c.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.inject(['webServer'], c => {
    c.effect(() => c.webServer.register({
      kind: 'prefix', path: '/claude-codex-mode',
      async handler(req, res) {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        try {
          const url = new URL(req.url, 'http://localhost')
          if (req.method === 'GET' && url.pathname === '/claude-codex-mode/state') {
            await transition
            return send(200, { mode: activeMode })
          }
          if (req.method !== 'POST' || url.pathname !== '/claude-codex-mode/preflight') return send(404, { error: 'Not found' })
          // Reject cross-origin saves; the form sends no request body or credential literal.
          if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { error: 'Origin refused' })
          const mode = url.searchParams.get('mode')
          if (!MODES.includes(mode)) return send(400, { error: 'mode must be api or claude-code-cli' })
          approved = undefined
          const result = await check(mode)
          if (result.ok) approved = mode
          return send(200, result)
        } catch {
          return send(500, { error: '前置检查或 MCP 挂载失败，请检查 DSH 服务日志后重试。' })
        }
      },
    }))
  })

  let dirs
  ctx.inject(['workingDirectory'], (c) => {
    dirs = c.workingDirectory
    c.effect(() => () => { dirs = undefined })
  })

  ctx.effect(() =>
    ctx.tools.guard((execution) => {
      if (!EDIT_TOOLS.has(execution.name)) return undefined

      const args = execution.arguments
      if (execution.name === 'str_replace_editor' && args?.command === 'view') return undefined
      if (!args || typeof args !== 'object') return undefined
      const raw = PATH_KEYS.map((key) => args[key]).find((value) => typeof value === 'string' && value)
      if (!raw) return undefined

      const base = execution.agent ? dirs?.get(execution.agent.session) : undefined
      const result = classifyEdit({ raw, base, home: homedir(), env: process.env })
      if (result.verdict === 'allow') return undefined

      let message
      if (result.reason === 'relative-without-base') {
        message = `无法确定相对路径 ${raw} 的会话工作目录，请使用绝对路径后重试。`
      } else {
        message = (
          `${result.target} 是 Git 仓库里的代码或配置文件，请交给 Codex 执行修改。` +
          '把目标、已确认约束、相关文件和验收方式写成完整简报；Codex 看不到本会话。' +
          '先调用 mcp__codex-cli__codex_cli_setup（传入绝对 cwd），' +
          '再调用 mcp__codex-cli__codex_cli_run（绝对 cwd，sandbox: "workspace-write"）；' +
          '预计超过 4 分钟用 background: true 后调用 mcp__codex-cli__codex_cli_wait，续聊用 resumeSessionId。' +
          '完成后自己检查 git status、git diff 并跑测试再汇报。' +
          '不要用 bash / pwsh 的 sed -i、heredoc、重定向绕过。' +
          `如需直接修改，可创建 ${join(result.root, '.claude', 'direct-edit')}，或用 DSH_DIRECT_EDIT=1 重启 dsh。`
        )
      }
      if (ctx.tools.get('mcp__codex-cli__codex_cli_run') === undefined) {
        message += 'Codex 工具未上线，请检查 claude-codex-mode 的 codex-cli MCP 子实例，或禁用本插件 / 使用旁路。'
      }
      return message
    }),
  )
  const result = await check(config.mode.get())
  for (const item of result.checks.filter(item => !item.ok)) {
    ctx.logger.warn(`${item.label}：${item.hint}`)
  }
  await codex
  transition = changeMode(config.mode.get())
  await transition
}
