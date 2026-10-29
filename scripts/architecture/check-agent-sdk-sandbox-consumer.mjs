// ------------------------------------------------------------------------------------------------
//                check-agent-sdk-sandbox-consumer.mjs - Explicit real installed-package sandbox lane
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SDK_NAMES = ["acp-registry", "acp-transport", "agent-history", "agent-orchestration", "agent-protocol", "agent-runtime",
  "provider-acp", "sandbox", "sandbox-docker", "validation"].map((name) => `@agen-ai/${name}`);

function parseSandboxConsumerArguments(argv) {
  assert(argv.length === 0 || (argv.length === 2 && argv[0] === "--consumer" && path.isAbsolute(argv[1] ?? "")),
    "Usage: test:agent-sdk-sandbox-consumer [--consumer <absolute-retained-installed-consumer>]");
  return argv.length === 0 ? undefined : path.resolve(argv[1]);
}

function assertSandboxConsumerEnvironment(env) {
  assert(typeof env.AGENAI_SANDBOX_TEST_ENGINE === "string" && env.AGENAI_SANDBOX_TEST_ENGINE.startsWith("unix:///"),
    "Explicit local AGENAI_SANDBOX_TEST_ENGINE is required; the selected real lane never skips missing infrastructure.");
  assert(env.AGENAI_SANDBOX_TEST_MANIFEST && path.isAbsolute(env.AGENAI_SANDBOX_TEST_MANIFEST), "Absolute AGENAI_SANDBOX_TEST_MANIFEST is required.");
  assert(env.AGENAI_SANDBOX_TEST_OUTPUT && path.isAbsolute(env.AGENAI_SANDBOX_TEST_OUTPUT), "Absolute AGENAI_SANDBOX_TEST_OUTPUT is required.");
}

async function assertInstalledSandboxConsumer(root) {
  assert.equal(await realpath(root), root, "Packed consumer must be an existing physical directory");
  assert(root !== ROOT && !root.startsWith(`${ROOT}${path.sep}`), "Packed consumer must live outside source authority");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const declared = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@agen-ai/")).sort();
  assert.deepEqual(declared, SDK_NAMES, "Packed consumer requires exactly the complete matching ten-package SDK set");
  const require = createRequire(path.join(root, "package.json"));
  const packages = [];
  for (const name of SDK_NAMES) {
    assert.match(manifest.dependencies[name], /^file:\//u, `${name} must be installed from an explicit packed archive`);
    const file = await realpath(require.resolve(`${name}/package.json`));
    assert(file.startsWith(`${root}${path.sep}`), `${name} must resolve within the independent consumer`);
    const installed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(installed.name, name);
    assert.equal(installed.version, "0.4.7", `${name} must match the coordinated 0.4.7 candidate`);
    packages.push({ name, version: installed.version });
  }
  const installedNames = (await readdir(path.join(root, "node_modules/@agen-ai"))).map((name) => `@agen-ai/${name}`).sort();
  assert.deepEqual(installedNames, SDK_NAMES, "Unexpected SDK package in the packed consumer");
  return packages;
}

function execute(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Packed sandbox command failed (${signal ?? `exit ${code}`}).`)));
  });
}

async function main() {
  const selected = parseSandboxConsumerArguments(process.argv.slice(2));
  assertSandboxConsumerEnvironment(process.env);
  let temporary;
  let passed = false;
  try {
    let consumer = selected;
    if (!consumer) {
      temporary = await mkdtemp(path.join(tmpdir(), "agenai-sandbox-packed-"));
      const packed = path.join(temporary, "proof");
      await execute([path.join(ROOT, "scripts/architecture/check-agent-sdk-external-consumer.mjs"), "--output", packed], ROOT);
      consumer = path.join(packed, "consumer");
    }
    const packages = await assertInstalledSandboxConsumer(consumer);
    await execute(["--import", "tsx", "examples/sandbox/docker.ts"], consumer);
    process.stdout.write(`${JSON.stringify({ proof: "installed-sandbox-consumer", consumer, packages, modelCalls: 0 })}\n`);
    passed = true;
  } finally {
    if (temporary && passed) await rm(temporary, { recursive: true, force: true });
    else if (temporary) process.stderr.write(`Failed packed consumer retained at ${temporary}.\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
