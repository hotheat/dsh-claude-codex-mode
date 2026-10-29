import { spawnSync } from "node:child_process";

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isProcessGroupAlive(pid) {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await delay(25);
  }
  return !isProcessGroupAlive(pid);
}

function signalPosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function terminateProcessGroup(pid, { graceMs = 1000 } = {}) {
  if (!isValidPid(pid) || !isProcessGroupAlive(pid)) return;

  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (result.error && result.error.code !== "ENOENT") throw result.error;
    if (await waitForProcessGroupExit(pid, graceMs)) return;
    throw new Error(`Process group ${pid} remained alive after taskkill.`);
  }

  // SIGINT lets Codex cancel its sandboxed command; SIGTERM alone leaves it orphaned.
  signalPosixProcessGroup(pid, "SIGINT");
  if (await waitForProcessGroupExit(pid, graceMs)) return;
  signalPosixProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, graceMs)) return;
  signalPosixProcessGroup(pid, "SIGKILL");
  if (await waitForProcessGroupExit(pid, graceMs)) return;
  throw new Error(`Process group ${pid} remained alive after SIGKILL.`);
}
