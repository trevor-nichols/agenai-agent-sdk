// ------------------------------------------------------------------------------------------------
//                neutral.ts - Installed neutral root and backend lifecycle proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileFromBytes,
  SandboxCleanupError, SandboxOperationError, SandboxRunError, SandboxStateError, SandboxUnsupportedError, SandboxValidationError, withSandbox,
  type SandboxExecutionPolicy, type SandboxRecoveryRecord, type SandboxRequestInput, type SandboxTransferSummary,
} from "@agen-ai/sandbox";
import { exportSandboxDirectory } from "@agen-ai/sandbox/node";
import { collectSandboxFiles } from "./collect.js";
import { controlledBackend } from "./controlled.js";
import { exportSandboxSubtree, roundTripSandboxDirectory } from "./filesystem.js";
import { isolatedSandboxRequest } from "./policy.js";

const require = createRequire(import.meta.url);
const spillDirectory = fileURLToPath(new URL("../spill", import.meta.url));
const filesystemRoot = fileURLToPath(new URL("../filesystem", import.meta.url));
for (const name of ["@agen-ai/provider-acp", "@agen-ai/acp-transport", "@agen-ai/sandbox-docker", "dockerode"]) {
  assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" }, `${name} must be absent from the neutral installation`);
}

const { execution: _smokeExecution, ...policy } = isolatedSandboxRequest().policy;
const omittedExecution: SandboxRequestInput = { policy };
const explicitUntilStopped: SandboxRequestInput = { policy: { ...policy, execution: { kind: "until_stopped" } } };
const admission = controlledBackend(spillDirectory);
assert.throws(() => admission.backend.reserve({ policy: { ...policy,
  workspaceDiskQuota: { kind: "required", bytes: 1024, accounting: "allocated_blocks" } } }, { kind: "in_process" }), SandboxUnsupportedError);
for (const kind of ["read_only", "read_write"] as const) {
  assert.throws(() => admission.backend.reserve({ policy: { ...policy, files: { kind } } }, { kind: "in_process" }), SandboxUnsupportedError);
}
assert.throws(() => admission.backend.reserve({ policy: { ...policy,
  network: { kind: "restricted_https", destinations: [{ hostname: "api.example.com", port: 443 }] } } },
{ kind: "in_process" }), SandboxUnsupportedError);
assert.equal(admission.reserveCalls, 0);
assert.deepEqual([...admission.resources], []);
const admissionOwner = admission.backend.reserve(omittedExecution, { kind: "in_process" });
assert.equal(admission.reserveCalls, 1);
try {
  const { configurationDigest: _configurationDigest, ...legacy } = admissionOwner.recoveryRecord;
  // @ts-expect-error Legacy recovery data cannot carry current cleanup authority.
  await assert.rejects(admission.backend.reconcile({ ...legacy, format: "agenai.sandbox-recovery.v1" }), SandboxValidationError);
  assert.equal(admission.reconcileCalls, 0);
  assert.deepEqual(await admission.backend.reconcile(admissionOwner.recoveryRecord), { kind: "absent", record: admissionOwner.recoveryRecord });
  assert.equal(admission.reconcileCalls, 1);
} finally { await admissionOwner.destroy(); }
assert.deepEqual([...admission.resources], []);
const normalizedExecution: SandboxExecutionPolicy[] = [];
for (const request of [omittedExecution, explicitUntilStopped]) {
  const fixture = controlledBackend(spillDirectory);
  const checkpoints: SandboxRecoveryRecord[] = [];
  const owner = fixture.backend.reserve(request, { kind: "persisted", async persist(record) { checkpoints.push(record); } });
  assert.deepEqual([...fixture.resources], []);
  try {
    const sandbox = await owner.start();
    assert.deepEqual(sandbox.files, { kind: "disabled" });
    assert.deepEqual(sandbox.effective.files, { kind: "disabled" });
    await sandbox.importTree([fileFromBytes("input.bin", Uint8Array.from([0, 255, 10]))], {
      quotas: { maxFiles: 1, maxFileBytes: 3, maxTotalBytes: 3 },
    });
    assert.throws(() => sandbox.exportTree({ kind: "files", paths: ["input.bin"] }, async () => {}), SandboxStateError);
    const process = sandbox.reserveProcess({ executable: "/guest/bin/peer", args: [], env: {}, cwd: sandbox.workspace });
    assert.equal(process.stopScope, "sandbox");
    const streams = await process.start();
    const output = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of streams.stdout) chunks.push(Buffer.from(chunk));
      return [...Buffer.concat(chunks)];
    })();
    const errors = (async () => { for await (const _chunk of streams.stderr) throw new Error("Unexpected controlled stderr."); })();
    streams.stdin.end(Buffer.from([0, 255, 206, 177, 10]));
    assert.deepEqual(await output, [0, 255, 206, 177, 10]);
    await errors;
    assert.deepEqual(await streams.exit, { kind: "exited", code: 0 });
    await sandbox.stop();
    const exported = await collectSandboxFiles(sandbox, ["input.bin"], 3);
    assert.deepEqual(exported.map((file) => ({ path: file.path, bytes: [...file.bytes] })), [{ path: "input.bin", bytes: [0, 255, 10] }]);
    assert.deepEqual([...fixture.resources], ["storage"]);
  } finally { await owner.destroy(); }
  assert.deepEqual([...fixture.resources], []);
  assert.equal(owner.state.kind, "destroyed");
  normalizedExecution.push(...fixture.executionPolicies);
}
assert.deepEqual(normalizedExecution, [{ kind: "until_stopped" }, { kind: "until_stopped" }]);

