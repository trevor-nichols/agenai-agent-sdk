// ------------------------------------------------------------------------------------------------
//                owner.mjs - Installed sandbox setup, actual reader joins and exact cleanup recovery
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSandboxRequest, SANDBOX_DEFAULT_TRANSFER_BUFFERS, SANDBOX_DEFAULT_STREAM_LIMITS, SandboxCleanupError } from '@agen-ai/sandbox';
import { importSandboxDirectory, SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { failure } from '../scalability/configuration.mjs';
import { observeAbsent } from '../scalability/resources.mjs';

export function qualificationRequest() {
  return parseSandboxRequest({ policy: { resources: { cpus: 2, memoryBytes: 1024 ** 3, pids: 128 },
    temporaryStorage: { homeBytes: 32 * 1024 ** 2, tempBytes: 32 * 1024 ** 2 }, network: { kind: 'isolated' },
    execution: { kind: 'until_stopped' }, deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, maxOutputBytes: 64 * 1024 } } });
}

async function collect(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) { length += chunk.length; assert(length <= 16 * 1024); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function withWorkspace({ id, fixture, backend, options, proxy, report, checkpoint, setPhase, signal, claimPublishedNamespace }, run) {
  const directory = join(options.output, id);
  await mkdir(directory, { mode: 0o700 });
  const evidence = { id, status: 'running', fixture: { directory: fixture.directory, files: fixture.files, payloadBytes: fixture.payloadBytes },
    recoveryPath: join(directory, 'recovery.json'), primaryFailure: null, cleanupFailures: [], observations: [], details: {} };
  report.workspaces.push(evidence);
  const encode = (value) => `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2)}\n`;
  const owner = backend.reserve(qualificationRequest(), { kind: 'persisted', persist: async (record) => {
    await writeFile(`${evidence.recoveryPath}.next`, encode(record), { mode: 0o600 });
    await rename(`${evidence.recoveryPath}.next`, evidence.recoveryPath);
  } });
  let readers;
  let primary;
  try {
    proxy.setRow(`${id}-setup`); setPhase(`${id}-import`);
    const sandbox = await owner.start({ signal });
    evidence.details.import = await importSandboxDirectory(sandbox, fixture.directory, { signal });
    assert.equal(evidence.details.import.files, BigInt(fixture.files + 2));
    setPhase(`${id}-guest`);
    const guest = await readFile(new URL('./guest.mjs', import.meta.url), 'utf8');
    assert(Buffer.byteLength(guest) <= 16 * 1024);
    const processOwner = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['--input-type=module', '-e', guest, sandbox.workspace],
      cwd: sandbox.workspace, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/sandbox', TMPDIR: '/tmp' } });
    const streams = await processOwner.start({ signal }); streams.stdin.end();
    const work = [collect(streams.stdout), collect(streams.stderr), streams.exit];
    readers = Promise.allSettled(work);
    const [stdout, stderr, exit] = await Promise.all(work);
    assert.deepEqual(exit, { kind: 'exited', code: 0 }, `Guest setup failed: ${stderr}`);
    assert.equal(stderr, '');
    evidence.details.guest = JSON.parse(stdout);
    assert.equal(evidence.details.guest.verification.files, fixture.files);
    assert.equal(evidence.details.guest.verification.payloadBytes, fixture.payloadBytes);
    assert.equal(evidence.details.guest.verification.aggregateSha256, fixture.aggregateSha256);
    await sandbox.stop();
    evidence.observations.push(...await observeAbsent(options.endpoint, owner.recoveryRecord, `${id}-before-selected-reads`, ['compute']));
    await proxy.idle();
    await checkpoint();
    await run({ sandbox, owner, evidence, directory });
  } catch (error) {
    primary = error; evidence.primaryFailure = failure(error);
    if (error instanceof SandboxDirectoryCleanupError) {
      evidence.details.directoryCleanup = { directory: error.directory, publishedDirectory: error.publishedDirectory ?? null, originalFailurePreserved: true };
      try {
        await error.retryCleanup(); evidence.details.directoryCleanup.retry = 'settled';
        if (error.publishedDirectory) await claimPublishedNamespace(error.directory);
      } catch (cleanupError) { evidence.cleanupFailures.push(failure(cleanupError)); evidence.details.directoryCleanup.retry = 'failed'; }
    }
  }
  finally {
    setPhase(`${id}-cleanup`);
    try {
      await owner.destroy();
      assert(!evidence.expectCleanupAcknowledgementLoss, 'Exact cleanup-ack fault was not observed.');
    } catch (error) {
      if (evidence.expectCleanupAcknowledgementLoss && error instanceof SandboxCleanupError && error.owner === owner) {
        evidence.details.expectedCleanupFailure = failure(error);
        try { await error.retryCleanup(); evidence.details.cleanupRecovered = true; }
        catch (cleanupError) { evidence.cleanupFailures.push(failure(cleanupError)); }
      } else evidence.cleanupFailures.push(failure(error));
    }
    if (readers) for (const result of await readers) if (result.status === 'rejected' && result.reason !== primary) evidence.cleanupFailures.push(failure(result.reason));
    evidence.recoveryRecord = owner.recoveryRecord;
    try { evidence.observations.push(...await observeAbsent(options.endpoint, owner.recoveryRecord, `${id}-after-destroy`)); }
    catch (error) { evidence.cleanupFailures.push(failure(error)); }
    evidence.status = evidence.primaryFailure !== null || evidence.cleanupFailures.length ? 'failed' : 'passed';
    await checkpoint();
  }
  assert.equal(evidence.status, 'passed', `Owned ${id} workspace failed; inspect primary and cleanup evidence.`);
}
