/** Real Loader + ConfigEditor + Settings + host Codex tools + Claude stdio MCP client, with isolated CLI/auth fixtures. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshRuntime } from './dsh-runtime.mjs'
import { SERVER_PATHS } from '../lib/preflight.js'

const runtime = dshRuntime()
if (!runtime) {
  console.log('SKIP cordis load: set DSH_CORDIS_PATH to Cordis, or install DSH globally (npm root -g).')
  process.exit(0)
}
const load = spec => import(pathToFileURL(runtime.require.resolve(spec)).href)
const { Context } = await import(pathToFileURL(runtime.cordis).href)
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const { default: ConfigEditor } = await load('@deepseek-ai/dsh-config-editor')
const { default: Settings } = await load('@deepseek-ai/dsh-settings')
const { mountRootInclude, readProfilePatches } = await load('@deepseek-ai/dsh-app-boot')
const { default: Schema } = await load('@deepseek-ai/schemastery')
const plugin = await import('../lib/index.js')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-routing-load-'))
const repo = join(temporary, 'repo')
const outside = join(temporary, 'outside')
const dir = join(temporary, 'profiles', 'test')
for (const path of [join(repo, '.git'), outside, dir]) mkdirSync(path, { recursive: true })
const fakeCli = join(temporary, 'cli.mjs')
writeFileSync(fakeCli, `#!${process.execPath}\nif (process.argv[2] === 'auth') { console.log(JSON.stringify({loggedIn:process.env.CC_TEST_AUTH !== 'false'})); process.exit(process.env.CC_TEST_AUTH === 'false' ? 1 : 0) }\nconsole.log(process.argv[2] === 'login' ? 'Logged in using ChatGPT' : 'test-cli 1.0')\n`, { mode: 0o700 })
const failedServer = join(temporary, 'failed-server.mjs')
writeFileSync(failedServer, 'process.exit(1)\n')
const savedEnv = Object.fromEntries(['CODEX_CLI_PATH', 'CLAUDE_CODE_CLI_PATH', 'DSH_HOME', 'CC_TEST_AUTH', 'DSH_DIRECT_EDIT', 'CLAUDE_DIRECT_EDIT'].map(key => [key, process.env[key]]))
process.env.CODEX_CLI_PATH = fakeCli
process.env.CLAUDE_CODE_CLI_PATH = fakeCli
process.env.DSH_HOME = temporary
process.env.CC_TEST_AUTH = 'true'
delete process.env.DSH_DIRECT_EDIT
delete process.env.CLAUDE_DIRECT_EDIT
const root = new Context()
const session = { id: 'session-1' }
const agent = { id: 'agent-1', session }
const directories = new Map([[session, outside]])
const sections = new Map()
const toolMap = new Map()
let guard
let route
let directoryService
let credentialsPresent = true
let credentialReads = 0
let selection = { provider: 'anthropic', model: 'claude-test' }
const profile = { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(temporary, 'package.json'), home: temporary, cwd: temporary, startedBundles: ['test-bundle'], overlays: [] }
const bundle = join(dir, 'node_modules', 'test-bundle')
mkdirSync(bundle, { recursive: true })
writeFileSync(profile.installAnchor, '{"name":"test-installation"}')
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles: ['test-bundle'] } } }))
writeFileSync(profile.patchPath, '[]\n')
writeFileSync(join(dir, 'cordis.yml'), '[]\n')
writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
  { id: 'config-editor', name: 'cordis:editor' },
  { id: 'settings', name: 'cordis:settings' },
  { id: 'llm-pi-ai', name: 'cordis:provider', config: { providers: { anthropic: { apiKeyEnv: 'TEST_KEY', models: [{ id: 'claude-test' }] } } } },
  { id: 'claude-codex-mode', name: 'cordis:mode', config: { mode: 'api' } },
] }]))
const request = async (mode, method = 'POST', path = `/claude-codex-mode/preflight?mode=${mode}`, headers = {}) => {
  let status
  let body
  await route.handler({ url: path, method, headers: { host: 'localhost', ...headers } }, {
    writeHead(code) { status = code }, end(text) { body = JSON.parse(text) },
  })
  return { status, body }
}
const state = () => request('', 'GET', '/claude-codex-mode/state')
const status = headers => request('', 'GET', '/claude-codex-mode/status', headers)
try {
  await root.plugin({
    name: 'fixture-services',
    apply(ctx) {
      ctx.provide('profileContext', profile)
      ctx.provide('systemPrompt', { section(definition) {
        sections.set(definition.name, definition)
        return () => sections.delete(definition.name)
      } })
      ctx.provide('tools', {
        guard(fn) { guard = fn; return () => { guard = undefined } },
        get(name) { return toolMap.get(name) },
        register(definition) {
          assert.equal(toolMap.has(definition.name), false, `duplicate tool ${definition.name}`)
          toolMap.set(definition.name, definition)
          return () => toolMap.delete(definition.name)
        },
      })
      ctx.provide('credentials', {
        describe: async () => { credentialReads++; return { configured: credentialsPresent, source: 'file' } },
        resolve: async ref => { assert.equal(ref, 'TEST_KEY'); return credentialsPresent ? { value: 'stored-test-secret', source: 'file' } : undefined },
      })
      ctx.provide('agentDefaultModel', { currentSelection: () => selection })
      ctx.provide('webServer', { register(definition) { route = definition; return () => { route = undefined } } })
    },
  })
  await root.plugin(Loader)
  Object.assign(root.loader.builtins, {
    editor: ConfigEditor, settings: Settings, mode: plugin,
    provider: { name: 'llm-pi-ai', Config: Schema.object({ providers: Schema.any().volatile() }), apply() {} },
  })
  await mountRootInclude(root, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await root.loader.await()
  const entry = root.configEditor.entries().find(row => row.options.id === 'claude-codex-mode')
  assert.ok(entry?.fiber, 'host must load')
  await entry.fiber
  const fiber = entry.fiber
  const activeState = fiber.state
  assert.ok(route)
  assert.ok(guard)
  assert.equal((await state()).body.mode, 'api')
  assert.ok(toolMap.has('codex_cli_run'), 'host Codex tool registration')
  assert.deepEqual([...toolMap.keys()].sort(), ['codex_cli_review', 'codex_cli_run', 'codex_cli_setup'])
  const setup = await toolMap.get('codex_cli_setup').execute({ cwd: repo }, {})
  assert.equal(setup.ready, true)
  await assert.rejects(toolMap.get('codex_cli_run').execute({ cwd: repo, prompt: 'test', background: true }, { callId: 'no-jobs', signal: new AbortController().signal }), /background jobs unavailable/)
  assert.equal([...toolMap.keys()].some(key => key.startsWith('mcp__claude-code__')), false)
  const section = () => sections.get('mode:claude-codex-routing').text
  assert.doesNotMatch(section(), /claude_code/)
  assert.match(section(), /由你直接完成/)
  const write = { name: 'write', arguments: { path: 'src/a.py' }, agent }
  assert.match(guard(write), /绝对路径/)
  directoryService = root.plugin({ name: 'fixture-directory', apply(ctx) {
    ctx.provide('workingDirectory', { get: session => directories.get(session) })
  } })
  await directoryService
  assert.equal(guard(write), undefined)
  directories.set(session, repo)
  assert.match(guard(write), /codex_cli_run/)
  assert.match(guard(write), /DSH_DIRECT_EDIT/)
  assert.doesNotMatch(guard(write), /Codex 工具未上线/)
  const codexTool = toolMap.get('codex_cli_run')
  toolMap.delete(codexTool.name)
  assert.match(guard(write), /宿主侧 Codex 工具注册失败/)
  toolMap.set(codexTool.name, codexTool)
  assert.equal(guard({ ...write, name: 'str_replace_editor', arguments: { command: 'view', path: join(repo, 'code.js') } }), undefined)
  assert.match(guard({ ...write, name: 'str_replace_editor', arguments: { command: 'str_replace', path: join(repo, 'code.js') } }), /codex_cli_run/)
  for (const file of ['requirements.txt', 'requirements-dev.txt', 'constraints.txt', 'CMakeLists.txt']) {
    assert.match(guard({ ...write, arguments: { path: file } }), /codex_cli_run/)
  }
  assert.equal(guard({ ...write, arguments: { path: 'notes.txt' } }), undefined)
  assert.equal(guard({ ...write, name: 'read' }), undefined)
  const describe = () => root.settings.describe().find(row => row.ns === 'claude-codex-mode')
  assert.equal(describe().value.codexView, 'jobs')
  assert.deepEqual((await state()).body, { mode: 'api', codexView: 'jobs' })
  const initialSection = sections.get('mode:claude-codex-routing')
  for (const codexView of ['tab', 'jobs']) {
    const current = describe()
    await root.settings.update(current.ns, { codexView }, current.revision)
    assert.deepEqual((await state()).body, { mode: 'api', codexView })
    assert.equal(entry.fiber, fiber, 'display updates keep the host fiber')
    assert.equal(sections.get('mode:claude-codex-routing'), initialSection, 'display updates skip the mode transition')
    const updated = describe()
    await assert.rejects(root.settings.update(updated.ns, { mode: 'claude-code-cli' }, updated.revision), /前置检查/)
  }
  console.log('codexView: volatile updates accepted without preflight; mode guard and routing unchanged')
  const first = describe()
  assert.equal(first.value.mode, 'api')
  assert.equal(first.autoGenerate, false)
  const before = readFileSync(profile.patchPath, 'utf8')
  const current = await status({ origin: 'http://localhost' })
  assert.equal(current.status, 200)
  assert.equal(current.body.mode, 'api')
  assert.equal(current.body.current.mode, 'api')
  assert.equal(current.body.current.ok, true)
  assert.equal(current.body.alternative, null)
  assert.equal(current.body.api.provider, true)
  assert.equal(current.body.api.credential.source, 'file')
  assert.deepEqual(current.body.api.models, ['claude-test'])
  assert.equal((await request('', 'POST', '/claude-codex-mode/test-connection', { origin: 'http://other-host' })).status, 403)
  assert.equal((await request('', 'GET', '/claude-codex-mode/check?mode=invalid')).status, 400)
  assert.equal((await request('', 'GET', '/claude-codex-mode/check?mode=api', { origin: 'http://other-host' })).status, 403)
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/models?limit=1000')
      assert.equal(init.headers['x-api-key'], 'stored-test-secret')
      assert.equal(init.redirect, 'manual')
      return new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }))
    }
    const connection = await request('', 'POST', '/claude-codex-mode/test-connection')
    assert.equal(connection.body.outcome, 'ok')
    assert.deepEqual(connection.body.missing, [])
    assert.doesNotMatch(JSON.stringify(connection.body), /stored-test-secret/)
    await assert.rejects(root.settings.update(first.ns, { mode: 'claude-code-cli' }, first.revision), /前置检查/)
    credentialsPresent = false
    globalThis.fetch = () => assert.fail('missing key must not make a network request')
    assert.equal((await request('', 'POST', '/claude-codex-mode/test-connection')).body.outcome, 'no-key')
  } finally {
    credentialsPresent = true
    globalThis.fetch = realFetch
  }
  const preview = await request('', 'GET', '/claude-codex-mode/check?mode=claude-code-cli')
  assert.equal(preview.status, 200)
  assert.equal(preview.body.ok, true)
  assert.equal(preview.body.mode, 'claude-code-cli')
  assert.equal(preview.body.api.provider, true)
  await assert.rejects(root.settings.update(first.ns, { mode: 'claude-code-cli' }, first.revision), /前置检查/)

  assert.equal((await status({ origin: 'http://other-host' })).status, 403)
  credentialsPresent = false
  const alternative = await status()
  assert.equal(alternative.body.current.ok, false)
  assert.equal(alternative.body.alternative.mode, 'claude-code-cli')
  assert.equal(alternative.body.alternative.ok, true)
  await assert.rejects(root.settings.update(first.ns, { mode: 'claude-code-cli' }, first.revision), /前置检查/)
  assert.equal(readFileSync(profile.patchPath, 'utf8'), before, 'unguarded settings writes must not persist')
  process.env.CC_TEST_AUTH = 'false'
  const bothFailed = await status()
  assert.equal(bothFailed.body.current.ok, false)
  assert.equal(bothFailed.body.alternative.ok, false)
  credentialsPresent = true
  const failed = await request('claude-code-cli')
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.checks.find(check => check.id === 'claude-auth').ok, false)
  await assert.rejects(root.settings.update(first.ns, { mode: 'claude-code-cli' }, first.revision), /前置检查/)
  assert.equal(describe().value.mode, 'api')
  assert.equal(readFileSync(profile.patchPath, 'utf8'), before)
  process.env.CC_TEST_AUTH = 'true'
  assert.equal((await request('claude-code-cli')).body.ok, true)
  await status()
  await root.settings.update(first.ns, { mode: 'claude-code-cli' }, first.revision)
  assert.equal((await status()).body.mode, 'claude-code-cli', 'status waits for the mode transition')
  assert.equal((await state()).body.mode, 'claude-code-cli')
  assert.equal(entry.fiber, fiber, 'volatile mode switch must keep the same host fiber')
  assert.ok(toolMap.has('mcp__claude-code__claude_code_run'), 'real Claude MCP tool discovery')
  assert.ok(toolMap.has('codex_cli_run'))
  for (const text of ['mode: "review"', '绝对 `cwd`', '用户原话', '必要上下文', 'resumeSessionId', '如实转述', '不自行改写']) assert.ok(section().includes(text))
  assert.match(guard(write), /codex_cli_run/, 'guard remains active in CLI mode')
  console.log('api -> claude-code-cli: same host fiber, Codex + Claude tools mounted, review prompt active')
  const second = describe()
  await assert.rejects(root.settings.update(second.ns, { mode: 'api' }, first.revision), /changed since/)
  credentialsPresent = false
  const readsBeforeStatus = credentialReads
  const cliCurrent = await status()
  assert.equal(cliCurrent.body.mode, 'claude-code-cli')
  assert.equal(cliCurrent.body.current.ok, true)
  assert.equal(cliCurrent.body.alternative, null)
  assert.equal(credentialReads, readsBeforeStatus + 1, 'passing CLI status reads the API summary only')
  console.log('status: current-only pass, alternatives on failure, cross-origin refused, approval unchanged')
  process.env.CC_TEST_AUTH = 'false'
  credentialsPresent = true
  const apiAlternative = await status()
  assert.equal(apiAlternative.body.current.mode, 'claude-code-cli')
  assert.equal(apiAlternative.body.current.ok, false)
  assert.equal(apiAlternative.body.alternative.mode, 'api')
  assert.equal(apiAlternative.body.alternative.ok, true)
  await assert.rejects(root.settings.update(second.ns, { mode: 'api' }, second.revision), /前置检查/)
  process.env.CC_TEST_AUTH = 'true'
  credentialsPresent = false
  assert.equal((await request('api')).body.ok, false)
  await assert.rejects(root.settings.update(second.ns, { mode: 'api' }, second.revision), /前置检查/)
  assert.equal(describe().value.mode, 'claude-code-cli')
  credentialsPresent = true
  selection = { provider: 'deepseek', model: 'deepseek-chat' }
  const warning = await request('api')
  assert.equal(warning.body.ok, true, 'default-model warning must not block saving')
  assert.equal(warning.body.checks.find(check => check.id === 'default-model').ok, false)
  await root.settings.update(second.ns, { mode: 'api' }, second.revision)
  assert.equal((await state()).body.mode, 'api')
  assert.equal(entry.fiber, fiber)
  assert.equal([...toolMap.keys()].some(key => key.startsWith('mcp__claude-code__')), false, 'Claude MCP unmounts')
  assert.ok(toolMap.has('codex_cli_run'))
  assert.doesNotMatch(section(), /claude_code/)
  console.log('claude-code-cli -> api: Claude tools removed, Codex retained, API prompt restored')
  directories.set(session, outside)
  assert.equal(guard(write), undefined)
  await directoryService.dispose()
  assert.match(guard(write), /绝对路径/)
  assert.match(guard({ ...write, arguments: { path: join(repo, 'code.js') } }), /codex_cli_run/)
  await fiber.dispose()
  assert.equal(guard, undefined)
  assert.equal(sections.size, 0)
  assert.equal(toolMap.size, 0)
  assert.equal(route, undefined)
  console.log('bundle disposal: guard, prompt, routes and all tools removed')

  for (const [serverName, mode, survivingTool] of [
    ['claude-code', 'claude-code-cli', 'codex_cli_run'],
  ]) {
    const warnings = []
    const children = []
    const unhandled = []
    const onUnhandled = error => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    const logOff = root.logger.exporter({ levels: { default: 3 }, export(message) {
      if (message.type === 'warn') warnings.push(message.args.join(' '))
    } })
    const childOff = root.on('internal/plugin', child => {
      if (child.runtime?.name === 'mcp-client' && child.uid !== null) children.push(child)
    }, { global: true })
    const failureHost = root.plugin({ ...plugin, async apply(ctx, config) {
      await plugin.apply(ctx, config, { ...SERVER_PATHS, [serverName]: failedServer })
    } }, { mode })
    try {
      await failureHost
      assert.equal(failureHost.state, activeState, `${serverName} startup failure must not fail the host`)
      assert.equal((await state()).body.mode, mode)
      const denied = guard({ name: 'write', arguments: { path: join(repo, 'code.js') }, agent })
      assert.match(denied, /codex_cli_run/, 'repository-code guard stays active')
      assert.equal([...toolMap.keys()].some(key => key.startsWith(`mcp__${serverName}__`)), false)
      if (survivingTool) assert.ok(toolMap.has(survivingTool), 'host Codex tools remain registered')
      assert.equal(section(), plugin.routing(mode), 'routing prompt survives the failed child')
      assert.ok(warnings.some(text => text.includes(serverName) && /启动失败/.test(text) && /重新启用/.test(text)), 'warn includes the server and a fix hint')
      const failedChild = children.find(child => child.config?.serverName === serverName)
      assert.ok(failedChild, 'the test must exercise a real MCP child fiber')
      assert.equal(failedChild.uid, null, 'failed child is explicitly disposed')
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(unhandled, [], 'startup failures are fully handled')
      console.log(`${serverName} startup failure: host, guard and routing remain active; failed child disposed`)
    } finally {
      await failureHost.dispose()
      await new Promise(resolve => setImmediate(resolve))
      process.off('unhandledRejection', onUnhandled)
      logOff()
      childOff()
    }
    assert.equal(guard, undefined)
    assert.equal(sections.size, 0)
    assert.equal(toolMap.size, 0)
    assert.equal(route, undefined)
    assert.deepEqual(unhandled, [], 'teardown leaves no unhandled rejections')
  }
} finally {
  await root.fiber.dispose()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(temporary, { recursive: true, force: true })
}
console.log('dsh-claude-codex-mode cordis load test: ok')
