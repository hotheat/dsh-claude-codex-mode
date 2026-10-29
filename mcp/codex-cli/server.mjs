#!/usr/bin/env node

import { TOOLS } from "./lib/tools.mjs";

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
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS.map(({ parameters, ...tool }) => ({ ...tool, inputSchema: parameters })) } });
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
