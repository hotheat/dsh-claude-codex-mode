import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isProviderRoutingEnvironmentKey } from "../lib/config.mjs";

const SERVER_PATH = fileURLToPath(new URL("../server.mjs", import.meta.url));

function fakeClaude(root) {
  const executable = path.join(root, "fake-claude.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-claude 1.0.0");
} else {
  console.log(JSON.stringify({ result: "done", session_id: "mcp-session", is_error: false }));
}
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

function longRunningFakeClaude(root) {
  const executable = path.join(root, "fake-claude-tree.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

if (process.argv.includes("--version")) {
  console.log("fake-claude 1.0.0");
  process.exit(0);
}
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
fs.writeFileSync(process.env.CLAUDE_TEST_PID_FILE, JSON.stringify({
  claudePid: process.pid,
  descendantPid: child.pid
}));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

function approvalFakeClaude(root) {
  const executable = path.join(root, "fake-claude-approval.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("fake-claude 1.0.0");
  process.exit(0);
}
if (!args.includes("--allowedTools") || !args[args.indexOf("--allowedTools") + 1].includes("Bash(ffprobe *)")) {
  console.log(JSON.stringify({
    result: "Command \`ffprobe -v error sample.mp4\` requires approval and was not executed.",
    session_id: "approval-session",
    is_error: false
  }));
  process.exit(0);
}
console.log(JSON.stringify({ result: "approved done", session_id: "approval-session", is_error: false }));
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

function startServer(env, processEnv = process.env) {
  const inheritedEnv = Object.fromEntries(
    Object.entries(processEnv).filter(([key]) => !isProviderRoutingEnvironmentKey(key))
  );
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...inheritedEnv, ...env }
  });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  return {
    child,
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 5000);
        pending.set(id, (message) => {
          clearTimeout(timeout);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    }
  };
}

function toolPayload(response) {
  assert.equal(response.result.isError, false);
  return JSON.parse(response.result.content[0].text);
}

function toolError(response) {
  assert.equal(response.result.isError, true);
  return JSON.parse(response.result.content[0].text);
}

test("MCP server lists tools and completes a background Claude job", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-mcp-"));
  fs.mkdirSync(path.join(root, ".git"));
  const server = startServer({
    CLAUDE_CODE_CLI_PATH: fakeClaude(root),
    CODEX_CLAUDE_CODE_STATE_DIR: path.join(root, "jobs")
  }, {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: "synthetic-host-token",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "synthetic-haiku"
  });
  t.after(() => server.child.kill("SIGTERM"));

  const initialized = await server.request(1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.serverInfo.name, "claude-code");
  const listed = await server.request(2, "tools/list", {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "claude_code_setup",
    "claude_code_run",
    "claude_code_status",
    "claude_code_result",
    "claude_code_cancel",
    "claude_code_approve",
    "claude_code_reject"
  ]);
  const setupTool = listed.result.tools.find((tool) => tool.name === "claude_code_setup");
  const runTool = listed.result.tools.find((tool) => tool.name === "claude_code_run");
  assert.equal(setupTool.inputSchema.properties.settingsFile.type, "string");
  assert.equal(runTool.inputSchema.properties.settingsFile.type, "string");
  assert.deepEqual(setupTool.inputSchema.properties.environmentPolicy.enum, ["inherit", "settings"]);
  assert.equal(runTool.inputSchema.properties.expectedModel.type, "string");

  const settingsFile = path.join(root, "settings.json.custom");
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom-haiku" }
  }));
  const setup = toolPayload(await server.request(3, "tools/call", {
    name: "claude_code_setup",
    arguments: { cwd: root, settingsFile }
  }));
  assert.equal(setup.settingsFile, settingsFile);
  assert.equal(setup.environmentSources.ANTHROPIC_DEFAULT_HAIKU_MODEL, "settings");

  const started = toolPayload(await server.request(4, "tools/call", {
    name: "claude_code_run",
    arguments: { cwd: root, prompt: "Do work", mode: "task", permissionMode: "plan", background: true }
  }));
  assert.match(started.jobId, /^claude-/);

  let completed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    completed = toolPayload(await server.request(10 + attempt, "tools/call", {
      name: "claude_code_result",
      arguments: { jobId: started.jobId }
    }));
    if (["completed", "failed"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "completed");
  assert.equal(typeof completed.lastActivityAt, "string");
  assert.equal(completed.outcome.result, "done");
  assert.equal(completed.outcome.sessionId, "mcp-session");

  const autoBackground = toolPayload(await server.request(100, "tools/call", {
    name: "claude_code_run",
    arguments: { cwd: root, prompt: "Long work", timeoutMs: 240001 }
  }));
  assert.match(autoBackground.jobId, /^claude-/);
});

test("MCP approve resumes a job waiting on Claude permissions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-approval-mcp-"));
  fs.mkdirSync(path.join(root, ".git"));
  const server = startServer({
    CLAUDE_CODE_CLI_PATH: approvalFakeClaude(root),
    CODEX_CLAUDE_CODE_STATE_DIR: path.join(root, "jobs")
  });
  t.after(() => server.child.kill("SIGTERM"));

  const started = toolPayload(await server.request(1, "tools/call", {
    name: "claude_code_run",
    arguments: { cwd: root, prompt: "Inspect media", background: true }
  }));

  let waiting;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    waiting = toolPayload(await server.request(10 + attempt, "tools/call", {
      name: "claude_code_result",
      arguments: { jobId: started.jobId }
    }));
    if (waiting.status === "needs_approval") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(waiting.status, "needs_approval");
  assert.deepEqual(waiting.pendingApproval.suggestedAllowedTools, ["Bash(ffprobe *)"]);
  const waitingRecord = JSON.parse(fs.readFileSync(path.join(root, "jobs", `${started.jobId}.json`), "utf8"));
  assert.equal(waitingRecord.pid, null);
  assert.equal(waitingRecord.claudePid, null);

  const approved = toolPayload(await server.request(100, "tools/call", {
    name: "claude_code_approve",
    arguments: { jobId: started.jobId }
  }));
  assert.equal(approved.status, "running");

  let completed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    completed = toolPayload(await server.request(110 + attempt, "tools/call", {
      name: "claude_code_result",
      arguments: { jobId: started.jobId }
    }));
    if (completed.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome.result, "approved done");
});

