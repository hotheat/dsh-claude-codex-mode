#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectClaudeSetup, runClaude } from "./lib/claude-runner.mjs";
import {
  cancelJob,
  cleanupExpiredJobs,
  countActiveJobs,
  createJob,
  listJobs,
  publicJob,
  readCurrentJob,
  readJob,
  rejectApproval,
  updateJob
} from "./lib/jobs.mjs";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const SYNC_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_MAX_BACKGROUND_JOBS = 4;

const TOOLS = [
  {
    name: "claude_code_setup",
    description: "Check the local Claude Code CLI and show which config source supplies each Claude-related environment variable without revealing values.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute workspace directory used to locate the nearest project .env." },
        envFile: { type: "string", description: "Optional explicit .env path, resolved from cwd." },
        environmentPolicy: { type: "string", enum: ["inherit", "settings"], default: "inherit", description: "Use settings to isolate Claude provider/model variables from the caller environment." },
        settingsFile: { type: "string", description: "Optional Claude settings JSON path. Supports ~/. Resolution: explicit value, CODEX_CLAUDE_CODE_SETTINGS_FILE, then ~/.claude/settings.json." }
      },
      required: ["cwd"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "claude_code_run",
    description: "Run a Claude Code CLI task or read-only review in a workspace, optionally as a persistent background job.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute trusted workspace directory." },
        prompt: { type: "string", description: "Complete task or review request sent to Claude Code." },
        mode: { type: "string", enum: ["task", "review"], default: "task" },
        background: { type: "boolean", default: false, description: "Run as a persistent job. Required for work expected to approach the four-minute synchronous limit." },
        envFile: { type: "string", description: "Optional explicit .env path, resolved from cwd." },
        environmentPolicy: { type: "string", enum: ["inherit", "settings"], default: "inherit", description: "Use settings to isolate Claude provider/model variables from the caller environment." },
        settingsFile: { type: "string", description: "Optional Claude settings JSON path. Supports ~/. Resolution: explicit value, CODEX_CLAUDE_CODE_SETTINGS_FILE, then ~/.claude/settings.json." },
        mcpConfigFile: { type: "string", description: "Optional MCP config JSON passed to Claude Code with --mcp-config." },
        strictMcpConfig: { type: "boolean", description: "Use only MCP servers from mcpConfigFile/settings instead of auto-loading broader defaults." },
        model: { type: "string", description: "Claude model alias or full model name." },
        expectedModel: { type: "string", description: "Fail unless Claude JSON modelUsage reports this exact model." },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        permissionMode: { type: "string", enum: ["acceptEdits", "auto", "manual", "dontAsk", "plan", "bypassPermissions"] },
        allowDangerousPermissions: { type: "boolean", description: "Required true when permissionMode is bypassPermissions." },
        resumeSessionId: { type: "string", description: "Claude session ID to resume." },
        continueLatest: { type: "boolean", description: "Continue the latest Claude session in cwd." },
        forkSession: { type: "boolean", description: "Fork instead of reusing the resumed session ID." },
        maxBudgetUsd: { type: "number", minimum: 0 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 86400000, description: "Execution timeout. Values above four minutes automatically start a background job." },
        allowedTools: { type: "array", items: { type: "string" } },
        allowedCommands: { type: "array", description: "Convenience allowlist for Bash(command *) entries. This approves Claude tools only; it is not an OS sandbox.", items: { type: "string" } },
        disallowedTools: { type: "array", items: { type: "string" } },
        addDirs: { type: "array", description: "Additional directories exposed to Claude. Values are isolated from the positional prompt.", items: { type: "string" } }
      },
      required: ["cwd", "prompt"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: "claude_code_status",
    description: "List Claude Code background jobs for a workspace or inspect one job.",
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
    name: "claude_code_result",
    description: "Read the complete stored result of a Claude Code background job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  {
    name: "claude_code_cancel",
    description: "Cancel an active Claude Code background job and its process group.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: "claude_code_approve",
    description: "Approve a background job that is waiting on Claude tool permissions and resume it with the pending allowed tools.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        allowedTools: { type: "array", items: { type: "string" }, description: "Optional explicit tools to allow when resuming. Defaults to the job's pending suggested tools." },
        allowedCommands: { type: "array", items: { type: "string" }, description: "Optional command allowlist converted to Bash(command *)." }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: "claude_code_reject",
    description: "Reject a pending Claude Code tool approval and mark the job canceled.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        reason: { type: "string" }
      },
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
  const value = Number(process.env.CODEX_CLAUDE_CODE_MAX_JOBS ?? DEFAULT_MAX_BACKGROUND_JOBS);
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
    throw new Error(`Too many active Claude Code background jobs for ${request.cwd}.`);
  }
  const job = createJob(request);
  return spawnWorkerForJob(job.jobId);
}

function approveJob(jobId, approval = {}) {
  const record = readJob(jobId);
  if (record.status !== "needs_approval") {
    throw new Error(`Job ${jobId} is not waiting for approval.`);
  }
  const pendingTools = record.pendingApproval?.suggestedAllowedTools
    ?? record.outcome?.pendingApproval?.suggestedAllowedTools
    ?? [];
  const request = {
    ...record.request,
    allowedTools: [
      ...(record.request.allowedTools ?? []),
      ...pendingTools,
      ...(approval.allowedTools ?? [])
    ],
    allowedCommands: [
      ...(record.request.allowedCommands ?? []),
      ...(approval.allowedCommands ?? [])
    ],
    resumeSessionId: record.outcome?.sessionId ?? record.request.resumeSessionId,
    continueLatest: false
  };
  updateJob(jobId, (current) => ({
    ...current,
    status: "queued",
    phase: "queued",
    completedAt: null,
    error: null,
    pendingApproval: null,
    request
  }));
  return spawnWorkerForJob(jobId);
}

async function callTool(name, args = {}) {
  switch (name) {
    case "claude_code_setup": {
      requireAbsoluteCwd(args.cwd);
      return inspectClaudeSetup({ cwd: args.cwd, envFile: args.envFile, environmentPolicy: args.environmentPolicy, settingsFile: args.settingsFile });
    }
    case "claude_code_run": {
      requireAbsoluteCwd(args.cwd);
      const shouldRunInBackground = args.background || (args.timeoutMs != null && args.timeoutMs > SYNC_TIMEOUT_MS);
      const request = {
        ...args,
        cwd: args.cwd,
        timeoutMs: shouldRunInBackground ? args.timeoutMs : (args.timeoutMs ?? SYNC_TIMEOUT_MS)
      };
      if (shouldRunInBackground) {
        return startBackground(request);
      }
      return runClaude(request);
    }
    case "claude_code_status": {
      if (args.jobId) {
        return publicJob(readCurrentJob(args.jobId));
      }
      if (args.cwd) requireAbsoluteCwd(args.cwd);
      return { jobs: listJobs(args.cwd).map((record) => publicJob(record)) };
    }
    case "claude_code_result":
      return publicJob(readCurrentJob(args.jobId), true);
    case "claude_code_cancel":
      return publicJob(await cancelJob(args.jobId), true);
    case "claude_code_approve":
      return approveJob(args.jobId, args);
    case "claude_code_reject":
      return publicJob(rejectApproval(args.jobId, args.reason), true);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResponse(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError
  };
}

async function handleMessage(message) {
  if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "claude-code", version: "0.3.2" }
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
      send({ jsonrpc: "2.0", id: message.id, result: toolResponse(value) });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: toolResponse({ error: error.message }, true)
      });
    }
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    });
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
      const message = JSON.parse(line);
      void handleMessage(message);
    } catch (error) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
    }
  }
});
