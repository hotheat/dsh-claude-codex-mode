import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS } from '../mcp/codex-cli/lib/tools.mjs'

const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])

function walk(schema) {
  if (typeof schema === 'boolean') return
  for (const key of Object.keys(schema)) assert.ok(allowed.has(key), `unsupported keyword: ${key}`)
  for (const value of Object.values(schema.properties ?? {})) walk(value)
  for (const value of schema.oneOf ?? []) walk(value)
  if (schema.items) walk(schema.items)
  if (typeof schema.additionalProperties === 'object') walk(schema.additionalProperties)
}

test('all seven shared tool schemas fit the host JSON Schema subset', () => {
  assert.deepEqual(TOOLS.map(tool => tool.name).sort(), [
    'codex_cli_cancel', 'codex_cli_result', 'codex_cli_review', 'codex_cli_run',
    'codex_cli_setup', 'codex_cli_status', 'codex_cli_wait',
  ])
  for (const tool of TOOLS) {
    assert.equal(tool.parameters.type, 'object')
    walk(tool.parameters)
  }
  const properties = TOOLS.find(tool => tool.name === 'codex_cli_run').parameters.properties
  for (const name of ['cwd', 'prompt', 'sandbox', 'background', 'timeoutMs', 'outputSchema', 'resumeSessionId', 'resumeLast', 'worktree', 'profile', 'addDirs', 'images']) {
    assert.ok(Object.hasOwn(properties, name), `missing run argument: ${name}`)
  }
})
