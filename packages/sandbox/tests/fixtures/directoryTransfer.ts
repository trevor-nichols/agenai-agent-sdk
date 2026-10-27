// ------------------------------------------------------------------------------------------------
//                directoryTransfer.ts - Real host roots and public sandbox boundaries for directory tests
// ------------------------------------------------------------------------------------------------

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Sandbox } from '../../src/contracts.js';
import type { SandboxExportEntry, SandboxTransferSummary } from '../../src/files/types.js';
import { fixture, request } from './backend.js';

export async function directoryRoot(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agenai-directory-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function directorySandbox(t: TestContext, exporting = false) {
  const physical = fixture();
  const sandbox = await physical.backend.reserve(request(), { kind: 'in_process' }).start();
  t.after(() => sandbox.destroy());
  if (exporting) await sandbox.stop();
  return { physical, sandbox };
}

export function file(path: string, bytes: Uint8Array, executable = false): SandboxExportEntry {
  return { kind: 'file', path, byteLength: bytes.byteLength, executable,
    bytes: { async *[Symbol.asyncIterator]() { yield bytes; } } };
}

export function exporting(sandbox: Sandbox, entries: Iterable<SandboxExportEntry>): Sandbox {
  return { ...sandbox, async exportTree(_selection, consume, options): Promise<SandboxTransferSummary> {
    const signal = options?.signal ?? new AbortController().signal;
    let files = 0n;
    let directories = 0n;
    let symlinks = 0n;
    let payloadBytes = 0n;
    for (const entry of entries) {
      await consume(entry, { signal });
      if (entry.kind === 'directory') directories += 1n;
      else if (entry.kind === 'symlink') symlinks += 1n;
      else { files += 1n; payloadBytes += BigInt(entry.byteLength); }
    }
    return { files, directories, symlinks, payloadBytes, archiveBytes: payloadBytes };
  } };
}
