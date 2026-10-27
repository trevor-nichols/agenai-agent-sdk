// ------------------------------------------------------------------------------------------------
//                backend.ts - Controlled physical-resource fixture - Neutral backend driver
// ------------------------------------------------------------------------------------------------

import { Readable, Writable } from 'node:stream';
import { createSandboxBackend } from '../../src/backend/index.js';
import type { SandboxBackendDriver, SandboxDriverReady, SandboxDriverStartOptions } from '../../src/backend/index.js';
import type { SandboxDriverSpillStore } from '../../src/backend/spill.js';
import { parseSandboxGuestPath, parseSandboxId, parseSandboxNamespace, parseSandboxProcessId, parseSandboxRelativePath,
  parseSandboxRequest, parseSandboxRecoveryRecord, SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '../../src/index.js';
import { fileFromBytes } from '../../src/files/bytes.js';
import type { Sandbox, SandboxExecutionPolicy, SandboxExportEntry, SandboxTreeEntry, SandboxProcessExit, SandboxProcessStreams, SandboxRecoveryRecord, SandboxRequest } from '../../src/index.js';

export function gate<T = void>() { return Promise.withResolvers<T>(); }

export function request(overrides: { startupMs?: number; cleanupMs?: number; execution?: SandboxExecutionPolicy; maxOutputBytes?: number;
  maxBufferedOutputBytes?: number; maxBufferedInputBytes?: number; highWaterMarkBytes?: number; maxStdinBytes?: number } = {}): SandboxRequest {
  return parseSandboxRequest({ policy: {
    resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
    temporaryStorage: { homeBytes: 16 * 1024 ** 2, tempBytes: 16 * 1024 ** 2 },
    network: { kind: 'isolated' },
    ...(overrides.execution === undefined ? {} : { execution: overrides.execution }),
    deadlines: { startupMs: overrides.startupMs ?? 1000, cleanupMs: overrides.cleanupMs ?? 1000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS,
    streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS,
      ...(overrides.maxOutputBytes === undefined ? {} : { maxOutputBytes: overrides.maxOutputBytes }),
      ...(overrides.maxBufferedOutputBytes === undefined ? {} : { maxBufferedOutputBytes: overrides.maxBufferedOutputBytes }),
      ...(overrides.maxBufferedInputBytes === undefined ? {} : { maxBufferedInputBytes: overrides.maxBufferedInputBytes }),
      ...(overrides.highWaterMarkBytes === undefined ? {} : { highWaterMarkBytes: overrides.highWaterMarkBytes }),
      ...(overrides.maxStdinBytes === undefined ? {} : { maxStdinBytes: overrides.maxStdinBytes }),
    },
  } });
}

export const processSpec = Object.freeze({ executable: parseSandboxGuestPath('/bin/fixture'), args: [], env: {}, cwd: parseSandboxGuestPath('/workspace') });
export const inputFile = (text: string): SandboxTreeEntry => fileFromBytes('input.txt', Buffer.from(text));
export const artifactPath = parseSandboxRelativePath('artifact.bin');
const digest = `sha256:${'1'.repeat(64)}`;

export interface FixtureOptions {
  readonly transferSymlinks?: boolean;
  readonly startupReply?: Promise<void>;
  readonly processReply?: Promise<void>;
  readonly stopGate?: Promise<void>;
  readonly importGate?: Promise<void>;
  readonly exportGate?: Promise<void>;
  readonly ignoreFileCancellation?: boolean;
  readonly output?: Readable;
  readonly errorOutput?: Readable;
  readonly input?: Writable;
  readonly failFirstStop?: boolean;
  readonly failFirstDestroy?: boolean;
  readonly malformedCheckpoint?: boolean;
  readonly changedCheckpointIdentity?: 'operationId' | 'configurationDigest';
  readonly decorateReady?: (ready: SandboxDriverReady) => SandboxDriverReady;
  readonly failFirstSpillClose?: boolean;
  readonly spillCloseGate?: Promise<void>;
}

/** A physical-resource port: shutdown removes compute; storage has an independent lifetime. */
export function fixture(options: FixtureOptions = {}) {
  const acquired = gate(); const stopping = gate(); const destroying = gate(); const importing = gate(); const exporting = gate();
  const processEntered = gate();
  const resources = new Set<'compute' | 'storage'>();
  const files = new Map<string, Uint8Array>();
  const symlinks = new Map<string, string>();
  const directories = new Set<string>();
  const inputBytes: number[] = [];
  const leader = gate<SandboxProcessExit>();
  const output = options.output ?? new Readable({ read() {} });
  const errorOutput = options.errorOutput ?? new Readable({ read() {} });
  const input = options.input ?? new Writable({ write(chunk: Buffer, _encoding, callback) {
    inputBytes.push(...chunk);
    output.push(Buffer.from(chunk));
    callback();
  } });
  const streams: SandboxProcessStreams = { stdin: input, stdout: output, stderr: errorOutput, exit: leader.promise };
  let processStarted = false;
  let importCount = 0;
  let stopAttempts = 0;
  let destroyAttempts = 0;
  let spillFiles = 0;
  let spillCloseAttempts = 0;
  let current: SandboxRecoveryRecord = parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'fixture', backendRevision: '1',
    namespace: parseSandboxNamespace('fixture-owner'), operationId: 'operation-1', sandboxId: parseSandboxId('sandbox-1'),
    imageDigest: digest, policyDigest: digest, configurationDigest: `sha256:${'3'.repeat(64)}`, phase: 'reserved', authority: { kind: 'unverified' },
    resources: [{ role: 'compute', name: 'compute-1', identity: { kind: 'planned' } }, { role: 'storage', name: 'storage-1', identity: { kind: 'planned' } }],
  });
  const stop = async () => {
    stopAttempts += 1;
    stopping.resolve();
    if (options.failFirstStop && stopAttempts === 1) throw new Error('physical stop failed');
    await options.stopGate;
    resources.delete('compute');
    input.destroy(); output.destroy(); errorOutput.destroy();
    leader.resolve({ kind: 'unavailable', reason: 'sandbox_stopped' });
  };
  const destroy = async () => {
    destroyAttempts += 1;
    destroying.resolve();
    if (resources.has('compute')) throw new Error('storage destruction with active compute');
    if (options.failFirstDestroy && destroyAttempts === 1) throw new Error('physical storage cleanup failed');
    resources.delete('storage'); files.clear(); symlinks.clear();
  };
  const driver: SandboxBackendDriver = {
    support: { backendId: 'fixture', backendRevision: '1', networkModes: ['isolated'], workspaceDiskQuota: false, networkAllowlist: false, independentProcessTermination: false,
      transferSymlinks: options.transferSymlinks ? { kind: 'preserve_internal', import: 'empty_workspace' } : false },
    reserve(admitted) {
      const checkpoint = async (context: SandboxDriverStartOptions, record: SandboxRecoveryRecord) => {
        current = record;
        await context.checkpoint(record);
      };
      return { id: current.sandboxId, get recoveryRecord() { return current; },
        async start(context) {
          await checkpoint(context, { ...current, phase: 'starting', authority: { kind: 'verified', backendIdentity: 'engine-1' } });
          await checkpoint(context, { ...current, resources: current.resources.map((resource) => ({ ...resource, identity: { kind: 'creating' } })) });
          resources.add('compute'); resources.add('storage');
          await checkpoint(context, { ...current, phase: 'running', resources: current.resources.map((resource) => ({ ...resource,
            identity: { kind: 'identified', id: `${resource.role}-id-1`, fingerprint: digest } })) });
          acquired.resolve();
          if (options.malformedCheckpoint) await context.checkpoint({ ...current, imageDigest: 'bad-digest' });
          if (options.changedCheckpointIdentity) await context.checkpoint({ ...current,
            [options.changedCheckpointIdentity]: options.changedCheckpointIdentity === 'operationId' ? 'replacement-operation' : `sha256:${'2'.repeat(64)}` });
          await options.startupReply;
          const ready: SandboxDriverReady = {
            effective: { backendIdentity: 'engine-1', isolation: 'container', resources: admitted.policy.resources,
              temporaryStorage: admitted.policy.temporaryStorage, network: admitted.policy.network,
              nonRoot: true, readOnlyRoot: true, workspaceDiskQuota: { kind: 'not_requested' } },
            workspace: parseSandboxGuestPath('/workspace'),
            async openSpill() {
              const handles = new Set<ReturnType<typeof memorySpillFile>>();
              const store: SandboxDriverSpillStore = {
                async createFile() {
                  spillFiles += 1;
                  const handle = memorySpillFile(() => { spillFiles -= 1; });
                  handles.add(handle);
                  return handle;
                },
                async close() {
                  spillCloseAttempts += 1;
                  await options.spillCloseGate;
                  if (options.failFirstSpillClose && spillCloseAttempts === 1) throw new Error('spill close failed');
                  await Promise.all([...handles].map((handle) => handle.close()));
                },
              };
              return store;
            },
            async importTree(values, operation) {
              importCount += 1; importing.resolve();
              if (options.ignoreFileCancellation) await options.importGate;
              else await abortable(options.importGate, operation.signal);
              let imported = 0n; let importedDirectories = 0n; let importedSymlinks = 0n; let payloadBytes = 0n;
              for await (const value of values) {
                if (value.kind === 'directory') { directories.add(value.path); importedDirectories += 1n; continue; }
                if (value.kind === 'symlink') { symlinks.set(value.path, value.target); importedSymlinks += 1n; continue; }
                const chunks: Uint8Array[] = [];
                for await (const chunk of value.open({ signal: operation.signal })) chunks.push(chunk);
                const payload = Buffer.concat(chunks);
                files.set(value.path, payload);
                imported += 1n; payloadBytes += BigInt(payload.byteLength);
              }
              return { files: imported, directories: importedDirectories, symlinks: importedSymlinks, payloadBytes, archiveBytes: payloadBytes };
            },
            reserveProcess() {
              return { id: parseSandboxProcessId('process-1'), async start() {
                processStarted = true; processEntered.resolve();
                await options.processReply;
                return streams;
              } };
            },
            async exportTree(selection, consume, operation) {
              exporting.resolve();
              if (options.ignoreFileCancellation) await options.exportGate;
              else await abortable(options.exportGate, operation.signal);
              const paths: string[] = [];
              if (selection.kind === 'files') { for await (const path of selection.paths) paths.push(path); }
              else if (selection.kind === 'subtree') {
                for (const path of [...directories, ...files.keys(), ...symlinks.keys()]) {
                  if (path === selection.path || path.startsWith(`${selection.path}/`)) paths.push(path);
                }
              }
              else paths.push(...directories, ...files.keys(), ...symlinks.keys());
              let exported = 0n; let exportedDirectories = 0n; let exportedSymlinks = 0n; let payloadBytes = 0n;
              for (const path of paths) {
                const target = symlinks.get(path);
                if (target !== undefined) { await consume({ kind: 'symlink', path, target }, { signal: operation.signal }); exportedSymlinks += 1n; continue; }
                if (selection.kind !== 'files' && directories.has(path)) {
                  await consume({ kind: 'directory', path }, { signal: operation.signal }); exportedDirectories += 1n; continue;
                }
                const payload = files.get(path);
                if (payload === undefined) continue;
                await consume({ kind: 'file', path, byteLength: payload.byteLength, executable: false,
                  bytes: { async *[Symbol.asyncIterator]() {
                    for (let offset = 0; offset < payload.byteLength; offset += operation.buffers.chunkBytes) yield payload.slice(offset, offset + operation.buffers.chunkBytes);
                  } } }, { signal: operation.signal });
                exported += 1n; payloadBytes += BigInt(payload.byteLength);
              }
              return { files: exported, directories: exportedDirectories, symlinks: exportedSymlinks, payloadBytes, archiveBytes: payloadBytes };
            },
          };
          return options.decorateReady?.(ready) ?? ready;
        }, stop, destroy,
      };
    },
    async reconcile(record) { return { kind: 'matched', owner: { get recoveryRecord() { return record; }, stop, destroy } }; },
  };
  return { backend: createSandboxBackend(driver), driver, resources, files, symlinks, acquired, stopping, destroying, importing, exporting,
    processEntered, output, errorOutput, input, inputBytes, leader,
    get processStarted() { return processStarted; }, get importCount() { return importCount; }, get stopAttempts() { return stopAttempts; }, get destroyAttempts() { return destroyAttempts; },
    get spillFiles() { return spillFiles; }, get spillCloseAttempts() { return spillCloseAttempts; } };
}

