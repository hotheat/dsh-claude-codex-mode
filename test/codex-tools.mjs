import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { registerCodexTools } from '../lib/codex-tools.js'
import { inspectCodexSetup, inspectCodexSetupAsync, runCodex } from '../mcp/codex-cli/lib/codex-runner.mjs'
import { isProcessGroupAlive } from '../mcp/codex-cli/lib/process-tree.mjs'
import { createFakeCodex, tempRoot } from '../mcp/codex-cli/tests/helpers.mjs'
import { dshRuntime } from './dsh-runtime.mjs'

const runtime = dshRuntime()
const load = spec => import(pathToFileURL(runtime.require.resolve(spec)).href)

function fixture(t, jobs, body = '') {
  const cwd = tempRoot('codex-host-')
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const executable = createFakeCodex(cwd, { body })
  const processEnv = { ...process.env, CODEX_CLI_PATH: executable, CODEX_HOME: cwd }
  const map = new Map()
  const warnings = []
  const ctx = {
    get: name => name === 'jobs' ? jobs : undefined,
    logger: { warn: message => warnings.push(message) },
    tools: { register(definition) {
      map.set(definition.name, definition)
      return () => map.delete(definition.name)
    } },
  }
  const dispose = registerCodexTools(ctx, { processEnv })
  t.after(dispose)
  const call = (args = {}, exec = {}, name = 'codex_cli_run') => map.get(name).execute({ cwd, prompt: 'test', ...args }, {
    callId: 'call-1', signal: new AbortController().signal, ...exec,
  })
  return { cwd, executable, processEnv, map, warnings, dispose, call }
}

async function registry(t, config = {}, controller = true) {
  const { Context } = await import(pathToFileURL(runtime.cordis).href)
  const { default: LocalJobs } = await load('@deepseek-ai/dsh-jobs-local')
  const root = new Context()
  await root.plugin(LocalJobs, config)
  if (controller) root.jobs.attachController('test-codex')
  t.after(() => root.fiber.dispose())
  return root.jobs
}

async function until(check) {
  for (let i = 0; i < 250; i++) {
    if (check()) return
    await delay(20)
  }
  assert.fail('fixture did not become ready')
}

const liveBody = `
emit({ type: 'thread.started', thread_id: 'live-thread' });
emit({ type: 'item.started', item: { type: 'command_execution', command: 'sleep' } });
await new Promise(resolve => setTimeout(resolve, 1500));
`

test('foreground without jobs keeps the canonical result; background fails clearly; disposal unregisters', async t => {
  const f = fixture(t)
  assert.deepEqual([...f.map.keys()], ['codex_cli_setup', 'codex_cli_run', 'codex_cli_review'])
  const result = await f.call({ sandbox: 'workspace-write', resumeSessionId: 'previous' })
  assert.equal(result.status, 'completed')
  assert.equal(result.sessionId, 'thread-123')
  assert.equal(result.kind, 'resume')
  assert.equal(result.usage.input_tokens, 10)
  assert.equal(JSON.parse(result.result).argv.includes('previous'), true)
  await assert.rejects(f.call({ background: true }), /background jobs unavailable: mount @deepseek-ai\/dsh-jobs-local/)
  await assert.rejects(f.call({ timeoutMs: 240001 }), /background jobs unavailable/)
  assert.throws(() => f.call({ sandbox: 'invalid', background: true }), /Unsupported sandbox/)
  const setup = await f.map.get('codex_cli_setup').execute({ cwd: f.cwd })
  assert.deepEqual(setup, inspectCodexSetup({ cwd: f.cwd, processEnv: f.processEnv }))
  assert.doesNotMatch(JSON.stringify(setup), /SECRET/)
  const review = await f.map.get('codex_cli_review').execute({ cwd: f.cwd, target: 'base', baseBranch: 'main' }, { callId: 'review' })
  assert.equal(review.kind, 'review')
  assert.equal(JSON.parse(review.result).argv.includes('--base'), true)
  assert.deepEqual(f.map.get('codex_cli_run').output.render({}, result), [{ type: 'text', text: JSON.stringify(result, null, 2) }])
  f.dispose()
  assert.equal(f.map.size, 0)
})

