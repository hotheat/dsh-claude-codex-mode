import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { profileFacts } from '../scripts/doctor.mjs'

test('doctor reads profile, stored refs, process, project and home env without writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
  try {
    const dir = join(home, 'profiles', 'custom')
    const cwd = join(home, 'project')
    mkdirSync(dir, { recursive: true }); mkdirSync(cwd)
    writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([
      { id: 'llm-pi-ai', config: { providers: { anthropic: { apiKeyEnv: 'STORED', models: [{ id: 'claude-test' }] } } } },
      { id: 'agent-default-model', config: { provider: 'anthropic', model: 'claude-test' } },
    ]))
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  STORED: stored-secret\n', { mode: 0o600 })
    writeFileSync(join(home, '.env'), 'USER_KEY=user-secret\nEMPTY=\n')
    writeFileSync(join(cwd, '.env'), 'PROJECT_KEY=project-secret\n')
    const facts = profileFacts({ profile: 'custom', home, cwd, env: { PROCESS_KEY: 'process-secret' } })
    assert.equal(facts.providers.anthropic.apiKeyEnv, 'STORED')
    assert.equal(facts.defaultModel.model, 'claude-test')
    for (const ref of ['STORED', 'USER_KEY', 'PROJECT_KEY', 'PROCESS_KEY']) assert.equal(facts.credentialPresent(ref), true)
    assert.equal(facts.credentialPresent('EMPTY'), false)
    assert.equal(facts.credentialPresent('MISSING'), false)
    assert.doesNotMatch(JSON.stringify(facts), /secret/)
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  STORED: 123\n', { mode: 0o600 })
    assert.throws(() => profileFacts({ profile: 'custom', home, cwd }), /refs/)
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs: [broken secret', { mode: 0o600 })
    assert.throws(() => profileFacts({ profile: 'custom', home, cwd }), error => !error.message.includes('secret'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})
