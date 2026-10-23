import './connection.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execute, preflight } from '../lib/preflight.js'

const facts = {
  providers: { anthropic: { apiKeyEnv: 'TEST_KEY', models: [{ id: 'claude-test' }] } },
  defaultModel: { provider: 'anthropic', model: 'claude-test' },
}
const deps = {
  nodeVersion: '20.0.0', env: { TEST_KEY: 'secret-must-never-appear', CODEX_CLI_PATH: '/test/codex', CLAUDE_CODE_CLI_PATH: '/test/claude' },
  fs: { existsSync: () => true },
  exec: async (_file, args) => ({ code: 0, stdout: args[0] === 'auth' ? '{"loggedIn":true}' : 'Logged in using ChatGPT', stderr: '' }),
}
for (const row of [
  { label: 'api success', mode: 'api', ok: true },
  { label: 'cli success', mode: 'claude-code-cli', ok: true },
  { label: 'Node too old', patch: { nodeVersion: '18.20.0' }, failed: 'node' },
  { label: 'missing Codex', patch: { exec: async () => { throw new Error('secret') } }, failed: 'codex-version' },
  { label: 'Codex not logged in', patch: { exec: async () => ({ code: 1, stderr: 'Not logged in' }) }, failed: 'codex-auth' },
  { label: 'Codex status unexpected', patch: { exec: async () => ({ code: 0, stdout: 'unknown' }) }, failed: 'codex-auth' },
  { label: 'missing bundled server', patch: { fs: { existsSync: () => false } }, failed: 'codex-server' },
  { label: 'missing provider', facts: { providers: {} }, failed: 'anthropic-provider' },
  { label: 'empty model list', facts: { providers: { anthropic: { models: [] } } }, failed: 'anthropic-provider' },
  { label: 'missing API key', patch: { env: {} }, failed: 'anthropic-credential' },
  { label: 'blank API key', patch: { env: { TEST_KEY: '' } }, failed: 'anthropic-credential' },
  { label: 'stored API key', patch: { env: {} }, facts: { credentialPresent: async () => true }, ok: true },
  { label: 'store failure', facts: { credentialPresent: async () => { throw new Error('secret') } }, failed: 'anthropic-credential' },
  { label: 'default model warning', facts: { defaultModel: { provider: 'deepseek', model: 'deepseek-chat' } }, ok: true, warning: true },
  { label: 'Claude auth false', mode: 'claude-code-cli', patch: { exec: async () => ({ code: 0, stdout: '{"loggedIn":false}' }) }, failed: 'claude-auth' },
  { label: 'Claude auth nonzero', mode: 'claude-code-cli', patch: { exec: async () => ({ code: 1, stdout: '{"loggedIn":true}' }) }, failed: 'claude-auth' },
  { label: 'Claude auth malformed', mode: 'claude-code-cli', patch: { exec: async () => ({ code: 0, stdout: 'logged in secret' }) }, failed: 'claude-auth' },
  { label: 'missing Claude server', mode: 'claude-code-cli', patch: { fs: { existsSync: path => !path.includes('claude-code/server') } }, failed: 'claude-server' },
]) {
  test(row.label, async () => {
    const result = await preflight({ ...facts, ...row.facts, mode: row.mode ?? 'api' }, { ...deps, ...row.patch })
    assert.equal(result.ok, row.ok ?? false)
    if (row.failed) assert.equal(result.checks.find(item => item.id === row.failed).ok, false)
    if (row.warning) assert.equal(result.checks.find(item => item.id === 'default-model').level, 'warning')
    assert.doesNotMatch(JSON.stringify(result), /secret-must-never-appear|logged in secret/)
    for (const item of result.checks.filter(item => !item.ok)) assert.ok(item.hint)
  })
}
test('exact commands, overrides and timeouts; CLI mode never reads API credentials', async () => {
  const calls = []
  const result = await preflight({ mode: 'claude-code-cli', credentialPresent: () => { throw new Error('must not read') } }, {
    ...deps, exec: async (file, args, options) => { calls.push({ file, args, options }); return deps.exec(file, args) },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(item => [item.file, item.args]), [
    ['/test/codex', ['--version']], ['/test/codex', ['login', 'status']],
    ['/test/claude', ['--version']], ['/test/claude', ['auth', 'status']],
  ])
  for (const item of calls) { assert.equal(item.options.timeout, 10000); assert.equal(item.options.killSignal, 'SIGKILL') }
})
test('exec timeout terminates an external command', async () => {
  const result = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100, killSignal: 'SIGKILL' })
  assert.notEqual(result.code, 0)
})
test('invalid mode is rejected', async () => {
  await assert.rejects(preflight({ mode: 'other' }, deps), /mode must be/)
})
