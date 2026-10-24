// ------------------------------------------------------------------------------------------------
//                proof.mjs - Independent neutral installed-package proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { packedOverridesSource } from "../dependency-baseline.mjs";

export async function runNeutralSandboxConsumer({ repoRoot, tempRoot, artifacts, run, publicExamplesRoot }) {
  const root = path.join(tempRoot, "sandbox-neutral-consumer");
  await mkdir(path.join(root, "src"), { recursive: true });
  const spillDirectory = path.join(root, "spill");
  await mkdir(spillDirectory);
  const filesystemRoot = path.join(root, "filesystem");
  await mkdir(filesystemRoot);
  const names = ["@agen-ai/sandbox", "@agen-ai/validation"];
  const dependencies = Object.fromEntries(names.map((name) => {
    const artifact = artifacts.find(({ manifest }) => manifest.name === name);
    assert(artifact, `Missing packed neutral prerequisite ${name}`);
    return [name, `file:${artifact.tarballPath}`];
  }));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "agent-sdk-neutral-sandbox-consumer", version: "1.0.0", private: true, type: "module",
    packageManager: "pnpm@11.7.0", engines: { node: ">=22.0.0" },
    dependencies,
    devDependencies: { "@types/node": "24.10.1", typescript: "5.9.3" },
  }, null, 2)}\n`);
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
  await writeFile(path.join(root, ".pnpmfile.cjs"), packedOverridesSource(dependencies));
  await writeFile(path.join(root, "tsconfig.json"), `${JSON.stringify({ compilerOptions: {
    target: "ES2022", lib: ["ES2024"], module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src",
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: ["node"],
  }, include: ["src/*.ts"] }, null, 2)}\n`);
  const sourceRoot = path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox");
  await copyFile(path.join(sourceRoot, "neutral.ts"), path.join(root, "src/neutral.ts"));
  await copyFile(path.join(sourceRoot, "neutral-guard.mjs"), path.join(root, "neutral-guard.mjs"));
  await copyFile(path.join(repoRoot, publicExamplesRoot, "sandbox/policy.ts"), path.join(root, "src/policy.ts"));
  await copyFile(path.join(repoRoot, publicExamplesRoot, "sandbox/collect.ts"), path.join(root, "src/collect.ts"));
  await copyFile(path.join(repoRoot, publicExamplesRoot, "sandbox/filesystem.ts"), path.join(root, "src/filesystem.ts"));
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], { cwd: root });
  const installed = (await readdir(path.join(root, "node_modules/@agen-ai"))).map((name) => `@agen-ai/${name}`).sort();
  assert.deepEqual(installed, names.sort(), "The neutral sandbox consumer must not install optional ACP or Docker packages");
  const installedGraph = await readdir(path.join(root, "node_modules/.pnpm"));
  assert.deepEqual(installedGraph.filter((name) => /^(?:@agen-ai\+(?:provider-acp|acp-transport|sandbox-docker)|dockerode)@/u.test(name)), [],
    "Optional peers may appear as manifest declarations but must be absent from the installed dependency graph");
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: root });
  const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const execution = await run(process.execPath, [permissionFlag, `--allow-fs-read=${root}`, `--allow-fs-write=${spillDirectory}`,
    `--allow-fs-write=${filesystemRoot}`,
    "--import", "./neutral-guard.mjs", "dist/neutral.js"], { cwd: root, timeoutMs: 30_000 });
  const report = JSON.parse(execution.stdout.trim());
  assert.deepEqual(report, { proof: "packed-neutral-sandbox", optionalPeers: "absent", docker: "absent",
    normalizedExecution: [{ kind: "until_stopped" }, { kind: "until_stopped" }],
    binaryEcho: [0, 255, 206, 177, 10], exportedBytes: [0, 255, 10], cleanup: "destroyed", originalFailureRetained: true,
    filesystem: { example: "examples/sandbox/filesystem.ts", files: "3", directories: "3", payloadBytes: "22",
      binary: [0, 255, 17, 128, 10], emptyBytes: 0, executable: true, publication: "complete",
      existingDestination: "preserved", lateFailure: "unpublished", cleanup: "destroyed" },
    subtree: { example: "examples/sandbox/filesystem.ts#exportSandboxSubtree", path: "reports/selected",
      files: "2", directories: "3", payloadBytes: "3", binary: [0, 255, 99], paths: "workspace_relative",
      outsideOutput: "rejected_before_body", invalidPublication: "absent", cleanup: "destroyed" } });
  assert.deepEqual(await readdir(spillDirectory), [], "Explicit neutral /node spill leaves no named metadata files");
  process.stdout.write(execution.stdout);
  return { ...report, installedSdkPackages: installed };
}
