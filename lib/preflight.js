/** Shared host/doctor checks. Command output and credential values never leave this module. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MODES = ['api', 'claude-code-cli']
export const SERVER_PATHS = Object.fromEntries(['codex-cli', 'claude-code'].map(name =>
  [name, fileURLToPath(new URL(`../mcp/${name}/server.mjs`, import.meta.url))]))

export function execute(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, { ...options, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })
    })
  })
}

/** Inputs are facts from the live host or the doctor's read-only profile projection. */
export async function preflight({ mode = 'api', providers = {}, defaultModel, credentialPresent } = {}, {
  exec = execute, fs = { existsSync }, env = process.env, nodeVersion = process.versions.node,
  serverPaths = SERVER_PATHS, timeoutMs = 10000,
} = {}) {
  if (!MODES.includes(mode)) throw new TypeError('mode must be api or claude-code-cli')
  const checks = []
  const add = (id, label, ok, hint, level = 'error') => checks.push({ id, label, ok: Boolean(ok), level, hint })
  const command = async (file, args) => {
    try { return await exec(file, args, { timeout: timeoutMs, env, killSignal: 'SIGKILL' }) }
    catch { return { code: 1, stdout: '', stderr: '' } }
  }
  const exists = path => { try { return fs.existsSync(path) } catch { return false } }
  add('node', 'Node >= 20', Number(nodeVersion.split('.')[0]) >= 20, '安装 Node.js 20 或更新版本，并用它启动 DSH。')
  const codex = env.CODEX_CLI_PATH || 'codex'
  add('codex-version', 'Codex CLI 可用', (await command(codex, ['--version'])).code === 0,
    '安装 Codex CLI，加入 PATH，或设置 CODEX_CLI_PATH。')
  const login = await command(codex, ['login', 'status'])
  add('codex-auth', 'Codex CLI 已登录', login.code === 0 && /\bLogged in\b/i.test(`${login.stdout}\n${login.stderr}`),
    '在启动 DSH 的同一用户环境运行 codex login。')
  add('codex-server', '包内 Codex 独立 MCP 备用 server 存在', exists(serverPaths['codex-cli']), '重新安装本插件，恢复 mcp/codex-cli/server.mjs。')
  if (mode === 'api') {
    const provider = providers.anthropic
    const models = provider?.models
    add('anthropic-provider', 'llm-pi-ai anthropic provider 至少配置一个模型',
      Array.isArray(models) && models.some(model => typeof model.id === 'string' && model.id.length > 0),
      '在 Models 页面配置 llm-pi-ai 的 anthropic provider，并添加至少一个 Claude 模型。')
    const ref = provider?.apiKeyEnv
    let present = false
    if (typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
      try { present = credentialPresent ? await credentialPresent(ref) : Boolean(env[ref]) } catch { /* Report presence only. */ }
    }
    add('anthropic-credential', 'anthropic apiKeyEnv 引用的凭据存在', present,
      '为 anthropic 设置 apiKeyEnv，并在 Models 页面保存对应密钥，或通过环境变量 / DSH home 的 .env 提供。')
    add('default-model', '默认模型为 Claude', defaultModel?.provider === 'anthropic' && /^claude(?:-|$)/i.test(defaultModel?.model ?? ''),
      '在模型选择器选择 Claude 并保存为默认模型；已有会话另行切换。', 'warning')
  } else {
    const claude = env.CLAUDE_CODE_CLI_PATH || 'claude'
    add('claude-version', 'Claude Code CLI 可用', (await command(claude, ['--version'])).code === 0,
      '安装 Claude Code CLI，加入 PATH，或设置 CLAUDE_CODE_CLI_PATH。')
    const auth = await command(claude, ['auth', 'status'])
    let loggedIn = false
    try { loggedIn = auth.code === 0 && JSON.parse(auth.stdout).loggedIn === true } catch { /* Malformed output is a failed check. */ }
    add('claude-auth', 'Claude Code CLI 已登录', loggedIn,
      '在启动 DSH 的同一用户环境运行 claude auth login，完成订阅账号登录后重试。')
    add('claude-server', '包内 claude-code MCP server 存在', exists(serverPaths['claude-code']),
      '重新安装本插件，恢复 mcp/claude-code/server.mjs。')
  }
  return { mode, ok: checks.every(check => check.ok || check.level === 'warning'), checks }
}
