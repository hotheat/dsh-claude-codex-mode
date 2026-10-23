/** Mount the shipped browser module in React and exercise the save/refusal flow through the DOM. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

async function withForm(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const calls = []
  let factory
  let Form
  let dictionaries
  let savedMode = 'api'
  let revision = 7
  let pass = false
  let rejectRevision = false
  let writable = true
  let describeOk = true
  let describeResponse
  let clock = 0
  let timerId = 0
  const timers = new Map()
  const timerDelays = []
  let preflightResponse
  let stateResponse
  let locale = 'zh'
  let statusResponse = async () => ({ mode: savedMode, current: { mode: savedMode, ok: true, checks: [] }, alternative: null })
  let statusFetch = async () => ({ ok: true, json: statusResponse })
  const context = {
    setTimeout(callback, delay) {
      const id = ++timerId
      timers.set(id, { callback, at: clock + delay })
      timerDelays.push(delay)
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    window: { __ModuleLoader__: { load(entry) { factory = entry.factory } } },
    fetch: async (url, options) => {
      calls.push(['fetch', url, options?.method])
      if (url.endsWith('/status')) return statusFetch()
      const state = url.endsWith('/state')
      if (state && stateResponse) return stateResponse()
      if (!state && preflightResponse) return preflightResponse()
      return { ok: true, json: async () => state ? { mode: savedMode } : {
        ok: pass, checks: [{ id: 'auth', label: 'CLI 登录', ok: pass, level: 'error', hint: '运行 claude auth login' },
          { id: 'model', label: '默认模型', ok: false, level: 'warning', hint: '选择 Claude' }],
      } }
    },
  }
  vm.runInNewContext(source, context)
  const plugin = factory(name => { assert.equal(name, 'react'); return React })
  const effects = []
  plugin.apply({
    effect: fn => { effects.push(fn()) },
    locale: { register: (_ns, locales) => { dictionaries = locales; return () => {} } },
    slots: {
      inject(name, callback) { assert.equal(name, 'plugins.bundle.config'); callback() },
      register(options, component) { assert.equal(options.key, 'dsh-claude-codex-mode'); Form = component },
    },
    remote: { settings: {
      describe: async () => {
        calls.push(['describe'])
        if (describeResponse) return describeResponse()
        return { ok: describeOk, value: { writable, namespaces: [
        { ns: 'claude-codex-mode', revision, value: { mode: savedMode } },
      ] } }
      },
      update: async (ns, patch, expected) => {
        calls.push(['update', ns, patch.mode, expected])
        if (rejectRevision) { revision++; return { ok: false, error: { message: 'conflict' } } }
        assert.equal(expected, revision)
        savedMode = patch.mode; revision++
        return { ok: true, value: { ns, revision, value: { mode: savedMode } } }
      },
    } },
  })
  const root = createRoot(document.getElementById('root'))
  const render = async () => { await act(async () => root.render(React.createElement(Form, { t: key => dictionaries[locale][key] }))) }
  const radio = value => document.querySelectorAll('[role="radio"]')[value === 'api' ? 0 : 1]
  const select = async value => { await act(async () => radio(value).click()) }
  const key = async (value, key) => {
    await act(async () => radio(value).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
  }
  const submit = async () => {
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  }
  const advance = async ms => {
    await act(async () => {
      clock += ms
      for (const [id, timer] of timers) {
        if (timer.at > clock) continue
        timers.delete(id)
        timer.callback()
      }
    })
  }
  try {
    await run({ calls, render, select, key, radio, submit, root, advance, timers, timerDelays,
      setDescribeResponse(value) { describeResponse = value },
      setWritable(value) { writable = value },
      setDescribeOk(value) { describeOk = value },
      setPreflightResponse(value) { preflightResponse = value },
      setStateResponse(value) { stateResponse = value },
      setLocale(value) { locale = value },
      setPass(value) { pass = value },
      setRejectRevision(value) { rejectRevision = value },
      setStatusResponse(value) { statusResponse = value },
      setStatusFetch(value) { statusFetch = value },
      setSavedMode(value) { savedMode = value },
      get savedMode() { return savedMode },
      get dictionaries() { return dictionaries },
    })
  } finally {
    await act(async () => root.unmount())
    for (const off of effects) off?.()
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}

test('form refuses failed checks, displays each hint, preserves revision, saves warnings and resets on unmount', async () => {
  await withForm(async fixture => {
    const { calls, render, select, submit, root, dictionaries } = fixture
    await render()
    assert.equal(fixture.radio('api').getAttribute('aria-checked'), 'true')
    assert.equal(document.querySelector('button[type="submit"]').disabled, true)
    await select('claude-code-cli')
    await submit()
    assert.equal(calls.some(call => call[0] === 'update'), false, 'failed preflight must never call settings.update')
    assert.match(document.querySelector('.dcm-active').getAttribute('aria-label'), /当前模式: API/)
    assert.match(document.body.textContent, /运行 claude auth login/)
    assert.match(document.body.textContent, /选择 Claude/)
    assert.match(document.querySelector('[role="alert"]').textContent, /保持不变/)
    fixture.setPass(true)
    fixture.setRejectRevision(true)
    await submit()
    assert.equal(fixture.savedMode, 'api')
    assert.match(document.body.textContent, /保存失败/)
    fixture.setRejectRevision(false)
    await submit()
    assert.equal(fixture.savedMode, 'claude-code-cli')
    assert.equal(calls.filter(call => call[0] === 'update').at(-1)[3], 8, 'conflict refreshes the revision')
    assert.match(document.body.textContent, /已保存/)
    assert.match(document.querySelector('.dcm-active').getAttribute('aria-label'), /当前模式: Claude Code CLI/)
    const lastUpdate = calls.findLastIndex(call => call[0] === 'update')
    assert.deepEqual(calls.slice(lastUpdate - 1, lastUpdate + 4).map(call => call[0] === 'fetch' ? call[1].split('/').at(-1).split('?')[0] : call[0]),
      ['preflight', 'update', 'state', 'describe', 'status'])
    assert.equal(calls.filter(call => call[0] === 'fetch' && call[1].endsWith('/status')).length, 2, 'successful save refreshes status')
    await select('api')
    await act(async () => root.render(null))
    await render()
    assert.equal(fixture.radio('claude-code-cli').getAttribute('aria-checked'), 'true', 'leaving the page discards unsaved edits')
    for (const lang of ['en', 'zh']) {
      const locale = JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url)))
      assert.ok(locale.meta.title && locale.meta.description)
      assert.deepEqual(locale.form, JSON.parse(JSON.stringify(dictionaries[lang])), 'locale file includes the browser form copy')
    }
  })
})

test('current status loads without blocking selection or saving, then shows pass and warning hints', async () => {
  await withForm(async ({ setStatusResponse, render, select, calls }) => {
    let finish
    setStatusResponse(() => new Promise(resolve => { finish = resolve }))
    await render()
    assert.match(document.body.textContent, /正在检查当前模式…/)
    assert.equal(document.querySelector('.dcm-badge').textContent, '检查中')
    assert.ok(document.querySelector('.dcm-active .dcm-dot.dcm-muted.dcm-pulse'))
    assert.equal(document.querySelector('[role="radio"]').disabled, false)
    await select('claude-code-cli')
    assert.equal(document.querySelector('button[type="submit"]').disabled, false)
    await act(async () => finish({ mode: 'api', current: { mode: 'api', ok: true, checks: [
      { id: 'model', label: '默认模型', ok: false, level: 'warning', hint: '选择 Claude' },
      { id: 'key', label: 'API key', ok: true, level: 'error', hint: '配置密钥' },
    ] }, alternative: null }))
    const section = document.querySelector('section')
    assert.equal(document.querySelector('.dcm-badge').textContent, '有提示')
    assert.match(section.textContent, /默认模型/)
    assert.match(section.textContent, /选择 Claude/)
    assert.doesNotMatch(section.textContent, /API key/)
    assert.equal(section.querySelector('button'), null)
    assert.equal(document.querySelectorAll('[role="radio"]')[1].getAttribute('aria-checked'), 'true', 'status must not replace the staged selection')
    assert.equal(calls.some(call => call[0] === 'update'), false)
  })
})

for (const [currentMode, otherMode, name] of [['api', 'claude-code-cli', 'Claude Code CLI'], ['claude-code-cli', 'api', 'API']]) {
  for (const alternativeOk of [true, false]) {
    test(`${currentMode} failed, ${otherMode} ${alternativeOk ? 'passes and can be selected' : 'fails without a switch suggestion'}`, async () => {
      await withForm(async ({ setSavedMode, setStatusResponse, render, calls, select, radio }) => {
        setSavedMode(currentMode)
        setStatusResponse(async () => ({ mode: currentMode,
          current: { mode: currentMode, ok: false, checks: [
            { id: 'current-auth', label: '当前登录检查', ok: false, level: 'error', hint: '修复当前登录' },
          ] },
          alternative: { mode: otherMode, ok: alternativeOk, checks: [
            { id: 'other-auth', label: '备选登录检查', ok: alternativeOk, level: 'error', hint: '修复备选登录' },
          ] },
        }))
        await render()
        const section = document.querySelector('section')
        assert.match(section.textContent, /当前登录检查/)
        assert.match(section.textContent, /修复当前登录/)
        assert.equal(radio(currentMode).querySelector('.dcm-badge').textContent, '未通过')
        assert.equal(radio(otherMode).querySelector('.dcm-badge').textContent, alternativeOk ? '可切换' : '未通过')
        assert.equal(radio(currentMode).getAttribute('aria-checked'), 'true', 'status never switches modes')
        assert.equal(document.querySelector('.dcm-active .dcm-dot').classList.contains('dcm-error'), true)
        if (alternativeOk) {
          assert.equal(document.querySelector('.dcm-callout').textContent, `${name} 的检查已通过。选中它，再点「检查并保存」切换。`)
          await select(otherMode)
          assert.equal(radio(otherMode).getAttribute('aria-checked'), 'true')
          assert.equal(calls.some(call => call[0] === 'update' || call[1]?.includes('/preflight')), false, 'suggestion only stages the mode')
        } else {
          assert.ok(section.textContent.includes('两种模式都未通过检查。按下列提示修复任一模式后即可使用。'))
          assert.match(section.textContent, /备选登录检查/)
          assert.match(section.textContent, /修复备选登录/)
          assert.equal(section.querySelectorAll('.dcm-check-group').length, 2)
          assert.deepEqual(Array.from(section.querySelectorAll('h5'), el => el.textContent), [currentMode === 'api' ? 'API' : 'Claude Code CLI', name])
          assert.equal(document.querySelector('.dcm-callout'), null)
        }
      })
    })
  }
}

for (const failure of ['network', 'http']) {
  test(`${failure} status failures stay non-alert and do not block saving`, async () => {
    await withForm(async ({ setStatusFetch, setPass, render, select, submit, calls }) => {
      setStatusFetch(async () => {
        if (failure === 'http') return { ok: false }
        throw new Error('status unavailable')
      })
      await render()
      assert.match(document.querySelector('[role="status"]').textContent, /暂时无法读取检查结果/)
      assert.equal(document.querySelector('[role="alert"]'), null)
      assert.equal(document.querySelector('.dcm-badge').textContent, '无法读取')
      assert.ok(document.querySelector('.dcm-active .dcm-dot.dcm-muted'))
      assert.equal(document.querySelector('.dcm-active .dcm-pulse'), null)
      await select('claude-code-cli')
      assert.equal(document.querySelector('button[type="submit"]').disabled, false)
      setPass(true)
      await submit()
      assert.equal(calls.filter(call => call[0] === 'update').length, 1)
      assert.match(document.body.textContent, /已保存/)
      assert.match(document.body.textContent, /暂时无法读取检查结果/)
    })
  })
}

test('saving while initial status loads refreshes status and ignores the older result', async () => {
  await withForm(async ({ setStatusResponse, setPass, render, select, submit }) => {
    let finish
    setStatusResponse(() => new Promise(resolve => { finish = resolve }))
    await render()
    await select('claude-code-cli')
    setPass(true)
    setStatusResponse(async () => ({ mode: 'claude-code-cli', current: { mode: 'claude-code-cli', ok: true, checks: [] }, alternative: null }))
    await submit()
    assert.match(document.body.textContent, /已保存/)
    assert.match(document.querySelector('section').textContent, /全部 0 项检查通过/)
    await act(async () => finish({ mode: 'api', current: { mode: 'api', ok: false, checks: [
      { id: 'key', label: '过期检查结果', ok: false, level: 'error', hint: '过期提示' },
    ] }, alternative: null }))
    assert.doesNotMatch(document.body.textContent, /过期检查结果/)
    assert.match(document.querySelector('section').textContent, /全部 0 项检查通过/)
  })
})

test('radio cards support roving focus, arrows, Space and Enter without saving', async () => {
  await withForm(async ({ render, select, key, radio, calls }) => {
    await render()
    assert.equal(document.querySelector('select'), null)
    assert.equal(document.querySelectorAll('form style').length, 1)
    assert.equal(document.querySelector('[style]'), null, 'presentation uses scoped classes')
    assert.equal(document.querySelector('[role="radiogroup"]').getAttribute('aria-label'), '讨论方式')
    assert.equal(radio('api').tabIndex, 0)
    assert.equal(radio('claude-code-cli').tabIndex, -1)
    assert.equal(radio('api').querySelector('.dcm-badge').textContent, '通过')
    assert.equal(radio('claude-code-cli').querySelector('.dcm-badge').textContent, '未检查')
    assert.equal(document.querySelector('.dcm-save-helper').textContent, '已是当前模式')
    assert.equal(document.querySelector('.dcm-active .dcm-dot').classList.contains('dcm-success'), true)
    assert.match(document.querySelector('.dcm-active').getAttribute('aria-label'), /通过/)
    assert.deepEqual(calls.map(call => call[0] === 'fetch' ? call[1] : call[0]), ['describe', '/claude-codex-mode/status'])
    for (const arrow of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await key('api', arrow)
      assert.equal(radio('claude-code-cli').getAttribute('aria-checked'), 'true')
      assert.equal(radio('claude-code-cli').tabIndex, 0)
      assert.equal(radio('api').tabIndex, -1)
      assert.equal(document.activeElement, radio('claude-code-cli'))
      assert.equal(document.querySelector('.dcm-save-helper'), null)
      await key('claude-code-cli', arrow)
      assert.equal(radio('api').getAttribute('aria-checked'), 'true')
    }
    for (const activation of [' ', 'Enter']) {
      await key('claude-code-cli', activation)
      assert.equal(radio('claude-code-cli').getAttribute('aria-checked'), 'true')
      await select('api')
    }
    await select('claude-code-cli')
    assert.equal(document.querySelector('button[type="submit"]').disabled, false)
    assert.equal(radio('api').querySelector('.dcm-current-tag').textContent, '当前')
    assert.equal(calls.length, 2, 'selection never requests preflight, updates settings or refreshes status')
  })
})

test('clean status summarizes the real check count; warnings have accessible levels and hints', async () => {
  for (const warning of [false, true]) {
    await withForm(async ({ setStatusResponse, render, radio }) => {
      setStatusResponse(async () => ({ mode: 'api', current: { mode: 'api', ok: true, checks: [
        { id: 'key', label: 'API key', ok: true, level: 'error', hint: '配置密钥' },
        { id: 'model', label: '默认模型', ok: !warning, level: 'warning', hint: '选择 Claude' },
      ] }, alternative: null }))
      await render()
      const panel = document.querySelector('.dcm-current-status')
      assert.equal(radio('api').querySelector('.dcm-badge').textContent, warning ? '有提示' : '通过')
      assert.equal(document.querySelector('.dcm-active .dcm-dot').classList.contains(warning ? 'dcm-warning' : 'dcm-success'), true)
      if (warning) {
        assert.equal(panel.querySelectorAll('.dcm-check-row').length, 1)
        assert.equal(panel.querySelector('.dcm-sr-only').textContent, '提示')
        assert.equal(panel.querySelector('.dcm-glyph [aria-hidden]').textContent, '!')
        assert.match(panel.textContent, /默认模型选择 Claude/)
      } else {
        assert.match(panel.textContent, /全部 2 项检查通过/)
        assert.equal(panel.querySelector('.dcm-check-row'), null)
      }
      assert.equal(document.querySelector('.dcm-callout'), null)
    })
  }
})

for (const missing of ['read-only', 'descriptor']) {
  test(`${missing} disables cards and save without allowing keyboard selection`, async () => {
    await withForm(async ({ setWritable, setDescribeOk, render, select, key, radio, calls, advance }) => {
      if (missing === 'read-only') setWritable(false)
      else setDescribeOk(false)
      await render()
      assert.equal(document.querySelector('[role="radiogroup"]').getAttribute('aria-disabled'), 'true')
      assert.equal(radio('api').disabled, true)
      assert.equal(radio('claude-code-cli').disabled, true)
      assert.equal(document.querySelector('button[type="submit"]').disabled, true)
      await select('claude-code-cli')
      await key('api', 'ArrowRight')
      await key('claude-code-cli', 'Enter')
      assert.equal(radio('api').getAttribute('aria-checked'), 'true')
      assert.equal(calls.some(call => call[0] === 'update' || call[1]?.includes('/preflight')), false)
      if (missing === 'descriptor') {
        for (const delay of [300, 600, 1200, 2400]) await advance(delay)
        assert.match(document.querySelector('.dcm-message').textContent, /配置暂不可用/)
      }
    })
  })
}

test('busy save locks radio cards, shows a spinner and renders preflight results in their own panel', async () => {
  await withForm(async ({ setPreflightResponse, render, select, key, radio, submit, calls }) => {
    let finish
    setPreflightResponse(() => new Promise(resolve => { finish = resolve }))
    await render()
    await select('claude-code-cli')
    await submit()
    assert.equal(document.querySelector('form').getAttribute('aria-busy'), 'true')
    assert.equal(document.querySelector('button[type="submit"]').textContent, '检查并保存中…')
    assert.ok(document.querySelector('.dcm-spinner[aria-hidden="true"]'))
    assert.equal(radio('api').disabled, true)
    assert.equal(radio('claude-code-cli').disabled, true)
    await select('api')
    await key('claude-code-cli', 'ArrowLeft')
    assert.equal(radio('claude-code-cli').getAttribute('aria-checked'), 'true')
    await act(async () => finish({ ok: true, json: async () => ({ ok: false, checks: [
      { id: 'pass', label: 'Codex', ok: true, level: 'error' },
      { id: 'warn', label: '模型', ok: false, level: 'warning', hint: '选择 Claude' },
      { id: 'fail', label: '登录', ok: false, level: 'error', hint: '运行 claude auth login' },
    ] }) }))
    assert.equal(document.querySelector('form').getAttribute('aria-busy'), 'false')
    const panel = document.querySelector('.dcm-preflight')
    assert.equal(panel.getAttribute('aria-label'), '本次检查')
    assert.equal(panel.nextElementSibling.className, 'dcm-actions')
    assert.deepEqual(Array.from(panel.querySelectorAll('.dcm-sr-only'), el => el.textContent), ['阻断', '提示', '通过'])
    assert.deepEqual(Array.from(panel.querySelectorAll('.dcm-glyph [aria-hidden]'), el => el.textContent), ['✕', '!', '✓'])
    assert.equal(calls.some(call => call[0] === 'update'), false)
    await select('api')
    assert.equal(document.querySelector('.dcm-preflight'), null, 'selection clears previous preflight results')
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.equal(document.querySelector('.dcm-save-helper').textContent, '已是当前模式')
  })
})

test('state verification failure stays a save failure and does not refetch status', async () => {
  await withForm(async ({ setPass, setStateResponse, render, select, submit, calls }) => {
    await render()
    setPass(true)
    setStateResponse(async () => ({ ok: true, json: async () => ({ mode: 'api' }) }))
    await select('claude-code-cli')
    await submit()
    assert.match(document.querySelector('[role="alert"]').textContent, /保存失败/)
    assert.equal(calls.filter(call => call[1]?.endsWith('/status')).length, 1)
  })
})

test('English labels use mode names, route captions and the same check summary', async () => {
  await withForm(async ({ setLocale, render, radio }) => {
    setLocale('en')
    await render()
    assert.equal(radio('api').getAttribute('aria-label'), 'API')
    assert.equal(radio('claude-code-cli').getAttribute('aria-label'), 'Claude Code CLI')
    assert.match(radio('claude-code-cli').textContent, /Claude Code \(read-only\)/)
    assert.match(document.querySelector('.dcm-current-status').textContent, /All 0 checks passed/)
    assert.equal(document.querySelector('.dcm-save-helper').textContent, 'Already the current mode')
  })
})

test('preflight orders blockers before warnings and collapses passed checks into one muted row', async () => {
  for (const locale of ['zh', 'en']) {
    for (const passedCount of [0, 5]) {
      await withForm(async ({ setLocale, setPreflightResponse, render, select, submit }) => {
        setLocale(locale)
        setPreflightResponse(async () => ({ ok: true, json: async () => ({ ok: false, checks: [
          ...Array.from({ length: passedCount }, (_, i) => ({ id: `pass-${i}`, label: `通过项 ${i}`, ok: true, level: 'error' })),
          { id: 'warn', label: '默认模型', ok: false, level: 'warning', hint: '选择 Claude' },
          { id: 'block', label: 'CLI 登录', ok: false, level: 'error', hint: '运行 claude auth login' },
        ] }) }))
        await render()
        await select('claude-code-cli')
        await submit()
        const panel = document.querySelector('.dcm-preflight')
        assert.deepEqual(Array.from(panel.querySelectorAll('.dcm-check-label'), el => el.textContent), [
          'CLI 登录', '默认模型', ...(passedCount ? [locale === 'zh' ? '另有 5 项检查通过' : '5 more checks passed'] : []),
        ])
        assert.doesNotMatch(panel.textContent, /通过项/)
        if (passedCount) {
          const row = panel.querySelector('.dcm-check-row:last-child')
          assert.equal(row.querySelector('.dcm-check-label').classList.contains('dcm-muted'), true)
          assert.equal(row.querySelector('.dcm-glyph').classList.contains('dcm-muted'), true)
        }
      })
    }
  }
})

test('preflight badge persists across selection, resets for a new check and clears on status refetch', async () => {
  await withForm(async ({ render, select, submit, radio, setPass, setRejectRevision, setPreflightResponse }) => {
    await render()
    await select('claude-code-cli')
    await submit()
    assert.equal(radio('claude-code-cli').querySelector('.dcm-badge').textContent, '未通过')
    assert.equal(radio('api').querySelector('.dcm-badge').textContent, '通过', 'active badge uses status.current')
    await select('api')
    await select('claude-code-cli')
    assert.equal(radio('claude-code-cli').querySelector('.dcm-badge').textContent, '未通过')
    let finish
    setPreflightResponse(() => new Promise(resolve => { finish = resolve }))
    setRejectRevision(true)
    await submit()
    assert.equal(radio('claude-code-cli').querySelector('.dcm-badge').textContent, '未检查', 'new preflight clears the old result for that mode')
    await act(async () => finish({ ok: true, json: async () => ({ ok: true, checks: [] }) }))
    assert.equal(radio('claude-code-cli').querySelector('.dcm-badge').textContent, '可切换')
    assert.match(document.querySelector('[role="alert"]').textContent, /保存失败/)
    assert.equal(document.querySelector('.dcm-callout'), null, 'preflight does not create an alternative-status suggestion')
    setPreflightResponse(null)
    setPass(true)
    setRejectRevision(false)
    await submit()
    assert.equal(radio('claude-code-cli').querySelector('.dcm-badge').textContent, '通过')
    await select('api')
    setPass(false)
    await submit()
    assert.equal(radio('api').querySelector('.dcm-badge').textContent, '未通过')
    await select('claude-code-cli')
    await select('api')
    setPass(true)
    await submit()
    assert.equal(radio('claude-code-cli').querySelector('.dcm-badge').textContent, '未检查', 'status refetch cleared the previous CLI preflight result')
  })
})

for (const failure of ['missing', 'rejected', 'throw']) {
  test(`describe retries ${failure} and loads the namespace on a later attempt`, async () => {
    await withForm(async ({ setDescribeResponse, render, advance, calls, timerDelays, timers, radio }) => {
      let attempts = 0
      setDescribeResponse(async () => {
        attempts++
        if (attempts === 3) return { ok: true, value: { writable: true, namespaces: [
          { ns: 'claude-codex-mode', revision: 7, value: { mode: 'claude-code-cli' } },
        ] } }
        if (failure === 'throw') throw new Error('host not ready')
        return { ok: failure !== 'rejected', value: { writable: true, namespaces: [] } }
      })
      await render()
      assert.equal(document.querySelector('.dcm-message').textContent, '正在读取配置…')
      assert.equal(document.querySelector('.dcm-retry'), null)
      assert.equal(calls.some(call => call[0] === 'fetch'), false)
      await advance(299)
      assert.equal(attempts, 1)
      await advance(1)
      assert.equal(attempts, 2)
      assert.equal(document.querySelector('.dcm-message').textContent, '正在读取配置…')
      await advance(599)
      assert.equal(attempts, 2)
      await advance(1)
      assert.equal(attempts, 3)
      assert.equal(timers.size, 0)
      assert.deepEqual(timerDelays, [300, 600])
      assert.equal(radio('claude-code-cli').getAttribute('aria-checked'), 'true')
      assert.equal(radio('claude-code-cli').disabled, false)
      assert.equal(calls.filter(call => call[1]?.endsWith('/status')).length, 1)
      assert.equal(document.querySelector('.dcm-message').textContent, '')
    })
  })
}

test('exhausted describe retries expose a localized retry button that restarts the full sequence', async () => {
  for (const locale of ['zh', 'en']) {
    await withForm(async ({ setLocale, setDescribeResponse, render, advance, calls, timerDelays, timers }) => {
      setLocale(locale)
      let ready = false
      setDescribeResponse(async () => ({ ok: true, value: { writable: true, namespaces: ready ? [
        { ns: 'claude-codex-mode', revision: 7, value: { mode: 'api' } },
      ] : [] } }))
      await render()
      for (const delay of [300, 600, 1200, 2400]) {
        assert.equal(document.querySelector('.dcm-retry'), null)
        await advance(delay)
      }
      assert.equal(calls.filter(call => call[0] === 'describe').length, 5)
      assert.equal(calls.some(call => call[0] === 'fetch'), false)
      assert.deepEqual(timerDelays, [300, 600, 1200, 2400])
      assert.equal(timers.size, 0)
      const retry = document.querySelector('.dcm-retry')
      assert.ok(retry)
      assert.equal(retry.type, 'button')
      assert.equal(retry.textContent, locale === 'zh' ? '重试' : 'Retry')
      assert.match(document.querySelector('.dcm-message').textContent, locale === 'zh' ? /配置暂不可用/ : /Configuration is unavailable/)
      await act(async () => retry.click())
      assert.equal(document.querySelector('.dcm-retry'), null)
      assert.match(document.querySelector('.dcm-message').textContent, locale === 'zh' ? /正在读取配置/ : /Reading configuration/)
      assert.equal(calls.filter(call => call[0] === 'describe').length, 6)
      ready = true
      await advance(300)
      assert.equal(calls.filter(call => call[0] === 'describe').length, 7)
      assert.equal(calls.filter(call => call[1]?.endsWith('/status')).length, 1)
      assert.equal(document.querySelector('.dcm-retry'), null)
      assert.equal(document.querySelector('.dcm-message').textContent, '')
    })
  }
})

test('unmount cancels pending describe retries and ignores an in-flight describe response', async () => {
  await withForm(async ({ setDescribeResponse, render, advance, timers, root, calls }) => {
    setDescribeResponse(async () => ({ ok: true, value: { writable: true, namespaces: [] } }))
    await render()
    assert.equal(timers.size, 1)
    await act(async () => root.render(null))
    assert.equal(timers.size, 0)
    await advance(4500)
    assert.equal(calls.length, 1)
    let finish
    setDescribeResponse(() => new Promise(resolve => { finish = resolve }))
    await render()
    await act(async () => root.render(null))
    await act(async () => finish({ ok: true, value: { writable: true, namespaces: [
      { ns: 'claude-codex-mode', revision: 7, value: { mode: 'api' } },
    ] } }))
    assert.equal(timers.size, 0)
    assert.equal(calls.some(call => call[0] === 'fetch'), false)
  })
})
