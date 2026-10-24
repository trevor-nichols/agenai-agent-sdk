// ------------------------------------------------------------------------------------------------
//                session-lifecycle.ts - Installed example native cleanup ownership proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId,
} from "@agen-ai/agent-protocol";
import { AgentProviderRegistryError, AgentProviderSessionCleanupError } from "@agen-ai/agent-runtime";
import { NodeAcpExecutionCleanupError } from "@agen-ai/provider-acp/node";
import {
  parseSandboxGuestPath, parseSandboxId, parseSandboxProcessId, parseSandboxRecoveryRecord,
  type Sandbox, type SandboxBackend, type SandboxExportEntry, type SandboxProcessExit,
} from "@agen-ai/sandbox";
import { isolatedSandboxRequest } from "./examples/sandbox/policy.js";
import { SandboxAcpSessionError, withSandboxAcpSession } from "./examples/sandbox/session.js";
import { collectSandboxFiles } from "./examples/sandbox/collect.js";

type Scenario = "materialization" | "session-opening" | "callback";

function controlledOwner(scenario: Scenario) {
  const resources = new Set(["compute", "storage"]);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exit = Promise.withResolvers<SandboxProcessExit>();
  const nativeFailure = new Error("controlled native startup failure");
  const shutdownFailure = new Error("controlled complete-workload stop failure");
  let nativeStarts = 0;
  let initializeCount = 0;
  let sessionCreates = 0;
  let stopAttempts = 0;
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    try {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const frame: { id: string | number; method: string } = JSON.parse(line);
        if (frame.method === "initialize") {
          initializeCount += 1;
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
            protocolVersion: 1, agentInfo: { name: "installed-lifecycle-peer", version: "1" }, authMethods: [],
          } })}\n`);
        } else if (frame.method === "session/new") {
          sessionCreates += 1;
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id,
            ...(scenario === "session-opening" ? { error: { code: -32000, message: "controlled session opening failure" } }
              : { result: { sessionId: "installed-lifecycle-session" } }),
          })}\n`);
        } else throw new Error(`Unexpected controlled request ${frame.method}`);
      }
      callback();
    } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
  } });
  const record = parseSandboxRecoveryRecord({ format: "agenai.sandbox-recovery.v2", backendId: "installed-lifecycle", backendRevision: "1",
    namespace: "installed-lifecycle", operationId: "installed-operation", sandboxId: "installed-sandbox",
    imageDigest: `sha256:${"1".repeat(64)}`, policyDigest: `sha256:${"2".repeat(64)}`, configurationDigest: `sha256:${"3".repeat(64)}`,
    authority: { kind: "verified", backendIdentity: "controlled-backend" }, phase: "running", resources: [
      { role: "compute", name: "installed-compute", identity: { kind: "identified", id: "installed-compute-id", fingerprint: `sha256:${"3".repeat(64)}` } },
      { role: "storage", name: "installed-storage", identity: { kind: "identified", id: "installed-storage-id", fingerprint: `sha256:${"4".repeat(64)}` } },
    ],
  });
  const request = isolatedSandboxRequest();
  const sandbox: Sandbox = {
    id: parseSandboxId("installed-sandbox"), state: { kind: "ready" }, recoveryRecord: record,
    workspace: parseSandboxGuestPath("/guest/installed"),
    effective: { backendIdentity: "controlled-backend", isolation: "container", resources: request.policy.resources,
      temporaryStorage: request.policy.temporaryStorage, network: request.policy.network,
      nonRoot: true, readOnlyRoot: true, workspaceDiskQuota: { kind: "not_requested" } },
    async importTree() { return { files: 0n, directories: 0n, payloadBytes: 0n, archiveBytes: 0n }; },
    reserveProcess() { return {
      id: parseSandboxProcessId("installed-process"), stopScope: "sandbox",
      async start() {
        nativeStarts += 1;
        if (scenario === "materialization") throw nativeFailure;
        return { stdin, stdout, stderr, exit: exit.promise };
      },
      stop: () => sandbox.stop(),
    }; },
    async exportTree() { throw new Error("A failed workflow must never enter export."); },
    async stop() {
      stopAttempts += 1;
      if (stopAttempts === 1) throw shutdownFailure;
      resources.delete("compute");
      stdin.destroy(); stdout.destroy(); stderr.destroy();
      exit.resolve({ kind: "unavailable", reason: "sandbox_stopped" });
    },
    async destroy() { await sandbox.stop(); resources.delete("storage"); },
  };
  const backend: SandboxBackend = {
    support: { backendId: "installed-lifecycle", backendRevision: "1", networkModes: ["isolated"], workspaceDiskQuota: false,
      networkAllowlist: false, independentProcessTermination: false },
    reserve() { return { id: sandbox.id, state: sandbox.state, recoveryRecord: record, async start() { return sandbox; },
      stop: () => sandbox.stop(), destroy: () => sandbox.destroy(),
    }; },
    async reconcile() { throw new Error("This workflow must not reconcile or replay a connection."); },
  };
  return { backend, nativeFailure, shutdownFailure, resources,
    stopAttempts: () => stopAttempts,
    snapshot: () => ({ nativeStarts, initializeCount, sessionCreates }) };
}

