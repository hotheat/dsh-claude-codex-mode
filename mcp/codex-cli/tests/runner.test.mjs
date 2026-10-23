import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildCodexArgs, inspectCodexSetup, resolveSessionWorkspace, runCodex, stdinPrompt } from "../lib/codex-runner.mjs";
import { createFakeCodex, tempRoot } from "./helpers.mjs";

function config(args) {
  return args.flatMap((value, index) => (args[index - 1] === "-c" ? [value] : []));
}

test("new exec defaults to read-only, never approves, and reads the prompt from stdin", () => {
  const args = buildCodexArgs({ cwd: "/tmp/work", prompt: "  analyze src  " });
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  assert.deepEqual(config(args), ['sandbox_mode="read-only"', 'approval_policy="never"']);
  assert.equal(args.at(-1), "-");
  assert.equal(stdinPrompt({ cwd: "/tmp/work", prompt: "  analyze src  " }), "analyze src");
});

test("exec maps write sandbox, network, model, effort, profile, worktree, and paths", () => {
  const args = buildCodexArgs({
    cwd: "/tmp/work",
    prompt: "fix",
    sandbox: "workspace-write",
    networkAccess: true,
    model: "gpt-5.5",
    reasoningEffort: "high",
    profile: "fast",
    worktree: true,
    addDirs: ["../shared"],
    images: ["shot.png"]
  }, { schemaFile: "/tmp/schema.json" });
  assert.deepEqual(config(args), [
    'sandbox_mode="workspace-write"',
    'approval_policy="never"',
    "sandbox_workspace_write.network_access=true",
    'model_reasoning_effort="high"'
  ]);
  assert.equal(args[args.indexOf("-m") + 1], "gpt-5.5");
  assert.equal(args[args.indexOf("-p") + 1], "fast");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/shared");
  assert.equal(args[args.indexOf("-i") + 1], "/tmp/work/shot.png");
  assert.equal(args[args.indexOf("--output-schema") + 1], "/tmp/schema.json");
  assert.ok(args.includes("--worktree"));
});

test("resume places the session ID before stdin and omits the positional with --last", () => {
  const byId = buildCodexArgs({ cwd: "/tmp/work", prompt: "continue", resumeSessionId: "abc" });
  assert.deepEqual(byId.slice(0, 3), ["exec", "resume", "--json"]);
  assert.deepEqual(byId.slice(-2), ["abc", "-"]);
  const last = buildCodexArgs({ cwd: "/tmp/work", prompt: "continue", resumeLast: true });
  assert.equal(last.at(-1), "--last");
  assert.ok(!last.includes("-"));
});

test("invalid combinations are rejected", () => {
  const base = { cwd: "/tmp/work", prompt: "x" };
  assert.throws(() => buildCodexArgs({ ...base, resumeSessionId: "a", resumeLast: true }), /cannot be used together/);
  assert.throws(() => buildCodexArgs({ ...base, sandbox: "danger-full-access" }), /Unsupported sandbox/);
  assert.throws(() => buildCodexArgs({ ...base, networkAccess: true }), /requires sandbox/);
  assert.throws(() => buildCodexArgs({ ...base, resumeLast: true, worktree: true }), /new session/);
  assert.throws(() => buildCodexArgs({ cwd: "/tmp/work", prompt: " " }), /prompt is required/);
});

test("review is always read-only and enforces target/prompt exclusivity", () => {
  const uncommitted = buildCodexArgs({ cwd: "/tmp/work", kind: "review", sandbox: "workspace-write" });
  assert.deepEqual(uncommitted.slice(0, 3), ["exec", "review", "--json"]);
  assert.equal(config(uncommitted)[0], 'sandbox_mode="read-only"');
  assert.ok(uncommitted.includes("--uncommitted"));
  assert.equal(stdinPrompt({ cwd: "/tmp/work", kind: "review" }), null);

  const base = buildCodexArgs({ cwd: "/tmp/work", kind: "review", target: "base", baseBranch: "main" });
  assert.equal(base[base.indexOf("--base") + 1], "main");
  const custom = buildCodexArgs({ cwd: "/tmp/work", kind: "review", target: "custom", prompt: "focus on auth" });
  assert.equal(custom.at(-1), "-");

  assert.throws(() => buildCodexArgs({ cwd: "/tmp/work", kind: "review", prompt: "focus" }), /only with target "custom"/);
  assert.throws(() => buildCodexArgs({ cwd: "/tmp/work", kind: "review", target: "commit" }), /requires commitSha/);
});

