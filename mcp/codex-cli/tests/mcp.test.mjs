import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeCodex, tempRoot } from "./helpers.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let nextId = 1;
  return {
    request(method, params = {}) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, 10000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async call(name, args) {
      const message = await this.request("tools/call", { name, arguments: args });
      return { isError: message.result.isError, payload: JSON.parse(message.result.content[0].text) };
    },
    stop() {
      child.kill("SIGTERM");
    }
  };
}

test("MCP server lists the Codex CLI tools", async () => {
  const server = startServer();
  try {
    const initialized = await server.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(initialized.result.serverInfo.name, "codex-cli");
    const listed = await server.request("tools/list");
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
      "codex_cli_setup",
      "codex_cli_run",
      "codex_cli_review",
      "codex_cli_status",
      "codex_cli_wait",
      "codex_cli_result",
      "codex_cli_cancel"
    ]);
  } finally {
    server.stop();
  }
});

test("MCP server rejects relative workspaces and invalid requests before running", async () => {
  const root = tempRoot("codex-mcp-invalid-");
  const server = startServer({ CODEX_CLI_PATH: createFakeCodex(root) });
  try {
    const relative = await server.call("codex_cli_setup", { cwd: "." });
    assert.equal(relative.isError, true);
    assert.match(relative.payload.error, /absolute path/);
    const review = await server.call("codex_cli_review", { cwd: root, prompt: "focus", background: true });
    assert.equal(review.isError, true);
    assert.match(review.payload.error, /only with target "custom"/);
  } finally {
    server.stop();
  }
});

test("MCP server runs synchronous tasks and reviews", async () => {
  const root = tempRoot("codex-mcp-sync-");
  const server = startServer({ CODEX_CLI_PATH: createFakeCodex(root) });
  try {
    const setup = await server.call("codex_cli_setup", { cwd: root });
    assert.equal(setup.payload.ready, true);
    const run = await server.call("codex_cli_run", { cwd: root, prompt: "Do the task" });
    assert.equal(run.isError, false);
    assert.equal(run.payload.status, "completed");
    assert.equal(JSON.parse(run.payload.result).stdin, "Do the task");
    const review = await server.call("codex_cli_review", { cwd: root, target: "commit", commitSha: "abc123" });
    const argv = JSON.parse(review.payload.result).argv;
    assert.deepEqual(argv.slice(0, 2), ["exec", "review"]);
    assert.equal(argv[argv.indexOf("--commit") + 1], "abc123");
  } finally {
    server.stop();
  }
});

test("MCP server runs parallel background jobs and waits for all of them", async () => {
  const root = tempRoot("codex-mcp-bg-");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-state-"));
  const server = startServer({ CODEX_CLI_PATH: createFakeCodex(root), CODEX_CLI_PLUGIN_STATE_DIR: state });
  try {
    const first = await server.call("codex_cli_run", { cwd: root, prompt: "analyze auth", background: true });
    const second = await server.call("codex_cli_run", { cwd: root, prompt: "analyze api", background: true });
    assert.match(first.payload.jobId, /^codex-/);
    const waited = await server.call("codex_cli_wait", { jobIds: [first.payload.jobId, second.payload.jobId], timeoutMs: 8000 });
    assert.equal(waited.payload.allDone, true);
    assert.deepEqual(waited.payload.jobs.map((job) => job.status), ["completed", "completed"]);
    assert.deepEqual(waited.payload.jobs.map((job) => JSON.parse(job.outcome.result).stdin), ["analyze auth", "analyze api"]);
    const listed = await server.call("codex_cli_status", { cwd: root });
    assert.equal(listed.payload.jobs.length, 2);
  } finally {
    server.stop();
  }
});

test("MCP server cancels a running background job", async () => {
  const root = tempRoot("codex-mcp-cancel-");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-state-"));
  const server = startServer({
    CODEX_CLI_PATH: createFakeCodex(root, { body: "setInterval(() => {}, 1000);" }),
    CODEX_CLI_PLUGIN_STATE_DIR: state
  });
  try {
    const started = await server.call("codex_cli_run", { cwd: root, prompt: "long", background: true });
    const waited = await server.call("codex_cli_wait", { jobIds: [started.payload.jobId], timeoutMs: 1000 });
    assert.equal(waited.payload.allDone, false);
    assert.deepEqual(waited.payload.pending, [started.payload.jobId]);
    const canceled = await server.call("codex_cli_cancel", { jobId: started.payload.jobId });
    assert.equal(canceled.payload.status, "canceled");
  } finally {
    server.stop();
  }
});
