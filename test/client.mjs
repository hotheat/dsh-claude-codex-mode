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
  let statusResponse = async () => ({ mode: savedMode, current: { mode: savedMode, ok: true, checks: [] }, alternative: null })
  let statusFetch = async () => ({ ok: true, json: statusResponse })
  const context = {
    window: { __ModuleLoader__: { load(entry) { factory = entry.factory } } },
    fetch: async (url, options) => {
      calls.push(['fetch', url, options?.method])
      if (url.endsWith('/status')) return statusFetch()
      const state = url.endsWith('/state')
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
      describe: async () => ({ ok: true, value: { writable: true, namespaces: [
        { ns: 'claude-codex-mode', revision, value: { mode: savedMode } },
      ] } }),
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
  const render = async () => { await act(async () => root.render(React.createElement(Form, { t: key => dictionaries.zh[key] }))) }
  const select = async value => {
    await act(async () => { const element = document.querySelector('select'); element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true })) })
  }
  const submit = async () => {
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
  }
  try {
    await run({ calls, render, select, submit, root,
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
    assert.equal(document.querySelector('select').value, 'api')
    assert.equal(document.querySelector('button').disabled, true)
    await select('claude-code-cli')
    await submit()
    assert.equal(calls.some(call => call[0] === 'update'), false, 'failed preflight must never call settings.update')
    assert.match(document.body.textContent, /当前模式: api/)
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
    assert.match(document.body.textContent, /当前模式: claude-code-cli/)
    const lastUpdate = calls.findLastIndex(call => call[0] === 'update')
    assert.ok(calls[lastUpdate - 1][1].includes('/preflight'))
    assert.ok(calls[lastUpdate + 1][1].endsWith('/state'))
    assert.equal(calls.filter(call => call[0] === 'fetch' && call[1].endsWith('/status')).length, 2, 'successful save refreshes status')
    await select('api')
    await act(async () => root.render(null))
    await render()
    assert.equal(document.querySelector('select').value, 'claude-code-cli', 'leaving the page discards unsaved edits')
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
    assert.equal(document.querySelector('select').disabled, false)
    await select('claude-code-cli')
    assert.equal(document.querySelector('button[type="submit"]').disabled, false)
    await act(async () => finish({ mode: 'api', current: { mode: 'api', ok: true, checks: [
      { id: 'model', label: '默认模型', ok: false, level: 'warning', hint: '选择 Claude' },
      { id: 'key', label: 'API key', ok: true, level: 'error', hint: '配置密钥' },
    ] }, alternative: null }))
    const section = document.querySelector('section')
    assert.match(section.textContent, /当前模式检查通过/)
    assert.match(section.textContent, /默认模型/)
    assert.match(section.textContent, /选择 Claude/)
    assert.doesNotMatch(section.textContent, /API key/)
    assert.equal(section.querySelector('button'), null)
    assert.equal(document.querySelector('select').value, 'claude-code-cli', 'status must not replace the staged selection')
    assert.equal(calls.some(call => call[0] === 'update'), false)
  })
})

for (const [currentMode, otherMode, name] of [['api', 'claude-code-cli', 'Claude Code CLI'], ['claude-code-cli', 'api', 'API']]) {
  for (const alternativeOk of [true, false]) {
    test(`${currentMode} failed, ${otherMode} ${alternativeOk ? 'passes and can be selected' : 'fails without a switch suggestion'}`, async () => {
      await withForm(async ({ setSavedMode, setStatusResponse, render, calls }) => {
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
        const button = section.querySelector('button')
        if (alternativeOk) {
          assert.ok(section.textContent.includes(`${name} 的检查已通过，可以切换到该模式`))
          assert.equal(button.textContent, `选择 ${name}`)
          assert.equal(button.type, 'button')
          await act(async () => button.click())
          assert.equal(document.querySelector('select').value, otherMode)
          assert.equal(calls.some(call => call[0] === 'update' || call[1]?.includes('/preflight')), false, 'suggestion only stages the mode')
        } else {
          assert.ok(section.textContent.includes('两种模式都未通过检查。按下列提示修复任一模式后即可使用。'))
          assert.match(section.textContent, /备选登录检查/)
          assert.match(section.textContent, /修复备选登录/)
          assert.equal(section.querySelectorAll('ul').length, 2)
          assert.equal(button, null)
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
    assert.match(document.querySelector('section').textContent, /当前模式检查通过/)
    await act(async () => finish({ mode: 'api', current: { mode: 'api', ok: false, checks: [
      { id: 'key', label: '过期检查结果', ok: false, level: 'error', hint: '过期提示' },
    ] }, alternative: null }))
    assert.doesNotMatch(document.body.textContent, /过期检查结果/)
    assert.match(document.querySelector('section').textContent, /当前模式检查通过/)
  })
})
