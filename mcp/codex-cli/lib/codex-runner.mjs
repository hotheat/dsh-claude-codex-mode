import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from 'node:util'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { terminateProcessGroup } from "./process-tree.mjs";

const SANDBOX_MODES = new Set(["read-only", "workspace-write"]);
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const REVIEW_TARGETS = new Set(["uncommitted", "base", "commit", "custom"]);
const MAX_LISTED_ITEMS = 50;
const RETRYABLE_ERROR = /at capacity|rate limit|too many requests|\b(?:429|500|502|503|504)\b|service unavailable|overloaded|stream disconnected/i;

function tomlString(value) {
  // JSON string escapes are a subset of TOML basic-string escapes.
  return JSON.stringify(String(value));
}

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function codexExecutable(processEnv = process.env) {
  // Executable selection is a plugin-process trust decision, never request input.
  return processEnv.CODEX_CLI_PATH || "codex";
}

export function runShape(request) {
  const kind = request.kind ?? "exec";
  if (kind === "review") return "review";
  if (kind !== "exec") throw new Error(`Unsupported run kind: ${kind}`);
  return request.resumeSessionId || request.resumeLast ? "resume" : "exec";
}

function validateRequest(request, shape) {
  if (request.resumeSessionId && request.resumeLast) {
    throw new Error("resumeSessionId and resumeLast cannot be used together.");
  }
  const sandbox = request.sandbox ?? "read-only";
  if (!SANDBOX_MODES.has(sandbox)) throw new Error(`Unsupported sandbox mode: ${sandbox}`);
  if (request.networkAccess && sandbox !== "workspace-write") {
    throw new Error("networkAccess requires sandbox: \"workspace-write\".");
  }
  if (request.reasoningEffort && !REASONING_EFFORTS.has(request.reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort: ${request.reasoningEffort}`);
  }
  if (request.outputSchema != null && (typeof request.outputSchema !== "object" || Array.isArray(request.outputSchema))) {
    throw new Error("outputSchema must be a JSON Schema object.");
  }

  if (shape === "review") {
    const target = request.target ?? "uncommitted";
    if (!REVIEW_TARGETS.has(target)) throw new Error(`Unsupported review target: ${target}`);
    if (target === "base" && !request.baseBranch) throw new Error("target \"base\" requires baseBranch.");
    if (target === "commit" && !request.commitSha) throw new Error("target \"commit\" requires commitSha.");
    if (target === "custom" && !request.prompt?.trim()) throw new Error("target \"custom\" requires prompt.");
    if (target !== "custom" && request.prompt?.trim()) {
      throw new Error("Codex review accepts a prompt only with target \"custom\".");
    }
    return;
  }

  if (!request.prompt?.trim()) throw new Error("prompt is required.");
  if (shape === "resume") {
    for (const field of ["profile", "addDirs", "worktree"]) {
      const value = request[field];
      if (value && (!Array.isArray(value) || value.length)) {
        throw new Error(`${field} applies only to a new session, not resume.`);
      }
    }
  }
}

export function buildCodexArgs(request, { schemaFile } = {}) {
  const shape = runShape(request);
  validateRequest(request, shape);

  const args = ["exec"];
  if (shape === "review") args.push("review");
  if (shape === "resume") args.push("resume");
  args.push("--json");

  // Review is always read-only; exec runs never wait for interactive approval.
  const sandbox = shape === "review" ? "read-only" : (request.sandbox ?? "read-only");
  args.push("-c", `sandbox_mode=${tomlString(sandbox)}`, "-c", `approval_policy="never"`);
  if (request.networkAccess) args.push("-c", "sandbox_workspace_write.network_access=true");
  if (request.model) args.push("-m", request.model);
  if (request.reasoningEffort) args.push("-c", `model_reasoning_effort=${tomlString(request.reasoningEffort)}`);
  if (request.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (request.ephemeral) args.push("--ephemeral");
  if (schemaFile) args.push("--output-schema", schemaFile);

  if (shape === "exec") {
    if (request.profile) args.push("-p", request.profile);
    if (request.worktree) args.push("--worktree");
    for (const directory of request.addDirs ?? []) args.push("--add-dir", path.resolve(request.cwd, directory));
  }
  if (shape !== "review") {
    for (const image of request.images ?? []) args.push("-i", path.resolve(request.cwd, image));
  }

  if (shape === "review") {
    const target = request.target ?? "uncommitted";
    if (target === "uncommitted") args.push("--uncommitted");
    if (target === "base") args.push("--base", request.baseBranch);
    if (target === "commit") args.push("--commit", request.commitSha);
    if (request.title) args.push("--title", request.title);
    if (target === "custom") args.push("-");
    return args;
  }

  // Prompts travel over stdin: no argv size limit and no positional ambiguity with --last.
  // With --last, a "-" positional would be parsed as SESSION_ID; resume reads stdin without one.
  if (shape === "resume" && request.resumeLast) {
    args.push("--last");
    return args;
  }
  if (shape === "resume") args.push(request.resumeSessionId);
  args.push("-");
  return args;
}

export function stdinPrompt(request) {
  const shape = runShape(request);
  if (shape === "review") return (request.target ?? "uncommitted") === "custom" ? request.prompt.trim() : null;
  return request.prompt.trim();
}

function probe(executable, args, cwd, env) {
  return spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 15_000 });
}

export function inspectCodexSetup({ cwd, processEnv = process.env }) {
  const executable = codexExecutable(processEnv);
  const version = probe(executable, ["--version"], cwd, processEnv);
  const ready = version.status === 0;
  const login = ready ? probe(executable, ["login", "status"], cwd, processEnv) : null;
  return setupResult(executable, version, login, processEnv)
}

function setupResult(executable, version, login, processEnv) {
  const ready = version.status === 0
  // Never echo login output: API-key logins may print a partial key.
  const loginText = `${login?.stdout ?? ""}\n${login?.stderr ?? ""}`;
  const authMethod = login?.status !== 0
    ? null
    : (/chatgpt/i.test(loginText) ? "chatgpt" : (/api key/i.test(loginText) ? "api-key" : "unknown"));
  return {
    ready: ready && login?.status === 0,
    executable,
    version: ready ? version.stdout.trim() : null,
    loggedIn: login?.status === 0,
    authMethod,
    codexHome: processEnv.CODEX_HOME ? "CODEX_HOME" : "default (~/.codex)",
    error: !ready
      ? (version.stderr || version.error?.message || "Codex CLI probe failed").trim()
      : (login.status === 0 ? null : "Codex CLI is not logged in. Run `codex login` in a terminal.")
  };
}

const execFileAsync = promisify(execFile)

export async function inspectCodexSetupAsync({ cwd, processEnv = process.env }) {
  const executable = codexExecutable(processEnv)
  const probeAsync = async args => {
    try {
      const result = await execFileAsync(executable, args, {
        cwd, env: processEnv, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      })
      return { ...result, status: 0 }
    } catch (error) {
      return { status: error.code, stdout: error.stdout, stderr: error.stderr, error }
    }
  }
  const version = await probeAsync(['--version'])
  const login = version.status === 0 ? await probeAsync(['login', 'status']) : null
  return setupResult(executable, version, login, processEnv)
}

export function describeEvent(event) {
  const item = event?.item;
  if (event?.type === "thread.started") return `thread ${event.thread_id}`;
  if (event?.type === "turn.failed") return `turn failed: ${truncate(event.error?.message, 300)}`;
  if (!item) return event?.type ?? null;
  if (item.type === "command_execution") return `${item.status}: ${truncate(item.command, 300)}`;
  if (item.type === "file_change") return `files: ${(item.changes ?? []).map((change) => change.path).join(", ")}`;
  if (item.type === "agent_message") return `message: ${truncate(item.text, 300)}`;
  if (item.type === "mcp_tool_call") return `mcp: ${item.server}/${item.tool}`;
  return `${event.type}: ${item.type}`;
}

export function summarizeEvents(stdout) {
  const summary = {
    threadId: null,
    eventCount: 0,
    unparsedLines: 0,
    messages: [],
    commands: [],
    fileChanges: [],
    toolCalls: [],
    warnings: [],
    errors: [],
    turnFailed: false,
    turnCompleted: false,
    usage: null
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      summary.unparsedLines += 1;
      continue;
    }
    summary.eventCount += 1;
    if (event.type === "thread.started") summary.threadId = event.thread_id ?? summary.threadId;
    if (event.type === "turn.completed") {
      summary.turnCompleted = true;
      summary.usage = event.usage ?? null;
    }
    if (event.type === "turn.failed") {
      summary.turnFailed = true;
      summary.errors.push(event.error?.message ?? "turn failed");
    }
    if (event.type === "error") summary.errors.push(event.message ?? "error");
    if (event.type !== "item.completed" || !event.item) continue;
    const item = event.item;
    if (item.type === "agent_message") summary.messages.push(item.text ?? "");
    if (item.type === "error") summary.warnings.push(item.message ?? "");
    if (item.type === "command_execution") {
      summary.commands.push({ command: truncate(item.command, 300), exitCode: item.exit_code ?? null, status: item.status ?? null });
    }
    if (item.type === "file_change") {
      for (const change of item.changes ?? []) summary.fileChanges.push({ path: change.path, kind: change.kind ?? null });
    }
    if (item.type === "mcp_tool_call") summary.toolCalls.push({ server: item.server ?? null, tool: item.tool ?? null, status: item.status ?? null });
  }
  summary.errors = [...new Set(summary.errors)];
  summary.warnings = [...new Set(summary.warnings)];
  return summary;
}

function dateDirectories(sessionsRoot, days) {
  const directories = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    directories.push(path.join(
      sessionsRoot,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ));
  }
  return directories;
}

function readFirstLine(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8").split("\n")[0];
  } finally {
    fs.closeSync(descriptor);
  }
}

export function resolveSessionWorkspace(threadId, processEnv = process.env) {
  if (!threadId || !/^[A-Za-z0-9-]+$/.test(threadId)) return null;
  const codexHome = processEnv.CODEX_HOME || path.join(os.homedir(), ".codex");
  for (const directory of dateDirectories(path.join(codexHome, "sessions"), 3)) {
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch {
      continue;
    }
    const name = names.find((entry) => entry.endsWith(`-${threadId}.jsonl`));
    if (!name) continue;
    try {
      return JSON.parse(readFirstLine(path.join(directory, name))).payload?.cwd ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function writeSchemaFile(schema) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-plugin-schema-"));
  const file = path.join(directory, "schema.json");
  fs.writeFileSync(file, JSON.stringify(schema), { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

export async function runCodex(request, options = {}) {
  const processEnv = options.processEnv ?? process.env;
  const executable = codexExecutable(processEnv);
  const cwd = path.resolve(request.cwd);
  const shape = runShape(request);
  const schema = request.outputSchema ? writeSchemaFile(request.outputSchema) : null;
  const timeoutMs = request.timeoutMs ?? 30 * 60 * 1000;
  const startedAt = new Date().toISOString();

  let raw;
  try {
    const args = buildCodexArgs(request, { schemaFile: schema?.file });
    const input = stdinPrompt(request);
    raw = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: processEnv,
        detached: process.platform !== "win32",
        stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let timedOut = false;
      let termination;
      const timeout = setTimeout(() => {
        timedOut = true;
        termination = terminateProcessGroup(child.pid);
      }, timeoutMs);
      try {
        options.onSpawn?.(child.pid);
      } catch (error) {
        clearTimeout(timeout);
        void terminateProcessGroup(child.pid);
        reject(error);
        return;
      }
      const emitActivity = (summary) => {
        if (!summary) return;
        try {
          options.onActivity?.({ summary });
        } catch {
          // Activity updates are best-effort and do not affect result collection.
        }
      };
      const emitEvent = (line) => {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          // Non-JSON stdout is kept in the final summary as unparsedLines.
          return
        }
        try {
          options.onEvent?.(event)
        } catch {
          // Event rendering is best-effort and does not affect result collection.
        }
        emitActivity(describeEvent(event))
      }
      if (input != null) {
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) emitEvent(line)
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start Codex CLI (${executable}): ${error.message}`));
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        if (lineBuffer.trim()) emitEvent(lineBuffer);
        Promise.resolve(termination).then(() => resolve({ exitCode, signal, stdout, stderr, timedOut }), reject);
      });
    });
  } finally {
    schema?.cleanup();
  }

  const events = summarizeEvents(raw.stdout);
  const result = events.messages.at(-1) ?? "";
  const succeeded = raw.exitCode === 0 && !raw.timedOut && !events.turnFailed && events.eventCount > 0;
  // Top-level error events also report recovered stream retries; they are fatal only on failure.
  const errors = succeeded ? [] : events.errors;
  const warnings = succeeded ? [...new Set([...events.warnings, ...events.errors])] : events.warnings;
  let structuredResult = null;
  if (succeeded && request.outputSchema) {
    try {
      structuredResult = JSON.parse(result);
    } catch {
      structuredResult = null;
    }
  }

  return {
    status: succeeded ? "completed" : "failed",
    kind: shape,
    exitCode: raw.exitCode,
    signal: raw.signal,
    timedOut: raw.timedOut,
    startedAt,
    completedAt: new Date().toISOString(),
    sessionId: events.threadId ?? request.resumeSessionId ?? null,
    worktreePath: request.worktree && shape === "exec" ? resolveSessionWorkspace(events.threadId, processEnv) : null,
    result,
    structuredResult,
    isError: !succeeded,
    retryable: !succeeded && errors.some((message) => RETRYABLE_ERROR.test(message)),
    errors,
    warnings,
    commands: events.commands.slice(-MAX_LISTED_ITEMS),
    commandCount: events.commands.length,
    fileChanges: events.fileChanges.slice(-MAX_LISTED_ITEMS),
    toolCalls: events.toolCalls.slice(-MAX_LISTED_ITEMS),
    usage: events.usage,
    requestedModel: request.model ?? null,
    stderrTail: succeeded ? null : (raw.stderr.trim().slice(-2000) || null)
  };
}
