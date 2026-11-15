// ------------------------------------------------------------------------------------------------
// native-server.mjs - A process fixture at the `opencode serve --stdio` launch contract - Node.js stdlib
// ------------------------------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.FIXTURE_MODE;
writeFileSync(process.env.FIXTURE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
if (mode === "exit") process.exit(3);
if (mode === "descendant") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  writeFileSync(`${process.env.FIXTURE_RECORD}.child`, String(child.pid));
}
process.stdout.write(mode === "foreign" ? '{"url":"http://0.0.0.0:4096"}\n' : '{"url":"http://127.0.0.1:4096"}\n');
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