test('async setup matches failure shape and leaves the event loop responsive', async t => {
  const f = fixture(t)
  const missing = { ...f.processEnv, CODEX_CLI_PATH: join(f.cwd, 'missing') }
  const actual = await inspectCodexSetupAsync({ cwd: f.cwd, processEnv: missing })
  const expected = inspectCodexSetup({ cwd: f.cwd, processEnv: missing })
  assert.match(actual.error, /ENOENT/)
  assert.deepEqual({ ...actual, error: null }, { ...expected, error: null })
  writeFileSync(f.executable, `#!${process.execPath}\nawait new Promise(r => setTimeout(r, 100));\nconsole.log(process.argv[2] === 'login' ? 'Logged in using ChatGPT' : 'codex-test');\n`)
  let ticks = 0
  const interval = setInterval(() => ticks++, 10)
  t.after(() => clearInterval(interval))
  const setup = await inspectCodexSetupAsync({ cwd: f.cwd, processEnv: f.processEnv })
  assert.equal(setup.ready, true)
  assert.ok(ticks > 5, 'probes must not block host timers')
})

test('runner forwards all events including a final unterminated JSONL event and contains callback failures', async t => {
  const f = fixture(t)
  writeFileSync(f.executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'turn.started'})+'\\n'+JSON.stringify({type:'turn.completed'}));\n`)
  const events = []
  const activities = []
  const result = await runCodex({ cwd: f.cwd, prompt: 'test' }, {
    processEnv: f.processEnv,
    onEvent(event) { events.push(event.type); throw new Error('renderer failed') },
    onActivity({ summary }) { activities.push(summary); throw new Error('activity failed') },
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(events, ['turn.started', 'turn.completed'])
  assert.deepEqual(activities, ['turn.started', 'turn.completed'])
})

test('foreground is visible from start and returns the full canonical outcome then removes its row', { skip: !runtime }, async t => {
  const jobs = await registry(t)
  const f = fixture(t, jobs, liveBody)
  const pending = f.call()
  const view = jobs.list()[0]
  assert.equal(view.kind, 'codex')
  assert.equal(view.label, 'test')
  await until(() => jobs.get(view.id).progress === 'exec: sleep')
  const output = jobs.readAt(view.id, 0)
  assert.match(JSON.stringify(output), /\[codex\] thread live-thread/)
  const result = await pending
  assert.equal(result.status, 'completed')
  assert.equal(result.commandCount, 1)
  assert.equal(result.sessionId, 'thread-123')
  assert.equal(jobs.list().length, 0)
})

test('foreground wait expiry hands out a live job without killing the process; settlement retains the row', { skip: !runtime }, async t => {
  const jobs = await registry(t)
  const f = fixture(t, jobs, liveBody)
  const handle = await f.call({ timeoutMs: 1000 })
  assert.equal(handle.status, 'running')
  assert.match(handle.jobId, /^codex-/)
  assert.equal(handle.timeoutMs, 1000)
  assert.match(handle.note, /job_output.*job_kill/)
  const settled = await jobs.wait(handle.jobId, 5000)
  assert.equal(settled.status, 'completed')
  assert.match(settled.detail, /exit code: 0; session thread-123/)
  assert.equal(jobs.list().length, 1)
  assert.ok(jobs.read(handle.jobId).result)
})

test('background and long timeouts return immediately with live output and a final result', { skip: !runtime }, async t => {
  const jobs = await registry(t)
  const f = fixture(t, jobs, liveBody)
  for (const options of [{ background: true }, { timeoutMs: 240001 }]) {
    const label = `first   line ${'x'.repeat(200)}`
    const handle = await f.call({ ...options, prompt: `\n${label}\nsecond line` })
    assert.equal(jobs.get(handle.jobId).status, 'running')
    assert.equal(jobs.get(handle.jobId).label, label.replace(/\s+/g, ' ').slice(0, 160))
    assert.equal(Object.hasOwn(handle, 'timeoutMs'), false)
    assert.equal((await jobs.wait(handle.jobId, 5000)).status, 'completed')
    assert.match(JSON.stringify(jobs.readAt(handle.jobId, 0)), /turn completed/)
  }
})

test('task-panel kill terminates the whole process group and preserves the first reason', { skip: !runtime || process.platform === 'win32' }, async t => {
  const jobs = await registry(t)
  const f = fixture(t, jobs, `