const sourceRoot = join(filesystemRoot, "source");
await mkdir(join(sourceRoot, "nested", "empty-dir"), { recursive: true });
await mkdir(join(sourceRoot, "scripts"));
const binary = Uint8Array.from([0, 255, 17, 128, 10]);
const executable = Buffer.from("#!/bin/sh\nexit 0\n");
await writeFile(join(sourceRoot, "binary.bin"), binary, { mode: 0o600 });
await writeFile(join(sourceRoot, "empty.bin"), new Uint8Array(), { mode: 0o600 });
await writeFile(join(sourceRoot, "scripts", "run.sh"), executable, { mode: 0o700 });
await chmod(join(sourceRoot, "scripts", "run.sh"), 0o700);
const filesystemFixture = controlledBackend(spillDirectory);
const filesystemOwner = filesystemFixture.backend.reserve(omittedExecution, { kind: "in_process" });
const transferOptions = { quotas: { maxFiles: 3, maxFileBytes: 64, maxTotalBytes: 128 } };
let filesystemSummary: SandboxTransferSummary | undefined;
try {
  const sandbox = await filesystemOwner.start();
  const namespace = join(filesystemRoot, "published");
  const result = await roundTripSandboxDirectory(sandbox, sourceRoot, namespace, transferOptions);
  filesystemSummary = result.exported;
  assert.equal(result.directory, join(namespace, "files"));
  for (const summary of [result.imported, result.exported]) {
    assert.equal(summary.files, 3n);
    assert.equal(summary.directories, 3n);
    assert.equal(summary.symlinks, 0n);
    assert.equal(summary.payloadBytes, 22n);
  }
  assert.deepEqual((await readdir(result.directory)).sort(), ["binary.bin", "empty.bin", "nested", "scripts"]);
  assert.deepEqual((await readdir(join(result.directory, "nested"))).sort(), ["empty-dir"]);
  assert.deepEqual((await readdir(join(result.directory, "scripts"))).sort(), ["run.sh"]);
  assert.deepEqual(await readFile(join(result.directory, "binary.bin")), Buffer.from([0, 255, 17, 128, 10]));
  assert.equal((await stat(join(result.directory, "empty.bin"))).size, 0);
  assert.deepEqual(await readFile(join(result.directory, "scripts", "run.sh")), executable);
  assert.notEqual((await stat(join(result.directory, "scripts", "run.sh"))).mode & 0o111, 0);
  assert.equal((await stat(join(result.directory, "binary.bin"))).mode & 0o111, 0);
  assert.deepEqual(await readdir(join(result.directory, "nested", "empty-dir")), []);
  assert.deepEqual([...filesystemFixture.resources], ["storage"]);
  const existing = join(filesystemRoot, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "caller-owned.txt"), "preserve caller data\n");
  await assert.rejects(exportSandboxDirectory(sandbox, { kind: "workspace" }, existing, transferOptions));
  assert.deepEqual(await readdir(existing), ["caller-owned.txt"]);
  assert.equal(await readFile(join(existing, "caller-owned.txt"), "utf8"), "preserve caller data\n");
} finally { await filesystemOwner.destroy(); }
assert.deepEqual([...filesystemFixture.resources], []);
assert(filesystemSummary);

const lateFailure = new Error("controlled failure after all export callbacks");
const unpublished = join(filesystemRoot, "unpublished");
const lateFixture = controlledBackend(spillDirectory, { lateExportFailure: lateFailure });
const lateOwner = lateFixture.backend.reserve(explicitUntilStopped, { kind: "in_process" });
try {
  const sandbox = await lateOwner.start();
  await assert.rejects(roundTripSandboxDirectory(sandbox, sourceRoot, unpublished, transferOptions), (error: unknown) => error === lateFailure);
  await assert.rejects(stat(unpublished), { code: "ENOENT" });
  assert.deepEqual([...lateFixture.resources], ["storage"]);
} finally { await lateOwner.destroy(); }
assert.deepEqual([...lateFixture.resources], []);

