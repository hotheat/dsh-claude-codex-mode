#!/usr/bin/env node

import { runCodex } from "./lib/codex-runner.mjs";
import { isTerminalStatus, readJob, updateJob } from "./lib/jobs.mjs";
import { terminateProcessGroup } from "./lib/process-tree.mjs";

const jobId = process.argv[2];
let activeCodexPid = null;
let stopping = false;

async function stopWorker() {
  if (stopping) return;
  stopping = true;
  if (activeCodexPid) await terminateProcessGroup(activeCodexPid);
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
      const outcome = await runCodex(current.request, {
        onSpawn(codexPid) {
          activeCodexPid = codexPid;
          updateJob(jobId, (record) => ({
            ...record,
            phase: "running",
            codexPid,
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
      activeCodexPid = null;
      updateJob(jobId, (record) => isTerminalStatus(record.status) ? record : ({
        ...record,
        status: outcome.status,
        phase: outcome.status,
        pid: null,
        codexPid: null,
        completedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
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
        codexPid: null,
        completedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        error: error.stack || error.message
      }));
    } catch {
      // The MCP caller will mark a stale worker as failed.
    }
    process.exitCode = 1;
  }
}
