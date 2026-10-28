// ------------------------------------------------------------------------------------------------
//                preparation.ts - Offline helper contexts from independently installed public exports
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareSandboxCredentialBootstrap, readSandboxCredentialFile } from "@agen-ai/sandbox/node";
import { prepareDockerSandboxEgressHelpers, prepareDockerSandboxFilesystemHelper,
  prepareDockerDesktopHostNetworkObserver, prepareDockerDesktopVmRouteObserver } from "@agen-ai/sandbox-docker/node";

const root = fileURLToPath(new URL("../sandbox-preparation/", import.meta.url));
const require = createRequire(import.meta.url);
const dockerPackageRoot = dirname(await realpath(require.resolve("@agen-ai/sandbox-docker/package.json")));
const sandboxPackageRoot = dirname(await realpath(require.resolve("@agen-ai/sandbox/package.json")));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const user = { uid: 65534, gid: 65534 };
const baseImageDigest = `registry.example/node@sha256:${"1".repeat(64)}`;
const toolchainImageDigest = `registry.example/gcc@sha256:${"2".repeat(64)}`;

async function contextFiles(directory: string, relative = ""): Promise<readonly { path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = posix.join(relative, entry.name);
    assert(!entry.isSymbolicLink(), "Prepared contexts must not borrow a mutable symlink target.");
    if (entry.isDirectory()) result.push(...await contextFiles(directory, path));
    else {
      assert(entry.isFile(), "Prepared contexts contain only directories and ordinary files.");
      result.push({ path, sha256: digest(await readFile(join(directory, path))) });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function verifyContext(result: {
  readonly directory: string;
  readonly sourceDigest: string;
  readonly files: readonly Readonly<{ path: string; sha256: string }>[];
}, packageRoot: string, sourceDirectory: string, generatedFiles: readonly string[]) {
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8")), result,
    "The published manifest must describe the context returned to the caller.");
  for (const file of result.files) {
    assert.equal(posix.normalize(file.path), file.path);
    assert(!posix.isAbsolute(file.path) && file.path !== ".." && !file.path.startsWith("../"));
    const copied = await readFile(join(result.directory, sourceDirectory === "dist" ? "runtime" : "", file.path));
    const shipped = await readFile(join(packageRoot, sourceDirectory, file.path));
    assert.deepEqual(copied, shipped, "Context source must come from the installed package's actual assets.");
    assert.equal(digest(copied), file.sha256);
  }
  assert.equal(result.sourceDigest, `sha256:${digest(Buffer.from(JSON.stringify(result.files)))}`);
  const actual = await contextFiles(result.directory);
  const expectedPaths = [...generatedFiles, ...result.files.map(({ path }) => sourceDirectory === "dist" ? `runtime/${path}` : path)].sort();
  assert.deepEqual(actual.map(({ path }) => path).sort(), expectedPaths,
    "The context must publish every declared source and its complete build inputs.");
  return actual;
}

const egressOptions = { directory: join(root, "egress"), baseImageDigest, user };
const egress = await prepareDockerSandboxEgressHelpers(egressOptions);
assert.equal(egress.directory, egressOptions.directory);
assert.equal(egress.baseImageDigest, baseImageDigest);
assert.deepEqual(egress.user, user);
assert.equal(egress.protocol, "agenai.sandbox.egress-connect.v1");
const egressFiles = await verifyContext(egress, dockerPackageRoot, "dist", ["Dockerfile", "manifest.json", "runtime/package.json"]);
assert.equal(JSON.parse(await readFile(join(egress.directory, "runtime/package.json"), "utf8")).type, "module");
assert((await readFile(join(egress.directory, "Dockerfile"), "utf8")).split("\n").includes(`FROM ${baseImageDigest} AS source`));
const entry: unknown = await import(pathToFileURL(join(egress.directory, "runtime/helpers/entry.js")).href);
assert(entry !== null && typeof entry === "object" && "runEgressHelper" in entry && typeof entry.runEgressHelper === "function",
  "The generated helper entry must load its complete dependency closure without process or network authority.");
await assert.rejects(prepareDockerSandboxEgressHelpers(egressOptions), { code: "EEXIST" });
assert.deepEqual(await contextFiles(egress.directory), egressFiles, "Re-preparation preserves an existing caller-owned context.");
const legacyEgress = await prepareDockerSandboxEgressHelpers({ ...egressOptions, directory: join(root, "egress-bare-id"),
  baseImageDigest: `sha256:${"1".repeat(64)}` });
assert.equal(legacyEgress.baseImageDigest, `sha256:${"1".repeat(64)}`);
assert.equal(legacyEgress.sourceDigest, egress.sourceDigest, "Borrowed image spelling does not change shipped helper source identity.");

const filesystemOptions = { directory: join(root, "filesystem"), toolchainImageDigest, user };
const filesystem = await prepareDockerSandboxFilesystemHelper(filesystemOptions);
assert.equal(filesystem.directory, filesystemOptions.directory);
assert.equal(filesystem.toolchainImageDigest, toolchainImageDigest);
assert.deepEqual(filesystem.user, user);
assert.equal(filesystem.protocol, "agenai.sandbox.filesystem.v1");
assert.equal(filesystem.layout, "agenai.sandbox.workspace.v1");
assert.equal(filesystem.executable, "/usr/local/bin/agenai-sandbox-files");
const filesystemFiles = await verifyContext(filesystem, dockerPackageRoot, "native/filesystem", ["Dockerfile", "manifest.json"]);
assert((await readFile(join(filesystem.directory, "Dockerfile"), "utf8")).split("\n").includes(`FROM ${toolchainImageDigest} AS compiler`));
await assert.rejects(prepareDockerSandboxFilesystemHelper(filesystemOptions), { code: "EEXIST" });
assert.deepEqual(await contextFiles(filesystem.directory), filesystemFiles);

const hostOptions = { directory: join(root, "desktop-host"), toolchain: {
  compiler: { path: "/explicit-offline-toolchain/clang", sha256: "3".repeat(64) },
  sdk: { path: "/explicit-offline-toolchain/MacOSX.sdk", version: "26.4" }, deploymentTarget: "13.0" } };
const host = await prepareDockerDesktopHostNetworkObserver(hostOptions);
assert.equal(host.protocol, "agenai.desktop-host-network.v1");
assert.equal(host.architecture, "darwin/arm64");
assert.equal(host.executable, "agenai-desktop-host-network");
assert.deepEqual(host.toolchain, hostOptions.toolchain);
const hostFiles = await verifyContext(host, dockerPackageRoot, "", ["manifest.json", "commands.json"]);
const hostRecipe = JSON.parse(await readFile(join(host.directory, "commands.json"), "utf8"));
assert.deepEqual(hostRecipe, { cwd: host.directory, compilerSha256: "3".repeat(64), commands: host.commands });
const compilation = host.commands.find(({ arguments: args }) => args.includes("native/desktop/host/observer.c"));
assert(compilation, "Host preparation must publish a source compilation command.");
assert.equal(compilation.executable, "/explicit-offline-toolchain/clang");
assert.deepEqual(compilation.arguments.slice(0, 5), ["-isysroot", "/explicit-offline-toolchain/MacOSX.sdk", "-arch", "arm64", "-mmacosx-version-min=13.0"]);
hostOptions.toolchain.compiler.path = "/changed-after-preparation/clang";
assert.equal(host.toolchain.compiler.path, "/explicit-offline-toolchain/clang", "Preparation captures the toolchain once.");
await assert.rejects(prepareDockerDesktopHostNetworkObserver({ ...hostOptions, toolchain: host.toolchain }), { code: "EEXIST" });
assert.deepEqual(await contextFiles(host.directory), hostFiles);

const vmOptions = { directory: join(root, "desktop-vm"), toolchainImageDigest, baseImageDigest, user };
const vm = await prepareDockerDesktopVmRouteObserver(vmOptions);
assert.equal(vm.protocol, "agenai.sandbox.desktop-route-observer.v1");
assert.equal(vm.observationProtocol, "agenai.desktop-vm-network.v1");
assert.equal(vm.platform, "linux/arm64");
assert.equal(vm.executable, "/usr/local/bin/agenai-sandbox-desktop-route");
assert.deepEqual(vm.user, user);
const vmFiles = await verifyContext(vm, dockerPackageRoot, "", ["Dockerfile", "manifest.json", "dist/package.json"]);
const vmRecipe = (await readFile(join(vm.directory, "Dockerfile"), "utf8")).split("\n");
assert(vmRecipe.includes(`FROM --platform=linux/arm64 ${toolchainImageDigest} AS compiler`));
assert(vmRecipe.includes(`FROM --platform=linux/arm64 ${baseImageDigest} AS source`));
assert(vmRecipe.includes(`USER ${user.uid}:${user.gid}`));
const vmEntry: unknown = await import(pathToFileURL(join(vm.directory, "dist/network/desktop/entry.js")).href);
assert(vmEntry !== null && typeof vmEntry === "object" && "runDesktopVmRouteObserverHelper" in vmEntry
  && typeof vmEntry.runDesktopVmRouteObserverHelper === "function", "The shipped observer controller closure must import without process/network authority.");
await assert.rejects(prepareDockerDesktopVmRouteObserver(vmOptions), { code: "EEXIST" });
assert.deepEqual(await contextFiles(vm.directory), vmFiles);

assert.equal(await realpath(fileURLToPath(import.meta.resolve("@agen-ai/sandbox/node"))), join(sandboxPackageRoot, "dist/node/index.js"),
  "The credential helpers must resolve through the installed sandbox Node export.");
const credentialOptions = { directory: join(root, "credentials") };
const credentials = await prepareSandboxCredentialBootstrap(credentialOptions);
assert.equal(credentials.protocol, "agenai.sandbox-credential-bootstrap.v1");
assert.equal(credentials.guestDirectory, "/home/sandbox/.agenai-credentials");
assert.equal(credentials.executableName, "agenai-credential-bootstrap");
assert.deepEqual(credentials.files.map(({ path }) => path), ["bootstrap.c", "protocol.h"]);
const credentialFiles = await verifyContext(credentials, sandboxPackageRoot, "native/credentials", ["BUILDING.md", "manifest.json"]);
assert.equal((await stat(credentials.directory)).mode & 0o777, 0o700);
await assert.rejects(prepareSandboxCredentialBootstrap(credentialOptions), { code: "EEXIST" });
assert.deepEqual(await contextFiles(credentials.directory), credentialFiles);

const syntheticSource = join(root, "synthetic-private-source");
const syntheticBytes = Uint8Array.of(0, 255, 34, 10, 65, 0, 123, 125);
await writeFile(syntheticSource, syntheticBytes, { flag: "wx", mode: 0o600 });
const sourceBefore = await stat(syntheticSource, { bigint: true });
assert.equal(sourceBefore.mode & 0o777n, 0o600n);
const selectedBytes = await readSandboxCredentialFile({ path: syntheticSource });
try { assert.deepEqual(selectedBytes, syntheticBytes); }
finally { selectedBytes.fill(0); }
assert.deepEqual(await readFile(syntheticSource), Buffer.from(syntheticBytes));
const sourceAfter = await stat(syntheticSource, { bigint: true });
assert.equal(sourceAfter.mode, sourceBefore.mode);
assert.equal(sourceAfter.uid, sourceBefore.uid);
assert.equal(sourceAfter.ino, sourceBefore.ino);
assert.equal(sourceAfter.mtimeNs, sourceBefore.mtimeNs);
assert.equal(sourceAfter.ctimeNs, sourceBefore.ctimeNs);

process.stdout.write(`${JSON.stringify({ proof: "packed-sandbox-helper-preparation", evidence: "installed-offline-contexts",
  processAndNetwork: "prohibited", filesystem: "owned_preparation_root", builds: "not_run",
  egress: { protocol: egress.protocol, sourceDigest: egress.sourceDigest, manifest: egress.files, context: egressFiles,
    runtimeClosure: "imported", existingContext: "preserved" },
  liveFiles: { protocol: filesystem.protocol, layout: filesystem.layout, executable: filesystem.executable,
    sourceDigest: filesystem.sourceDigest, manifest: filesystem.files, context: filesystemFiles, existingContext: "preserved" },
  desktopHost: { protocol: host.protocol, architecture: host.architecture, sourceDigest: host.sourceDigest,
    manifest: host.files, context: hostFiles, existingContext: "preserved" },
  desktopVm: { protocol: vm.protocol, observationProtocol: vm.observationProtocol, platform: vm.platform,
    sourceDigest: vm.sourceDigest, manifest: vm.files, context: vmFiles, runtimeClosure: "imported", existingContext: "preserved" },
  credentials: { protocol: credentials.protocol, guestDirectory: credentials.guestDirectory, executableName: credentials.executableName,
    sourceDigest: credentials.sourceDigest, manifest: credentials.files, context: credentialFiles, existingContext: "preserved",
    sourceRead: "exact_private_bytes", sourceUnchanged: true, callerCopy: "cleared" } })}\n`);
