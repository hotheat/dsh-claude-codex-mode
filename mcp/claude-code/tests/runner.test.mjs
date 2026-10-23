import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isProviderRoutingEnvironmentKey, resolveSettingsFile } from "../lib/config.mjs";
import {
  buildClaudeArgs,
  inspectClaudeSetup,
  runClaude as runClaudeUnisolated
} from "../lib/claude-runner.mjs";

function isolatedProviderEnvironment(baseEnv = process.env, overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !isProviderRoutingEnvironmentKey(key))
  );
  return { ...env, ...overrides };
}

function runClaude(request, options = {}) {
  return runClaudeUnisolated(request, {
    ...options,
    processEnv: isolatedProviderEnvironment(options.processEnv)
  });
}

function createFakeClaude(root) {
  const executable = path.join(root, "fake-claude.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-claude 1.0.0");
  process.exit(0);
}
console.log(JSON.stringify({
  result: JSON.stringify({
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    args: process.argv.slice(2)
  }),
  session_id: "session-test",
  is_error: false,
  total_cost_usd: 0
}));
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

async function waitForProcessExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

test("buildClaudeArgs forces reviews to plan mode", () => {
  const args = buildClaudeArgs({
    prompt: "Review this diff",
    mode: "review",
    allowedTools: ["Write", "Bash(git *)"],
    mcpConfigFile: "/tmp/untrusted-mcp.json"
  });
  assert.deepEqual(args.slice(0, 5), ["--print", "--output-format", "json", "--prompt-suggestions", "false"]);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args.includes("--safe-mode"), true);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args.includes("--mcp-config"), false);
  assert.match(args.at(-1), /Do not modify files/);
});

test("buildClaudeArgs rejects implicit permission bypass", () => {
  assert.throws(
    () => buildClaudeArgs({ prompt: "Fix it", permissionMode: "bypassPermissions" }),
    /allowDangerousPermissions=true/
  );
});

test("buildClaudeArgs terminates variadic add-dir values before the prompt", () => {
  const args = buildClaudeArgs({
    prompt: "Inspect the workspace",
    addDirs: ["../shared", "../fixtures"]
  });

  assert.deepEqual(args.slice(-6), [
    "--add-dir",
    "../shared",
    "--add-dir",
    "../fixtures",
    "--",
    "Inspect the workspace"
  ]);
});

test("buildClaudeArgs passes explicit settings, strict MCP config, and command allowlist", () => {
  const args = buildClaudeArgs({
    prompt: "Run checks",
    settingsFile: "/tmp/settings.json.custom",
    mcpConfigFile: "/tmp/mcp.json",
    strictMcpConfig: true,
    allowedCommands: ["node", "pnpm", "ffprobe"]
  });

  assert.equal(args[args.indexOf("--settings") + 1], "/tmp/settings.json.custom");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/mcp.json");
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(
    args[args.indexOf("--allowedTools") + 1],
    "Bash(node *),Bash(pnpm *),Bash(ffprobe *)"
  );
});

test("buildClaudeArgs rejects unsafe command allowlist entries", () => {
  assert.throws(
    () => buildClaudeArgs({ prompt: "Run checks", allowedCommands: ["node;rm"] }),
    /Unsupported workspace command/
  );
});

test("runClaude passes merged environment without shell interpolation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-runner-"));
  const settingsFile = path.join(root, "settings.json");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".env"), "ANTHROPIC_AUTH_TOKEN=dotenv-token\n");
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: "settings-token", ANTHROPIC_BASE_URL: "https://settings.test" }
  }));
  const executable = createFakeClaude(root);
  const outcome = await runClaudeUnisolated({
    cwd: root,
    settingsFile,
    prompt: "Check $HOME and `uname` literally",
    mode: "task",
    permissionMode: "plan"
  }, {
    processEnv: isolatedProviderEnvironment({
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "synthetic-host-token",
      ANTHROPIC_BASE_URL: "https://synthetic-provider.invalid"
    }, {
      CLAUDE_CODE_CLI_PATH: executable
    })
  });
  const payload = JSON.parse(outcome.result);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.sessionId, "session-test");
  assert.equal(payload.authToken === "dotenv-token", true);
  assert.equal(payload.baseUrl, "https://settings.test");
  assert.equal(payload.args[payload.args.indexOf("--settings") + 1], settingsFile);
  assert.equal(payload.args.at(-1), "Check $HOME and `uname` literally");
});

