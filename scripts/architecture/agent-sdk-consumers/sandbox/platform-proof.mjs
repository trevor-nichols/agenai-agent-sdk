// ------------------------------------------------------------------------------------------------
//                platform-proof.mjs - Explicit portable installed sandbox preparation and admission
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { consumerPackageManifest, packedOverridesSource } from "../dependency-baseline.mjs";
import { runSandboxBridgeExamples } from "./bridges-proof.mjs";
import { copyPublicExampleSources, sandboxExampleSourceIdentities } from "./example-sources.mjs";

const compilerOptions = {
  target: "ES2022", lib: ["ES2024"], module: "NodeNext", moduleResolution: "NodeNext",
  strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: ["node"],
};

async function runConcurrentLocalTests({ consumerRoot, run }) {
  const directory = "platform-dist/examples/sandbox/concurrency/tests";
  const files = (await readdir(path.join(consumerRoot, directory)))
    .filter((name) => name.endsWith(".test.js")).sort();
  assert(files.length > 0, "The packed concurrency example must execute its compiled behavioral tests.");
  const scratch = path.join(consumerRoot, "sandbox-concurrency-local-fixtures");
  await mkdir(scratch, { mode: 0o700 });
  const runner = path.join(consumerRoot, "sandbox-concurrency-local-tests.mjs");
  await writeFile(runner, `${["TMPDIR", "TMP", "TEMP"].map((name) => `process.env.${name} = ${JSON.stringify(scratch)};`).join("\n")}\n${
    files.map((file) => `await import(${JSON.stringify(`./${directory}/${file}`)});`).join("\n")}\n`, { flag: "wx" });
  const timeoutMs = 60_000;
  const execution = await run(process.execPath, ["--test", "--test-reporter=tap", runner],
    { cwd: consumerRoot, timeoutMs });
  process.stdout.write(execution.stdout);
  const results = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map((name) => {
    const matches = [...execution.stdout.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gmu"))];
    assert.equal(matches.length, 1, `The installed local test runner must report one ${name} total.`);
    return [name, Number(matches[0][1])];
  }));
  assert.deepEqual(results, { tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  const cases = [...execution.stdout.matchAll(/^ok \d+ - (.+)$/gmu)].map((match) => match[1]);
  assert.equal(cases.length, results.tests);
  assert.deepEqual(await readdir(scratch), [], "Every original local primary and reader must settle before its scratch is removed.");
  await rmdir(scratch);
  return { proof: "packed-concurrent-local-workflow-tests", scope: "local_node_git_programs_tls_and_public_admission",
    files: files.map((file) => `${directory}/${file}`), cases, results, timeoutMs,
    scratch: { directory: scratch, state: "joined_empty_removed" }, engine: "not_exercised", network: "loopback_tls_only" };
}

export async function runSandboxPlatformCheck({ repoRoot, consumerRoot, run }) {
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/platform.ts"),
    path.join(consumerRoot, "sandbox-platform.ts"));
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/preparation.ts"),
    path.join(consumerRoot, "sandbox-preparation.ts"));
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/coordinator.ts"),
    path.join(consumerRoot, "coordinator.ts"));
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/concurrency.ts"),
    path.join(consumerRoot, "concurrency.ts"));
  await writeFile(path.join(consumerRoot, "sandbox-platform-fixture.json"), `${JSON.stringify({
    format: "agenai.sandbox-docker-fixture.v1", imageDigest: `sha256:${"1".repeat(64)}`, user: { uid: 65534, gid: 65534 },
  })}\n`);
  await writeFile(path.join(consumerRoot, "tsconfig.sandbox-platform.json"), `${JSON.stringify({
    compilerOptions: { ...compilerOptions, rootDir: ".", outDir: "platform-dist" },
    include: ["sandbox-platform.ts", "sandbox-preparation.ts", "coordinator.ts", "concurrency.ts", "examples/sandbox/**/*.ts"],
    exclude: ["examples/sandbox/claude"],
  }, null, 2)}\n`);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.sandbox-platform.json"], { cwd: consumerRoot });
  await copyFile(path.join(consumerRoot, "examples/sandbox/peer.mjs"),
    path.join(consumerRoot, "platform-dist/examples/sandbox/peer.mjs"));
  await copyPublicExampleSources(path.join(consumerRoot, "examples/sandbox/grok/guest"),
    path.join(consumerRoot, "platform-dist/examples/sandbox/grok/guest"));
  const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const execution = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "platform-dist/sandbox-platform.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  const report = JSON.parse(execution.stdout.trim());
  assert.deepEqual(report, { proof: "packed-sandbox-platform-configuration", evidence: "inert-configuration-and-controller-rejection",
    controller: { os: process.platform, architecture: process.arch },
    profiles: ["linux-x64", "desktop-apple-virtualization-native-arm64", "desktop-apple-virtualization-rosetta-amd64"],
    defaultProfile: "linux-x64", constructors: 4, desktopAuthorities: 2, desktopRestrictedReservations: 2,
    authorityClonesRejected: true, wrongControllerRejected: true, engineRequests: 0, operationRootsCreated: 0,
    filesystemConstructors: 3, filesystemGrantsReserved: 6, unconfiguredFilesystemGrantsRejected: 6,
    preservingTransfers: [
      { profile: "linux-x64", support: { kind: "preserve_internal", import: "empty_workspace" } },
      { profile: "desktop-apple-virtualization-native-arm64", support: { kind: "preserve_internal", import: "empty_workspace" } },
      { profile: "desktop-apple-virtualization-rosetta-amd64", support: { kind: "preserve_internal", import: "empty_workspace" } },
    ],
    combinedExampleImport: "inert", coordinators: ["desktop-apple-virtualization-native-arm64", "desktop-apple-virtualization-rosetta-amd64"].map((profile) => ({
      profile, state: { kind: "closed", result: "never_activated" }, invalidOperationInputs: 5,
      cancelledBeforeEntry: ["initialize", "activate", "reopenCleanup"], invalidMemberCapabilitiesRejected: 4,
      clonedRouteAuthoritiesRejected: 2, foreignRouteAuthorityRejected: true, unknownConfigurationRejected: true,
      invalidHelperRejected: true, originalErrorOwner: true, closedIdempotently: true, nativeActivation: "not_run",
    })), concurrentExamples: ["desktop-apple-virtualization-native-arm64", "desktop-apple-virtualization-rosetta-amd64"].map((profile) => ({
      profile, import: "inert", inactiveCoordinator: "rejected_before_reservation", nativeWorkflow: "not_run",
    })), nativeMacQualification: "pending" });
  process.stdout.write(execution.stdout);
  const preparationRoot = path.join(consumerRoot, "sandbox-preparation");
  await mkdir(preparationRoot);
  const guard = path.join(consumerRoot, "sandbox-preparation-guard.mjs");
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/neutral-guard.mjs"), guard);
  const preparation = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    `--allow-fs-write=${preparationRoot}`, "--import", guard, "platform-dist/sandbox-preparation.js"],
  { cwd: consumerRoot, timeoutMs: 30_000 });
  const helperPreparation = JSON.parse(preparation.stdout.trim());
  assert.equal(helperPreparation.proof, "packed-sandbox-helper-preparation");
  assert.equal(helperPreparation.evidence, "installed-offline-contexts");
  assert.equal(helperPreparation.processAndNetwork, "prohibited");
  assert.equal(helperPreparation.filesystem, "owned_preparation_root");
  assert.equal(helperPreparation.builds, "not_run");
  process.stdout.write(preparation.stdout);
  return { ...report, helperPreparation, examples: await sandboxExampleSourceIdentities(consumerRoot),
    concurrentLocalTests: await runConcurrentLocalTests({ consumerRoot, run }),
    bridgeExamples: await runSandboxBridgeExamples({ repoRoot, consumerRoot, run }) };
}

