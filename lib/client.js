/** Browser half, loaded directly by DSH's module loader without a build step. */
window.__ModuleLoader__.load({
  id: 'dsh-claude-codex-mode',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'claudeCodexMode'
    const dictionaries = {
      zh: {
        title: '讨论模式', mode: '讨论方式', current: '当前模式',
        api: 'API：DSH 主模型直接讨论', cli: 'Claude Code CLI：只读讨论',
        apiHint: '在 Models 页面配置 Anthropic provider 和 API key，并选择 Claude。代码修改交给 Codex。',
        cliHint: '使用 Claude Code 的订阅登录讨论。用户确认执行后，由 DSH 调用 Codex 修改代码。',
        save: '检查并保存', saving: '检查并保存中…', saved: '已保存，模式已生效。',
        loading: '正在读取配置…', unavailable: '配置暂不可用，请确认插件和 Settings 服务已启用。',
        failed: '保存失败，请重新检查配置后重试。', blocked: '前置检查未通过，当前模式保持不变。',
        error: '阻断', warning: '提示', pass: '通过', hint: '修复提示',
        currentStatus: '当前模式检查结果', statusLoading: '正在检查当前模式…',
        statusPassed: '当前模式检查通过', statusUnavailable: '暂时无法读取检查结果',
        apiReady: 'API 的检查已通过，可以切换到该模式', cliReady: 'Claude Code CLI 的检查已通过，可以切换到该模式',
        chooseApi: '选择 API', chooseCli: '选择 Claude Code CLI',
        bothNeedFix: '两种模式都未通过检查。按下列提示修复任一模式后即可使用。',
      },
      en: {
        title: 'Discussion mode', mode: 'Discuss using', current: 'Current mode',
        api: 'API: discuss with the DSH model', cli: 'Claude Code CLI: read-only discussion',
        apiHint: 'Configure an Anthropic provider and API key on Models, then select Claude. Codex handles code edits.',
        cliHint: 'Discuss through your Claude Code subscription. After you approve execution, DSH calls Codex to edit code.',
        save: 'Check and save', saving: 'Checking and saving…', saved: 'Saved. The mode is active.',
        loading: 'Reading configuration…', unavailable: 'Configuration is unavailable. Enable this plugin and the Settings service.',
        failed: 'Save failed. Check the configuration and try again.', blocked: 'Preflight failed. The current mode is unchanged.',
        error: 'Blocking', warning: 'Warning', pass: 'Pass', hint: 'Fix',
        currentStatus: 'Current mode checks', statusLoading: 'Checking the current mode…',
        statusPassed: 'Current mode checks passed', statusUnavailable: 'Check results are temporarily unavailable',
        apiReady: 'API checks passed. You can switch to this mode.', cliReady: 'Claude Code CLI checks passed. You can switch to this mode.',
        chooseApi: 'Select API', chooseCli: 'Select Claude Code CLI',
        bothNeedFix: 'Neither mode passes its checks. Fix either mode using the hints below.',
      },
    }
    function createForm(ctx) {
      return function ModeForm({ t }) {
        const [descriptor, setDescriptor] = React.useState(null)
        const [mode, setMode] = React.useState('api')
        const [writable, setWritable] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [checks, setChecks] = React.useState([])
        const [message, setMessage] = React.useState('loading')
        const [status, setStatus] = React.useState(null)
        const [statusMessage, setStatusMessage] = React.useState('')
        const alive = React.useRef(true)
        const statusRequest = React.useRef(0)
        const readStatus = async () => {
          const request = ++statusRequest.current
          setStatus(null)
          setStatusMessage('statusLoading')
          try {
            const response = await fetch('/claude-codex-mode/status')
            if (!response.ok) throw new Error('status failed')
            const result = await response.json()
            if (alive.current && request === statusRequest.current) {
              setStatus(result)
              setStatusMessage('')
            }
          } catch {
            if (alive.current && request === statusRequest.current) setStatusMessage('statusUnavailable')
          }
        }
        const read = async (stage = false) => {
          const response = await ctx.remote.settings.describe()
          if (!alive.current) return
          if (!response.ok) throw new Error('describe failed')
          const entry = response.value.namespaces.find(item => item.ns === 'claude-codex-mode')
          if (!entry) throw new Error('entry unavailable')
          setDescriptor(entry)
          setWritable(response.value.writable)
          if (stage) setMode(entry.value.mode)
          return entry
        }
        React.useEffect(() => {
          alive.current = true
          read(true).then(() => {
            if (alive.current) { setMessage(''); void readStatus() }
          }).catch(() => { if (alive.current) setMessage('unavailable') })
          return () => { alive.current = false; statusRequest.current++ }
        }, [])
        const save = async event => {
          event.preventDefault()
          setBusy(true)
          setMessage('')
          setChecks([])
          try {
            const response = await fetch(`/claude-codex-mode/preflight?mode=${encodeURIComponent(mode)}`, { method: 'POST' })
            if (!response.ok) throw new Error('preflight failed')
            const result = await response.json()
            if (!alive.current) return
            setChecks(result.checks)
            if (!result.ok) { setMessage('blocked'); return }
            const saved = await ctx.remote.settings.update(descriptor.ns, { mode }, descriptor.revision)
            if (!saved.ok) throw new Error('update failed')
            const state = await fetch('/claude-codex-mode/state')
            if (!state.ok || (await state.json()).mode !== mode) throw new Error('mount failed')
            await read()
            if (alive.current) { setMessage('saved'); void readStatus() }
          } catch {
            if (alive.current) {
              setMessage('failed')
              await read().catch(() => {})
            }
          } finally { if (alive.current) setBusy(false) }
        }
        const statusChecks = (result, items) => items.length > 0 && h('ul', { style: { paddingLeft: 22, lineHeight: 1.7 }, 'aria-label': t(result.mode === 'api' ? 'api' : 'cli') },
          ...items.map(item => h('li', { key: item.id, style: { marginBottom: 8 } },
            h('strong', null, `[${t(item.level === 'warning' ? 'warning' : 'error')}] `), item.label,
            h('div', null, `${t('hint')}: ${item.hint}`))))
        return h('form', { className: 'dsh-cc-mode', onSubmit: save, 'aria-busy': busy },
          h('h3', { style: { margin: '0 0 16px', fontSize: 16 } }, t('title')),
          h('label', { htmlFor: 'dsh-cc-mode-select', style: { display: 'block', marginBottom: 8 } }, t('mode')),
          h('select', {
            id: 'dsh-cc-mode-select', value: mode, disabled: busy || !descriptor || !writable,
            style: { width: '100%', maxWidth: 480, minHeight: 36, padding: '6px 10px', font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6 },
            onChange: event => { setMode(event.target.value); setMessage(''); setChecks([]) },
          }, h('option', { value: 'api' }, t('api')), h('option', { value: 'claude-code-cli' }, t('cli'))),
          h('p', { style: { margin: '10px 0', lineHeight: 1.6, opacity: 0.8 } }, t(mode === 'api' ? 'apiHint' : 'cliHint')),
          descriptor && h('p', { style: { fontSize: 13, opacity: 0.8 } }, `${t('current')}: ${descriptor.value.mode}`),
          (statusMessage || status) && h('section', { 'aria-label': t('currentStatus'), style: { margin: '16px 0', lineHeight: 1.6 } },
            h('h4', { style: { margin: '0 0 8px', fontSize: 14 } }, t('currentStatus')),
            statusMessage && h('p', { role: 'status' }, t(statusMessage)),
            status && h(React.Fragment, null,
              status.current.ok && h('p', { role: 'status' }, t('statusPassed')),
              statusChecks(status.current, status.current.checks.filter(item => status.current.ok ? item.level === 'warning' : !item.ok)),
              status.alternative && (status.alternative.ok ? h(React.Fragment, null,
                h('p', null, t(status.alternative.mode === 'api' ? 'apiReady' : 'cliReady')),
                h('button', { type: 'button', disabled: busy || !writable,
                  style: { minHeight: 36, padding: '6px 14px', font: 'inherit', borderRadius: 6, cursor: busy ? 'wait' : 'pointer' },
                  onClick: () => { setMode(status.alternative.mode); setMessage(''); setChecks([]) },
                }, t(status.alternative.mode === 'api' ? 'chooseApi' : 'chooseCli')),
              ) : h(React.Fragment, null,
                h('h4', { style: { margin: '16px 0 8px', fontSize: 14 } }, t('bothNeedFix')),
                h('p', null, t(status.alternative.mode === 'api' ? 'api' : 'cli')),
                statusChecks(status.alternative, status.alternative.checks.filter(item => !item.ok)),
              )))),
          checks.length > 0 && h('ul', { style: { paddingLeft: 22, lineHeight: 1.7 }, 'aria-label': 'Preflight' }, ...checks.map(item =>
            h('li', { key: item.id, style: { marginBottom: 8 } },
              h('strong', null, `[${t(item.ok ? 'pass' : item.level === 'warning' ? 'warning' : 'error')}] `), item.label,
              !item.ok && h('div', null, `${t('hint')}: ${item.hint}`)))),
          message && h('p', { role: message === 'blocked' || message === 'failed' ? 'alert' : 'status', style: { lineHeight: 1.6 } }, t(message)),
          h('button', { type: 'submit', disabled: busy || !descriptor || !writable || mode === descriptor.value.mode,
            style: { marginTop: 8, minHeight: 36, padding: '6px 14px', font: 'inherit', borderRadius: 6, cursor: busy ? 'wait' : 'pointer' } }, t(busy ? 'saving' : 'save')))
      }
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-claude-codex-mode', locale: NS,
        }, createForm(ctx)))
      },
    }
  },
})