test("setup reports login method without echoing login output", () => {
  const root = tempRoot("codex-setup-");
  const setup = inspectCodexSetup({ cwd: root, processEnv: { ...process.env, CODEX_CLI_PATH: createFakeCodex(root) } });
  assert.equal(setup.ready, true);
  assert.equal(setup.version, "codex-cli 0.162.1");
  assert.equal(setup.authMethod, "api-key");
  assert.equal(JSON.stringify(setup).includes("SECRET"), false);
});

test("runCodex parses JSONL events and sends the prompt over stdin", async () => {
  const root = tempRoot("codex-run-");
  const outcome = await runCodex(
    { cwd: root, prompt: "Check $HOME and `uname` literally", sandbox: "workspace-write" },
    { processEnv: { ...process.env, CODEX_CLI_PATH: createFakeCodex(root) } }
  );
  const echoed = JSON.parse(outcome.result);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.sessionId, "thread-123");
  assert.equal(echoed.stdin, "Check $HOME and `uname` literally");
  assert.equal(echoed.cwd, root);
  assert.equal(echoed.argv.at(-1), "-");
  assert.deepEqual(outcome.commands, [{ command: "ls", exitCode: 0, status: "completed" }]);
  assert.deepEqual(outcome.fileChanges, [{ path: "a.txt", kind: "update" }]);
  assert.deepEqual(outcome.warnings, ["ignored config key"]);
  assert.equal(outcome.usage.output_tokens, 2);
});

test("runCodex passes an output schema file and parses structured results", async () => {
  const root = tempRoot("codex-schema-");
  const executable = createFakeCodex(root, {
    body: `
const schemaFile = argv[argv.indexOf("--output-schema") + 1];
const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
emit({ type: "thread.started", thread_id: "thread-schema" });
emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ schemaTitle: schema.title }) } });
emit({ type: "turn.completed", usage: null });
process.exit(0);
`
  });
  const outcome = await runCodex(
    { cwd: root, prompt: "x", outputSchema: { title: "Findings", type: "object" } },
    { processEnv: { ...process.env, CODEX_CLI_PATH: executable } }
  );
  assert.deepEqual(outcome.structuredResult, { schemaTitle: "Findings" });
});

test("runCodex reports turn failures with errors and stderr", async () => {
  const root = tempRoot("codex-fail-");
  const executable = createFakeCodex(root, {
    body: `
emit({ type: "thread.started", thread_id: "thread-fail" });
emit({ type: "error", message: "model not supported" });
emit({ type: "turn.failed", error: { message: "model not supported" } });
process.stderr.write("fatal detail");
process.exit(1);
`
  });
  const outcome = await runCodex({ cwd: root, prompt: "x" }, { processEnv: { ...process.env, CODEX_CLI_PATH: executable } });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.isError, true);
  assert.deepEqual(outcome.errors, ["model not supported"]);
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.stderrTail, "fatal detail");
});

test("runCodex marks capacity failures retryable and demotes recovered errors to warnings", async () => {
  const root = tempRoot("codex-retry-");
  const capacity = createFakeCodex(root, {
    body: `
emit({ type: "thread.started", thread_id: "thread-capacity" });
emit({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } });
process.exit(1);
`
  });
  const failed = await runCodex({ cwd: root, prompt: "x" }, { processEnv: { ...process.env, CODEX_CLI_PATH: capacity } });
  assert.equal(failed.retryable, true);

  const recovered = createFakeCodex(root, {
    body: `emit({ type: "error", message: "Reconnecting... 2/5 (unexpected status 503 Service Unavailable)" });`
  });
  const completed = await runCodex({ cwd: root, prompt: "x" }, { processEnv: { ...process.env, CODEX_CLI_PATH: recovered } });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.errors, []);
  assert.ok(completed.warnings.some((message) => message.startsWith("Reconnecting")));
  assert.equal(completed.retryable, false);
});

test("runCodex terminates the process group on timeout", async () => {
  const root = tempRoot("codex-timeout-");
  const executable = createFakeCodex(root, { body: "setInterval(() => {}, 1000);" });
  const outcome = await runCodex({ cwd: root, prompt: "x", timeoutMs: 300 }, { processEnv: { ...process.env, CODEX_CLI_PATH: executable } });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.status, "failed");
});

test("resolveSessionWorkspace reads cwd from the session rollout", () => {
  const home = tempRoot("codex-home-");
  const now = new Date();
  const directory = path.join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "rollout-2026-01-01T00-00-00-thread-wt.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { cwd: "/worktrees/abc/repo" } })}\n{}\n`
  );
  assert.equal(resolveSessionWorkspace("thread-wt", { CODEX_HOME: home }), "/worktrees/abc/repo");
  assert.equal(resolveSessionWorkspace("../etc", { CODEX_HOME: home }), null);
  assert.equal(resolveSessionWorkspace("missing", { CODEX_HOME: home }), null);
});
