// ------------------------------------------------------------------------------------------------
//                platform-proof.mjs - Explicit portable installed sandbox preparation and admission
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { consumerPackageManifest, packedOverridesSource } from "../dependency-baseline.mjs";

const compilerOptions = {
  target: "ES2022", lib: ["ES2024"], module: "NodeNext", moduleResolution: "NodeNext",
  strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: ["node"],
};

export async function runSandboxPlatformCheck({ repoRoot, consumerRoot, run }) {
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/platform.ts"),
    path.join(consumerRoot, "sandbox-platform.ts"));
  await writeFile(path.join(consumerRoot, "sandbox-platform-fixture.json"), `${JSON.stringify({
    format: "agenai.sandbox-docker-fixture.v1", imageDigest: `sha256:${"1".repeat(64)}`, user: { uid: 65534, gid: 65534 },
  })}\n`);
  await writeFile(path.join(consumerRoot, "tsconfig.sandbox-platform.json"), `${JSON.stringify({
    compilerOptions: { ...compilerOptions, rootDir: ".", outDir: "platform-dist" },
    include: ["sandbox-platform.ts", "examples/sandbox/**/*.ts"],
  }, null, 2)}\n`);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.sandbox-platform.json"], { cwd: consumerRoot });
  await copyFile(path.join(consumerRoot, "examples/sandbox/peer.mjs"),
    path.join(consumerRoot, "platform-dist/examples/sandbox/peer.mjs"));
  const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const execution = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "platform-dist/sandbox-platform.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  const report = JSON.parse(execution.stdout.trim());
  assert.deepEqual(report, { proof: "packed-sandbox-platform-configuration", evidence: "inert-configuration-and-controller-rejection",
    controller: { os: process.platform, architecture: process.arch },
    profiles: ["linux-x64", "desktop-apple-virtualization-native-arm64", "desktop-apple-virtualization-rosetta-amd64"],
    defaultProfile: "linux-x64", constructors: 4, wrongControllerRejected: true, engineRequests: 0, operationRootsCreated: 0,
    nativeMacQualification: "pending" });
  process.stdout.write(execution.stdout);
  return report;
}

export async function runPortableSandboxConsumer({ repoRoot, tempRoot, artifacts, run, publicExamplesRoot }) {
  const consumerRoot = path.join(tempRoot, "consumer");
  await mkdir(consumerRoot);
  const dependencies = Object.fromEntries(artifacts.map(({ manifest, tarballPath }) => [manifest.name, `file:${tarballPath}`]));
  await writeFile(path.join(consumerRoot, "package.json"), `${JSON.stringify(consumerPackageManifest("consumer", dependencies), null, 2)}\n`);
  await writeFile(path.join(consumerRoot, ".pnpmfile.cjs"), packedOverridesSource(dependencies));
  await cp(path.join(repoRoot, publicExamplesRoot), path.join(consumerRoot, "examples"), { recursive: true });
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
  const examples = await Promise.all(["configuration.ts", "docker.ts", "datasets.ts", "session.ts", "collect.ts", "evidence.ts", "policy.ts", "filesystem.ts", "peer.mjs"].map(async (file) => ({
    path: `examples/sandbox/${file}`,
    sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "examples/sandbox", file))).digest("hex"),
  })));
  return { proof: "packed-sandbox-platform-consumer", profile: "sandbox-platform", consumerRoot,
    scope: "portable installed configuration and sandbox example types; native platform execution not run",
    installedSdkPackages, configuration, examples, examplesTypechecked: true, nativePlatformExecution: "not_run" };
}
