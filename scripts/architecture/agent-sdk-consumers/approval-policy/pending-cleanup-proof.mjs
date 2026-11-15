import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function runPendingCleanupProof({ consumerRoot, fixtureRoot, permissions, exampleRoot }) {
  const results = [];
  for (const signal of ["SIGUSR2", "SIGINT", "SIGTERM"]) {
    const directory = path.join(fixtureRoot, `pending-${signal.toLowerCase()}`);
    await mkdir(directory, { mode: 0o700 });
    const marker = path.join(directory, "marker.txt");
    await writeFile(marker, "pending-cleanup\n", { flag: "wx" });
    const child = spawn(process.execPath, [...permissions, `${exampleRoot}/native/tests/pending-cleanup-child.js`, directory],
      { cwd: consumerRoot, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let exited = false;
    const completion = new Promise((resolve) => {
      child.once("close", (code, exitSignal) => { exited = true; resolve({ code, signal: exitSignal }); });
      child.once("error", (error) => { exited = true; resolve({ error }); });
    });
    let resolvePending;
    let rejectPending;
    const pending = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
    let buffer = "";
    let outputBytes = 0;
    let outputFailure;
    const reports = [];
    const failOutput = (error) => { outputFailure ??= error; rejectPending(error); };
    const receive = (chunk, stdout) => {
      outputBytes += chunk.length;
      if (outputBytes > 65536) { failOutput(new Error("Pending-cleanup fixture exceeded its output bound.")); return; }
      if (!stdout) return;
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const report = JSON.parse(line);
          reports.push(report);
          if (reports.length > 8) throw new Error("Too many pending-cleanup fixture reports.");
          if (report.status === "cleanup_pending") resolvePending(report);
        } catch (error) { failOutput(error); }
      }
    };
    child.stdout.on("data", (chunk) => receive(chunk, true));
    child.stderr.on("data", (chunk) => receive(chunk, false));
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Pending-cleanup fixture timed out.")), 15000); });
    try {
      const report = await Promise.race([pending, deadline, completion.then(() => { throw new Error("Cleanup owner exited before publishing its pending state."); })]);
      assert.equal(report.processPID, child.pid);
      assert.deepEqual(report.cleanupRetrySignals, ["SIGUSR2", "SIGINT", "SIGTERM"]);
      assert.equal(report.cleanupRetryInstruction, `kill -USR2 ${child.pid}`);
      assert.equal(report.cleanup.settled, false);
      // An unsettled Promise or a signal listener alone does not retain a Node process after stdin EOF.
      await delay(100);
      if (outputFailure) throw outputFailure;
      assert.equal(exited, false, "The original cleanup process must remain alive without automatic retries.");
      assert.equal(await readFile(marker, "utf8"), "pending-cleanup\n");
      assert.equal(child.kill(signal), true);
      const finished = await Promise.race([completion, deadline]);
      if (outputFailure) throw outputFailure;
      assert.deepEqual(finished, { code: 1, signal: null });
      assert.equal(reports.at(-1)?.cleanup.settled, true);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      results.push({ signal, stdin: "closed", beforeRetry: "alive_with_owned_marker", cleanup: "marker_removed", exitCode: 1 });
    } finally {
      clearTimeout(timer);
      if (!exited) child.kill("SIGKILL");
      await completion;
      await rm(directory, { recursive: true, force: true });
    }
  }
  return { scope: "credentialless original cleanup controller process; no native admission", cases: results };
}
