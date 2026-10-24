// ------------------------------------------------------------------------------------------------
//                runner.test.mjs - Real lane environment and installed-set admission
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../check-agent-sdk-sandbox-consumer.mjs", import.meta.url));

test("the selected real packed lane rejects missing infrastructure before packaging or execution", () => {
  const env = { ...process.env };
  delete env.AGENAI_SANDBOX_TEST_ENGINE;
  delete env.AGENAI_SANDBOX_TEST_MANIFEST;
  delete env.AGENAI_SANDBOX_TEST_OUTPUT;
  for (const [values, expected] of [
    [{}, /Explicit local AGENAI_SANDBOX_TEST_ENGINE/u],
    [{ AGENAI_SANDBOX_TEST_ENGINE: "unix:///missing-engine.sock" }, /Absolute AGENAI_SANDBOX_TEST_MANIFEST/u],
    [{ AGENAI_SANDBOX_TEST_ENGINE: "unix:///missing-engine.sock", AGENAI_SANDBOX_TEST_MANIFEST: "/missing-manifest.json" }, /Absolute AGENAI_SANDBOX_TEST_OUTPUT/u],
  ]) {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...env, ...values }, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, "");
  }
});

test("real packed lane rejects ambiguous consumer selection before reading infrastructure", () => {
  for (const args of [["--consumer"], ["--consumer", "relative"], ["--unknown", "/tmp/consumer"], ["--consumer", "/tmp/one", "--consumer", "/tmp/two"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: test:agent-sdk-sandbox-consumer/u);
  }
});

test("installed selection rejects an incomplete SDK set without changing the selected directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-installed-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "consumer"));
  const manifest = `${JSON.stringify({ dependencies: { "@agen-ai/sandbox": "file:/tmp/sandbox.tgz" } })}\n`;
  await writeFile(path.join(root, "consumer/package.json"), manifest);
  const result = spawnSync(process.execPath, [script, "--consumer", path.join(root, "consumer")], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, AGENAI_SANDBOX_TEST_ENGINE: "unix:///not-entered.sock", AGENAI_SANDBOX_TEST_MANIFEST: "/not-read.json", AGENAI_SANDBOX_TEST_OUTPUT: "/not-created" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /complete matching ten-package SDK set/u);
  assert.equal(await readFile(path.join(root, "consumer/package.json"), "utf8"), manifest);
});
