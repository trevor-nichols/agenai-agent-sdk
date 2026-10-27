// ------------------------------------------------------------------------------------------------
//                links.ts - Explicit full-filesystem installed symbolic-link publication proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxDirectoryCleanupError, exportSandboxDirectory } from "@agen-ai/sandbox/node";
import { controlledBackend } from "./controlled.js";
import { roundTripSandboxDirectory } from "./filesystem.js";
import { isolatedSandboxRequest } from "./policy.js";

assert.equal(process.permission.has("fs.read"), true, "Node symlink creation requires the explicit full filesystem read grant.");
assert.equal(process.permission.has("fs.write"), true, "Node symlink creation requires the explicit full filesystem write grant.");
assert.equal(process.permission.has("child"), false);
const filesystemRoot = fileURLToPath(new URL("../links-filesystem", import.meta.url));
const spillDirectory = fileURLToPath(new URL("../links-spill", import.meta.url));
const sourceRoot = join(filesystemRoot, "source");
await mkdir(join(sourceRoot, "nested", "empty-dir"), { recursive: true });
await mkdir(join(sourceRoot, "scripts"));
const binary = Uint8Array.from([0, 255, 17, 128, 10]);
const executable = Buffer.from("#!/bin/sh\nexit 0\n");
await writeFile(join(sourceRoot, "binary.bin"), binary, { mode: 0o600 });
await writeFile(join(sourceRoot, "scripts", "run.sh"), executable, { mode: 0o700 });
await chmod(join(sourceRoot, "scripts", "run.sh"), 0o700);
const targets = [["binary-link", "./nested//../binary.bin"], ["scripts/runner", "./run.sh"], ["nested/dangling", "missing"]] as const;
for (const [path, target] of targets) await symlink(target, join(sourceRoot, path));
const options = { symlinks: "preserve_internal" as const,
  quotas: { maxFiles: 2, maxSymlinks: 3, maxFileBytes: 64, maxTotalBytes: 128 } };
const fixture = controlledBackend(spillDirectory, { preserveLinks: true });
const owner = fixture.backend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
try {
  const sandbox = await owner.start();
  const namespace = join(filesystemRoot, "published");
  const result = await roundTripSandboxDirectory(sandbox, sourceRoot, namespace, options);
  assert.equal(result.directory, join(namespace, "files"));
  for (const summary of [result.imported, result.exported]) {
    assert.equal(summary.files, 2n); assert.equal(summary.directories, 3n);
    assert.equal(summary.symlinks, 3n); assert.equal(summary.payloadBytes, 22n);
  }
  assert.deepEqual((await readdir(result.directory)).sort(), ["binary-link", "binary.bin", "nested", "scripts"]);
  for (const [path, target] of targets) {
    assert.equal((await lstat(join(result.directory, path))).isSymbolicLink(), true);
    assert.deepEqual(await readlink(join(result.directory, path), { encoding: "buffer" }), Buffer.from(target));
  }
  assert.deepEqual(await readFile(join(result.directory, "binary.bin")), Buffer.from(binary));
  assert.deepEqual(await readFile(join(result.directory, "binary-link")), Buffer.from(binary));
  assert.deepEqual(await readFile(join(result.directory, "scripts", "run.sh")), executable);
  assert.notEqual((await stat(join(result.directory, "scripts", "run.sh"))).mode & 0o111, 0);
  assert.equal((await stat(join(result.directory, "binary.bin"))).mode & 0o111, 0);
  await assert.rejects(stat(join(result.directory, "nested", "dangling")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(result.directory, "nested", "empty-dir")), []);
  const existing = join(filesystemRoot, "existing"); await mkdir(existing);
  await writeFile(join(existing, "caller-owned.txt"), "preserve caller data\n");
  try {
    await exportSandboxDirectory(sandbox, { kind: "workspace" }, existing, options);
    assert.fail("An existing destination must remain caller-owned.");
  } catch (error) {
    if (error instanceof SandboxDirectoryCleanupError) throw error;
    assert(error instanceof Error && "code" in error && error.code === "EEXIST");
  }
  assert.deepEqual(await readdir(existing), ["caller-owned.txt"]);
  assert.equal(await readFile(join(existing, "caller-owned.txt"), "utf8"), "preserve caller data\n");
  assert.deepEqual([...fixture.resources], ["storage"]);
} catch (error) {
  if (error instanceof SandboxDirectoryCleanupError) await error.retryCleanup();
  throw error;
} finally { await owner.destroy(); }
assert.deepEqual([...fixture.resources], []);

const lateFailure = new Error("controlled failure after all preserved-link callbacks");
const lateFixture = controlledBackend(spillDirectory, { preserveLinks: true, lateExportFailure: lateFailure });
const lateOwner = lateFixture.backend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
const unpublished = join(filesystemRoot, "unpublished");
try {
  const sandbox = await lateOwner.start();
  try {
    await roundTripSandboxDirectory(sandbox, sourceRoot, unpublished, options);
    assert.fail("A late backend failure must prevent publication.");
  } catch (error) {
    if (error instanceof SandboxDirectoryCleanupError) { await error.retryCleanup(); throw error; }
    assert.equal(error, lateFailure);
  }
  await assert.rejects(lstat(unpublished), { code: "ENOENT" });
  assert.deepEqual([...lateFixture.resources], ["storage"]);
} finally { await lateOwner.destroy(); }
assert.deepEqual([...lateFixture.resources], []);
assert.deepEqual(await readdir(spillDirectory), []);
process.stdout.write(`${JSON.stringify({ proof: "packed-neutral-sandbox-links", optionalPeers: "absent", docker: "absent",
  filesystemPermissions: "full_read_write_required_by_node_symlink", networkAndProcess: "prohibited",
  example: "examples/sandbox/filesystem.ts", files: "2", directories: "3", symlinks: "3", payloadBytes: "22",
  binary: [...binary], executable: true, targets: targets.map(([path, target]) => ({ path, target })),
  publication: "complete", existingDestination: "preserved", lateFailure: "unpublished", cleanup: "destroyed" })}\n`);
