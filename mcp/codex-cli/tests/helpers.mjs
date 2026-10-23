import fs from "node:fs";
import path from "node:path";

// Fake Codex CLI: echoes argv, stdin, and cwd back through the final agent message.
export function createFakeCodex(root, { body = "" } = {}) {
  const executable = path.join(root, "fake-codex.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("codex-cli 0.162.1"); process.exit(0); }
if (argv[0] === "login") { console.log("Logged in using an API key - sk-proj-***SECRET"); process.exit(0); }
const emit = (event) => console.log(JSON.stringify(event));
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
${body}
emit({ type: "thread.started", thread_id: "thread-123" });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { id: "i0", type: "error", message: "ignored config key" } });
emit({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", exit_code: 0, status: "completed" } });
emit({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: "a.txt", kind: "update" }], status: "completed" } });
emit({ type: "item.completed", item: { id: "i3", type: "agent_message", text: JSON.stringify({ argv, stdin, cwd: process.cwd() }) } });
emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

export function tempRoot(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), prefix)));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}
