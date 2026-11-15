import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PUBLIC_PACKAGE_POLICIES } from "./package-inventory.mjs";

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
  const archives = Array.from({ length: 14 }, (_, index) => `release/package-${index}.tgz`);
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

test("publication workflow verifies all fourteen archives with at most three concurrent checks", async (t) => {
  const { exitCode, events, archives } = await runVerification(t, false);
  assert.equal(exitCode, 0);
  const starts = events.filter((event) => event.kind === "start");
  assert.deepEqual(starts.map((event) => event.archive).sort(), [...archives].sort());
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

test("signature audit installs every admitted package at the release version", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenai-signature-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, "scripts/release"), { recursive: true });
  await writeFile(path.join(root, "scripts/release/package-inventory.mjs"),
    await readFile(new URL("./package-inventory.mjs", import.meta.url)));
  const recorder = path.join(root, "npm.mjs");
  await writeFile(path.join(root, "bin/npm"), '#!/bin/sh\nexec "$ACTUAL_NODE" "$RECORDER" "$@"\n', { mode: 0o755 });
  await writeFile(recorder, `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    if (args[0] === 'init') writeFileSync('package.json', '{}');
    if (args[0] === 'install') {
      const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
      const requested = args.filter(arg => arg.startsWith('@')).map(spec => {
        const at = spec.lastIndexOf('@'); return [spec.slice(0, at), spec.slice(at + 1)];
      });
      appendFileSync(process.env.RECORD, JSON.stringify({ command: 'install', args,
        dependencies: { ...manifest.dependencies, ...Object.fromEntries(requested) } }) + '\\n');
    }
    if (args[0] === 'audit') appendFileSync(process.env.RECORD, JSON.stringify({ command: 'audit', args }) + '\\n');
  `);
  const block = workflow.match(/      - name: Verify registry signatures and provenance\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:|$)/u);
  assert.ok(block);
  const command = block[1].split("\n").map((line) => line.slice(10)).join("\n");
  const record = path.join(root, "events.jsonl");
  await execFileAsync("bash", ["-c", command], { cwd: root, timeout: 10_000,
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ACTUAL_NODE: process.execPath,
      RECORDER: recorder, RECORD: record, RELEASE_TAG: "v0.4.13" } });
  const [install, audit, ...extra] = (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(install.dependencies, Object.fromEntries(PUBLIC_PACKAGE_POLICIES.map(({ name }) => [name, "0.4.13"])));
  assert.ok(install.args.includes("--ignore-scripts"));
  assert.deepEqual(audit, { command: "audit", args: ["audit", "signatures"] });
  assert.deepEqual(extra, []);
});
