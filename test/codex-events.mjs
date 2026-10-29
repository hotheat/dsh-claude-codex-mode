import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventRenderer } from '../lib/codex-events.js'

test('Codex event stream renders facts and cumulative text deltas exactly once', () => {
  const renderer = createEventRenderer()
  const sequence = [
    [{ type: 'thread.started', thread_id: 't1' }, ['[codex] thread t1'], 'starting'],
    [{ type: 'turn.started' }, ['[codex] turn started'], null],
    [{ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }, ['$ npm test'], 'exec: npm test'],
    [{ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }, ['  exit 0'], null],
    [{ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }, { path: 'b.js', kind: 'add' }] } }, ['± a.js (update)', '± b.js (add)'], 'files: 2'],
    [{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't', status: 'completed' } }, ['→ mcp s/t (completed)'], null],
    [{ type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Hello' } }, ['> Hello'], 'agent: Hello'],
    [{ type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Hello world\nNext' } }, ['>  world', '> Next'], 'agent: Hello world Next'],
    [{ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Hello world\nNext' } }, [], 'agent: Hello world Next'],
    [{ type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Hello' } }, ['> Hello'], 'agent: Hello'],
    [{ type: 'item.started', item: { id: 'r', type: 'reasoning', text: 'Think' } }, ['  · Think'], null],
    [{ type: 'item.updated', item: { id: 'r', type: 'reasoning', text: 'Think more' } }, ['  ·  more'], null],
    [{ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'Think more' } }, [], null],
    [{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }, ['[codex] turn completed (input: 10, output: 2)'], 'done'],
    [{ type: 'turn.completed' }, ['[codex] turn completed'], 'done'],
    [{ type: 'turn.failed', error: { message: 'failed turn' } }, ['! failed turn'], 'failed'],
    [{ type: 'error', message: 'broken stream' }, ['! broken stream'], 'failed'],
    [{ type: 'unknown' }, [], null],
    [{ type: 'item.completed', item: { type: 'unknown' } }, [], null],
  ]
  for (const [event, lines, progress] of sequence) {
    assert.deepEqual(renderer.render(event), { lines, progress }, JSON.stringify(event))
  }
  assert.deepEqual(createEventRenderer().render({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Hello' } }), { lines: ['> Hello'], progress: 'agent: Hello' })
})

test('commands and agent progress stay on one bounded line', () => {
  const { render } = createEventRenderer()
  assert.deepEqual(render({ type: 'item.started', item: { type: 'command_execution', command: `  ${'x'.repeat(400)}\n` } }), {
    lines: [`$ ${'x'.repeat(300)}`], progress: `exec: ${'x'.repeat(300)}`,
  })
  assert.equal(render({ type: 'item.updated', item: { type: 'agent_message', text: 'x'.repeat(100) } }).progress, `agent: ${'x'.repeat(80)}`)
})
