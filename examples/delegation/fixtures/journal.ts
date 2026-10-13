// ------------------------------------------------------------------------------------------------
//                journal.ts - Independent durable invocation and crash-barrier evidence
// ------------------------------------------------------------------------------------------------

import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export async function temporaryRoot() {
  const override = process.env.AGENT_SDK_DURABLE_TEST_ROOT;
  if (override && (!isAbsolute(override) || Buffer.byteLength(override) > 4_096)) throw new Error("The explicit durable test root must be a bounded absolute path.");
  const requested = override ?? join(process.cwd(), ".agent");
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const base = await realpath(requested);
  const filesystem = await statfs(base);
  if (filesystem.type !== 0xEF53) throw new Error("Durable qualification requires the inspected persistent local filesystem (0xEF53).");
  const root = await mkdtemp(join(base, "ms005-"));
  await mkdir(join(root, "database"), { mode: 0o700 });
  return { root, tuple: { node: process.version, sqlite: process.versions.sqlite, filesystem: `0x${filesystem.type.toString(16)}` },
    remove: () => rm(root, { recursive: true, force: true }) };
}

export function persistJson(root: string, name: string, value: unknown) {
  const file = openSync(join(root, name), "w", 0o600);
  try { writeSync(file, JSON.stringify(value)); fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(root, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function readJson<Value>(root: string, name: string): Value {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as Value;
}

export function recordInvocation(root: string, actor: "child" | "parent" | "answer") {
  const file = openSync(join(root, `${actor}-invocations.log`), "a", 0o600);
  try { writeSync(file, "invoked\n"); fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(root, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function invocationCount(root: string, actor: "child" | "parent" | "answer") {
  try { return readFileSync(join(root, `${actor}-invocations.log`), "utf8").trim().split("\n").length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

export async function barrier(event: string, detail?: unknown): Promise<void> {
  if (!process.send) throw new Error("Crash qualification requires a separate IPC process.");
  process.send({ event, ...(detail === undefined ? {} : { detail }) });
  await new Promise<void>((resolve) => {
    process.on("message", function resume(message: unknown) {
      if (message === `continue:${event}`) { process.off("message", resume); resolve(); }
    });
  });
}