const selectedPath = "reports/selected";
const subtreeInput = [
  { kind: "directory" as const, path: "reports" },
  { kind: "directory" as const, path: selectedPath },
  { kind: "directory" as const, path: `${selectedPath}/nested` },
  { kind: "directory" as const, path: `${selectedPath}/empty` },
  { kind: "directory" as const, path: "reports/selected-other" },
  fileFromBytes(`${selectedPath}/nested/result.bin`, Uint8Array.from([0, 255, 99])),
  fileFromBytes(`${selectedPath}/zero.bin`, new Uint8Array()),
  fileFromBytes("reports/outside.bin", Uint8Array.from([17])),
  fileFromBytes("reports/selected-other/lookalike.bin", Uint8Array.from([23])),
];
let subtreeSummary: SandboxTransferSummary | undefined;
for (const invalid of [false, true]) {
  const selectedFixture = controlledBackend(spillDirectory, invalid ? { outsideSubtreePath: "reports/selected-other/leak.bin" } : {});
  const selectedOwner = selectedFixture.backend.reserve(omittedExecution, { kind: "in_process" });
  const destination = join(filesystemRoot, invalid ? "invalid-subtree" : "selected-subtree");
  try {
    const sandbox = await selectedOwner.start();
    await sandbox.importTree(subtreeInput, { quotas: { maxFiles: 4, maxFileBytes: 3, maxTotalBytes: 5 } });
    const exported = exportSandboxSubtree(sandbox, selectedPath, destination, {
      // Admit the injected extra file so the negative case reaches subtree validation.
      quotas: { maxFiles: 3, maxFileBytes: 3, maxTotalBytes: 4 },
    });
    if (invalid) {
      await assert.rejects(exported, (error: unknown) => error instanceof SandboxOperationError && error.code === "driver_failure");
      assert.equal(selectedFixture.outsideBodyPulled, false);
      await assert.rejects(stat(destination), { code: "ENOENT" });
    } else {
      const result = await exported;
      subtreeSummary = result.summary;
      assert.equal(result.directory, join(destination, "files"));
      assert.equal(result.summary.files, 2n);
      assert.equal(result.summary.directories, 3n);
      assert.equal(result.summary.payloadBytes, 3n);
      assert.deepEqual(await readdir(result.directory), ["reports"]);
      assert.deepEqual(await readdir(join(result.directory, "reports")), ["selected"]);
      assert.deepEqual((await readdir(join(result.directory, selectedPath))).sort(), ["empty", "nested", "zero.bin"]);
      assert.deepEqual(await readdir(join(result.directory, selectedPath, "empty")), []);
      assert.equal((await stat(join(result.directory, selectedPath, "zero.bin"))).size, 0);
      assert.deepEqual(await readdir(join(result.directory, selectedPath, "nested")), ["result.bin"]);
      assert.deepEqual(await readFile(join(result.directory, selectedPath, "nested", "result.bin")), Buffer.from([0, 255, 99]));
    }
    assert.deepEqual([...selectedFixture.resources], ["storage"]);
  } finally { await selectedOwner.destroy(); }
  assert.deepEqual([...selectedFixture.resources], []);
}
assert(subtreeSummary);

const failed = controlledBackend(spillDirectory, { failFirstDestroy: true });
const original = new Error("controlled callback failure");
let retained: unknown;
try { await withSandbox(failed.backend, explicitUntilStopped, async () => { throw original; }, { recovery: { kind: "in_process" } }); }
catch (error) { retained = error; }
assert(retained instanceof SandboxRunError);
assert.equal(retained.primaryError, original);
assert(retained.cleanupError instanceof SandboxCleanupError);
assert.equal(retained.cleanupError.owner, retained.owner);
assert.deepEqual([...failed.resources], ["storage"]);
await retained.retryCleanup();
assert.deepEqual([...failed.resources], []);
assert.equal(retained.primaryError, original);
process.stdout.write(`${JSON.stringify({ proof: "packed-neutral-sandbox", optionalPeers: "absent", docker: "absent",
  capabilityAdmission: { defaultFiles: "disabled", unsupportedFileGrants: ["read_only", "read_write"],
    unsupportedNetwork: "restricted_https", rejectedBeforeDriverReservation: true },
  normalizedExecution, binaryEcho: [0, 255, 206, 177, 10], exportedBytes: [0, 255, 10], cleanup: "destroyed", originalFailureRetained: true,
  filesystem: { example: "examples/sandbox/filesystem.ts", files: filesystemSummary.files.toString(),
    directories: filesystemSummary.directories.toString(), symlinks: filesystemSummary.symlinks.toString(), payloadBytes: filesystemSummary.payloadBytes.toString(),
    binary: [0, 255, 17, 128, 10], emptyBytes: 0, executable: true, publication: "complete",
    existingDestination: "preserved", lateFailure: "unpublished", cleanup: "destroyed" },
  subtree: { example: "examples/sandbox/filesystem.ts#exportSandboxSubtree", path: selectedPath,
    files: subtreeSummary.files.toString(), directories: subtreeSummary.directories.toString(), symlinks: subtreeSummary.symlinks.toString(), payloadBytes: subtreeSummary.payloadBytes.toString(),
    binary: [0, 255, 99], paths: "workspace_relative", outsideOutput: "rejected_before_body", invalidPublication: "absent", cleanup: "destroyed" } })}\n`);
