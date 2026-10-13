// ------------------------------------------------------------------------------------------------
//                process.ts - Bounded separate-process barriers and abrupt termination
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ScenarioMessage {
  readonly event: string;
  readonly detail?: unknown;
}

export function startScenario(root: string, mode: string, options: Record<string, unknown> = {}, entrypoint = new URL("./scenario.ts", import.meta.url)) {
  const child = fork(fileURLToPath(entrypoint), [root, mode, JSON.stringify(options)], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced",
  });
  let diagnostics = "";
  child.stdout?.on("data", (data: Buffer) => { diagnostics += data.toString(); });
  child.stderr?.on("data", (data: Buffer) => { diagnostics += data.toString(); });
  const messages: ScenarioMessage[] = [];
  const listeners = new Set<() => void>();
  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => {
    exited = true;
    resolve({ code, signal });
    for (const listener of listeners) listener();
  }));
  child.on("message", (message: ScenarioMessage) => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  async function wait(event: string): Promise<ScenarioMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`Timed out at ${mode}/${event}: ${diagnostics}`)); }, 10_000);
      function finish(error?: Error, message?: ScenarioMessage) {
        clearTimeout(timer);
        listeners.delete(check);
        if (error) reject(error); else resolve(message!);
      }
      function check() {
        const failure = messages.find((message) => message.event === "error");
        const found = messages.find((message) => message.event === event);
        if (failure) finish(new Error(`${mode}: ${JSON.stringify(failure.detail)}\n${diagnostics}`));
        else if (found) finish(undefined, found);
        else if (exited) finish(new Error(`${mode} exited before ${event}: ${diagnostics}`));
      }
      listeners.add(check);
      check();
    });
  }
  return { child, wait, async kill() {
    if (!exited) child.kill("SIGKILL");
    const result = await exit;
    assert.equal(result.signal, "SIGKILL", diagnostics);
  }, async complete() {
    await wait("complete");
    const result = await exit;
    assert.equal(result.code, 0, diagnostics);
    return messages.find((message) => message.event === "complete")!.detail;
  }, async stop() {
    if (!exited) { child.kill("SIGKILL"); await exit; }
  } };
}
