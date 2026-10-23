import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessGroupAlive, terminateProcessGroup } from "./process-tree.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "canceling"]);
const DEFAULT_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function jobsDirectory() {
  return process.env.CODEX_CLI_PLUGIN_STATE_DIR
    ? path.resolve(process.env.CODEX_CLI_PLUGIN_STATE_DIR)
    : path.join(os.homedir(), ".claude", "codex-cli-plugin", "jobs");
}

function ensureJobsDirectory() {
  fs.mkdirSync(jobsDirectory(), { recursive: true, mode: 0o700 });
}

function jobPath(jobId) {
  if (!/^codex-[a-f0-9-]+$/.test(jobId)) throw new Error(`Invalid job ID: ${jobId}`);
  return path.join(jobsDirectory(), `${jobId}.json`);
}

function atomicWrite(file, value) {
  ensureJobsDirectory();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function jobSummary(request) {
  const text = request.prompt?.trim() || `review ${request.target ?? "uncommitted"} ${request.baseBranch ?? request.commitSha ?? ""}`;
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

export function createJob(request) {
  const jobId = `codex-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const record = {
    jobId,
    status: "queued",
    phase: "queued",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    cwd: path.resolve(request.cwd),
    summary: jobSummary(request),
    request
  };
  atomicWrite(jobPath(jobId), record);
  return record;
}

export function readJob(jobId) {
  const file = jobPath(jobId);
  if (!fs.existsSync(file)) throw new Error(`Unknown job ID: ${jobId}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function updateJob(jobId, updater) {
  const current = readJob(jobId);
  const next = { ...updater(current), updatedAt: new Date().toISOString() };
  atomicWrite(jobPath(jobId), next);
  return next;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function refreshStaleJob(record) {
  if (record.status !== "running" || isProcessAlive(record.pid)) return record;
  return updateJob(record.jobId, (current) => ({
    ...current,
    status: "failed",
    phase: "failed",
    completedAt: new Date().toISOString(),
    error: "Background worker exited without recording a result."
  }));
}

export function readCurrentJob(jobId) {
  return refreshStaleJob(readJob(jobId));
}

export function cleanupExpiredJobs(ttlMs = Number(process.env.CODEX_CLI_PLUGIN_JOB_TTL_MS ?? DEFAULT_JOB_TTL_MS)) {
  ensureJobsDirectory();
  const maxAgeMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_JOB_TTL_MS;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of fs.readdirSync(jobsDirectory())) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(jobsDirectory(), name);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      const timestamp = Date.parse(record.completedAt ?? record.updatedAt ?? record.createdAt);
      if (TERMINAL_STATUSES.has(record.status) && Number.isFinite(timestamp) && timestamp < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      // Preserve unreadable state for operator inspection.
    }
  }
  return { removed };
}

export function listJobs(cwd) {
  ensureJobsDirectory();
  const resolvedCwd = cwd ? path.resolve(cwd) : null;
  return fs.readdirSync(jobsDirectory())
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(jobsDirectory(), name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((record) => !resolvedCwd || record.cwd === resolvedCwd)
    .map(refreshStaleJob)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function countActiveJobs(cwd) {
  return listJobs(cwd).filter((record) => ACTIVE_STATUSES.has(record.status)).length;
}

export function publicJob(record, includeResult = false) {
  const output = {
    jobId: record.jobId,
    status: record.status,
    phase: record.phase ?? record.status,
    cwd: record.cwd,
    summary: record.summary,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    lastActivityAt: record.lastActivityAt ?? record.updatedAt,
    recentOutputSummary: record.recentOutputSummary ?? null,
    sessionId: record.outcome?.sessionId ?? null,
    worktreePath: record.outcome?.worktreePath ?? null
  };
  if (includeResult) {
    output.outcome = record.outcome ?? null;
    output.error = record.error ?? null;
  }
  return output;
}

export async function cancelJob(jobId) {
  const record = readJob(jobId);
  if (TERMINAL_STATUSES.has(record.status)) return record;
  updateJob(jobId, (current) => ({ ...current, status: "canceling", phase: "canceling" }));
  try {
    if (record.codexPid && isProcessGroupAlive(record.codexPid)) {
      await terminateProcessGroup(record.codexPid);
    }
    if (record.pid && isProcessGroupAlive(record.pid)) {
      await terminateProcessGroup(record.pid);
    }
  } catch (error) {
    updateJob(jobId, (current) => ({
      ...current,
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      error: `Cancellation failed: ${error.message}`
    }));
    throw error;
  }
  return updateJob(jobId, (current) => ({
    ...current,
    status: "canceled",
    phase: "canceled",
    pid: null,
    codexPid: null,
    completedAt: new Date().toISOString()
  }));
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}
