import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileFromBytes, SandboxOperationError, SandboxStateError, SandboxValidationError } from '@agen-ai/sandbox';
import { SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { GuestSession } from '../../../capabilities/production/session.mjs';
import { census, failure } from '../live/evidence.mjs';
import { assertGuestFacts, reserve, send } from '../live/installed.mjs';
import { acquireCaseHost } from './host-roots.mjs';

export { send };
export const preserve = Object.freeze({ symlinks: 'preserve_internal' });
export const file = (path, bytes = Uint8Array.of(73)) => fileFromBytes(path, bytes);
export const directory = (path) => ({ kind: 'directory', path });
export const link = (path, target) => ({ kind: 'symlink', path, target });
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function assertAbsent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

export function variantCases(context, definitions) {
  const cases = [];
  for (const hostRoot of context.hostRoots) for (const layout of ['baseline', 'private']) {
    const variant = Object.freeze({ layout, hostRoot });
    for (const [name, action] of definitions) cases.push([`${hostRoot.role}-${layout}-${name}`, async (run) => {
      run.evidence.variant = { role: hostRoot.role, layout };
      await acquireCaseHost(run, variant);
      await action(run, variant);
    }]);
  }
  return cases;
}

export async function ready(run, context, variant) {
  const filesystem = variant.layout === 'private';
  const reserved = await reserve(run, context, { filesystem, access: filesystem ? 'read_write' : 'disabled', directory: run.hostDirectory });
  const sandbox = await reserved.owner.start({ signal: context.signal });
  assert.equal(sandbox.files.kind, filesystem ? 'read_write' : 'disabled');
  assert.equal(reserved.owner.recoveryRecord.resources.some(({ role }) => role === 'filesystem'), filesystem);
  run.evidence.observations.push({ kind: 'empty-preserving-workspace-ready', layout: variant.layout,
    namespace: reserved.entry.namespace, files: sandbox.files.kind, spillDirectory: `${run.hostDirectory}/spill`,
    census: await census(context.engine, reserved.owner.recoveryRecord, 'preserve-ready') });
  await run.save(); return { ...reserved, sandbox };
}

export async function startGuestAfterImport(run, context, reserved) {
  const source = await readFile(new URL('../../../capabilities/live/guest.mjs', import.meta.url));
  await reserved.sandbox.importTree([fileFromBytes('qualification/live-guest.mjs', source)]);
  const streams = await reserved.sandbox.reserveProcess({ executable: '/usr/local/bin/node',
    args: [`${reserved.sandbox.workspace}/qualification/live-guest.mjs`], cwd: reserved.sandbox.workspace, env: { LANG: 'C.UTF-8' } })
    .start({ signal: context.signal });
  const session = new GuestSession(streams, context.config.capabilities.limits.requestMs); run.sessions.push(session);
  await session.ready; const facts = await send(session, { kind: 'facts' }); assertGuestFacts(context.config, facts);
  run.evidence.observations.push({ kind: 'preserving-workspace-controlled-guest', namespace: reserved.entry.namespace,
    facts, sourceBytes: source.length, sourceSha256: sha(source) }); await run.save();
  return { session, facts };
}

export function retainDirectoryCleanup(run, error) {
  if (!(error instanceof SandboxDirectoryCleanupError)) return null;
  const existing = run.localCleanupOwners.find(({ owner }) => owner === error); if (existing) return existing;
  assert(run.localCleanupOwners.length < 16);
  const errorEvidence = { directory: error.directory, publishedDirectory: error.publishedDirectory ?? null,
    failure: failure(error), primaryError: error.primaryError === undefined ? null : failure(error.primaryError),
    cleanupError: failure(error.cleanupError), complete: false, attempts: [],
    authority: 'Only the original error instance in this controller authorizes retryCleanup; JSON is evidence.' };
  const retained = { owner: error, errorEvidence }; run.localCleanupOwners.push(retained);
  run.evidence.localDirectoryCleanup.push(errorEvidence); return retained;
}

export async function denial(run, actual, pattern, kind = 'validation') {
  try { await actual; }
  catch (error) {
    if (retainDirectoryCleanup(run, error)) throw error;
    assert(kind === 'validation' ? error instanceof SandboxValidationError
      : kind === 'state' ? error instanceof SandboxStateError
        : error instanceof SandboxValidationError || error instanceof SandboxOperationError,
    `Expected ${kind} rejection, received ${error?.name}: ${error?.message}`);
    const messages = error instanceof SandboxValidationError ? error.issues.map(({ message }) => message).join('\n') : error.message;
    assert.match(messages, pattern);
    return { ...failure(error), ...(error instanceof SandboxValidationError ? { issues: error.issues.slice(0, 16) } : {}) };
  }
  assert.fail('Invalid preserving transfer unexpectedly completed.');
}

export async function metadata(sandbox, options = preserve, selection = { kind: 'workspace' }) {
  const entries = []; let metadataBytes = 0; let payloadBytes = 0;
  const summary = await sandbox.exportTree(selection, async (entry) => {
    assert(entries.length < 5000); let observed;
    if (entry.kind !== 'file') observed = { ...entry };
    else {
      const digest = createHash('sha256'); let bytes = 0n;
      for await (const chunk of entry.bytes) {
        bytes += BigInt(chunk.byteLength); payloadBytes += chunk.byteLength; assert(payloadBytes <= 2 * 1024 ** 2); digest.update(chunk);
      }
      observed = { kind: entry.kind, path: entry.path, bytes, executable: entry.executable, sha256: digest.digest('hex') };
    }
    metadataBytes += Buffer.byteLength(JSON.stringify(observed, (_, value) => typeof value === 'bigint' ? String(value) : value));
    assert(metadataBytes <= 2 * 1024 ** 2); entries.push(observed);
  }, options);
  return { summary, entries };
}
