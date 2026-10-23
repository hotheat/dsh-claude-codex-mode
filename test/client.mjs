/** Mount the shipped browser module in React and exercise the save/refusal flow through the DOM. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('form refuses failed checks, displays each hint, preserves revision, saves warnings and resets on unmount', async () => {
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
  const context = {
    window: { __ModuleLoader__: { load(entry) { factory = entry.factory } } },
    fetch: async (url, options) => {
      calls.push(['fetch', url, options?.method])
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
    pass = true
    rejectRevision = true
    await submit()
    assert.equal(savedMode, 'api')
    assert.match(document.body.textContent, /保存失败/)
    rejectRevision = false
    await submit()
    assert.equal(savedMode, 'claude-code-cli')
    assert.equal(calls.filter(call => call[0] === 'update').at(-1)[3], 8, 'conflict refreshes the revision')
    assert.match(document.body.textContent, /已保存/)
    assert.match(document.body.textContent, /当前模式: claude-code-cli/)
    const lastUpdate = calls.findLastIndex(call => call[0] === 'update')
    assert.ok(calls[lastUpdate - 1][1].includes('/preflight'))
    assert.ok(calls[lastUpdate + 1][1].endsWith('/state'))
    await select('api')
    await act(async () => root.render(null))
    await render()
    assert.equal(document.querySelector('select').value, 'claude-code-cli', 'leaving the page discards unsaved edits')
    for (const lang of ['en', 'zh']) {
      const locale = JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url)))
      assert.ok(locale.meta.title && locale.meta.description)
      assert.deepEqual(locale.form, JSON.parse(JSON.stringify(dictionaries[lang])), 'locale file includes the browser form copy')
    }
  } finally {
    await act(async () => root.unmount())
    for (const off of effects) off?.()
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
