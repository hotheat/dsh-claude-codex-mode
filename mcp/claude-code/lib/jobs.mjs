import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessGroupAlive, terminateProcessGroup } from "./process-tree.mjs";

const TERMINAL_STATUSES = new Set(["completed", "completed_with_blockers", "failed", "canceled"]);
const ACTIVE_STATUSES = new Set(["queued", "running", "canceling"]);
const DEFAULT_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function jobsDirectory() {
  return process.env.CODEX_CLAUDE_CODE_STATE_DIR
    ? path.resolve(process.env.CODEX_CLAUDE_CODE_STATE_DIR)
    : path.join(os.homedir(), ".codex", "claude-code-plugin", "jobs");
}

function ensureJobsDirectory() {
  fs.mkdirSync(jobsDirectory(), { recursive: true, mode: 0o700 });
}

function jobPath(jobId) {
  if (!/^claude-[a-f0-9-]+$/.test(jobId)) {
    throw new Error(`Invalid job ID: ${jobId}`);
  }
  return path.join(jobsDirectory(), `${jobId}.json`);
}

function atomicWrite(file, value) {
  ensureJobsDirectory();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function createJob(request) {
  const jobId = `claude-${crypto.randomUUID()}`;
  const record = {
    jobId,
    status: "queued",
    phase: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    cwd: path.resolve(request.cwd),
    summary: request.prompt.trim().replace(/\s+/g, " ").slice(0, 160),
    modifiedFiles: [],
    request
  };
  atomicWrite(jobPath(jobId), record);
  return record;
}

export function readJob(jobId) {
  const file = jobPath(jobId);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown job ID: ${jobId}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function updateJob(jobId, updater) {
  const current = readJob(jobId);
  const next = {
    ...updater(current),
    updatedAt: new Date().toISOString()
  };
  atomicWrite(jobPath(jobId), next);
  return next;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function refreshStaleJob(record) {
  if (record.status !== "running" || isProcessAlive(record.pid)) {
    return record;
  }
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

export function cleanupExpiredJobs(ttlMs = Number(process.env.CODEX_CLAUDE_CODE_JOB_TTL_MS ?? DEFAULT_JOB_TTL_MS)) {
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
      // Leave unreadable files in place so an operator can inspect them.
    }
  }
  return { removed };
}

export function countActiveJobs(cwd) {
  return listJobs(cwd).filter((record) => ACTIVE_STATUSES.has(record.status)).length;
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

export function publicJob(record, includeResult = false) {
  const output = {
    jobId: record.jobId,
    status: record.status,
    cwd: record.cwd,
    summary: record.summary,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    sessionId: record.outcome?.sessionId ?? null
  };
  output.phase = record.phase ?? record.status;
  output.lastActivityAt = record.lastActivityAt ?? record.updatedAt;
  output.recentToolCall = record.recentToolCall ?? null;
  output.recentOutputSummary = record.recentOutputSummary ?? null;
  output.modifiedFiles = record.modifiedFiles ?? [];
  output.pendingApproval = record.pendingApproval ?? record.outcome?.pendingApproval ?? null;
  if (includeResult) {
    output.outcome = record.outcome ?? null;
    output.error = record.error ?? null;
  }
  return output;
}

export async function cancelJob(jobId) {
  const record = readJob(jobId);
  if (TERMINAL_STATUSES.has(record.status)) {
    return record;
  }
  if (record.status === "needs_approval") {
    return updateJob(jobId, (current) => ({
      ...current,
      status: "canceled",
      phase: "canceled",
      pid: null,
      claudePid: null,
      completedAt: new Date().toISOString()
    }));
  }

  updateJob(jobId, (current) => ({
    ...current,
    status: "canceling",
    phase: "canceling",
    completedAt: null
  }));
  try {
    if (record.claudePid && isProcessGroupAlive(record.claudePid)) {
      await terminateProcessGroup(record.claudePid);
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
    completedAt: new Date().toISOString()
  }));
}

export function rejectApproval(jobId, reason = "Approval rejected.") {
  const record = readJob(jobId);
  if (record.status !== "needs_approval") {
    throw new Error(`Job ${jobId} is not waiting for approval.`);
  }
  return updateJob(jobId, (current) => ({
    ...current,
    status: "canceled",
    phase: "canceled",
    completedAt: new Date().toISOString(),
    error: reason
  }));
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}
