const SYNC_TIMEOUT_MS = 4 * 60 * 1000

const COMMON_RUN_PROPERTIES = {
  cwd: { type: 'string', description: 'Absolute trusted workspace directory. Codex runs with this as its working root.' },
  background: { type: 'boolean', default: false, description: 'Run as a persistent job and return a jobId immediately. Use for parallel work or anything that may exceed four minutes.' },
  model: { type: 'string', description: 'Codex model requested for this invocation.' },
  reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  outputSchema: { type: 'object', description: 'JSON Schema for the final response. The parsed object is returned as structuredResult.' },
  skipGitRepoCheck: { type: 'boolean', description: 'Allow running outside a Git repository.' },
  ephemeral: { type: 'boolean', description: 'Do not persist the Codex session; it cannot be resumed.' },
  timeoutMs: { type: 'integer', description: 'Whole milliseconds; minimum 1000, maximum 86400000; values above 240000 run as a background job.' }
}

const definitions = [
  {
    name: 'codex_cli_setup',
    description: 'Check the local Codex CLI version and login state without revealing credentials.',
    parameters: {
      type: 'object',
      properties: { cwd: { type: 'string', description: 'Absolute workspace directory.' } },
      required: ['cwd'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'codex_cli_run',
    description: 'Delegate a task to Codex CLI (`codex exec`), or continue a previous Codex session. Defaults to a read-only sandbox; pass sandbox "workspace-write" to let Codex edit files.',
    parameters: {
      type: 'object',
      properties: {
        ...COMMON_RUN_PROPERTIES,
        prompt: { type: 'string', description: 'Complete instructions, including pre-collected file paths, errors, and code so Codex can skip exploration.' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], default: 'read-only' },
        networkAccess: { type: 'boolean', description: 'Allow network access inside the workspace-write sandbox.' },
        resumeSessionId: { type: 'string', description: 'Codex session ID (from a previous result\'s sessionId) to continue.' },
        resumeLast: { type: 'boolean', description: 'Continue the most recent Codex session recorded for cwd.' },
        worktree: { type: 'boolean', description: 'New sessions only: run in a fresh Codex-managed Git worktree. The result reports worktreePath.' },
        profile: { type: 'string', description: 'New sessions only: Codex config profile layered on the user config.' },
        addDirs: { type: 'array', items: { type: 'string' }, description: 'New sessions only: extra writable directories, resolved from cwd.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Image files attached to the prompt, resolved from cwd.' }
      },
      required: ['cwd', 'prompt'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: 'codex_cli_review',
    description: 'Run Codex\'s built-in code review (`codex exec review`) in a read-only sandbox.',
    parameters: {
      type: 'object',
      properties: {
        ...COMMON_RUN_PROPERTIES,
        target: { type: 'string', enum: ['uncommitted', 'base', 'commit', 'custom'], default: 'uncommitted', description: 'uncommitted: staged, unstaged, and untracked changes; base: diff against baseBranch; commit: one commit; custom: review driven only by prompt.' },
        baseBranch: { type: 'string' },
        commitSha: { type: 'string' },
        title: { type: 'string', description: 'Optional commit title shown in the review summary.' },
        prompt: { type: 'string', description: 'Review instructions. Codex accepts them only with target "custom".' }
      },
      required: ['cwd'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'codex_cli_status',
    description: 'List Codex CLI background jobs for a workspace or inspect one job.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute workspace directory used to filter jobs.' },
        jobId: { type: 'string' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'codex_cli_wait',
    description: 'Block until the given background jobs finish or the wait times out (max four minutes), then return their results.',
    parameters: {
      type: 'object',
      properties: {
        jobIds: { type: 'array', items: { type: 'string' }, description: 'At least one job ID.' },
        timeoutMs: { type: 'integer', description: 'Whole milliseconds; minimum 1000, maximum 240000.', default: SYNC_TIMEOUT_MS }
      },
      required: ['jobIds'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'codex_cli_result',
    description: 'Read the complete stored result of a Codex CLI background job.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: 'codex_cli_cancel',
    description: 'Cancel an active Codex CLI background job and its process group.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }
]

export const [SETUP_TOOL, RUN_TOOL, REVIEW_TOOL, ...JOB_TOOLS] = definitions
export const TOOLS = [SETUP_TOOL, RUN_TOOL, REVIEW_TOOL, ...JOB_TOOLS]
