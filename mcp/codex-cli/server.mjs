#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCodexArgs, inspectCodexSetup, runCodex } from "./lib/codex-runner.mjs";
import {
  cancelJob,
  cleanupExpiredJobs,
  countActiveJobs,
  createJob,
  isTerminalStatus,
  listJobs,
  publicJob,
  readCurrentJob,
  readJob,
  updateJob
} from "./lib/jobs.mjs";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const SYNC_TIMEOUT_MS = 4 * 60 * 1000;
const WAIT_POLL_MS = 500;
const DEFAULT_MAX_BACKGROUND_JOBS = 4;

const COMMON_RUN_PROPERTIES = {
  cwd: { type: "string", description: "Absolute trusted workspace directory. Codex runs with this as its working root." },
  background: { type: "boolean", default: false, description: "Run as a persistent job and return a jobId immediately. Use for parallel work or anything that may exceed four minutes." },
  model: { type: "string", description: "Codex model requested for this invocation." },
  reasoningEffort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh"] },
  outputSchema: { type: "object", description: "JSON Schema for the final response. The parsed object is returned as structuredResult." },
  skipGitRepoCheck: { type: "boolean", description: "Allow running outside a Git repository." },
  ephemeral: { type: "boolean", description: "Do not persist the Codex session; it cannot be resumed." },
  timeoutMs: { type: "integer", minimum: 1000, maximum: 86400000, description: "Values above four minutes automatically start a background job." }
};

const TOOLS = [
  {
    name: "codex_cli_setup",
    description: "Check the local Codex CLI version and login state without revealing credentials.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Absolute workspace directory." } },
      required: ["cwd"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "codex_cli_run",
    description: "Delegate a task to Codex CLI (`codex exec`), or continue a previous Codex session. Defaults to a read-only sandbox; pass sandbox \"workspace-write\" to let Codex edit files.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_RUN_PROPERTIES,
        prompt: { type: "string", description: "Complete instructions, including pre-collected file paths, errors, and code so Codex can skip exploration." },
        sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
        networkAccess: { type: "boolean", description: "Allow network access inside the workspace-write sandbox." },
        resumeSessionId: { type: "string", description: "Codex session ID (from a previous result's sessionId) to continue." },
        resumeLast: { type: "boolean", description: "Continue the most recent Codex session recorded for cwd." },
        worktree: { type: "boolean", description: "New sessions only: run in a fresh Codex-managed Git worktree. The result reports worktreePath." },
        profile: { type: "string", description: "New sessions only: Codex config profile layered on the user config." },
        addDirs: { type: "array", items: { type: "string" }, description: "New sessions only: extra writable directories, resolved from cwd." },
        images: { type: "array", items: { type: "string" }, description: "Image files attached to the prompt, resolved from cwd." }
      },
      required: ["cwd", "prompt"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: "codex_cli_review",
    description: "Run Codex's built-in code review (`codex exec review`) in a read-only sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        ...COMMON_RUN_PROPERTIES,
        target: { type: "string", enum: ["uncommitted", "base", "commit", "custom"], default: "uncommitted", description: "uncommitted: staged, unstaged, and untracked changes; base: diff against baseBranch; commit: one commit; custom: review driven only by prompt." },
        baseBranch: { type: "string" },
        commitSha: { type: "string" },
        title: { type: "string", description: "Optional commit title shown in the review summary." },
        prompt: { type: "string", description: "Review instructions. Codex accepts them only with target \"custom\"." }
      },
      required: ["cwd"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "codex_cli_status",
    description: "List Codex CLI background jobs for a workspace or inspect one job.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute workspace directory used to filter jobs." },
        jobId: { type: "string" }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "codex_cli_wait",
    description: "Block until the given background jobs finish or the wait times out (max four minutes), then return their results.",
    inputSchema: {
      type: "object",
      properties: {
        jobIds: { type: "array", items: { type: "string" }, minItems: 1 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: SYNC_TIMEOUT_MS, default: SYNC_TIMEOUT_MS }
      },
      required: ["jobIds"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "codex_cli_result",
    description: "Read the complete stored result of a Codex CLI background job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "codex_cli_cancel",
    description: "Cancel an active Codex CLI background job and its process group.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }
];

function requireAbsoluteCwd(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path.");
  }
}

