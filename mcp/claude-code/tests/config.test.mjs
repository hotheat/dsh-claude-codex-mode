import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseDotEnv, resolveClaudeEnvironment, resolveSettingsFile } from "../lib/config.mjs";

test("resolveSettingsFile expands a home-relative path", () => {
  assert.equal(
    resolveSettingsFile("~/.claude/settings.json.custom"),
    path.join(os.homedir(), ".claude", "settings.json.custom")
  );
});

test("resolveSettingsFile ignores the legacy Kimi settings file by default", () => {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-standard-home-"));
  fs.mkdirSync(path.join(homeDirectory, ".claude"));
  fs.writeFileSync(path.join(homeDirectory, ".claude", "settings.json.kimi"), "{}");
  assert.equal(
    resolveSettingsFile(undefined, { processEnv: {}, homeDirectory }),
    path.join(homeDirectory, ".claude", "settings.json")
  );
});

test("resolveSettingsFile falls back to the standard Claude settings", () => {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-standard-home-"));
  assert.equal(
    resolveSettingsFile(undefined, { processEnv: {}, homeDirectory }),
    path.join(homeDirectory, ".claude", "settings.json")
  );
});

test("resolveSettingsFile allows an environment override", () => {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-env-home-"));
  assert.equal(
    resolveSettingsFile(undefined, {
      processEnv: { CODEX_CLAUDE_CODE_SETTINGS_FILE: "~/.claude/settings.json.custom" },
      homeDirectory
    }),
    path.join(homeDirectory, ".claude", "settings.json.custom")
  );
});

test("parseDotEnv handles exports, quotes, escapes, and comments", () => {
  assert.deepEqual(
    parseDotEnv([
      "export ANTHROPIC_AUTH_TOKEN='token # literal'",
      "ANTHROPIC_BASE_URL=https://example.test # comment",
      'CLAUDE_CODE_NOTE="line\\nnext"'
    ].join("\n")),
    {
      ANTHROPIC_AUTH_TOKEN: "token # literal",
      ANTHROPIC_BASE_URL: "https://example.test",
      CLAUDE_CODE_NOTE: "line\nnext"
    }
  );
});

test("process environment overrides .env, which overrides Claude settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-config-"));
  const project = path.join(root, "project");
  const nested = path.join(project, "src");
  const settingsFile = path.join(root, "settings.json");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(project, ".env"), [
    "ANTHROPIC_AUTH_TOKEN=dotenv-token",
    "ANTHROPIC_BASE_URL=https://dotenv.test",
    "ANTHROPIC_DEFAULT_SONNET_MODEL=dotenv-sonnet",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
  ].join("\n"));
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: "settings-token",
      ANTHROPIC_BASE_URL: "https://settings.test",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "settings-haiku",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "settings-opus"
    }
  }));

  const result = resolveClaudeEnvironment({
    cwd: nested,
    settingsFile,
    processEnv: { ANTHROPIC_BASE_URL: "https://process.test", PATH: "/bin" }
  });

  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, "dotenv-token");
  assert.equal(result.env.ANTHROPIC_BASE_URL, "https://process.test");
  assert.equal(result.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "settings-haiku");
  assert.equal(result.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "settings-opus");
  assert.equal(result.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "dotenv-sonnet");
  assert.equal(result.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(result.envFile, path.join(project, ".env"));
  assert.deepEqual(result.sources, {
    ANTHROPIC_AUTH_TOKEN: ".env",
    ANTHROPIC_BASE_URL: "process",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "settings",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "settings",
    ANTHROPIC_DEFAULT_SONNET_MODEL: ".env",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: ".env"
  });
});

test("settings environment policy isolates provider variables from the caller", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-isolated-config-"));
  const settingsFile = path.join(root, "settings.json");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".env"), [
    "ANTHROPIC_AUTH_TOKEN=dotenv-token",
    "ANTHROPIC_BASE_URL=https://dotenv.test",
    "CLAUDE_CODE_USE_BEDROCK=1"
  ].join("\n"));
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      CLAUDE_CODE_EFFORT_LEVEL: "max"
    }
  }));

  const result = resolveClaudeEnvironment({
    cwd: root,
    settingsFile,
    environmentPolicy: "settings",
    processEnv: {
      ANTHROPIC_AUTH_TOKEN: "process-token",
      ANTHROPIC_BASE_URL: "https://process.test",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2",
      CLAUDE_CODE_CLI_PATH: "/tmp/fake-claude",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      PATH: "/bin"
    }
  });

  assert.equal(result.environmentPolicy, "settings");
  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(result.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(result.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-4-6");
  assert.equal(result.env.CLAUDE_CODE_EFFORT_LEVEL, "max");
  assert.equal(result.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(result.env.CLAUDE_CODE_CLI_PATH, "/tmp/fake-claude");
  assert.deepEqual(result.sources, {
    ANTHROPIC_DEFAULT_OPUS_MODEL: "settings",
    CLAUDE_CODE_CLI_PATH: "process",
    CLAUDE_CODE_EFFORT_LEVEL: "settings"
  });
});

test("resolveClaudeEnvironment rejects an unknown environment policy", () => {
  assert.throws(
    () => resolveClaudeEnvironment({ cwd: "/tmp", environmentPolicy: "unsafe" }),
    /Unsupported environment policy/
  );
});
