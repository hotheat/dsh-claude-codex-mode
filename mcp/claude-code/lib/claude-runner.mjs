import { spawn, spawnSync } from "node:child_process";

import { resolveClaudeEnvironment } from "./config.mjs";
import { terminateProcessGroup } from "./process-tree.mjs";

const PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan"
]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SAFE_COMMAND_NAME = /^[A-Za-z0-9._+-]+$/;

function addListArgument(args, flag, values) {
  if (!values?.length) {
    return;
  }
  args.push(flag, values.join(","));
}

function commandAllowedTool(command) {
  if (!SAFE_COMMAND_NAME.test(command)) {
    throw new Error(`Unsupported workspace command allowlist entry: ${command}`);
  }
  return `Bash(${command} *)`;
}

function buildAllowedTools(request) {
  return [
    ...(request.allowedTools ?? []),
    ...(request.allowedCommands ?? []).map(commandAllowedTool)
  ];
}

export function buildClaudeArgs(request) {
  if (!request.prompt?.trim()) {
    throw new Error("prompt is required.");
  }
  if (request.resumeSessionId && request.continueLatest) {
    throw new Error("resumeSessionId and continueLatest cannot be used together.");
  }
  if (request.effort && !EFFORT_LEVELS.has(request.effort)) {
    throw new Error(`Unsupported effort: ${request.effort}`);
  }
  if (request.permissionMode && !PERMISSION_MODES.has(request.permissionMode)) {
    throw new Error(`Unsupported permission mode: ${request.permissionMode}`);
  }
  if (request.permissionMode === "bypassPermissions" && !request.allowDangerousPermissions) {
    throw new Error("bypassPermissions requires allowDangerousPermissions=true.");
  }

  const mode = request.mode ?? "discuss";
  if (!new Set(["discuss", "review", "task"]).has(mode)) {
    throw new Error(`Unsupported run mode: ${mode}`);
  }
  if (mode === "task" && !request.permissionMode) {
    throw new Error("task mode requires an explicit permissionMode");
  }
  const preamble = {
    discuss: [
      "Answer the request in read-only mode. Do not modify files or repository state.",
      "When the request is a plan or design, state the assumptions it depends on, the trade-offs, and what would make it fail."
    ],
    review: [
      "Review the requested scope in read-only mode. Do not modify files or repository state.",
      "Report concrete findings with file paths and line numbers, ordered by severity."
    ]
  }[mode];
  const prompt = preamble
    ? [...preamble, "", request.prompt.trim()].join("\n")
    : request.prompt.trim();

  const args = request.outputFormat === "stream"
    ? ["--print", "--output-format", "stream-json", "--verbose", "--prompt-suggestions", "false"]
    : ["--print", "--output-format", "json", "--prompt-suggestions", "false"];
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  if (mode !== "task") {
    args.push(
      "--permission-mode", "plan",
      "--safe-mode",
      "--strict-mcp-config",
      "--tools", "Read,Glob,Grep"
    );
  } else if (request.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else if (request.permissionMode) {
    args.push("--permission-mode", request.permissionMode);
  }
  if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
  if (request.continueLatest) args.push("--continue");
  if (request.forkSession) args.push("--fork-session");
  if (request.settingsFile) args.push("--settings", request.settingsFile);
  if (mode === "task" && request.mcpConfigFile) args.push("--mcp-config", request.mcpConfigFile);
  if (mode === "task" && request.strictMcpConfig) args.push("--strict-mcp-config");
  if (request.maxBudgetUsd != null) args.push("--max-budget-usd", String(request.maxBudgetUsd));
  if (mode === "task") {
    addListArgument(args, "--allowedTools", buildAllowedTools(request));
    addListArgument(args, "--disallowedTools", request.disallowedTools);
  }
  for (const directory of request.addDirs ?? []) {
    args.push("--add-dir", directory);
  }
  args.push("--", prompt);
  return args;
}

export function inspectClaudeSetup(options) {
  const configuration = resolveClaudeEnvironment(options);
  const probeEnv = options.processEnv ?? process.env;
  const executable = probeEnv.CLAUDE_CODE_CLI_PATH || "claude";
  const probe = spawnSync(executable, ["--version"], {
    cwd: configuration.cwd,
    env: probeEnv,
    encoding: "utf8",
    timeout: 10_000
  });
  return {
    ready: probe.status === 0,
    executable,
    version: probe.status === 0 ? probe.stdout.trim() : null,
    error: probe.status === 0 ? null : (probe.stderr || probe.error?.message || "Claude CLI probe failed").trim(),
    envFile: configuration.envFile,
    environmentPolicy: configuration.environmentPolicy,
    settingsFile: configuration.settingsFile,
    environmentSources: configuration.sources
  };
}

export function parseClaudeStreamOutput(stdout) {
  let result = null;
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseClaudeOutput(line);
    if (event?.type === "result") result = event;
  }
  return result;
}

