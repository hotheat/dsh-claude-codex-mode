#!/usr/bin/env node
/** Read-only profile diagnostics. Never invoke DSH's profile initializer or credential migration. */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { parseDotEnv } from '../mcp/claude-code/lib/config.mjs'
import { MODES, preflight } from '../lib/preflight.js'

function yaml(text) {
  const doc = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => ({ expression: true }) }],
    prettyErrors: false,
  })
  if (doc.errors.length) throw new Error('配置文件无法解析；请检查 YAML 格式。')
  return doc.toJS()
}

function optionalFile(path, fs) {
  try { return fs.readFileSync(path, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return ''; throw new Error('配置文件无法读取；请检查权限。') }
}

/** Profile patch is the offline authority; expressions are never executed by doctor. */
export function profileFacts({ profile = 'web', home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
  cwd = process.cwd(), env = process.env, fs = { readFileSync, statSync } } = {}) {
  const text = optionalFile(join(home, 'profiles', profile, 'cordis.patch.yml'), fs)
  const patch = yaml(text) ?? []
  if (!Array.isArray(patch)) throw new Error('profile patch 必须是 YAML 数组。')
  const rows = new Map()
  const apply = patches => {
    for (const row of patches) {
      if (row.insert) apply(row.insert)
      if (!row.id) continue
      const previous = rows.get(row.id) ?? {}
      rows.set(row.id, { ...previous, ...row })
      if (row.group && Array.isArray(row.config)) apply(row.config)
    }
  }
  apply(patch)
  const live = [...rows.values()].filter(row => !row.disabled)
  const providers = Object.assign({}, ...live
    .filter(row => row.id === 'llm-pi-ai' || row.name === '@deepseek-ai/dsh-llm-pi-ai')
    .map(row => row.config?.providers ?? {}))
  const defaultModel = live.find(row => row.id === 'agent-default-model' || row.name === '@deepseek-ai/dsh-agent-default-model')?.config
  const credentialConfig = live.find(row => row.id === 'credentials-local' || row.name === '@deepseek-ai/dsh-credentials-local')?.config
  const file = resolve(credentialConfig?.path ?? join(credentialConfig?.dshHome ?? home, '.credentials.yaml'))
  const credentialText = optionalFile(file, fs)
  if (credentialText && process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) {
    throw new Error('DSH 凭据文件权限过宽；请将其权限改为 600。')
  }
  const stored = yaml(credentialText) ?? {}
  if (Object.keys(stored).length && stored.version !== 1) {
    throw new Error('DSH 凭据文件格式不符合当前运行时；请通过 DSH 修复后重试。')
  }
  const refs = stored.refs ?? {}
  if (typeof refs !== 'object' || Array.isArray(refs) || Object.entries(refs).some(([ref, value]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || typeof value !== 'string' || !value.length)) {
    throw new Error('DSH 凭据 refs 格式无效；请通过 DSH 修复后重试。')
  }
  const userEnv = parseDotEnv(optionalFile(join(home, '.env'), fs))
  const projectEnv = parseDotEnv(optionalFile(join(cwd, '.env'), fs))
  return { providers, defaultModel, credentialPresent: ref =>
    Boolean(refs[ref] || env[ref] || projectEnv[ref] || userEnv[ref]) }
}

export async function main(args = process.argv.slice(2)) {
  let mode = 'api'
  let profile = 'web'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) mode = args[++i]
    else if (args[i] === '--profile' && args[i + 1]) profile = args[++i]
    else throw new Error('用法：npm run doctor -- [--mode api|claude-code-cli] [--profile web]')
  }
  if (!MODES.includes(mode) || !/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error('mode 或 profile 参数无效。')
  let facts = {}
  let profileError = false
  if (mode === 'api') {
    try { facts = profileFacts({ profile }) } catch { profileError = true }
  }
  const result = await preflight({ ...facts, mode })
  if (profileError) {
    result.checks.push({ id: 'profile', label: 'profile / 凭据文件可读取且格式正确', ok: false, level: 'error',
      hint: '检查所选 profile patch、DSH home 的 .env 和 .credentials.yaml 格式及权限；凭据文件须为 600。' })
    result.ok = false
  }
  console.log(`DSH Claude / Codex doctor | mode=${mode} | profile=${profile}`)
  if (mode === 'api') console.log('离线 provider 检查使用所选 profile 的 cordis.patch.yml；不执行配置表达式。')
  for (const item of result.checks) {
    console.log(`[${item.ok ? 'PASS' : item.level === 'warning' ? 'WARN' : 'FAIL'}] ${item.label}`)
    if (!item.ok) console.log(`  修复提示：${item.hint}`)
  }
  console.log(result.ok ? '前置检查通过。' : '前置检查未通过，当前模式不可切换为此模式。')
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main() } catch { console.error('doctor 参数无效。用法：npm run doctor -- [--mode api|claude-code-cli] [--profile web]'); process.exitCode = 1 }
}
