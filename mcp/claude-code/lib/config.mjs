import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];
export const SETTINGS_FILE_ENV = "CODEX_CLAUDE_CODE_SETTINGS_FILE";
export const DEFAULT_SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");
export const ENVIRONMENT_POLICIES = new Set(["inherit", "settings"]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeEnv(input, label) {
  if (input == null) {
    return {};
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function decodeDoubleQuoted(value, lineNumber) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    index += 1;
    if (index >= value.length) {
      throw new Error(`Invalid trailing escape on .env line ${lineNumber}.`);
    }
    const escaped = value[index];
    output += ({ n: "\n", r: "\r", t: "\t" })[escaped] ?? escaped;
  }
  return output;
}

function parseValue(rawValue, lineNumber) {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    let closingIndex = -1;
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === quote && (quote === "'" || value[index - 1] !== "\\")) {
        closingIndex = index;
        break;
      }
    }
    if (closingIndex === -1) {
      throw new Error(`Unterminated quoted value on .env line ${lineNumber}.`);
    }
    const trailing = value.slice(closingIndex + 1).trim();
    if (trailing && !trailing.startsWith("#")) {
      throw new Error(`Unexpected content after quoted value on .env line ${lineNumber}.`);
    }
    const quotedValue = value.slice(1, closingIndex);
    return quote === '"' ? decodeDoubleQuoted(quotedValue, lineNumber) : quotedValue;
  }
  return value.replace(/\s+#.*$/, "").trimEnd();
}

export function parseDotEnv(contents) {
  const result = {};
  const lines = String(contents).replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      throw new Error(`Invalid assignment on .env line ${lineNumber}.`);
    }
    result[match[1]] = parseValue(match[2], lineNumber);
  }
  return result;
}

function findGitRoot(startDirectory) {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveEnvFile(cwd, explicitEnvFile) {
  if (explicitEnvFile) {
    const resolved = path.resolve(cwd, explicitEnvFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Environment file does not exist: ${resolved}`);
    }
    return resolved;
  }

  const start = path.resolve(cwd);
  const gitRoot = findGitRoot(start);
  const boundary = gitRoot ?? start;
  let current = start;
  while (true) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (current === boundary) {
      return null;
    }
    current = path.dirname(current);
  }
}

export function loadSettingsEnv(settingsFile = DEFAULT_SETTINGS_FILE) {
  if (!fs.existsSync(settingsFile)) {
    return { settingsFile, env: {} };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse Claude settings at ${settingsFile}: ${error.message}`);
  }
  return { settingsFile, env: normalizeEnv(settings?.env, `${settingsFile} env`) };
}

export function resolveSettingsFile(
  settingsFile,
  { processEnv = process.env, homeDirectory = os.homedir() } = {}
) {
  const configuredFile = settingsFile || processEnv[SETTINGS_FILE_ENV];
  if (!configuredFile) {
    return path.join(homeDirectory, ".claude", "settings.json");
  }
  if (configuredFile === "~") {
    return homeDirectory;
  }
  if (configuredFile.startsWith("~/")) {
    return path.join(homeDirectory, configuredFile.slice(2));
  }
  return path.resolve(configuredFile);
}

function shouldReportKey(key) {
  return CLAUDE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isProviderRoutingEnvironmentKey(key) {
  return key.startsWith("ANTHROPIC_")
    || (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_CLI_PATH");
}

export function resolveClaudeEnvironment({
  cwd,
  envFile,
  environmentPolicy = "inherit",
  processEnv = process.env,
  settingsFile
}) {
  if (!ENVIRONMENT_POLICIES.has(environmentPolicy)) {
    throw new Error(`Unsupported environment policy: ${environmentPolicy}`);
  }
  const resolvedCwd = path.resolve(cwd);
  const settings = loadSettingsEnv(resolveSettingsFile(settingsFile, { processEnv }));
  const resolvedEnvFile = resolveEnvFile(resolvedCwd, envFile);
  const dotenvEnv = resolvedEnvFile
    ? parseDotEnv(fs.readFileSync(resolvedEnvFile, "utf8"))
    : {};
  const runtimeEnv = normalizeEnv(processEnv, "process environment");
  const env = { ...settings.env, ...dotenvEnv, ...runtimeEnv };
  if (environmentPolicy === "settings") {
    for (const key of Object.keys(env)) {
      if (isProviderRoutingEnvironmentKey(key) && !hasOwn(settings.env, key)) {
        delete env[key];
      }
    }
    for (const [key, value] of Object.entries(settings.env)) {
      if (isProviderRoutingEnvironmentKey(key)) {
        env[key] = value;
      }
    }
  }

  const configuredKeys = new Set([
    ...Object.keys(settings.env),
    ...Object.keys(dotenvEnv),
    ...Object.keys(runtimeEnv).filter(shouldReportKey)
  ]);
  const sources = {};
  for (const key of [...configuredKeys].sort()) {
    if (!shouldReportKey(key) || !hasOwn(env, key)) {
      continue;
    }
    if (environmentPolicy === "settings" && isProviderRoutingEnvironmentKey(key) && hasOwn(settings.env, key)) {
      sources[key] = "settings";
    } else if (hasOwn(runtimeEnv, key)) {
      sources[key] = "process";
    } else if (hasOwn(dotenvEnv, key)) {
      sources[key] = ".env";
    } else if (hasOwn(settings.env, key)) {
      sources[key] = "settings";
    }
  }

  return {
    cwd: resolvedCwd,
    env,
    envFile: resolvedEnvFile,
    environmentPolicy,
    settingsFile: settings.settingsFile,
    sources
  };
}