function parseClaudeOutput(stdout, outputFormat = "json") {
  if (outputFormat === "stream") return parseClaudeStreamOutput(stdout);
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function reportedModels(parsed) {
  if (!parsed?.modelUsage || typeof parsed.modelUsage !== "object" || Array.isArray(parsed.modelUsage)) {
    return [];
  }
  return Object.keys(parsed.modelUsage);
}

function resultText(parsed, fallback) {
  const value = parsed?.result ?? fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function extractPendingApproval(text) {
  if (!/(requires? approval|needs? approval|awaiting approval|approval required|permission denied|not approved|without approval)/i.test(text)) {
    return null;
  }
  const commands = [...text.matchAll(/`([A-Za-z0-9._+-]+(?:\s+[^`\n]*)?)`/g)]
    .map((match) => match[1].trim());
  const suggestedAllowedTools = [...new Set(commands.map((command) => {
    const executable = command.split(/\s+/)[0];
    return SAFE_COMMAND_NAME.test(executable) ? commandAllowedTool(executable) : null;
  }).filter(Boolean))];
  if (suggestedAllowedTools.length === 0) {
    return null;
  }
  return {
    reason: "Claude reported that one or more actions require approval.",
    commands: [...new Set(commands)],
    suggestedAllowedTools
  };
}

function hasCompletionBlockers(text) {
  return /(not executed|not run|unable to (?:run|execute|render|test|verify)|could not (?:run|execute|render|test|verify)|missing artifact|visual QA unavailable|blocked by)/i.test(text);
}

function classifyClaudeResult(rawResult, parsed, hasValidOutput, mode, expectedModel) {
  const baseSucceeded = rawResult.exitCode === 0
    && !rawResult.timedOut
    && !rawResult.stalled
    && hasValidOutput
    && parsed.is_error !== true;
  if (!baseSucceeded) {
    return { status: "failed", isError: true, pendingApproval: null, verificationError: null };
  }
  const text = resultText(parsed, rawResult.stdout.trim());
  const pendingApproval = extractPendingApproval(text);
  if (pendingApproval) {
    return { status: "needs_approval", isError: false, pendingApproval, verificationError: null };
  }
  const modelsUsed = reportedModels(parsed);
  if (expectedModel && !modelsUsed.includes(expectedModel)) {
    const reported = modelsUsed.length ? modelsUsed.join(", ") : "none";
    return {
      status: "failed",
      isError: true,
      pendingApproval: null,
      verificationError: `Expected Claude model ${expectedModel}; reported modelUsage: ${reported}`
    };
  }
  if (mode !== "review" && hasCompletionBlockers(text)) {
    return { status: "completed_with_blockers", isError: false, pendingApproval: null, verificationError: null };
  }
  return { status: "completed", isError: false, pendingApproval: null, verificationError: null };
}

export async function runClaude(request, options = {}) {
  const configuration = resolveClaudeEnvironment({
    cwd: request.cwd,
    envFile: request.envFile,
    environmentPolicy: request.environmentPolicy,
    processEnv: options.processEnv,
    settingsFile: request.settingsFile
  });
  const executable = configuration.env.CLAUDE_CODE_CLI_PATH || "claude";
  const args = buildClaudeArgs({
    ...request,
    settingsFile: configuration.settingsFile
  });
  const timeoutMs = request.timeoutMs ?? 30 * 60 * 1000;

  const startedAt = new Date().toISOString();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: configuration.cwd,
      env: configuration.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const emitActivity = (activity) => {
      try {
        options.onActivity?.(activity);
      } catch {
        // Activity updates are best-effort and must not interrupt Claude output collection.
      }
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stalled = false;
    let termination;
    let lastOutputAt = Date.now();
    let streamBuffer = "";
    let events = 0;
    let lastTool = null;
    let lastActivityAt = 0;
    let activityTimer;
    const emitStreamActivity = () => {
      activityTimer = undefined;
      lastActivityAt = Date.now();
      emitActivity({ stream: "stdout", events, lastTool });
    };
    const consumeStreamLine = (line) => {
      const event = parseClaudeOutput(line);
      if (event === null) return;
      events += 1;
      if (event.type === "assistant") {
        const content = event.message?.content;
        lastTool = Array.isArray(content)
          ? content.filter((block) => block?.type === "tool_use").at(-1)?.name ?? null
          : null;
      }
    };
    const clearTimers = () => {
      clearTimeout(timeout);
      clearInterval(stallCheck);
      clearTimeout(activityTimer);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      clearTimers();
      termination = terminateProcessGroup(child.pid);
    }, timeoutMs);
    const stallCheck = request.stallAfterMs != null ? setInterval(() => {
      if (Date.now() - lastOutputAt > request.stallAfterMs) {
        stalled = true;
        clearTimers();
        termination = terminateProcessGroup(child.pid);
      }
    }, Math.max(200, Math.min(request.stallAfterMs, 15_000))) : undefined;
    try {
      options.onSpawn?.(child.pid);
    } catch (error) {
      clearTimers();
      void terminateProcessGroup(child.pid);
      reject(error);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lastOutputAt = Date.now();
      stdout += chunk;
      if (request.outputFormat !== "stream") {
        emitActivity({ stream: "stdout", summary: String(chunk).slice(-500) });
        return;
      }
      streamBuffer += chunk;
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop();
      const previousEvents = events;
      for (const line of lines) consumeStreamLine(line);
      if (events === previousEvents) return;
      const delay = lastActivityAt ? Math.max(0, 1000 - (Date.now() - lastActivityAt)) : 1000;
      if (!activityTimer) activityTimer = setTimeout(emitStreamActivity, delay);
    });
    child.stderr.on("data", (chunk) => {
      lastOutputAt = Date.now();
      stderr += chunk;
      emitActivity({ stream: "stderr", summary: String(chunk).slice(-500) });
    });
    child.on("error", (error) => {
      clearTimers();
      reject(new Error(`Failed to start Claude CLI (${executable}): ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      const previousEvents = events;
      if (request.outputFormat === "stream" && streamBuffer) consumeStreamLine(streamBuffer);
      const pendingActivity = activityTimer || events !== previousEvents;
      clearTimers();
      // Short runs still report activity; longer runs keep the one-second throttle.
      if (pendingActivity && Date.now() - lastActivityAt >= 1000) emitStreamActivity();
      Promise.resolve(termination).then(() => {
        resolve({ exitCode, signal, stdout, stderr, timedOut, stalled });
      }, reject);
    });
  });

  const parsed = parseClaudeOutput(result.stdout, request.outputFormat);
  const hasValidOutput = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const modelsUsed = reportedModels(parsed);
  const classification = classifyClaudeResult(
    result,
    parsed,
    hasValidOutput,
    request.mode ?? "discuss",
    request.expectedModel
  );
  const completedAt = new Date().toISOString();
  return {
    status: classification.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stalled: result.stalled === true,
    startedAt,
    completedAt,
    sessionId: parsed?.session_id ?? null,
    result: parsed?.result ?? result.stdout.trim(),
    isError: classification.isError,
    pendingApproval: classification.pendingApproval,
    expectedModel: request.expectedModel ?? null,
    modelsUsed,
    verificationError: classification.verificationError,
    totalCostUsd: parsed?.total_cost_usd ?? null,
    durationMs: parsed?.duration_ms ?? null,
    stderr: result.stderr.trim() || null
  };
}