const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('child-ready', ''); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
fs.writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
emit({ type: 'thread.started', thread_id: 'kill-thread' });
await new Promise(() => {});
`)
  const handle = await f.call({ background: true })
  await until(() => existsSync(join(f.cwd, 'pids.json')) && existsSync(join(f.cwd, 'child-ready')))
  const [pid, childPid] = JSON.parse(readFileSync(join(f.cwd, 'pids.json'), 'utf8'))
  assert.equal(jobs.kill(handle.jobId, undefined, 'panel stop'), 'requested')
  jobs.kill(handle.jobId, undefined, 'second reason')
  const settled = await jobs.wait(handle.jobId, 5000)
  assert.equal(settled.status, 'killed')
  assert.match(settled.detail, /panel stop/)
  assert.equal(isProcessGroupAlive(pid), false, 'job settles only after the whole process group exits')
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
})

test('caller abort kills, awaits settlement and removes its foreground row before throwing', { skip: !runtime }, async t => {
  const jobs = await registry(t)
  const f = fixture(t, jobs, liveBody)
  const controller = new AbortController()
  const pending = f.call({}, { signal: controller.signal })
  const rejected = assert.rejects(pending, /abort/i)
  const id = jobs.list()[0].id
  await until(() => jobs.get(id).progress === 'exec: sleep')
  controller.abort()
  await rejected
  assert.equal(jobs.list().length, 0)
})

test('headless admission and job cap errors fall back only for foreground calls', { skip: !runtime }, async t => {
  const jobs = await registry(t, {}, false)
  const f = fixture(t, jobs)
  assert.equal((await f.call()).status, 'completed')
  assert.equal(f.warnings.length, 1)
  await assert.rejects(f.call({ background: true }), /no job controller/)
  jobs.attachController('test-codex')
  const capped = await registry(t, { maxConcurrentJobsPerOwner: 1 })
  const f2 = fixture(t, capped, liveBody)
  const handle = await f2.call({ background: true })
  await assert.rejects(f2.call({ background: true }), /job limit reached/)
  assert.equal((await f2.call()).status, 'completed')
  assert.equal(f2.warnings.length, 2)
  await capped.wait(handle.jobId, 5000)
})

test('failed processes and spawn errors settle jobs without unhandled rejections', { skip: !runtime }, async t => {
  const jobs = await registry(t)
  const f = fixture(t, jobs, "process.stderr.write('fixture failed'); process.exit(2);")
  const result = await f.call()
  assert.equal(result.status, 'failed')
  assert.equal(result.stderrTail, 'fixture failed')
  const handle = await f.call({ background: true })
  const failed = await jobs.wait(handle.jobId, 5000)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.detail, 'fixture failed')
  rmSync(f.executable)
  await assert.rejects(f.call(), /Failed to start Codex CLI/)
  assert.equal(jobs.list().length, 1, 'only the handed-out background job remains')
})

test('job metadata carries the owner and root call and review label', async t => {
  const specs = []
  const completions = []
  const jobs = { start(spec) {
    specs.push(spec)
    const hooks = spec.run({ append() {}, updateProgress() {} })
    completions.push(hooks.done)
    return `codex-${specs.length}`
  } }
  const f = fixture(t, jobs)
  const agent = { id: 'agent-1', session: { id: 'session-1' } }
  await f.call({ background: true }, { agent, rootCallId: 'root-1' })
  await f.call({ prompt: undefined, target: 'base', baseBranch: 'main', background: true }, { agent }, 'codex_cli_review')
  assert.equal(specs[0].owner, 'agent-1')
  assert.deepEqual(specs[0].toolCall, { callId: 'call-1', rootCallId: 'root-1' })
  assert.deepEqual(specs[1].toolCall, { callId: 'call-1', rootCallId: 'call-1' })
  assert.equal(specs[1].label, 'review base main')
  await Promise.all(completions)
})

test('explicit background timeout reaches the runner; foreground panel stop returns canonical outcome', { skip: !runtime }, async t => {
  const jobs = await registry(t)
  const f = fixture(t, jobs, liveBody)
  const handle = await f.call({ background: true, timeoutMs: 1000 })
  assert.equal((await jobs.wait(handle.jobId, 5000)).status, 'failed')
  const pending = f.call()
  const view = jobs.list().find(row => row.status === 'running')
  await until(() => jobs.get(view.id).progress === 'exec: sleep')
  jobs.kill(view.id, undefined, 'panel stop')
  const result = await pending
  assert.equal(result.status, 'killed')
  assert.equal(result.stoppedByUser, true)
  assert.match(result.stopReason, /panel stop/)
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.sessionId, 'live-thread')
  assert.ok(Array.isArray(result.commands))
  assert.ok(Array.isArray(result.fileChanges))
  assert.ok(Object.hasOwn(result, 'usage'))
  assert.equal(result.isError, true)
  assert.equal(jobs.list().length, 1, 'collected foreground row is removed')
})
