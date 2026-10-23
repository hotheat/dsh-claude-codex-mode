/** Table-driven policy checks against temporary Git and non-Git directories. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyEdit } from '../lib/policy.js'

const temporary = mkdtempSync(join(tmpdir(), 'dsh-routing-policy-'))
const repo = join(temporary, 'repo')
const outside = join(temporary, 'outside')
const home = join(repo, 'home')
const direct = join(temporary, 'direct')
const previousBypass = process.env.DSH_DIRECT_EDIT

try {
  for (const directory of [join(repo, '.git'), outside, join(home, '.claude'), join(direct, '.git'), join(direct, '.claude')]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(join(direct, '.claude', 'direct-edit'), '')
  process.env.DSH_DIRECT_EDIT = '1'

  const cases = [
    ['repo code absolute', join(repo, 'src/a.py'), undefined, 'deny'],
    ['uppercase document suffix', join(repo, 'README.MD'), undefined, 'allow'],
    ['plain text document', join(repo, 'notes.txt'), undefined, 'allow'],
    ['requirements config', join(repo, 'requirements.txt'), undefined, 'deny'],
    ['requirements variant', join(repo, 'requirements-dev.txt'), undefined, 'deny'],
    ['constraints config', join(repo, 'constraints.txt'), undefined, 'deny'],
    ['constraints variant', join(repo, 'constraints-ci.txt'), undefined, 'deny'],
    ['CMake config', join(repo, 'CMakeLists.txt'), undefined, 'deny'],
    ['uppercase requirements', join(repo, 'REQUIREMENTS.TXT'), undefined, 'deny'],
    ['non-Git file', join(outside, 'a.py'), undefined, 'allow'],
    ['explicit Claude home', join(home, '.claude/settings.json'), undefined, 'allow'],
    ['repository bypass marker', join(direct, 'a.py'), undefined, 'allow'],
    ['relative path in Git', 'src/a.py', repo, 'deny'],
    ['relative path outside Git', 'src/a.py', outside, 'allow'],
    ['relative path without base', 'src/a.py', undefined, 'deny'],
  ]
  for (const [label, raw, base, verdict] of cases) {
    const input = { raw, base, home, env: {} }
    assert.equal(classifyEdit(input).verdict, verdict, label)
    assert.equal(classifyEdit({ ...input, env: { DSH_DIRECT_EDIT: '1' } }).verdict, 'allow', `${label}: env bypass`)
  }

  assert.equal(classifyEdit({ raw: '~/.claude/settings.json', home, env: {} }).verdict, 'allow')
  const bareHome = classifyEdit({ raw: '~', home, env: {} })
  assert.equal(bareHome.verdict, 'deny')
  assert.equal(bareHome.target, home, 'bare tilde expands without a session base')
} finally {
  if (previousBypass === undefined) delete process.env.DSH_DIRECT_EDIT
  else process.env.DSH_DIRECT_EDIT = previousBypass
  rmSync(temporary, { recursive: true, force: true })
}

console.log('dsh-claude-codex-mode policy test: ok')
