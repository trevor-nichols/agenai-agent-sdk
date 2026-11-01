import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const block = workflow.match(/      - name: Verify all package publications\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/u);
assert.ok(block, "workflow must contain the complete publication verification command");
const verificationCommand = block[1].split("\n").map((line) => line.slice(10)).join("\n");

async function runVerification(t, fail) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenai-publication-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"));
  await mkdir(path.join(root, "bin"));
  const archives = Array.from({ length: 10 }, (_, index) => `release/package-${index}.tgz`);
  for (const archive of archives) await writeFile(path.join(root, archive), "admitted fixture");
  await writeFile(path.join(root, "bin/node"), '#!/bin/sh\nexec "$ACTUAL_NODE" "$RECORDER" "$@"\n', { mode: 0o755 });
  const recorder = path.join(root, "recorder.mjs");
  await writeFile(recorder, `
    import { appendFile, readFile } from 'node:fs/promises';
    const args = process.argv.slice(2);
    const archive = args[args.indexOf('--tarball') + 1];
    await appendFile('events.jsonl', JSON.stringify({ kind: 'start', archive, args }) + '\\n');
    // Hold the first batch until all three real subprocesses have entered.
    if (Number(archive.match(/package-(\\d+)/)[1]) < 3) {
      while ((await readFile('events.jsonl', 'utf8')).trim().split('\\n').map(JSON.parse).filter(e => e.kind === 'start').length < 3) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    await appendFile('events.jsonl', JSON.stringify({ kind: 'end', archive }) + '\\n');
    if (process.env.FAIL === 'yes' && archive.endsWith('package-0.tgz')) process.exitCode = 1;
  `);
  let exitCode = 0;
  try {
    await execFileAsync("bash", ["-c", verificationCommand], {
      cwd: root,
      timeout: 10_000,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ACTUAL_NODE: process.execPath,
        RECORDER: recorder, NPM_TAG: "beta", RELEASE_REF: "refs/tags/v0.4.9",
        RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567", FAIL: fail ? "yes" : "no" },
    });
  } catch (error) {
    if (error.code !== 1) throw error;
    exitCode = error.code;
  }
  const events = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const active = new Set();
  let peak = 0;
  for (const event of events) {
    if (event.kind === "start") {
      active.add(event.archive);
      peak = Math.max(peak, active.size);
    } else assert.ok(active.delete(event.archive));
  }
  assert.equal(peak, 3);
  assert.equal(active.size, 0, "workflow must join all entered checks before exiting");
  return { exitCode, events, archives };
}

test("publication workflow verifies all ten archives with at most three concurrent checks", async (t) => {
  const { exitCode, events, archives } = await runVerification(t, false);
  assert.equal(exitCode, 0);
  const starts = events.filter((event) => event.kind === "start");
  assert.deepEqual(starts.map((event) => event.archive).sort(), archives);
  for (const { archive, args } of starts) {
    assert.deepEqual(args, ["scripts/release/verify-package-publication.mjs", "--tarball", archive,
      "--npm-tag", "beta", "--release-ref", "refs/tags/v0.4.9", "--release-sha",
      "0123456789abcdef0123456789abcdef01234567", "--require-present", "--attempts", "90", "--delay-ms", "10000"]);
  }
});

test("publication workflow fails a rejected batch after joining every entered verifier", async (t) => {
  const { exitCode, events } = await runVerification(t, true);
  assert.equal(exitCode, 1);
  assert.equal(events.filter((event) => event.kind === "start").length, 3);
  assert.equal(events.filter((event) => event.kind === "end").length, 3);
});
