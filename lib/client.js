/** Browser half, loaded directly by DSH's module loader without a build step. */
window.__ModuleLoader__.load({
  id: 'dsh-claude-codex-mode',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'claudeCodexMode'
    const dictionaries = {
      zh: {
        title: '讨论模式',
        mode: '讨论方式',
        current: '当前',
        currentMode: '当前模式',
        api: 'API',
        cli: 'Claude Code CLI',
        discussion: '讨论',
        execution: '执行',
        apiRoute: 'DSH 主模型',
        cliRoute: 'Claude Code（只读）',
        codex: 'Codex',
        apiRequirement: '需要 Anthropic provider 和 API key',
        cliRequirement: '需要 Claude Code 订阅登录',
        save: '检查并保存',
        saving: '检查并保存中…',
        saved: '已保存，模式已生效。',
        loading: '正在读取配置…',
        unavailable: '配置暂不可用，请确认插件和 Settings 服务已启用。',
        failed: '保存失败，请重新检查配置后重试。',
        blocked: '前置检查未通过，当前模式保持不变。',
        error: '阻断',
        warning: '提示',
        currentStatus: '当前模式检查',
        statusLoading: '正在检查当前模式…',
        statusPassed: '全部 {count} 项检查通过',
        statusUnavailable: '暂时无法读取检查结果',
        checking: '检查中',
        hasWarnings: '有提示',
        notPassed: '未通过',
        unreadable: '无法读取',
        switchable: '可切换',
        unchecked: '未检查',
        alreadyCurrent: '已是当前模式',
        preflight: '本次检查',
        morePassed: '另有 {count} 项检查通过',
        retry: '重试',
        apiReady: 'API 的检查已通过。选中它，再点「检查并保存」切换。',
        cliReady: 'Claude Code CLI 的检查已通过。选中它，再点「检查并保存」切换。',
        bothNeedFix: '两种模式都未通过检查。按下列提示修复任一模式后即可使用。',
        pass: '通过',
      },
      en: {
        title: 'Discussion mode',
        mode: 'Discussion method',
        current: 'Current',
        currentMode: 'Current mode',
        api: 'API',
        cli: 'Claude Code CLI',
        discussion: 'Discuss',
        execution: 'Execute',
        apiRoute: 'DSH main model',
        cliRoute: 'Claude Code (read-only)',
        codex: 'Codex',
        apiRequirement: 'Requires an Anthropic provider and API key',
        cliRequirement: 'Requires Claude Code subscription sign-in',
        save: 'Check and save',
        saving: 'Checking and saving…',
        saved: 'Saved. The mode is active.',
        loading: 'Reading configuration…',
        unavailable: 'Configuration is unavailable. Enable this plugin and the Settings service.',
        failed: 'Save failed. Check the configuration and try again.',
        blocked: 'Preflight failed. The current mode is unchanged.',
        error: 'Blocking',
        warning: 'Warning',
        currentStatus: 'Current mode checks',
        statusLoading: 'Checking the current mode…',
        statusPassed: 'All {count} checks passed',
        statusUnavailable: 'Check results are temporarily unavailable',
        checking: 'Checking',
        hasWarnings: 'Warnings',
        notPassed: 'Failed',
        unreadable: 'Unavailable',
        switchable: 'Ready to switch',
        unchecked: 'Not checked',
        alreadyCurrent: 'Already the current mode',
        preflight: 'Checks before saving',
        morePassed: '{count} more checks passed',
        retry: 'Retry',
        apiReady: 'API checks passed. Select it, then click “Check and save” to switch.',
        cliReady: 'Claude Code CLI checks passed. Select it, then click “Check and save” to switch.',
        bothNeedFix: 'Neither mode passes its checks. Fix either mode using the hints below.',
        pass: 'Pass',
      },
    }
    const styles = `
.dsh-cc-mode {
  --dcm-primary: var(--dsw-alias-label-primary, currentColor);
  --dcm-secondary: var(--dsw-alias-label-secondary, #737780);
  --dcm-tertiary: var(--dsw-alias-label-tertiary, #858993);
  --dcm-border: var(--dsw-alias-border-l2, rgb(0 0 0 / 12%));
  --dcm-brand: var(--dsw-alias-brand-primary, #4d6bfe);
  --dcm-success: var(--dsw-alias-state-success-primary, #1f9d55);
  --dcm-warning: var(--dsw-alias-state-warn-primary, #d97706);
  --dcm-error: var(--dsw-alias-state-error-primary, #dc2626);
  container: dcm / inline-size;
  width: 100%; max-width: 640px; display: grid; gap: 16px;
  color: var(--dcm-primary); font-family: var(--dsw-font-family, inherit); font-size: 13px; line-height: 1.5;
}
.dsh-cc-mode *, .dsh-cc-mode *::before, .dsh-cc-mode *::after { box-sizing: border-box; }
.dsh-cc-mode .dcm-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-cc-mode .dcm-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 24px; }
.dsh-cc-mode .dcm-active { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; border: 1px solid var(--dcm-border); border-radius: 999px; font-size: 12px; }
.dsh-cc-mode .dcm-dot { display: inline-block; flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.dsh-cc-mode .dcm-muted { color: var(--dcm-tertiary); }
.dsh-cc-mode .dcm-success { color: var(--dcm-success); }
.dsh-cc-mode .dcm-warning { color: var(--dcm-warning); }
.dsh-cc-mode .dcm-error { color: var(--dcm-error); }
.dsh-cc-mode .dcm-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dsh-cc-mode .dcm-mode {
  appearance: none; display: flex; flex-direction: column; align-items: stretch; gap: 12px; min-width: 0; padding: 16px;
  text-align: start; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1, transparent);
  border: 1.5px solid var(--dcm-border); border-radius: var(--dsw-radius-lg, 12px); cursor: pointer;
  transition: border-color 150ms, background-color 150ms, box-shadow 150ms;
}
.dsh-cc-mode .dcm-mode:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, var(--dcm-tertiary)); background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dcm-primary) 4%, transparent)); }
.dsh-cc-mode .dcm-mode[aria-checked="true"] { border-color: var(--dcm-brand); background: color-mix(in srgb, var(--dcm-brand) 6%, var(--dsw-alias-bg-layer-1, transparent)); }
.dsh-cc-mode .dcm-mode[aria-checked="true"]:hover:not(:disabled) { border-color: var(--dcm-brand); background: color-mix(in srgb, var(--dcm-brand) 10%, transparent); }
.dsh-cc-mode .dcm-mode:disabled { cursor: default; opacity: .6; }
.dsh-cc-mode .dcm-mode:focus-visible, .dsh-cc-mode .dcm-save:focus-visible, .dsh-cc-mode .dcm-retry:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dcm-brand)); outline-offset: 3px; }
.dsh-cc-mode .dcm-mode-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-cc-mode .dcm-mode-title { font-size: 14px; font-weight: 600; }
.dsh-cc-mode .dcm-current-tag { color: var(--dcm-secondary); border: 1px solid var(--dcm-border); border-radius: 4px; padding: 0 4px; font-size: 11px; font-weight: 400; }
.dsh-cc-mode .dcm-route { display: flex; align-items: center; gap: 4px; font-size: 11px; line-height: 20px; }
.dsh-cc-mode .dcm-node { min-width: 0; padding: 4px; border: 1px solid var(--dcm-border); border-radius: 4px; background: var(--dsw-alias-bg-layer-2, transparent); }
.dsh-cc-mode .dcm-caption { color: var(--dcm-tertiary); font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; }
.dsh-cc-mode .dcm-arrow { flex-shrink: 0; color: var(--dcm-tertiary); }
.dsh-cc-mode .dcm-requirement { color: var(--dcm-secondary); font-size: 12px; }
.dsh-cc-mode .dcm-badge { align-self: flex-start; margin-top: auto; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, currentColor 10%, transparent); font-size: 12px; }
.dsh-cc-mode .dcm-callout { margin: 0; padding: 12px 16px; color: var(--dcm-secondary); border-left: 2px solid var(--dcm-brand); background: color-mix(in srgb, var(--dcm-brand) 6%, transparent); border-radius: 0 var(--dsw-radius-md, 8px) var(--dsw-radius-md, 8px) 0; }
.dsh-cc-mode .dcm-panel { padding: 16px; border: 1px solid var(--dcm-border); border-radius: var(--dsw-radius-lg, 12px); background: color-mix(in srgb, var(--dcm-secondary) 3%, var(--dsw-alias-bg-layer-2, transparent)); }
.dsh-cc-mode .dcm-panel-title { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.dsh-cc-mode .dcm-summary { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.dsh-cc-mode .dcm-checks { margin: 0; padding: 0; list-style: none; }
.dsh-cc-mode .dcm-check-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; padding: 12px 0; animation: dcm-row-in 180ms both; }
.dsh-cc-mode .dcm-check-row:first-child { padding-top: 0; }
.dsh-cc-mode .dcm-check-row:last-child { padding-bottom: 0; }
.dsh-cc-mode .dcm-check-row + .dcm-check-row { border-top: 1px solid var(--dcm-border); }
.dsh-cc-mode .dcm-check-row:nth-child(2) { animation-delay: 30ms; }
.dsh-cc-mode .dcm-check-row:nth-child(3) { animation-delay: 60ms; }
.dsh-cc-mode .dcm-check-row:nth-child(4) { animation-delay: 90ms; }
.dsh-cc-mode .dcm-check-row:nth-child(5) { animation-delay: 120ms; }
.dsh-cc-mode .dcm-check-row:nth-child(n+6) { animation-delay: 150ms; }
.dsh-cc-mode .dcm-glyph { text-align: center; font-weight: 600; }
.dsh-cc-mode .dcm-check-label { color: var(--dcm-primary); }
.dsh-cc-mode .dcm-check-label.dcm-muted { color: var(--dcm-tertiary); }
.dsh-cc-mode .dcm-check-hint { margin-top: 4px; color: var(--dcm-secondary); font-size: 12px; overflow-wrap: anywhere; }
.dsh-cc-mode .dcm-both-failed { margin: 0 0 16px; color: var(--dcm-secondary); }
.dsh-cc-mode .dcm-check-group + .dcm-check-group { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--dcm-border); }
.dsh-cc-mode .dcm-group-title { margin: 0 0 12px; color: var(--dcm-secondary); font-size: 12px; font-weight: 600; }
.dsh-cc-mode .dcm-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-top: 16px; border-top: 1px solid var(--dcm-border); }
.dsh-cc-mode .dcm-message { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1 1 200px; min-width: 0; }
.dsh-cc-mode .dcm-retry { padding: 4px 8px; border: 1px solid var(--dcm-border); border-radius: var(--dsw-radius-md, 8px); font: inherit; font-size: 12px; color: var(--dcm-primary); background: transparent; cursor: pointer; transition: background-color 150ms; }
.dsh-cc-mode .dcm-retry:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dcm-primary) 4%, transparent)); }
.dsh-cc-mode .dcm-message p { margin: 0; }
.dsh-cc-mode .dcm-save-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 12px; margin-left: auto; }
.dsh-cc-mode .dcm-save-helper { color: var(--dcm-tertiary); font-size: 12px; }
.dsh-cc-mode .dcm-save { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 0 16px; border: 1px solid transparent; border-radius: var(--dsw-radius-md, 8px); font: inherit; font-weight: 500; color: var(--dsw-alias-label-primary-inverted, #fff); background: var(--dsw-alias-button-primary-fill, var(--dcm-brand)); cursor: pointer; transition: background-color 150ms; }
.dsh-cc-mode .dcm-save:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-button-primary-fill, var(--dcm-brand)), black 8%); }
.dsh-cc-mode:not([aria-busy="true"]) .dcm-save:disabled { color: var(--dcm-secondary); background: transparent; border-color: var(--dcm-border); opacity: .6; cursor: default; }
.dsh-cc-mode[aria-busy="true"] .dcm-save { cursor: wait; }
.dsh-cc-mode .dcm-spinner { width: 12px; height: 12px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: dcm-spin 700ms linear infinite; }
.dsh-cc-mode .dcm-pulse { animation: dcm-pulse 1200ms ease-in-out infinite; }
.dsh-cc-mode .dcm-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@container dcm (max-width: 519px) { .dsh-cc-mode .dcm-modes { grid-template-columns: minmax(0, 1fr); } }
@keyframes dcm-row-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dcm-pulse { 50% { opacity: .35; } }
@keyframes dcm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-cc-mode *, .dsh-cc-mode *::before, .dsh-cc-mode *::after { animation: none !important; transition: none !important; } }
`
    function createForm(ctx) {
      return function ModeForm({ t }) {
        const [descriptor, setDescriptor] = React.useState(null)
        const [mode, setMode] = React.useState('api')
        const [writable, setWritable] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [checks, setChecks] = React.useState([])
        const [preflightResults, setPreflightResults] = React.useState({})
        const [loadSequence, setLoadSequence] = React.useState(0)
        const [message, setMessage] = React.useState('loading')
        const [status, setStatus] = React.useState(null)
        const [statusMessage, setStatusMessage] = React.useState('')
        const alive = React.useRef(true)
        const statusRequest = React.useRef(0)
        const readStatus = async () => {
          const request = ++statusRequest.current
          setStatus(null)
          setPreflightResults({})
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
        const read = async (stage = false, isCancelled = () => false) => {
          const response = await ctx.remote.settings.describe()
          if (!alive.current || isCancelled()) return
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
          let cancelled = false
          let retryTimer
          const delays = [300, 600, 1200, 2400]
          setMessage('loading')
          const load = async (attempt = 0) => {
            try {
              await read(true, () => cancelled)
              if (!cancelled) { setMessage(''); void readStatus() }
            } catch {
              if (cancelled) return
              if (attempt < delays.length) retryTimer = setTimeout(() => { void load(attempt + 1) }, delays[attempt])
              else setMessage('unavailable')
            }
          }
          void load()
          return () => {
            cancelled = true
            clearTimeout(retryTimer)
            alive.current = false
            statusRequest.current++
          }
        }, [loadSequence])
        const save = async event => {
          event.preventDefault()
          setBusy(true)
          setMessage('')
          setChecks([])
          setPreflightResults(results => ({ ...results, [mode]: null }))
          try {
            const response = await fetch(`/claude-codex-mode/preflight?mode=${encodeURIComponent(mode)}`, { method: 'POST' })
            if (!response.ok) throw new Error('preflight failed')
            const result = await response.json()
            if (!alive.current) return
            setChecks(result.checks)
            setPreflightResults(results => ({ ...results, [mode]: result }))
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
        const activeMode = descriptor?.value.mode
        const disabled = busy || !descriptor || !writable
        const modes = ['api', 'claude-code-cli']
        const modeName = value => t(value === 'api' ? 'api' : 'cli')
        const hasWarnings = result => result.checks.some(item => !item.ok && item.level === 'warning')
        const currentState = statusMessage === 'statusLoading' ? 'checking'
          : !status ? 'unreadable' : !status.current.ok ? 'notPassed'
            : hasWarnings(status.current) ? 'hasWarnings' : 'pass'
        const tone = state => ({ pass: 'success', switchable: 'success', hasWarnings: 'warning', notPassed: 'error' }[state] || 'muted')
        const selectMode = value => { setMode(value); setMessage(''); setChecks([]) }
        const checkRows = items => h('ul', { className: 'dcm-checks' }, ...items.map(item => {
          const level = item.ok ? 'pass' : item.level === 'warning' ? 'warning' : 'error'
          return h('li', { key: item.id, className: 'dcm-check-row' },
            h('span', { className: `dcm-glyph dcm-${item.muted ? 'muted' : level === 'pass' ? 'success' : level}` },
              h('span', { 'aria-hidden': true }, level === 'pass' ? '✓' : level === 'warning' ? '!' : '✕'),
              h('span', { className: 'dcm-sr-only' }, t(level))),
            h('div', { className: 'dcm-check-copy' }, h('div', { className: `dcm-check-label${item.muted ? ' dcm-muted' : ''}` }, item.label),
              !item.ok && item.hint && h('div', { className: 'dcm-check-hint' }, item.hint)))
        }))
        const statusGroup = result => h('div', { className: 'dcm-check-group', key: result.mode },
          h('h5', { className: 'dcm-group-title' }, modeName(result.mode)),
          checkRows(result.checks.filter(item => !item.ok)))
        const passedCount = checks.filter(item => item.ok).length
        const preflightChecks = [
          ...checks.filter(item => !item.ok && item.level !== 'warning'),
          ...checks.filter(item => !item.ok && item.level === 'warning'),
          ...(passedCount ? [{ id: 'dcm-passed-summary', ok: true, muted: true,
            label: t('morePassed').replace('{count}', passedCount) }] : []),
        ]
        const bothFailed = status && !status.current.ok && status.alternative && !status.alternative.ok
        return h('form', { className: 'dsh-cc-mode', onSubmit: save, 'aria-busy': busy },
          h('style', null, styles),
          h('div', { className: 'dcm-header' },
            h('h3', { className: 'dcm-title' }, t('title')),
            descriptor && h('span', { className: 'dcm-active', 'aria-label': `${t('currentMode')}: ${modeName(activeMode)}, ${t(currentState)}` },
              h('span', { className: `dcm-dot dcm-${tone(currentState)}${currentState === 'checking' ? ' dcm-pulse' : ''}`, 'aria-hidden': true }),
              modeName(activeMode), h('span', { className: 'dcm-sr-only' }, t(currentState)))),
          h('div', { className: 'dcm-modes', role: 'radiogroup', 'aria-label': t('mode'), 'aria-disabled': disabled }, ...modes.map(value => {
            const active = value === activeMode
            const result = preflightResults[value] || (status?.alternative?.mode === value ? status.alternative : null)
            const state = active ? currentState : result ? result.ok ? 'switchable' : 'notPassed' : 'unchecked'
            return h('button', {
              key: value, type: 'button', role: 'radio', 'aria-checked': mode === value,
              'aria-label': modeName(value), tabIndex: mode === value ? 0 : -1, disabled,
              className: 'dcm-mode', onClick: () => selectMode(value),
              onKeyDown: event => {
                if (disabled) return
                const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
                if (direction) {
                  event.preventDefault()
                  const next = modes[(modes.indexOf(value) + direction + modes.length) % modes.length]
                  selectMode(next)
                  event.currentTarget.parentElement.querySelectorAll('[role="radio"]')[modes.indexOf(next)].focus()
                } else if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault()
                  selectMode(value)
                }
              },
            },
            h('span', { className: 'dcm-mode-heading' }, h('span', { className: 'dcm-mode-title' }, modeName(value)),
              active && h('span', { className: 'dcm-current-tag' }, t('current'))),
            h('span', { className: 'dcm-route' },
              h('span', { className: 'dcm-node' }, h('span', { className: 'dcm-caption' }, t('discussion')), ' · ', t(value === 'api' ? 'apiRoute' : 'cliRoute')),
              h('span', { className: 'dcm-arrow', 'aria-hidden': true }, '→'),
              h('span', { className: 'dcm-node' }, h('span', { className: 'dcm-caption' }, t('execution')), ' · ', t('codex'))),
            h('span', { className: 'dcm-requirement' }, t(value === 'api' ? 'apiRequirement' : 'cliRequirement')),
            h('span', { className: `dcm-badge dcm-${tone(state)}` }, t(state)))
          })),
          status?.alternative?.ok && h('p', { className: 'dcm-callout' }, t(status.alternative.mode === 'api' ? 'apiReady' : 'cliReady')),
          h('section', { className: 'dcm-panel dcm-current-status', 'aria-label': t('currentStatus') },
            h('h4', { className: 'dcm-panel-title' }, t('currentStatus')),
            statusMessage === 'statusLoading' || (!descriptor && message === 'loading')
              ? h('div', { className: 'dcm-summary', role: 'status' }, h('span', { className: 'dcm-dot dcm-muted dcm-pulse', 'aria-hidden': true }), t('statusLoading'))
              : !status ? h('div', { className: 'dcm-summary dcm-muted', role: 'status' }, t('statusUnavailable'))
                : bothFailed ? h(React.Fragment, null,
                  h('p', { className: 'dcm-both-failed' }, t('bothNeedFix')), statusGroup(status.current), statusGroup(status.alternative))
                  : status.current.ok && !hasWarnings(status.current)
                    ? h('div', { className: 'dcm-summary', role: 'status' },
                      h('span', { className: 'dcm-glyph dcm-success', 'aria-hidden': true }, '✓'),
                      t('statusPassed').replace('{count}', status.current.checks.length))
                    : checkRows(status.current.checks.filter(item => !item.ok))),
          checks.length > 0 && h('section', { className: 'dcm-panel dcm-preflight', 'aria-label': t('preflight') },
            h('h4', { className: 'dcm-panel-title' }, t('preflight')), checkRows(preflightChecks)),
          h('div', { className: 'dcm-actions' },
            h('div', { className: 'dcm-message' }, message && h('p', {
              role: message === 'blocked' || message === 'failed' ? 'alert' : 'status',
              className: message === 'saved' ? 'dcm-success' : ['blocked', 'failed', 'unavailable'].includes(message) ? 'dcm-error' : 'dcm-muted',
            }, t(message)),
              !descriptor && message === 'unavailable' && h('button', { type: 'button', className: 'dcm-retry',
                onClick: () => setLoadSequence(sequence => sequence + 1),
              }, t('retry'))),
            h('div', { className: 'dcm-save-controls' },
              descriptor && mode === activeMode && h('span', { className: 'dcm-save-helper' }, t('alreadyCurrent')),
              h('button', { type: 'submit', className: 'dcm-save', disabled: disabled || mode === activeMode },
                busy && h('span', { className: 'dcm-spinner', 'aria-hidden': true }), t(busy ? 'saving' : 'save')))))
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