test("runClaude passes the resolved default Claude settings file to Claude", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-default-settings-"));
  fs.mkdirSync(path.join(root, ".git"));
  const executable = createFakeClaude(root);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({ cwd: root, prompt: "Check default settings" });
    const payload = JSON.parse(outcome.result);
    assert.equal(
      payload.args[payload.args.indexOf("--settings") + 1],
      resolveSettingsFile()
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude verifies the exact model reported by Claude", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-model-verified-"));
  const executable = createFakeClaude(root);
  fs.mkdirSync(path.join(root, ".git"));
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({
      cwd: root,
      prompt: "Verify model",
      model: "claude-opus-4-6",
      expectedModel: "claude-opus-4-6"
    });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.verificationError, /reported modelUsage: none/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude accepts the expected modelUsage entry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-model-match-"));
  const executable = path.join(root, "fake-claude-model.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({
  result: "done",
  session_id: "model-session",
  is_error: false,
  modelUsage: { "claude-opus-4-6": { inputTokens: 1, outputTokens: 1 } }
}));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({
      cwd: root,
      prompt: "Verify model",
      model: "claude-opus-4-6",
      expectedModel: "claude-opus-4-6"
    });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(outcome.modelsUsed, ["claude-opus-4-6"]);
    assert.equal(outcome.verificationError, null);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude rejects a different reported model", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-model-mismatch-"));
  const executable = path.join(root, "fake-claude-wrong-model.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({
  result: "done",
  session_id: "wrong-model-session",
  is_error: false,
  modelUsage: { "glm-5.2": { inputTokens: 1, outputTokens: 1 } }
}));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({
      cwd: root,
      prompt: "Verify model",
      model: "claude-opus-4-6",
      expectedModel: "claude-opus-4-6"
    });
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.modelsUsed, ["glm-5.2"]);
    assert.match(outcome.verificationError, /reported modelUsage: glm-5.2/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude reports approval requirements without marking the job completed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-needs-approval-"));
  const executable = path.join(root, "fake-claude-approval.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({
  result: "Command \`ffprobe -v error sample.mp4\` requires approval and was not executed.",
  session_id: "approval-session",
  is_error: false
}));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({ cwd: root, prompt: "Inspect media" });
    assert.equal(outcome.status, "needs_approval");
    assert.equal(outcome.isError, false);
    assert.deepEqual(outcome.pendingApproval.commands, ["ffprobe -v error sample.mp4"]);
    assert.deepEqual(outcome.pendingApproval.suggestedAllowedTools, ["Bash(ffprobe *)"]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude defers exact-model verification while approval is pending", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-model-approval-"));
  const executable = path.join(root, "fake-claude-model-approval.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({
  result: "Command \`git diff\` requires approval and was not executed.",
  session_id: "model-approval-session",
  is_error: false
}));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({
      cwd: root,
      prompt: "Inspect diff",
      expectedModel: "claude-opus-4-6"
    });
    assert.equal(outcome.status, "needs_approval");
    assert.equal(outcome.verificationError, null);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude recognizes approval requirements for arbitrary safe commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-git-approval-"));
  const executable = path.join(root, "fake-claude-git-approval.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({
  result: "Command \`git diff\` requires approval and was not executed.",
  session_id: "git-approval-session",
  is_error: false
}));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({ cwd: root, prompt: "Inspect diff" });
    assert.equal(outcome.status, "needs_approval");
    assert.deepEqual(outcome.pendingApproval.commands, ["git diff"]);
    assert.deepEqual(outcome.pendingApproval.suggestedAllowedTools, ["Bash(git *)"]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude does not infer approval or blockers from read-only review prose", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-review-prose-"));
  const executable = path.join(root, "fake-claude-review-prose.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({
  result: "The Plan is not approved yet. Tests were not run because this is a read-only review.",
  session_id: "review-session",
  is_error: false
}));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({ cwd: root, prompt: "Review only", mode: "review" });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.pendingApproval, null);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude reports completed_with_blockers when artifacts were not verified", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-blockers-"));
  const executable = path.join(root, "fake-claude-blockers.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({
  result: "Implementation finished, but rendering and tests were not executed because visual QA unavailable.",
  session_id: "blocker-session",
  is_error: false
}));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({ cwd: root, prompt: "Render video" });
    assert.equal(outcome.status, "completed_with_blockers");
    assert.equal(outcome.isError, false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude treats Claude JSON error responses as failed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-error-result-"));
  const executable = path.join(root, "fake-claude-error.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log(JSON.stringify({ result: "model request failed", is_error: true }));
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({ cwd: root, prompt: "Fail cleanly" });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.isError, true);
    assert.equal(outcome.result, "model request failed");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("runClaude treats invalid JSON output as failed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-invalid-json-"));
  const executable = path.join(root, "fake-claude-invalid-json.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
console.log("not-json");
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CLAUDE_CODE_CLI_PATH;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  try {
    const outcome = await runClaude({ cwd: root, prompt: "Return malformed output" });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.isError, true);
    assert.equal(outcome.result, "not-json");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previous;
  }
});

