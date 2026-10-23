import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupExpiredJobs, createJob, jobsDirectory, updateJob } from "../lib/jobs.mjs";

test("cleanupExpiredJobs removes only expired terminal jobs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-jobs-"));
  const previousStateDir = process.env.CODEX_CLAUDE_CODE_STATE_DIR;
  process.env.CODEX_CLAUDE_CODE_STATE_DIR = path.join(root, "jobs");
  try {
    const expired = createJob({ cwd: root, prompt: "Expired done" });
    const active = createJob({ cwd: root, prompt: "Still running" });
    updateJob(expired.jobId, (record) => ({
      ...record,
      status: "completed",
      completedAt: new Date(Date.now() - 10_000).toISOString()
    }));
    updateJob(active.jobId, (record) => ({
      ...record,
      status: "running",
      completedAt: new Date(Date.now() - 10_000).toISOString()
    }));

    assert.deepEqual(cleanupExpiredJobs(1000), { removed: 1 });
    assert.equal(fs.existsSync(path.join(jobsDirectory(), `${expired.jobId}.json`)), false);
    assert.equal(fs.existsSync(path.join(jobsDirectory(), `${active.jobId}.json`)), true);
  } finally {
    if (previousStateDir === undefined) delete process.env.CODEX_CLAUDE_CODE_STATE_DIR;
    else process.env.CODEX_CLAUDE_CODE_STATE_DIR = previousStateDir;
  }
});