const observations = [];
for (const scenario of ["materialization", "session-opening", "callback"] as const) {
  const fixture = controlledOwner(scenario);
  const callbackFailure = new Error("controlled caller failure");
  let retained: unknown;
  try {
    await withSandboxAcpSession({ backend: fixture.backend, request: isolatedSandboxRequest(), recovery: { kind: "in_process" }, entries: [],
      identity: { providerKey: parseAgentProviderKey("installed-lifecycle"), instanceId: parseAgentInstanceId("installed-lifecycle:instance"),
        sessionId: parseAgentSessionId("installed-lifecycle:session"), configurationRevision: parseAgentConfigurationRevisionId("installed-lifecycle:configuration") },
      launch: () => ({ executable: "/guest/bin/peer", args: [], env: {}, shutdownTimeoutMs: 15_000 }), exportPaths: [], maxExportBytes: 0,
    }, async () => { throw callbackFailure; });
  } catch (error) { retained = error; }
  assert(retained instanceof SandboxAcpSessionError);
  const original = retained.primaryFailure?.error;
  let verifyNativeCleanup: (() => Promise<void>) | undefined;
  if (scenario === "materialization") {
    assert(original instanceof AgentProviderRegistryError);
    assert(original.cause instanceof NodeAcpExecutionCleanupError);
    assert.equal(original.cause.cause, fixture.nativeFailure);
    const nativeOwner = original.cause;
    verifyNativeCleanup = () => nativeOwner.retryCleanup();
    assert.equal(retained.cleanupFailures.length, 0);
  } else if (scenario === "session-opening") {
    assert(original instanceof AgentProviderSessionCleanupError);
    verifyNativeCleanup = () => original.retryCleanup();
    assert.equal(retained.cleanupFailures.length, 0);
  } else {
    assert.equal(original, callbackFailure);
    assert.deepEqual(retained.cleanupFailures.map(({ operation }) => operation), ["provider-close"]);
  }
  await retained.retryCleanup();
  const stopped = fixture.stopAttempts();
  await verifyNativeCleanup?.();
  assert.equal(fixture.stopAttempts(), stopped, "The workflow retry must settle the exact native cleanup owner before returning.");
  assert.equal(retained.primaryFailure?.error, original);
  assert.deepEqual([...fixture.resources], []);
  assert.deepEqual(fixture.snapshot(), scenario === "materialization"
    ? { nativeStarts: 1, initializeCount: 0, sessionCreates: 0 }
    : { nativeStarts: 1, initializeCount: 1, sessionCreates: 1 });
  observations.push({ scenario, ...fixture.snapshot(), originalFailureRetained: true, explicitRetry: "joined", cleanup: "destroyed" });
}

const collectionFixture = controlledOwner("callback");
const collectionOwner = collectionFixture.backend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
const collectionSandbox = await collectionOwner.start();
function exporter(entries: readonly SandboxExportEntry[]): Sandbox {
  return { ...collectionSandbox, async exportTree(_selection, consume) {
    let files = 0n;
    let payloadBytes = 0n;
    for (const entry of entries) {
      await consume(entry, { signal: new AbortController().signal });
      if (entry.kind === "file") { files += 1n; payloadBytes += BigInt(entry.byteLength); }
    }
    return { files, directories: 0n, payloadBytes, archiveBytes: 0n };
  } };
}
const shared = Uint8Array.of(0, 255);
const collected = await collectSandboxFiles(exporter([{ kind: "file", path: "result.bin", byteLength: 3, executable: false,
  bytes: { async *[Symbol.asyncIterator]() { yield shared; shared[0] = 7; yield shared.subarray(0, 1); } },
}]), ["result.bin"], 3);
assert.deepEqual(collected.map((file) => ({ path: file.path, bytes: [...file.bytes], executable: file.executable })),
  [{ path: "result.bin", bytes: [0, 255, 7], executable: false }]);
await assert.rejects(collectSandboxFiles(exporter([{ kind: "file", path: "result.bin", byteLength: 4, executable: false,
  bytes: { async *[Symbol.asyncIterator]() { throw new Error("Over-budget bodies must not be pulled."); } },
}]), ["result.bin"], 3), /explicit aggregate byte budget/u);
const empty = (path: string): SandboxExportEntry => ({ kind: "file", path, byteLength: 0, executable: false,
  bytes: { async *[Symbol.asyncIterator]() { return; } } });
await assert.rejects(collectSandboxFiles(exporter([empty("one"), empty("two")]), ["one"], 0), /explicit regular-file count/u);
const lateFailure = new Error("late exported body failed");
await assert.rejects(collectSandboxFiles(exporter([{ kind: "file", path: "result.bin", byteLength: 3, executable: false,
  bytes: { async *[Symbol.asyncIterator]() { yield Uint8Array.of(23); throw lateFailure; } },
}]), ["result.bin"], 3), (error: unknown) => error === lateFailure);
await assert.rejects(collectionOwner.destroy(), (error: unknown) => error === collectionFixture.shutdownFailure);
await collectionOwner.destroy();
assert.deepEqual([...collectionFixture.resources], []);
process.stdout.write(`${JSON.stringify({ proof: "packed-sandbox-example-cleanup", evidence: "in-memory-public-acp", observations })}\n`);