test("setup reports environment sources without values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-setup-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".env"), "ANTHROPIC_AUTH_TOKEN=never-print-this\n");
  const executable = createFakeClaude(root);
  const setup = inspectClaudeSetup({
    cwd: root,
    settingsFile: path.join(root, "missing.json"),
    processEnv: isolatedProviderEnvironment({
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "synthetic-host-token"
    }, {
      CLAUDE_CODE_CLI_PATH: executable
    })
  });
  assert.equal(setup.ready, true);
  assert.equal(setup.environmentPolicy, "inherit");
  assert.equal(setup.environmentSources.ANTHROPIC_AUTH_TOKEN, ".env");
  assert.equal(JSON.stringify(setup).includes("never-print-this"), false);
});

test("setup never executes CLAUDE_CODE_CLI_PATH from a project .env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-safe-setup-"));
  const bin = path.join(root, "bin");
  const marker = path.join(root, "malicious-ran");
  const malicious = path.join(root, "malicious.mjs");
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho safe-claude 1.0.0\n");
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  fs.writeFileSync(malicious, `#!${process.execPath}
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker)}, "executed");
console.log("malicious 1.0.0");
`);
  fs.chmodSync(malicious, 0o755);
  fs.writeFileSync(path.join(root, ".env"), `CLAUDE_CODE_CLI_PATH=${malicious}\n`);

  const setup = inspectClaudeSetup({
    cwd: root,
    settingsFile: path.join(root, "missing.json"),
    processEnv: { PATH: bin }
  });

  assert.equal(setup.ready, true);
  assert.equal(setup.executable, "claude");
  assert.equal(setup.version, "safe-claude 1.0.0");
  assert.equal(fs.existsSync(marker), false);
});

test("runClaude timeout terminates the complete Claude process group", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-timeout-"));
  const executable = path.join(root, "fake-claude-tree.mjs");
  const pidFile = path.join(root, "pids.json");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
fs.writeFileSync(process.env.CLAUDE_TEST_PID_FILE, JSON.stringify({
  claudePid: process.pid,
  descendantPid: child.pid
}));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(executable, 0o755);

  const previousCli = process.env.CLAUDE_CODE_CLI_PATH;
  const previousPidFile = process.env.CLAUDE_TEST_PID_FILE;
  process.env.CLAUDE_CODE_CLI_PATH = executable;
  process.env.CLAUDE_TEST_PID_FILE = pidFile;
  let descendantPid;
  try {
    const outcome = await runClaude({
      cwd: root,
      prompt: "Run until timeout",
      timeoutMs: 1000
    });
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    descendantPid = pids.descendantPid;

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.timedOut, true);
    assert.equal(await waitForProcessExit(pids.claudePid), true);
    assert.equal(await waitForProcessExit(pids.descendantPid), true);
  } finally {
    if (descendantPid && isProcessAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    if (previousCli === undefined) delete process.env.CLAUDE_CODE_CLI_PATH;
    else process.env.CLAUDE_CODE_CLI_PATH = previousCli;
    if (previousPidFile === undefined) delete process.env.CLAUDE_TEST_PID_FILE;
    else process.env.CLAUDE_TEST_PID_FILE = previousPidFile;
  }
});
