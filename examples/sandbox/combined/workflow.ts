import assert from 'node:assert/strict';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { fileFromBytes, parseSandboxRequest, SandboxStateError } from '@agen-ai/sandbox';
import type {
  SandboxBackend, SandboxFileReadResult, SandboxFileWriteResult, SandboxProcessExit, SandboxRecoveryPolicy,
  SandboxRecoveryRecord, SandboxRequestInput, SandboxReservation, SandboxTransferOptions, SandboxTransferSummary,
} from '@agen-ai/sandbox';
import { exportSandboxDirectory, SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { COMBINED_FILES, COMBINED_GUEST_PROGRAM } from './program.js';
import { CombinedProgramSession } from './session.js';
import type { CombinedForbiddenFixture, CombinedHttpsFixture, CombinedNetworkObservation } from './session.js';

export type CombinedWorkflowPhase = 'reserved' | 'started' | 'imported' | 'process_started' | 'live_read'
  | 'live_write_entered' | 'live_written' | 'network_verified' | 'program_verified' | 'stop_requested'
  | 'cancel_write_entered' | 'cancel_write_settled' | 'stop_entered' | 'stopped' | 'exported' | 'destroy_requested' | 'destroyed';

export interface CombinedWorkflowObservation {
  readonly phase: CombinedWorkflowPhase;
  readonly sandboxId: string;
}

export interface CombinedWorkflowOptions {
  /** Construct explicitly with caller-owned images, spill storage, helpers, authority and namespace. */
  readonly backend: SandboxBackend;
  readonly request: SandboxRequestInput;
  readonly recovery: SandboxRecoveryPolicy;
  readonly mode: 'normal' | 'cancel';
  /** Bounds individual controlled-program observations, not the sandbox's execution lifetime. */
  readonly operationTimeoutMs: number;
  readonly positive: CombinedHttpsFixture;
  readonly forbidden: CombinedForbiddenFixture;
  /** Fresh host destination beneath an existing physical directory exclusively owned by the caller. */
  readonly destination: string;
  readonly transferOptions?: (operation: 'import' | 'export') => Omit<SandboxTransferOptions, 'symlinks'>;
  /** Awaited audit delivery. A failure aborts the workflow and preserves the original error. */
  readonly onObservation?: (observation: CombinedWorkflowObservation) => Promise<void>;
}

export interface CombinedWorkflowResult {
  readonly mode: 'normal' | 'cancel';
  readonly network: CombinedNetworkObservation;
  readonly live: Readonly<{ read: SandboxFileReadResult; write: SandboxFileWriteResult }>;
  readonly processExit: SandboxProcessExit;
  readonly cancellation: Readonly<{ kind: 'not_requested' }> | Readonly<{
    kind: 'entered_write'; receipt: SandboxFileWriteResult; sourceJoined: 1;
  }>;
  readonly imported: SandboxTransferSummary;
  readonly exported: SandboxTransferSummary;
  readonly directory: string;
  readonly recoveryRecord: SandboxRecoveryRecord;
}

export class CombinedSandboxWorkflowError extends AggregateError {
  constructor(
    readonly primaryFailure: Readonly<{ error: unknown }> | undefined,
    readonly cleanupFailures: readonly Readonly<{ operation: string; error: unknown }>[],
    readonly owner: SandboxReservation,
    readonly retryCleanup: () => Promise<void>,
    readonly readerFailures: readonly unknown[] = [],
  ) {
    super([...(primaryFailure ? [primaryFailure.error] : []), ...readerFailures, ...cleanupFailures.map(({ error }) => error)],
      'Combined sandbox workflow failed; original errors and any cleanup ownership are retained.');
    this.name = 'CombinedSandboxWorkflowError';
  }
}

const encoder = new TextEncoder();
const expectedFiles = Object.freeze({
  'source.txt': { text: COMBINED_FILES.source, executable: false },
  'live.txt': { text: COMBINED_FILES.replacementLive, executable: false },
  'tool.sh': { text: COMBINED_FILES.tool, executable: true },
  'program.mjs': { text: COMBINED_GUEST_PROGRAM, executable: false },
  'result.txt': { text: COMBINED_FILES.result, executable: false },
});

async function verifyExport(directory: string, summary: SandboxTransferSummary): Promise<void> {
  assert.deepEqual((await readdir(directory)).sort(), [...Object.keys(expectedFiles), 'source-link.txt'].sort());
  let payloadBytes = 0n;
  for (const [name, expected] of Object.entries(expectedFiles)) {
    const path = join(directory, name); const metadata = await lstat(path);
    assert(metadata.isFile(), `Final ${name} is not a regular file.`);
    assert.equal(metadata.mode & 0o777, expected.executable ? 0o700 : 0o600);
    assert.equal(await readFile(path, 'utf8'), expected.text);
    payloadBytes += BigInt(encoder.encode(expected.text).byteLength);
  }
  assert((await lstat(join(directory, 'source-link.txt'))).isSymbolicLink());
  assert.equal(await readlink(join(directory, 'source-link.txt')), 'source.txt');
  assert.equal(summary.files, 5n); assert.equal(summary.directories, 0n); assert.equal(summary.symlinks, 1n);
  assert.equal(summary.payloadBytes, payloadBytes);
}

function validateOptions(options: CombinedWorkflowOptions): void {
  assert(options.mode === 'normal' || options.mode === 'cancel');
  assert(Number.isSafeInteger(options.operationTimeoutMs) && options.operationTimeoutMs > 0 && options.operationTimeoutMs <= 2_147_483_647);
  assert(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(options.positive.hostname));
  assert(Number.isInteger(options.positive.port) && options.positive.port >= 1 && options.positive.port <= 65535);
  assert(/^\/[\u0021-\u007e]*$/u.test(options.positive.path) && options.positive.path.length <= 2048);
  assert(Number.isInteger(options.positive.status) && options.positive.status >= 100 && options.positive.status <= 599);
  assert(Number.isSafeInteger(options.positive.bodyBytes) && options.positive.bodyBytes >= 0 && options.positive.bodyBytes <= 262_144);
  assert(/^[a-f0-9]{64}$/u.test(options.positive.bodySha256));
  assert(/^[a-z0-9.-]{1,253}$/u.test(options.forbidden.hostname));
  assert.equal(net.isIP(options.forbidden.address), 4, 'Select an explicit IPv4 forbidden fixture.');
  assert(Number.isInteger(options.forbidden.port) && options.forbidden.port >= 1 && options.forbidden.port <= 65535);
  for (const value of [options.forbidden.probe, options.forbidden.marker]) assert(value.length > 0 && Buffer.byteLength(value) <= 4096);
}

async function withinObservation<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Explicit combined-workflow observation deadline.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Provider-neutral linked import, live mutation, verified HTTPS, cancellation and final publication. */
export async function runCombinedSandboxWorkflow(options: CombinedWorkflowOptions): Promise<CombinedWorkflowResult> {
  validateOptions(options);
  const request = parseSandboxRequest(options.request);
  assert.equal(request.policy.files.kind, 'read_write', 'The combined example requires an explicit read_write grant.');
  assert.equal(request.policy.network.kind, 'restricted_https', 'The combined example requires an explicit restricted_https policy.');
  if (request.policy.network.kind === 'restricted_https') {
    assert(request.policy.network.destinations.some(({ hostname, port }) => hostname === options.positive.hostname && port === options.positive.port),
      'The positive HTTPS fixture must be explicitly admitted.');
    assert(!request.policy.network.destinations.some(({ hostname, port }) => hostname === options.forbidden.hostname && port === options.forbidden.port),
      'The forbidden CONNECT fixture must be omitted from this example policy.');
  }
  const owner = options.backend.reserve(request, options.recovery);
  const observe = (phase: CombinedWorkflowPhase) => options.onObservation?.({ phase, sandboxId: owner.id });
  let session: CombinedProgramSession | undefined;
  let heldWriter: Readonly<{ release(): void; joined(): number }> | undefined;
  let artifactCleanup: SandboxDirectoryCleanupError | undefined;
  let primaryFailure: Readonly<{ error: unknown }> | undefined;
  const cleanupFailures: Array<Readonly<{ operation: string; error: unknown }>> = [];
  let result: Omit<CombinedWorkflowResult, 'recoveryRecord'> | undefined;
  const cleanup = async () => {
    const failures: unknown[] = [];
    heldWriter?.release();
    session?.beginStop();
    try { await owner.destroy(); } catch (error) { failures.push(error); }
    if (owner.state.kind === 'destroyed') await session?.settle();
    if (artifactCleanup) {
      try { await artifactCleanup.retryCleanup(); artifactCleanup = undefined; } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Combined sandbox cleanup remains owned.');
  };
  try {
    await observe('reserved');
    const sandbox = await owner.start(); await observe('started');
    const imported = await sandbox.importTree([
      fileFromBytes('source.txt', encoder.encode(COMBINED_FILES.source)),
      { kind: 'symlink', path: 'source-link.txt', target: 'source.txt' },
      fileFromBytes('live.txt', encoder.encode(COMBINED_FILES.initialLive)),
      fileFromBytes('tool.sh', encoder.encode(COMBINED_FILES.tool), { executable: true }),
      fileFromBytes('program.mjs', encoder.encode(COMBINED_GUEST_PROGRAM)),
    ], { ...options.transferOptions?.('import'), symlinks: 'preserve_internal' });
    assert.equal(imported.files, 4n); assert.equal(imported.symlinks, 1n); await observe('imported');
    const processOwner = sandbox.reserveProcess({ executable: '/usr/local/bin/node',
      args: [`${sandbox.workspace}/program.mjs`, String(options.operationTimeoutMs)], env: {}, cwd: sandbox.workspace });
    const streams = await processOwner.start();
    session = new CombinedProgramSession(streams, options.operationTimeoutMs); await session.ready(); await observe('process_started');
    const files = sandbox.files;
    assert.equal(files.kind, 'read_write');
    if (files.kind !== 'read_write') throw new Error('Configured backend did not provide the admitted live grant.');
    const readChunks: Uint8Array[] = [];
    const read = await files.readFile('live.txt', async ({ chunks }) => {
      for await (const chunk of chunks) readChunks.push(Uint8Array.from(chunk));
    }, { quotas: { maxBytes: Buffer.byteLength(COMBINED_FILES.initialLive) } });
    assert.equal(read.kind, 'completed'); assert.equal(Buffer.concat(readChunks).toString('utf8'), COMBINED_FILES.initialLive);
    await observe('live_read');
    async function* replacement() {
      await observe('live_write_entered');
      yield encoder.encode(COMBINED_FILES.replacementLive);
    }
    const write = await files.writeFile('live.txt', replacement(), { mode: 'replace', quotas: { maxBytes: Buffer.byteLength(COMBINED_FILES.replacementLive) } });
    assert.equal(write.kind, 'completed'); assert.equal(write.effect, 'published');
    assert.equal(write.bytes, BigInt(Buffer.byteLength(COMBINED_FILES.replacementLive))); await observe('live_written');
    const network = await session.network(options.positive, options.forbidden); await observe('network_verified');
    await session.verify(); await observe('program_verified');
    let cancelledReceipt: SandboxFileWriteResult | undefined;
    let normalExit: SandboxProcessExit | undefined;
    if (options.mode === 'normal') {
      session.finish(); normalExit = await withinObservation(streams.exit, options.operationTimeoutMs);
      assert.deepEqual(normalExit, { kind: 'exited', code: 0 });
    } else {
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const abort = new AbortController(); let sourceJoined = 0;
      heldWriter = { release: () => release.resolve(), joined: () => sourceJoined };
      const writing = files.writeFile('cancelled-write.txt', { async *[Symbol.asyncIterator]() {
        try {
          yield Uint8Array.of(1);
          await observe('cancel_write_entered'); entered.resolve();
          await release.promise; yield Uint8Array.of(2);
        } finally { sourceJoined++; }
      } }, { mode: 'create', signal: abort.signal, quotas: { maxBytes: 2 } });
      void writing.catch(() => {});
      await withinObservation(Promise.race([entered.promise, writing.then(() => {
        throw new Error('Cancellation write settled before its source entered.');
      })]), options.operationTimeoutMs);
      // Aborting entered live work itself initiates the SDK's owned whole-sandbox stop.
      session.beginStop();
      abort.abort(); cancelledReceipt = await withinObservation(writing, options.operationTimeoutMs);
      assert.deepEqual(cancelledReceipt, { kind: 'cancelled', reason: 'signal', effect: 'unknown', bytes: null });
      assert.equal(sourceJoined, 0); assert.throws(() => files.stat('.'), SandboxStateError);
      await observe('cancel_write_settled');
    }
    await observe('stop_requested');
    session.beginStop();
    const stopping = options.mode === 'cancel' ? processOwner.stop() : owner.stop();
    void stopping.catch(() => {});
    try { await observe('stop_entered'); } finally { heldWriter?.release(); }
    await stopping; assert(!heldWriter || heldWriter.joined() === 1); await observe('stopped');
    const processExit = normalExit ?? await streams.exit; await session.join();
    const exported = await exportSandboxDirectory(sandbox, { kind: 'workspace' }, options.destination,
      { ...options.transferOptions?.('export'), symlinks: 'preserve_internal' });
    await verifyExport(exported.directory, exported.summary); await observe('exported');
    const cancellation: CombinedWorkflowResult['cancellation'] = cancelledReceipt
      ? { kind: 'entered_write', receipt: cancelledReceipt, sourceJoined: 1 } : { kind: 'not_requested' };
    result = { mode: options.mode, network, live: { read, write }, processExit, cancellation, imported, exported: exported.summary, directory: exported.directory };
  } catch (error) {
    heldWriter?.release();
    primaryFailure = { error };
    if (error instanceof SandboxDirectoryCleanupError) artifactCleanup = error;
  }
  try { await observe('destroy_requested'); }
  catch (error) { primaryFailure ??= { error }; }
  session?.beginStop();
  try { await owner.destroy(); }
  catch (error) { cleanupFailures.push({ operation: 'sandbox-destroy', error }); }
  if (owner.state.kind === 'destroyed') {
    try { await observe('destroyed'); }
    catch (error) { primaryFailure ??= { error }; }
  }
  const readerFailure = owner.state.kind === 'destroyed' ? await session?.settle() : undefined;
  if (!primaryFailure && readerFailure) primaryFailure = { error: readerFailure };
  const readerFailures: readonly unknown[] = Object.freeze(readerFailure && readerFailure !== primaryFailure?.error
    ? readerFailure.errors.filter((error: unknown) => error !== primaryFailure?.error) : []);
  if (primaryFailure || cleanupFailures.length) throw new CombinedSandboxWorkflowError(primaryFailure, Object.freeze(cleanupFailures), owner, cleanup, readerFailures);
  assert(result, 'Combined workflow produced no completed result.');
  return { ...result, recoveryRecord: owner.recoveryRecord };
}
