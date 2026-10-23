import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJob, listJobs, publicJob, readJob, updateJob } from "../lib/jobs.mjs";

test("jobs persist with private files and public summaries", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "codex-jobs-"));
  const previous = process.env.CODEX_CLI_PLUGIN_STATE_DIR;
  process.env.CODEX_CLI_PLUGIN_STATE_DIR = state;
  try {
    const job = createJob({ cwd: state, prompt: "Implement the requested change" });
    assert.match(job.jobId, /^codex-[a-f0-9-]+$/);
    assert.equal(fs.statSync(path.join(state, `${job.jobId}.json`)).mode & 0o777, 0o600);
    updateJob(job.jobId, (record) => ({ ...record, status: "completed", outcome: { result: "done", sessionId: "s1", worktreePath: "/wt" } }));
    assert.equal(listJobs(state).length, 1);
    const summary = publicJob(readJob(job.jobId));
    assert.equal(summary.outcome, undefined);
    assert.equal(summary.sessionId, "s1");
    assert.equal(summary.worktreePath, "/wt");
    assert.equal(publicJob(readJob(job.jobId), true).outcome.result, "done");

    const review = createJob({ cwd: state, kind: "review", target: "base", baseBranch: "main" });
    assert.equal(review.summary, "review base main");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_PLUGIN_STATE_DIR;
    else process.env.CODEX_CLI_PLUGIN_STATE_DIR = previous;
  }
});

test("jobs reject path-like IDs", () => {
  assert.throws(() => readJob("../../secret"), /Invalid job ID/);
});
