/** Exercise the shipped sidebar tab through the module loader, jobs store and DOM. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const now = Date.now()
const job = (id, status, startedAt, extra = {}) => ({ id, kind: 'codex', label: id, status, startedAt, ...extra })
const initialRows = [
  job('old-completed', 'completed', now - 40000, { finishedAt: now - 10000, detail: 'Earlier result' }),
  job('new-live', 'running', now - 5000, { progress: 'Reviewing' }),
  job('shell-job', 'running', now - 50000, { kind: 'shell' }),
  job('first-live', 'stopping', now - 10000, { progress: 'Stopping process' }),
  job('recent-failed', 'failed', now - 10000, { finishedAt: now - 1000, detail: 'CLI failed' }),
]

async function withTab(run, { hasJobs = true, hasSidebar = true, locale = 'zh', codexView = 'tab', describe } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const calls = []
  const listeners = new Set()
  const timers = new Map()
  const effects = []
  const tabs = []
  const copied = []
  let timerId = 0
  let clock = 0
  let factory
  let dictionaries
  let killError
  let copyError
  let snapshot = { rows: { session: initialRows }, observed: {
    'first-live': { text: 'First retained output', gapBefore: false, streaming: true },
    'new-live': { text: 'New retained output', gapBefore: false, streaming: true },
  } }
  const jobs = {
    state: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        calls.push(['subscribe'])
        listeners.add(listener)
        return () => { calls.push(['unsubscribe']); listeners.delete(listener) }
      },
    },
    watchRows(sessionId) { calls.push(['watchRows', sessionId]); return () => calls.push(['releaseRows', sessionId]) },
    observe(sessionId, jobId) { calls.push(['observe', sessionId, jobId]); return () => calls.push(['releaseObserve', sessionId, jobId]) },
    async kill(sessionId, jobId) { calls.push(['kill', sessionId, jobId]); if (killError) throw killError },
  }
  const context = {
    window: { __ModuleLoader__: { load(entry) { factory = entry.factory } } },
    navigator: { clipboard: { async writeText(text) { if (copyError) throw copyError; copied.push(text) } } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  vm.runInNewContext(source, context)
  const plugin = factory(name => { assert.equal(name, 'react'); return React })
  const t = (key, params = {}) => {
    assert.ok(dictionaries[locale][key], `missing ${locale} translation: ${key}`)
    return Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), dictionaries[locale][key])
  }
  const ctx = {
    get(name) { assert.equal(name, 'jobs'); return hasJobs ? jobs : undefined },
    effect(fn) { effects.push(fn()) },
    locale: {
      register(namespace, value) { assert.equal(namespace, 'claudeCodexMode'); dictionaries = value; return () => {} },
      bind(namespace) { assert.equal(namespace, 'claudeCodexMode'); return t },
    },
    slots: { inject() {} },
    remote: { settings: { describe: describe ?? (async () => ({ ok: true, value: { namespaces: [
      { ns: 'claude-codex-mode', value: { codexView } },
    ] } })) } },
    inject(dependencies, callback) {
      assert.deepEqual(Array.from(dependencies), ['betterSidebar'])
      if (hasSidebar) callback(ctx)
    },
    betterSidebar: { registerTab(descriptor) { tabs.push(descriptor); return () => calls.push(['disposeTab']) } },
  }
  plugin.apply(ctx)
  await Promise.resolve()
  const root = createRoot(document.getElementById('root'))
  let props = { ctx, scope: { sessionId: 'session' }, visible: true }
  let unmounted = false
  const render = async updates => {
    props = { ...props, ...updates }
    await act(async () => root.render(React.createElement(tabs[0].component, props)))
  }
  const emit = async patch => {
    await act(async () => {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    })
  }
  const click = async selector => { await act(async () => document.querySelector(selector).click()) }
  const unmount = async () => { await act(async () => root.unmount()); unmounted = true }
  try {
    await run({ tabs, calls, render, emit, click, unmount, copied, timers, listeners, dictionaries,
      disposePlugin() { for (const release of effects.splice(0).reverse()) release?.() },
      get snapshot() { return snapshot },
      setKillError(error) { killError = error },
      setCopyError(error) { copyError = error },
      async advance(ms) {
        await act(async () => {
          clock += ms
          for (const [id, timer] of timers) {
            if (timer.at > clock) continue
            timers.delete(id)
            timer.callback()
          }
        })
      },
    })
  } finally {
    if (!unmounted) await unmount()
    for (const release of effects.reverse()) release?.()
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}

const rowLabels = () => Array.from(document.querySelectorAll('.dcm-codex-label'), row => row.textContent)
const selectedLabel = () => document.querySelector('.dcm-codex-row[aria-pressed="true"] .dcm-codex-label')?.textContent

for (const codexView of ['jobs', undefined]) {
  test(`startup leaves the Codex tab unregistered for ${codexView ?? 'a missing option'}`, async () => {
    await withTab(async ({ tabs, calls }) => {
      assert.equal(tabs.length, 0)
      assert.equal(calls.some(call => call[0] === 'disposeTab'), false)
    }, { describe: async () => ({ ok: true, value: { namespaces: [
      { ns: 'claude-codex-mode', value: codexView ? { codexView } : { mode: 'api' } },
    ] } }) })
  })
}

test('a late startup describe cannot register a tab after plugin disposal', async () => {
  let resolve
  await withTab(async ({ tabs, disposePlugin }) => {
    disposePlugin()
    resolve({ ok: true, value: { namespaces: [{ ns: 'claude-codex-mode', value: { codexView: 'tab' } }] } })
    await Promise.resolve()
    assert.equal(tabs.length, 0)
  }, { describe: () => new Promise(done => { resolve = done }) })
})

test('registers a single optional Codex tab with localized description and terminal icon', async () => {
  let calls
  await withTab(async fixture => {
    calls = fixture.calls
    assert.equal(fixture.tabs.length, 1)
    const tab = fixture.tabs[0]
    assert.equal(tab.id, 'claude-codex-mode:codex')
    assert.equal(tab.title, 'Codex')
    assert.equal(tab.single, true)
    assert.equal(tab.order, 60)
    assert.equal(typeof tab.component, 'function')
    assert.equal(tab.description(), '本会话的 Codex 运行与实时输出')
    const icon = tab.icon(16)
    assert.equal(icon.type, 'svg')
    assert.equal(icon.props.width, 16)
    assert.equal(icon.props.stroke, 'currentColor')
    assert.deepEqual(Object.keys(fixture.dictionaries.zh).sort(), Object.keys(fixture.dictionaries.en).sort())
  })
  assert.deepEqual(calls.at(-1), ['disposeTab'])
  await withTab(async ({ tabs }) => assert.equal(tabs.length, 0), { hasSidebar: false })
})

test('watches this session, sorts only Codex rows, observes selection and streams pushed text', async () => {
  await withTab(async fixture => {
    const { render, calls, click, emit } = fixture
    await render()
    assert.deepEqual(rowLabels(), ['first-live', 'new-live', 'recent-failed', 'old-completed'])
    assert.equal(document.querySelector('.dcm-codex-header').textContent, '4 个任务 · 2 运行中')
    assert.equal(selectedLabel(), 'first-live')
    assert.deepEqual(calls.filter(call => call[0] === 'watchRows'), [['watchRows', 'session']])
    assert.deepEqual(calls.filter(call => call[0] === 'observe'), [['observe', 'session', 'first-live']])
    assert.equal(document.querySelector('.dcm-codex-text').textContent, 'First retained output')
    assert.match(document.querySelector('.dcm-codex-meta').textContent, /停止中.*Stopping process/)
    await click('.dcm-codex-row[title="new-live"]')
    assert.deepEqual(calls.at(-1), ['observe', 'session', 'new-live'])
    assert.ok(calls.some(call => call.join() === 'releaseObserve,session,first-live'))
    assert.equal(document.querySelector('.dcm-codex-text').textContent, 'New retained output')
    await emit({ observed: { ...fixture.snapshot.observed, 'new-live': { text: 'New retained output\nPushed chunk', streaming: true, gapBefore: false } } })
    assert.equal(document.querySelector('.dcm-codex-text').textContent, 'New retained output\nPushed chunk')
    assert.equal(calls.filter(call => call[0] === 'subscribe').length, 1, 'store callbacks stay stable')
    await render({ visible: false })
    assert.ok(calls.some(call => call.join() === 'releaseRows,session'))
    assert.ok(calls.some(call => call.join() === 'releaseObserve,session,new-live'))
    await render({ visible: true })
    assert.equal(calls.filter(call => call[0] === 'watchRows').length, 2)
    assert.deepEqual(calls.at(-1), ['observe', 'session', 'new-live'])
    await fixture.unmount()
    assert.equal(fixture.listeners.size, 0)
    assert.deepEqual(calls.filter(call => call[0] === 'watchRows').length, calls.filter(call => call[0] === 'releaseRows').length)
    assert.deepEqual(calls.filter(call => call[0] === 'observe').length, calls.filter(call => call[0] === 'releaseObserve').length)
  })
})

test('hidden tabs defer watching and observation; removed rows and session changes reset selection', async () => {
  await withTab(async fixture => {
    const { render, calls, emit, click } = fixture
    await render({ visible: false })
    assert.equal(calls.some(call => call[0] === 'watchRows' || call[0] === 'observe'), false)
    await render({ visible: true })
    await click('.dcm-codex-row[title="new-live"]')
    await emit({ rows: { session: initialRows.filter(row => row.id !== 'new-live') } })
    assert.equal(selectedLabel(), 'first-live')
    await emit({ rows: { session: initialRows } })
    assert.equal(selectedLabel(), 'first-live', 'removed selection is forgotten')
    await emit({ rows: { ...fixture.snapshot.rows, other: [job('other-session', 'running', now)] } })
    await render({ scope: { sessionId: 'other' } })
    assert.deepEqual(rowLabels(), ['other-session'])
    assert.deepEqual(calls.at(-1), ['observe', 'other', 'other-session'])
    assert.ok(calls.some(call => call.join() === 'releaseRows,session'))
    await emit({ rows: { other: [] } })
    assert.match(document.querySelector('.dcm-codex-tab').textContent, /本会话暂无 Codex 任务/)
    assert.equal(document.querySelector('.dcm-codex-pane'), null)
    assert.deepEqual(calls.at(-1), ['releaseObserve', 'other', 'other-session'])
  })
})

test('stop arms for three seconds, requires a second press and reports kill failures inline', async () => {
  await withTab(async fixture => {
    const { render, click, calls, advance } = fixture
    await render()
    await click('.dcm-codex-row[title="new-live"]')
    await click('.dcm-codex-stop')
    assert.equal(document.querySelector('.dcm-codex-stop').textContent, '再次点击确认停止')
    assert.equal(calls.some(call => call[0] === 'kill'), false)
    await advance(3000)
    assert.equal(document.querySelector('.dcm-codex-stop').textContent, '停止任务')
    await click('.dcm-codex-stop')
    await click('.dcm-codex-stop')
    assert.deepEqual(calls.filter(call => call[0] === 'kill'), [['kill', 'session', 'new-live']])
    fixture.setKillError(new Error('connection lost'))
    await click('.dcm-codex-stop')
    await click('.dcm-codex-stop')
    assert.match(document.querySelector('[role="alert"]').textContent, /停止失败：connection lost/)
    await click('.dcm-codex-stop')
    await render({ visible: false })
    assert.equal(fixture.timers.size, 0, 'hiding cancels the armed stop timer')
    await render({ visible: true })
    assert.equal(document.querySelector('.dcm-codex-stop').textContent, '停止任务')
    await click('.dcm-codex-stop')
    await click('.dcm-codex-row[title="recent-failed"]')
    assert.equal(document.querySelector('.dcm-codex-stop'), null)
    assert.equal(fixture.timers.size, 0)
    assert.match(document.querySelector('.dcm-codex-row[title="recent-failed"] .dcm-codex-meta').textContent, /失败 · 9秒 · CLI failed/)
  })
})

test('output follows streaming text, can pause following, copies text and displays gap/error/empty states', async () => {
  await withTab(async fixture => {
    const { render, emit, click, copied } = fixture
    await render()
    const pane = document.querySelector('.dcm-codex-output')
    Object.defineProperty(pane, 'scrollHeight', { value: 700, configurable: true })
    const push = async (text, extra = {}) => emit({ observed: { 'first-live': { text, streaming: true, gapBefore: true, ...extra } } })
    await push('Latest chunk', { error: 'stream interrupted' })
    assert.equal(pane.scrollTop, 700)
    assert.match(pane.textContent, /较早的输出已丢弃/)
    assert.match(pane.querySelector('[role="alert"]').textContent, /输出读取失败：stream interrupted/)
    await click('.dcm-codex-follow input')
    pane.scrollTop = 20
    await push('Another chunk')
    assert.equal(pane.scrollTop, 20)
    await click('.dcm-codex-follow input')
    assert.equal(pane.scrollTop, 700)
    await click('.dcm-codex-copy')
    assert.deepEqual(copied, ['Another chunk'])
    assert.equal(document.querySelector('.dcm-codex-copy').textContent, '已复制')
    fixture.setCopyError(new Error('clipboard denied'))
    await push('Changed text')
    assert.equal(document.querySelector('.dcm-codex-copy').textContent, '复制')
    await click('.dcm-codex-copy')
    assert.match(document.querySelector('[role="alert"]').textContent, /复制失败：clipboard denied/)
    await push('', { streaming: false })
    assert.match(pane.textContent, /该任务暂无输出/)
    assert.equal(document.querySelector('.dcm-codex-copy').disabled, true)
    await push('Settled output', { streaming: false })
    pane.scrollTop = 10
    await push('More settled output', { streaming: false })
    assert.equal(pane.scrollTop, 10, 'settled output does not trigger following')
  })
})

test('defaults to the most recently settled job, formats duration in at most two units and localizes English', async () => {
  await withTab(async ({ render, emit, tabs }) => {
    await emit({ rows: { session: [
      job('unknown-finish', 'completed', now - 500000),
      job('long-completed', 'completed', now - 3661000, { finishedAt: now, detail: 'Done' }),
      job('short-killed', 'killed', now - 70000, { finishedAt: now - 5000 }),
    ] } })
    await render()
    assert.equal(tabs[0].description(), "This session's Codex runs and live output")
    assert.equal(selectedLabel(), 'long-completed')
    assert.equal(document.querySelector('.dcm-codex-meta').textContent, 'Completed · 1h 1m · Done')
    assert.equal(document.querySelectorAll('.dcm-codex-meta')[1].textContent, 'Stopped · 1m 5s')
    assert.equal(document.querySelector('.dcm-codex-header').textContent, '3 jobs · 0 running')
    assert.equal(document.querySelector('.dcm-codex-stop'), null)
    assert.match(document.querySelector('.dcm-codex-output').textContent, /No output for this job yet/)
  }, { locale: 'en' })
})

test('missing jobs service renders a short notice without subscribing', async () => {
  await withTab(async ({ render, calls }) => {
    await render()
    assert.equal(document.querySelector('[role="status"]').textContent, '任务服务不可用。')
    assert.equal(document.querySelectorAll('.dcm-codex-tab > style').length, 1)
    assert.equal(calls.length, 0)
  }, { hasJobs: false })
})