test("MCP cancel terminates the worker, Claude process, and descendants", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-cancel-"));
  const pidFile = path.join(root, "pids.json");
  fs.mkdirSync(path.join(root, ".git"));
  const server = startServer({
    CLAUDE_CODE_CLI_PATH: longRunningFakeClaude(root),
    CLAUDE_TEST_PID_FILE: pidFile,
    CODEX_CLAUDE_CODE_STATE_DIR: path.join(root, "jobs")
  });
  let pids;
  t.after(() => server.child.kill("SIGTERM"));
  t.after(() => {
    for (const pid of [pids?.claudePid, pids?.descendantPid]) {
      if (pid && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  const started = toolPayload(await server.request(1, "tools/call", {
    name: "claude_code_run",
    arguments: { cwd: root, prompt: "Keep running", background: true }
  }));
  assert.equal(await waitFor(() => fs.existsSync(pidFile)), true);
  pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));

  const cancelRequest = server.request(2, "tools/call", {
    name: "claude_code_cancel",
    arguments: { jobId: started.jobId }
  });
  const jobFile = path.join(root, "jobs", `${started.jobId}.json`);
  assert.equal(await waitFor(() => JSON.parse(fs.readFileSync(jobFile, "utf8")).status !== "running"), true);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "canceling");
  const canceled = toolPayload(await cancelRequest);

  assert.equal(canceled.status, "canceled");
  assert.equal(await waitFor(() => !isProcessAlive(pids.claudePid)), true);
  assert.equal(await waitFor(() => !isProcessAlive(pids.descendantPid)), true);

  const canceledAgain = toolPayload(await server.request(3, "tools/call", {
    name: "claude_code_cancel",
    arguments: { jobId: started.jobId }
  }));
  assert.equal(canceledAgain.status, "canceled");
});

test("MCP rejects new background jobs over the active job limit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-limit-"));
  const pidFile = path.join(root, "pids.json");
  fs.mkdirSync(path.join(root, ".git"));
  const server = startServer({
    CLAUDE_CODE_CLI_PATH: longRunningFakeClaude(root),
    CLAUDE_TEST_PID_FILE: pidFile,
    CODEX_CLAUDE_CODE_STATE_DIR: path.join(root, "jobs"),
    CODEX_CLAUDE_CODE_MAX_JOBS: "1"
  });
  t.after(() => server.child.kill("SIGTERM"));

  const first = toolPayload(await server.request(1, "tools/call", {
    name: "claude_code_run",
    arguments: { cwd: root, prompt: "Keep running", background: true }
  }));
  assert.match(first.jobId, /^claude-/);

  const second = toolError(await server.request(2, "tools/call", {
    name: "claude_code_run",
    arguments: { cwd: root, prompt: "Second job", background: true }
  }));
  assert.match(second.error, /Too many active Claude Code background jobs/);

  const canceled = toolPayload(await server.request(3, "tools/call", {
    name: "claude_code_cancel",
    arguments: { jobId: first.jobId }
  }));
  assert.equal(canceled.status, "canceled");
});

test("MCP result refreshes a running job whose worker exited", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-stale-result-"));
  const jobs = path.join(root, "jobs");
  const jobId = "claude-00000000-0000-4000-8000-000000000000";
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(jobs);
  fs.writeFileSync(path.join(jobs, `${jobId}.json`), JSON.stringify({
    jobId,
    status: "running",
    phase: "running",
    pid: 2_147_483_647,
    cwd: root,
    summary: "stale worker",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
  const server = startServer({ CODEX_CLAUDE_CODE_STATE_DIR: jobs });
  t.after(() => server.child.kill("SIGTERM"));

  const result = toolPayload(await server.request(1, "tools/call", {
    name: "claude_code_result",
    arguments: { jobId }
  }));

  assert.equal(result.status, "failed");
  assert.match(result.error, /worker exited/i);
});

test("MCP cancel does not signal stale PIDs on a needs_approval job", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-stale-approval-"));
  const jobs = path.join(root, "jobs");
  const jobId = "claude-00000000-0000-4000-8000-000000000001";
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(jobs);
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  sentinel.unref();
  t.after(() => {
    if (isProcessAlive(sentinel.pid)) process.kill(-sentinel.pid, "SIGKILL");
  });
  fs.writeFileSync(path.join(jobs, `${jobId}.json`), JSON.stringify({
    jobId,
    status: "needs_approval",
    phase: "needs_approval",
    pid: sentinel.pid,
    claudePid: sentinel.pid,
    cwd: root,
    summary: "approval waiting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
  const server = startServer({ CODEX_CLAUDE_CODE_STATE_DIR: jobs });
  t.after(() => server.child.kill("SIGTERM"));

  const canceled = toolPayload(await server.request(1, "tools/call", {
    name: "claude_code_cancel",
    arguments: { jobId }
  }));

  assert.equal(canceled.status, "canceled");
  assert.equal(isProcessAlive(sentinel.pid), true);
});
