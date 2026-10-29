import { isAbsolute } from 'node:path'
import { SETUP_TOOL, RUN_TOOL, REVIEW_TOOL } from '../mcp/codex-cli/lib/tools.mjs'
import { buildCodexArgs, inspectCodexSetupAsync, runCodex } from '../mcp/codex-cli/lib/codex-runner.mjs'
import { terminateProcessGroup } from '../mcp/codex-cli/lib/process-tree.mjs'
import { createEventRenderer } from './codex-events.js'

const SYNC_TIMEOUT_MS = 4 * 60 * 1000
const JOB_NOTE = 'Execution continues as a background job; read it with job_output and stop it with job_kill.'

function requireCwd(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('cwd 必须是绝对路径。')
}

function jobLabel(request) {
  const prompt = request.prompt?.split(/\r?\n/).find(line => line.trim())
  return (prompt ?? `review ${request.target ?? 'uncommitted'} ${request.baseBranch ?? request.commitSha ?? ''}`)
    .replace(/\s+/g, ' ').trim().slice(0, 160)
}

export function registerCodexTools(ctx, { processEnv = process.env } = {}) {
  const disposers = []
  const stopProcess = pid => {
    return terminateProcessGroup(pid).catch(error => ctx.logger.warn(`Codex 进程组停止失败：${error.message}`))
  }
  const executeRun = (args, exec, kind) => {
    const request = { ...args, kind }
    requireCwd(request.cwd)
    // Validate before registering a job or spawning a process.
    buildCodexArgs(request)
    exec.signal?.throwIfAborted()
    return runRequest(request, exec)
  }
  const runRequest = async (request, exec) => {
    const background = request.background === true || (request.timeoutMs != null && request.timeoutMs > SYNC_TIMEOUT_MS)
    const budget = request.timeoutMs ?? SYNC_TIMEOUT_MS
    const jobs = ctx.get('jobs')
    const owner = exec.agent?.id
    let id
    let outcome
    let failure
    let done
    if (jobs) {
      try {
        id = jobs.start({
          kind: 'codex', label: jobLabel(request),
          ...(exec.agent ? { owner } : {}),
          toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId },
          run(job) {
            let pid
            let stopped = false
            let reason
            let termination
            const renderer = createEventRenderer()
            // A foreground wait budget must not become the process deadline.
            const jobRequest = background ? request : { ...request, timeoutMs: undefined }
            done = runCodex(jobRequest, {
              processEnv,
              onSpawn(value) {
                pid = value
                if (stopped) termination = stopProcess(pid)
              },
              onEvent(event) {
                const { lines, progress } = renderer.render(event)
                for (const line of lines) job.append(`${line}\n`, { channel: 'stdout' })
                if (progress !== null) job.updateProgress(progress)
              },
            }).then(async value => {
              await termination
              outcome = value
              const detail = value.status === 'completed'
                ? `exit code: ${value.exitCode}; session ${value.sessionId}`
                : value.errors[0] || value.stderrTail || `exit code: ${value.exitCode}`
              return {
                status: stopped ? 'killed' : value.status,
                detail: stopped ? reason : detail,
                ...(value.result ? { result: value.result } : {}),
              }
            }, async error => {
              await termination
              failure = error
              return { status: stopped ? 'killed' : 'failed', detail: stopped ? reason : error.message }
            })
            return {
              done,
              cancel(value) {
                if (stopped) return
                stopped = true
                reason = value
                if (pid) termination = stopProcess(pid)
              },
            }
          },
        })
      } catch (error) {
        ctx.logger.warn(`Codex 后台任务注册失败：${error.message}`)
        if (background) throw error
      }
    }
    if (id === undefined) {
      if (background) throw new Error('background jobs unavailable: mount @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs')
      return runCodex({ ...request, timeoutMs: budget }, { processEnv })
    }
    if (background) return { status: 'running', jobId: id, note: JOB_NOTE }
    let view
    try {
      view = await jobs.wait(id, budget, owner, exec.signal)
    } catch (error) {
      if (!exec.signal?.aborted) throw error
      jobs.kill(id, owner, 'tool call aborted')
      // Wait for process exit even when cancellation takes longer than the budget.
      await done
      await jobs.wait(id, budget, owner)
      jobs.remove(id, owner)
      throw error
    }
    if (view.status === 'running' || view.status === 'stopping') {
      return { status: 'running', jobId: id, timeoutMs: budget, note: JOB_NOTE }
    }
    jobs.remove(id, owner)
    if (failure) throw failure
    if (view.status === 'killed') {
      return { ...outcome, status: 'killed', stoppedByUser: true, stopReason: view.detail || 'stopped by user' }
    }
    return outcome
  }
  const definitions = [
    [SETUP_TOOL, async args => {
      requireCwd(args.cwd)
      return inspectCodexSetupAsync({ cwd: args.cwd, processEnv })
    }],
    [RUN_TOOL, (args, exec) => executeRun(args, exec, 'exec')],
    [REVIEW_TOOL, (args, exec) => executeRun(args, exec, 'review')],
  ]
  const dispose = () => { for (const off of disposers.splice(0).reverse()) off() }
  try {
    for (const [tool, execute] of definitions) {
      disposers.push(ctx.tools.register({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        execute,
      }))
    }
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}
