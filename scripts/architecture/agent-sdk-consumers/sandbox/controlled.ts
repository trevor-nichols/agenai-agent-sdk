// ------------------------------------------------------------------------------------------------
//                controlled.ts - Bounded shared public-backend fixture for installed neutral proofs
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import {
  parseSandboxGuestPath, parseSandboxId, parseSandboxProcessId, parseSandboxRecoveryRecord,
  type SandboxExecutionPolicy, type SandboxProcessExit,
} from "@agen-ai/sandbox";
import { createSandboxBackend, type SandboxBackendDriver } from "@agen-ai/sandbox/backend";
import { createSandboxSpillStore } from "@agen-ai/sandbox/node";

export function controlledBackend(spillDirectory: string, configuration: { failFirstDestroy?: boolean; lateExportFailure?: Error; outsideSubtreePath?: string; preserveLinks?: boolean } = {}) {
  const resources = new Set<string>();
  const executionPolicies: SandboxExecutionPolicy[] = [];
  const files = new Map<string, Readonly<{ bytes: Uint8Array; executable: boolean }>>();
  const directoryPaths = new Set<string>();
  const links = new Map<string, string>();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exit = Promise.withResolvers<SandboxProcessExit>();
  let destroys = 0;
  let reserveCalls = 0;
  let reconcileCalls = 0;
  let outsideBodyPulled = false;
  const digest = `sha256:${"1".repeat(64)}`;
  let record = parseSandboxRecoveryRecord({ format: "agenai.sandbox-recovery.v3", backendId: "packed-controlled", backendRevision: "1",
    namespace: "packed-controlled", operationId: "packed-operation", sandboxId: "packed-sandbox", imageDigest: digest, policyDigest: digest, configurationDigest: digest,
    phase: "reserved", authority: { kind: "unverified" }, resources: [
      { role: "compute", name: "packed-compute", identity: { kind: "planned" } },
      { role: "storage", name: "packed-storage", identity: { kind: "planned" } },
    ],
  });
  const driver: SandboxBackendDriver = {
    support: { backendId: "packed-controlled", backendRevision: "1", networkModes: ["isolated"], workspaceDiskQuota: false,
      networkAllowlist: false, independentProcessTermination: false,
      transferSymlinks: configuration.preserveLinks ? { kind: "preserve_internal", import: "empty_workspace" } : false },
    reserve(request) {
      reserveCalls += 1;
      executionPolicies.push(request.policy.execution);
      return {
        id: parseSandboxId("packed-sandbox"), get recoveryRecord() { return record; },
        async start({ checkpoint }) {
          record = parseSandboxRecoveryRecord({ ...record, phase: "starting", authority: { kind: "verified", backendIdentity: "packed-backend" } });
          await checkpoint(record);
          record = parseSandboxRecoveryRecord({ ...record, resources: record.resources.map((resource) => ({ ...resource, identity: { kind: "creating" } })) });
          await checkpoint(record);
          resources.add("compute"); resources.add("storage");
          record = parseSandboxRecoveryRecord({ ...record, phase: "running", resources: record.resources.map((resource) => ({
            ...resource, identity: { kind: "identified", id: `${resource.role}-exact`, fingerprint: digest },
          })) });
          await checkpoint(record);
          return {
            effective: { backendIdentity: "packed-backend", isolation: "container", resources: request.policy.resources,
              temporaryStorage: request.policy.temporaryStorage, network: request.policy.network,
              nonRoot: true, readOnlyRoot: true, workspaceDiskQuota: { kind: "not_requested" } },
            workspace: parseSandboxGuestPath("/guest/workspace"),
            openSpill: (options) => createSandboxSpillStore({ directory: spillDirectory, ...options }),
            async importTree(input, options) {
              if (options.symlinks === "preserve_internal") assert.equal(files.size + directoryPaths.size + links.size, 0);
              let count = 0n;
              let directories = 0n;
              let symlinks = 0n;
              let payloadBytes = 0n;
              for await (const entry of input) {
                if (entry.kind === "directory") {
                  assert(directoryPaths.size < 8, "The small controlled fixture has an explicit directory budget.");
                  directoryPaths.add(entry.path); directories += 1n; continue;
                }
                if (entry.kind === "symlink") {
                  assert(links.size < 4, "The small controlled fixture has an explicit link budget.");
                  links.set(entry.path, entry.target); symlinks += 1n; continue;
                }
                assert(files.size < 8 && entry.byteLength <= 64 && payloadBytes + BigInt(entry.byteLength) <= 128n,
                  "The small controlled fixture has explicit file and payload budgets.");
                const bytes = new Uint8Array(entry.byteLength);
                let offset = 0;
                for await (const chunk of entry.open({ signal: options.signal })) {
                  bytes.set(chunk, offset); offset += chunk.byteLength;
                }
                assert.equal(offset, entry.byteLength);
                files.set(entry.path, { bytes, executable: entry.executable });
                count += 1n;
                payloadBytes += BigInt(bytes.byteLength);
              }
              return { files: count, directories, symlinks, payloadBytes, archiveBytes: 0n };
            },
            reserveProcess() {
              return { id: parseSandboxProcessId("packed-process"), async start() {
                const stdin = new Writable({
                  write(chunk: Buffer, _encoding, callback) { stdout.write(chunk, callback); },
                  final(callback) { stdout.end(); stderr.end(); exit.resolve({ kind: "exited", code: 0 }); callback(); },
                });
                return { stdin, stdout, stderr, exit: exit.promise };
              } };
            },
            async exportTree(selection, consume, options) {
              let count = 0n;
              let directories = 0n;
              let symlinks = 0n;
              let payloadBytes = 0n;
              const selected = (path: string) => selection.kind !== "subtree" || path === selection.path || path.startsWith(`${selection.path}/`);
              if (selection.kind !== "files") for (const path of directoryPaths) {
                if (!selected(path)) continue;
                await consume({ kind: "directory", path }, { signal: options.signal });
                directories += 1n;
              }
              const paths = selection.kind === "files" ? selection.paths : files.keys();
              for await (const path of paths) {
                if (!selected(path)) continue;
                const file = files.get(path);
                assert(file, "The controlled selected file must exist.");
                const { bytes, executable } = file;
                await consume({ kind: "file", path, byteLength: bytes.byteLength, executable,
                  bytes: { async *[Symbol.asyncIterator]() { yield bytes; } } }, { signal: options.signal });
                count += 1n;
                payloadBytes += BigInt(bytes.byteLength);
              }
              if (selection.kind !== "files") for (const [path, target] of links) {
                if (!selected(path)) continue;
                await consume({ kind: "symlink", path, target }, { signal: options.signal });
                symlinks += 1n;
              }
              if (selection.kind === "subtree" && configuration.outsideSubtreePath !== undefined) {
                await consume({ kind: "file", path: configuration.outsideSubtreePath, byteLength: 1, executable: false,
                  bytes: { async *[Symbol.asyncIterator]() { outsideBodyPulled = true; yield Uint8Array.from([73]); } } }, { signal: options.signal });
                count += 1n;
                payloadBytes += 1n;
              }
              if (configuration.lateExportFailure) throw configuration.lateExportFailure;
              return { files: count, directories, symlinks, payloadBytes, archiveBytes: 0n };
            },
          };
        },
        async stop() { resources.delete("compute"); stdout.destroy(); stderr.destroy(); exit.resolve({ kind: "unavailable", reason: "sandbox_stopped" }); },
        async destroy() {
          destroys += 1;
          if (configuration.failFirstDestroy && destroys === 1) throw new Error("controlled storage cleanup failure");
          resources.delete("storage"); files.clear(); directoryPaths.clear(); links.clear();
        },
      };
    },
    async reconcile(retained) { reconcileCalls += 1; return { kind: "absent", record: retained }; },
  };
  return { backend: createSandboxBackend(driver), resources, executionPolicies,
    get reserveCalls() { return reserveCalls; }, get reconcileCalls() { return reconcileCalls; },
    get outsideBodyPulled() { return outsideBodyPulled; } };
}
