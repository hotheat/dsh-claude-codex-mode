import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { isProcessGroupAlive, terminateProcessGroup } from "../lib/process-tree.mjs";

async function until(check) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.fail("process fixture did not become ready");
}

function fixture(t, body) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-group-"));
  const parent = spawn(process.execPath, ["-e", `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
${body}
fs.writeFileSync('ready', '');
setInterval(() => {}, 1000);
`], { cwd, detached: true, stdio: "ignore" });
  const exists = name => fs.existsSync(path.join(cwd, name));
  const read = name => fs.readFileSync(path.join(cwd, name), "utf8");
  t.after(() => {
    const pids = [parent.pid, ...(exists("child.pid") ? [Number(read("child.pid"))] : [])];
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { parent, exists, read };
}

test("SIGINT lets the parent tear down its detached sandbox child", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t, `
const child = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('child-ready', ''); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
process.once('SIGINT', () => {
  child.once('exit', () => process.kill(process.pid, 'SIGINT'));
  child.kill('SIGTERM');
});
fs.writeFileSync('child.pid', String(child.pid));
`);
  await until(() => f.exists("ready") && f.exists("child-ready"));
  const childPid = Number(f.read("child.pid"));
  assert.equal(isProcessGroupAlive(childPid), true, "child has its own process group");
  const exited = once(f.parent, "exit");
  await terminateProcessGroup(f.parent.pid);
  assert.equal((await exited)[1], "SIGINT");
  assert.equal(isProcessGroupAlive(f.parent.pid), false);
  for (const pid of [f.parent.pid, childPid]) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

for (const ignoreTerm of [false, true]) {
  const expectedSignal = ignoreTerm ? "SIGKILL" : "SIGTERM";
  test(`termination escalates to ${expectedSignal} when earlier signals are ignored`, { skip: process.platform === "win32" }, async t => {
    const f = fixture(t, `
process.on('SIGINT', () => fs.appendFileSync('signals', 'SIGINT\\n'));
${ignoreTerm ? "process.on('SIGTERM', () => fs.appendFileSync('signals', 'SIGTERM\\n'));" : ""}
`);
    await until(() => f.exists("ready"));
    const exited = once(f.parent, "exit");
    await terminateProcessGroup(f.parent.pid, { graceMs: 100 });
    assert.equal((await exited)[1], expectedSignal);
    assert.equal(f.read("signals"), ignoreTerm ? "SIGINT\nSIGTERM\n" : "SIGINT\n");
    assert.equal(isProcessGroupAlive(f.parent.pid), false);
    assert.throws(() => process.kill(f.parent.pid, 0), { code: "ESRCH" });
  });
}
