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

  const mode = request.mode ?? "task";
  if (!new Set(["task", "review"]).has(mode)) {
    throw new Error(`Unsupported run mode: ${mode}`);
  }
  const prompt = mode === "review"
    ? [
        "Review the requested scope in read-only mode. Do not modify files or repository state.",
        "Report concrete findings with file paths and line numbers, ordered by severity.",
        "",
        request.prompt.trim()
      ].join("\n")
    : request.prompt.trim();

  const args = ["--print", "--output-format", "json", "--prompt-suggestions", "false"];
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  if (mode === "review") {
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
  if (mode !== "review" && request.mcpConfigFile) args.push("--mcp-config", request.mcpConfigFile);
  if (mode !== "review" && request.strictMcpConfig) args.push("--strict-mcp-config");
  if (request.maxBudgetUsd != null) args.push("--max-budget-usd", String(request.maxBudgetUsd));
  if (mode !== "review") {
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

function parseClaudeOutput(stdout) {
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      emitActivity({ stream: "stdout", summary: String(chunk).slice(-500) });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      emitActivity({ stream: "stderr", summary: String(chunk).slice(-500) });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start Claude CLI (${executable}): ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      Promise.resolve(termination).then(() => {
        resolve({ exitCode, signal, stdout, stderr, timedOut });
      }, reject);
    });
  });

  const parsed = parseClaudeOutput(result.stdout);
  const hasValidOutput = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const modelsUsed = reportedModels(parsed);
  const classification = classifyClaudeResult(
    result,
    parsed,
    hasValidOutput,
    request.mode ?? "task",
    request.expectedModel
  );
  const completedAt = new Date().toISOString();
  return {
    status: classification.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
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
