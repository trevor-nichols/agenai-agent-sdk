// ------------------------------------------------------------------------------------------------
//                settlement.ts - Native filesystem observations into neutral terminal outcomes
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxFileEntry, SandboxFileObservation, SandboxFileWriteResult, SandboxLivePath } from '@agen-ai/sandbox';
import type { FilesystemMetadata, FilesystemReply, FilesystemTerminal } from './protocol.js';

export function terminal(reply: FilesystemReply): FilesystemTerminal {
  if (reply.kind !== 'terminal') throw new SandboxOperationError('driver_failure', 'Filesystem helper omitted its correlated terminal observation.');
  if ((reply.terminal.status === 'ready' || reply.terminal.status === 'complete') && reply.terminal.errno !== 0) {
    throw new SandboxOperationError('driver_failure', 'Filesystem helper success contradicts its error observation.');
  }
  return reply.terminal;
}

export function entry(observedEntry: FilesystemMetadata, path: SandboxLivePath): SandboxFileEntry {
  return Object.freeze({ kind: observedEntry.kind, path, byteLength: observedEntry.byteLength, permissions: observedEntry.mode });
}

export function observation(value: FilesystemTerminal): SandboxFileObservation {
  if (value.effect !== 'none') throw new SandboxOperationError('driver_failure', 'Read-only filesystem operation reported an unexpected mutation.');
  if (value.status === 'complete' && value.errno === 0) return { kind: 'completed' };
  if (value.status === 'changed' || value.errno === 116) return { kind: 'changed' };
  if (value.status === 'cancelled') return { kind: 'cancelled', reason: 'signal' };
  if (value.status === 'rejected') {
    if (value.errno === 2) return { kind: 'missing' };
    if ([1, 13, 30].includes(value.errno)) return { kind: 'rejected', reason: 'permission_denied' };
    if (value.errno === 17) return { kind: 'rejected', reason: 'already_exists' };
    if (value.errno === 31) return { kind: 'rejected', reason: 'hardlink' };
    if (value.errno === 95) return { kind: 'rejected', reason: 'unsupported_type' };
    if ([18, 20, 22, 36, 40, 84].includes(value.errno)) return { kind: 'rejected', reason: 'path_resolution' };
  }
  throw new SandboxOperationError('driver_failure', `Filesystem helper failed (${value.status}, errno ${value.errno}).`);
}

export function unpublished(value: FilesystemTerminal, bytes: bigint): SandboxFileWriteResult {
  const result = observation(value);
  if (result.kind === 'completed' || result.kind === 'changed') {
    throw new SandboxOperationError('driver_failure', 'Filesystem write reported completion or change without publication.');
  }
  return { ...result, effect: 'none', bytes };
}
