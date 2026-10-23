import assert from 'node:assert/strict'
import test from 'node:test'
import { anthropicModelsURL, testAnthropicConnection } from '../lib/connection.js'
import { apiConfigSummary } from '../lib/api-config.js'

const key = 'secret-connection-key'
const probe = options => testAnthropicConnection({ apiKey: key, ...options })
const listing = (data = [{ id: 'claude-a' }]) => new Response(JSON.stringify({ data }))

test('model listing roots, request headers and redirect boundary', async () => {
  for (const [baseURL, expected] of [
    [undefined, 'https://api.anthropic.com/v1/models?limit=1000'],
    ['https://example.com/', 'https://example.com/v1/models?limit=1000'],
    ['https://example.com/v1///', 'https://example.com/v1/models?limit=1000'],
    ['https://example.com/proxy/v1/', 'https://example.com/proxy/v1/models?limit=1000'],
  ]) {
    assert.equal(anthropicModelsURL(baseURL), expected)
    const result = await probe({ baseURL, fetch: async (url, init) => {
      assert.equal(url, expected)
      assert.equal(init.method, 'GET')
      assert.equal(init.headers['x-api-key'], key)
      assert.equal(init.headers['anthropic-version'], '2023-06-01')
      assert.equal(init.redirect, 'manual')
      assert.ok(init.signal instanceof AbortSignal)
      return listing()
    } })
    assert.equal(result.outcome, 'ok')
    assert.deepEqual(result.models, ['claude-a'])
    assert.equal(typeof result.elapsedMs, 'number')
    assert.doesNotMatch(JSON.stringify(result), /secret-connection-key/)
  }
})

test('missing provider and key make no network request', async () => {
  const fetch = () => assert.fail('must not fetch')
  assert.equal((await probe({ provider: false, fetch })).outcome, 'no-provider')
  assert.equal((await probe({ apiKey: '', fetch })).outcome, 'no-key')
})

for (const [status, outcome] of [[301, 'redirect'], [307, 'redirect'], [401, 'unauthorized'], [403, 'unauthorized'],
  [404, 'not-supported'], [405, 'not-supported'], [501, 'not-supported'], [429, 'http-error'], [500, 'http-error']]) {
  test(`HTTP ${status}: ${outcome}, body never exposed`, async () => {
    const result = await probe({ fetch: async () => new Response(key, { status }) })
    assert.equal(result.ok, false)
    assert.equal(result.outcome, outcome)
    assert.equal(result.status, status)
    assert.doesNotMatch(JSON.stringify(result), /secret-connection-key/)
  })
}
for (const body of ['not json', '{}', '{"data":{}}']) {
  test(`unparseable listing ${body}`, async () => {
    assert.equal((await probe({ fetch: async () => new Response(body) })).outcome, 'not-supported')
  })
}

test('network failure and fetch/body timeouts', async () => {
  assert.equal((await probe({ fetch: async () => { throw new Error(key) } })).outcome, 'unreachable')
  let signal
  assert.equal((await probe({ timeoutMs: 5, fetch: (_url, options) => { signal = options.signal; return new Promise(() => {}) } })).outcome, 'timeout')
  assert.equal(signal.aborted, true)
  let cancelled = false
  const result = await probe({ timeoutMs: 5, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
  assert.equal(result.outcome, 'timeout')
  assert.equal(cancelled, true)
})

test('stream and declared body sizes capped at 1 MiB with cancellation', async () => {
  let cancelled = false
  let reads = 0
  const result = await probe({ fetch: async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(512 * 1024)) },
    cancel() { cancelled = true },
  })) })
  assert.equal(result.outcome, 'not-supported')
  assert.equal(cancelled, true)
  assert.ok(reads <= 4)
  assert.equal((await probe({ fetch: async () => new Response('[]', { headers: { 'content-length': 1048577 } }) })).outcome, 'not-supported')
})

test('safe model ids capped at 100, missing computed against entire listing', async () => {
  const data = Array.from({ length: 150 }, (_, i) => ({ id: `claude-${i}` }))
  data.push(null, { id: 123 }, {}, { id: 'x'.repeat(201) }, { id: key })
  const result = await probe({ configuredModels: ['claude-149', 'missing', key], fetch: async () => listing(data) })
  assert.equal(result.ok, true)
  assert.equal(result.models.length, 100)
  assert.deepEqual(result.missing, ['missing'])
  assert.doesNotMatch(JSON.stringify(result), /secret-connection-key/)
})

test('API summary strips userinfo/query/fragment and preserves credential source without key', async () => {
  const summary = await apiConfigSummary({ providers: { anthropic: {
    baseURL: `https://user:${key}@example.com/prefix/v1?key=${key}#${key}`,
    apiKeyEnv: 'TEST_KEY', apiKey: key, models: [{ id: 'claude-a', key }],
  } }, credentialDescribe: async () => ({ configured: true, source: 'file', value: key }),
  defaultModel: { provider: 'anthropic', model: 'claude-a', key } })
  assert.equal(summary.baseURL, 'https://example.com/prefix/v1')
  assert.deepEqual(summary.credential, { configured: true, source: 'file' })
  assert.deepEqual(summary.models, ['claude-a'])
  assert.equal(summary.defaultBaseURL, false)
  assert.doesNotMatch(JSON.stringify(summary), /secret-connection-key/)
  const absent = await apiConfigSummary({ providers: {} })
  assert.equal(absent.provider, false)
  assert.equal(absent.defaultBaseURL, true)
  assert.deepEqual(absent.credential, { configured: false, source: null })
  for (const source of ['env', 'custom-store']) {
    const value = await apiConfigSummary({ providers: { anthropic: { apiKeyEnv: 'KEY' } }, credentialDescribe: async () => ({ configured: true, source }) })
    assert.equal(value.credential.source, source)
  }
})
