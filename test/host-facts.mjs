/** Provider lookup across Cordis config shapes: 0.2.1 resolved `fiber.config`, 0.2.2 raw `config` + `effectiveConfig`. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { hostFacts } from '../lib/index.js'

const occurrence = config => ({ fiber: { runtime: { name: 'llm-pi-ai' }, config } })
const context = rows => ({
  get: name => name === 'configEditor' ? { entries: () => rows } : undefined,
})

test('hostFacts reads validated provider config from Cordis 0.2.2 effectiveConfig', () => {
  const anthropic = { apiKeyEnv: 'ANTHROPIC_KEY', models: [{ id: 'claude-test' }] }
  const rows = [
    occurrence({ providers: { anthropic } }),
    occurrence({ providers: { sub2api: { baseURL: 'https://relay.example/v1' } } }),
    { fiber: { runtime: { name: 'other-plugin' }, config: { providers: { ignored: true } } } },
  ]
  const resolved = { get: () => ({ anthropic }) }
  const relay = { get: () => ({ sub2api: { baseURL: 'https://relay.example/v1' } }) }
  rows[0].fiber.effectiveConfig = { providers: resolved }
  rows[1].fiber.effectiveConfig = { providers: relay }
  rows[0].fiber.config = { providers: { raw: true } }
  rows[1].fiber.config = { providers: { raw: true } }
  const facts = hostFacts(context(rows), 'api')
  assert.deepEqual(facts.providers, {
    anthropic,
    sub2api: { baseURL: 'https://relay.example/v1' },
  })
})

test('hostFacts reads validated provider config from Cordis 0.2.1 fiber.config', () => {
  const anthropic = { apiKeyEnv: 'ANTHROPIC_KEY' }
  const facts = hostFacts(context([occurrence({ providers: { get: () => ({ anthropic }) } })]), 'api')
  assert.deepEqual(facts.providers, { anthropic })
})

test('hostFacts tolerates raw plain provider maps and missing providers', () => {
  const anthropic = { apiKeyEnv: 'ANTHROPIC_KEY' }
  const rows = [
    occurrence({ providers: { anthropic } }),
    occurrence({ providers: undefined }),
    occurrence({}),
    { fiber: { runtime: { name: 'llm-pi-ai' } } },
    { fiber: undefined },
    {},
  ]
  rows[3].fiber.effectiveConfig = { providers: {} }
  assert.deepEqual(hostFacts(context(rows), 'api').providers, { anthropic })
  assert.deepEqual(hostFacts({ get: () => undefined }, 'api').providers, {})
})
