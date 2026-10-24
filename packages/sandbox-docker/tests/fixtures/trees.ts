// ------------------------------------------------------------------------------------------------
//                trees.ts - Explicit small in-memory test fixtures - Public streaming API consumers
// ------------------------------------------------------------------------------------------------

import type { Sandbox, SandboxTransferOptions, SandboxTreeEntry } from '@agen-ai/sandbox';

export interface FixtureFile { readonly path: string; readonly bytes: Uint8Array; readonly executable: boolean }

export function inputFiles(files: readonly FixtureFile[]): readonly SandboxTreeEntry[] {
  return files.map((file) => ({ kind: 'file', path: file.path, byteLength: file.bytes.length, executable: file.executable,
    open: () => [file.bytes] }));
}

export function importFixtures(sandbox: Sandbox, files: readonly FixtureFile[], options?: SandboxTransferOptions) {
  return sandbox.importTree(inputFiles(files), options);
}

export async function exportFixtures(sandbox: Sandbox, paths: readonly string[], options?: SandboxTransferOptions): Promise<readonly FixtureFile[]> {
  const files: FixtureFile[] = [];
  const maximum = 8 * 1024 * 1024;
  let total = 0;
  await sandbox.exportTree({ kind: 'files', paths }, async (entry) => {
    if (entry.kind !== 'file') throw new Error('Exact test export returned a directory.');
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.bytes) {
      total += chunk.length;
      if (total > maximum) throw new Error('Test fixture collection exceeds its explicit 8 MiB bound.');
      chunks.push(Uint8Array.from(chunk));
    }
    files.push({ path: entry.path, executable: entry.executable, bytes: Buffer.concat(chunks) });
  }, options);
  return files;
}