function maxBackgroundJobs() {
  const value = Number(process.env.CODEX_CLI_PLUGIN_MAX_JOBS ?? DEFAULT_MAX_BACKGROUND_JOBS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_BACKGROUND_JOBS;
}

function spawnWorkerForJob(jobId) {
  const child = spawn(process.execPath, [WORKER_PATH, jobId], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  const latest = readJob(jobId);
  if (latest.status === "queued") {
    updateJob(jobId, (record) => ({
      ...record,
      status: "running",
      phase: "starting",
      pid: child.pid,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString()
    }));
  }
  return publicJob(readJob(jobId));
}

function startBackground(request) {
  cleanupExpiredJobs();
  if (countActiveJobs(request.cwd) >= maxBackgroundJobs()) {
    throw new Error(`Too many active Codex CLI background jobs for ${request.cwd}.`);
  }
  return spawnWorkerForJob(createJob(request).jobId);
}

function dispatchRun(request) {
  requireAbsoluteCwd(request.cwd);
  // Validate before queueing so argument errors surface synchronously.
  buildCodexArgs(request);
  const shouldRunInBackground = request.background || (request.timeoutMs != null && request.timeoutMs > SYNC_TIMEOUT_MS);
  const prepared = {
    ...request,
    timeoutMs: shouldRunInBackground ? request.timeoutMs : (request.timeoutMs ?? SYNC_TIMEOUT_MS)
  };
  return shouldRunInBackground ? startBackground(prepared) : runCodex(prepared);
}

async function waitForJobs(jobIds, timeoutMs = SYNC_TIMEOUT_MS) {
  const deadline = Date.now() + Math.min(timeoutMs, SYNC_TIMEOUT_MS);
  let records = jobIds.map((jobId) => readCurrentJob(jobId));
  while (!records.every((record) => isTerminalStatus(record.status)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    records = jobIds.map((jobId) => readCurrentJob(jobId));
  }
  const pending = records.filter((record) => !isTerminalStatus(record.status)).map((record) => record.jobId);
  return {
    allDone: pending.length === 0,
    pending,
    jobs: records.map((record) => publicJob(record, isTerminalStatus(record.status)))
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case "codex_cli_setup":
      requireAbsoluteCwd(args.cwd);
      return inspectCodexSetup({ cwd: args.cwd });
    case "codex_cli_run":
      return dispatchRun({ ...args, kind: "exec" });
    case "codex_cli_review":
      return dispatchRun({ ...args, kind: "review" });
    case "codex_cli_status":
      if (args.jobId) return publicJob(readCurrentJob(args.jobId));
      if (args.cwd) requireAbsoluteCwd(args.cwd);
      return { jobs: listJobs(args.cwd).map((record) => publicJob(record)) };
    case "codex_cli_wait":
      if (!Array.isArray(args.jobIds) || args.jobIds.length === 0) throw new Error("jobIds must be a non-empty array.");
      return waitForJobs(args.jobIds, args.timeoutMs);
    case "codex_cli_result":
      return publicJob(readCurrentJob(args.jobId), true);
    case "codex_cli_cancel":
      return publicJob(await cancelJob(args.jobId), true);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResponse(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

async function handleMessage(message) {
  if (message.method?.startsWith("notifications/")) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "codex-cli", version: "0.1.0" }
      }
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const value = await callTool(message.params?.name, message.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id: message.id, result: toolResponse(value, value?.isError === true) });
    } catch (error) {
      send({ jsonrpc: "2.0", id: message.id, result: toolResponse({ error: error.message }, true) });
    }
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      void handleMessage(JSON.parse(line));
    } catch (error) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
    }
  }
});