function memorySpillFile(released: () => void) {
  let content = new Uint8Array();
  let closed = false;
  return {
    async read(buffer: Uint8Array, offset: number, length: number, position: number) {
      const bytesRead = Math.max(0, Math.min(length, content.byteLength - position));
      buffer.set(content.subarray(position, position + bytesRead), offset);
      return { bytesRead };
    },
    async write(buffer: Uint8Array, offset: number, length: number, position: number) {
      if (position + length > content.byteLength) { const next = new Uint8Array(position + length); next.set(content); content = next; }
      content.set(buffer.subarray(offset, offset + length), position);
      return { bytesWritten: length };
    },
    async truncate(size: number) { content = content.slice(0, size); },
    async close() { if (!closed) { closed = true; content = new Uint8Array(); released(); } },
  };
}

/** Small-fixture collector with an explicit application byte budget. */
export async function exportFiles(sandbox: Sandbox, paths: readonly string[]) {
  const result: { path: string; bytes: Uint8Array; executable: boolean }[] = [];
  await sandbox.exportTree({ kind: 'files', paths }, async (entry) => {
    if (entry.kind !== 'file') throw new Error('expected regular file');
    result.push({ path: entry.path, bytes: await entryBytes(entry), executable: entry.executable });
  }, { quotas: { maxTotalBytes: 1024 * 1024 } });
  return result;
}

export async function entryBytes(entry: Extract<SandboxExportEntry, { kind: 'file' }>): Promise<Uint8Array> {
  if (entry.byteLength > 1024 * 1024) throw new Error('fixture byte budget exceeded');
  const chunks: Uint8Array[] = [];
  for await (const chunk of entry.bytes) chunks.push(chunk);
  return Uint8Array.from(Buffer.concat(chunks));
}

async function abortable(pending: Promise<void> | undefined, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  if (!pending) return;
  const interrupted = gate<never>();
  const abort = () => interrupted.reject(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try { await Promise.race([pending, interrupted.promise]); }
  finally { signal?.removeEventListener('abort', abort); }
}

export async function bytes(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function nextTurn(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