export async function runPortableSandboxConsumer({ repoRoot, tempRoot, artifacts, run, publicExamplesRoot }) {
  const consumerRoot = path.join(tempRoot, "consumer");
  await mkdir(consumerRoot);
  const dependencies = Object.fromEntries(artifacts.map(({ manifest, tarballPath }) => [manifest.name, `file:${tarballPath}`]));
  await writeFile(path.join(consumerRoot, "package.json"), `${JSON.stringify(consumerPackageManifest("consumer", dependencies), null, 2)}\n`);
  await writeFile(path.join(consumerRoot, ".pnpmfile.cjs"), packedOverridesSource(dependencies));
  await copyPublicExampleSources(path.join(repoRoot, publicExamplesRoot), path.join(consumerRoot, "examples"));
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/session-lifecycle.ts"),
    path.join(consumerRoot, "sandbox-session-lifecycle.ts"));
  await writeFile(path.join(consumerRoot, "tsconfig.sandbox.json"), `${JSON.stringify({
    compilerOptions: { ...compilerOptions, rootDir: ".", noEmit: true }, include: ["sandbox-session-lifecycle.ts"],
  }, null, 2)}\n`);
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], { cwd: consumerRoot });
  const installedSdkPackages = (await readdir(path.join(consumerRoot, "node_modules/@agen-ai"))).map((name) => `@agen-ai/${name}`).sort();
  assert.deepEqual(installedSdkPackages, Object.keys(dependencies).sort(), "Portable sandbox preparation requires the complete packed SDK inventory");
  await run("pnpm", ["exec", "tsc", "--project", "examples/tsconfig.json", "--noEmit"], { cwd: consumerRoot });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.sandbox.json"], { cwd: consumerRoot });
  const configuration = await runSandboxPlatformCheck({ repoRoot, consumerRoot, run });
  return { proof: "packed-sandbox-platform-consumer", profile: "sandbox-platform", consumerRoot,
    scope: "portable installed configuration, sandbox example types and local Node/Git behavior; native platform execution not run",
    installedSdkPackages, configuration, examples: configuration.examples, examplesTypechecked: true, nativePlatformExecution: "not_run" };
}
