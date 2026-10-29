/** Render one Codex JSONL stream without repeating cumulative item text. */
export function createEventRenderer() {
  const texts = new Map()
  const textLines = (item, prefix) => {
    const text = item.text ?? ''
    const previous = item.id ? (texts.get(item.id) ?? '') : ''
    if (item.id) texts.set(item.id, text)
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text
    return delta.split('\n').filter(line => line.length > 0).map(line => `${prefix}${line}`)
  }

  return {
    render(event) {
      const result = (lines = [], progress = null) => ({ lines, progress })
      switch (event.type) {
        case 'thread.started':
          return result([`[codex] thread ${event.thread_id}`], 'starting')
        case 'turn.started':
          return result(['[codex] turn started'])
        case 'turn.completed': {
          const usage = event.usage
          const tokens = usage ? ` (input: ${usage.input_tokens}, output: ${usage.output_tokens})` : ''
          return result([`[codex] turn completed${tokens}`], 'done')
        }
        case 'turn.failed':
        case 'error':
          return result([`! ${event.error?.message ?? event.message ?? 'Unknown error'}`], 'failed')
      }
      if (!['item.started', 'item.updated', 'item.completed'].includes(event.type)) return result()
      const item = event.item
      if (!item) return result()
      switch (item.type) {
        case 'command_execution':
          if (event.type === 'item.started') {
            const command = (item.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
            return result([`$ ${command}`], `exec: ${command}`)
          }
          if (event.type === 'item.completed') return result([`  exit ${item.exit_code}`])
          return result()
        case 'file_change':
          if (event.type !== 'item.completed') return result()
          return result((item.changes ?? []).map(change => `± ${change.path} (${change.kind})`), `files: ${(item.changes ?? []).length}`)
        case 'mcp_tool_call':
          return event.type === 'item.completed'
            ? result([`→ mcp ${item.server}/${item.tool} (${item.status})`]) : result()
        case 'agent_message':
          if (event.type === 'item.started') return result()
          return result(textLines(item, '> '), `agent: ${(item.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`)
        case 'reasoning':
          return result(textLines(item, '  · '))
        default:
          return result()
      }
    },
  }
}
