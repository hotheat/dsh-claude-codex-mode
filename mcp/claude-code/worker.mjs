#!/usr/bin/env node

import { runClaude } from "./lib/claude-runner.mjs";
import { isTerminalStatus, readJob, updateJob } from "./lib/jobs.mjs";
import { terminateProcessGroup } from "./lib/process-tree.mjs";

const jobId = process.argv[2];
let activeClaudePid = null;
let stopping = false;

async function stopWorker() {
  if (stopping) return;
  stopping = true;
  if (activeClaudePid) await terminateProcessGroup(activeClaudePid);
  process.exit(143);
}

process.on("SIGTERM", () => { void stopWorker(); });
process.on("SIGINT", () => { void stopWorker(); });

if (!jobId) {
  process.exitCode = 2;
} else {
  try {
    const current = readJob(jobId);
    if (!isTerminalStatus(current.status)) {
      updateJob(jobId, (record) => ({
        ...record,
        status: "running",
        phase: "starting",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      }));
      const outcome = await runClaude(current.request, {
        onSpawn(claudePid) {
          activeClaudePid = claudePid;
          updateJob(jobId, (record) => ({
            ...record,
            phase: "running",
            claudePid,
            recentToolCall: "claude",
            lastActivityAt: new Date().toISOString()
          }));
        },
        onActivity(activity) {
          updateJob(jobId, (record) => ({
            ...record,
            phase: "running",
            lastActivityAt: new Date().toISOString(),
            recentOutputSummary: activity.summary
          }));
        }
      });
      activeClaudePid = null;
      updateJob(jobId, (record) => isTerminalStatus(record.status) ? record : ({
        ...record,
        status: outcome.status,
        phase: outcome.status,
        pid: null,
        claudePid: null,
        completedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        pendingApproval: outcome.pendingApproval,
        outcome
      }));
    }
  } catch (error) {
    try {
      updateJob(jobId, (record) => isTerminalStatus(record.status) ? record : ({
        ...record,
        status: "failed",
        phase: "failed",
        pid: null,
        claudePid: null,
        completedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        error: error.stack || error.message
      }));
    } catch {
      // The MCP caller will detect a stale job if the state file cannot be updated.
    }
    process.exitCode = 1;
  }
}
