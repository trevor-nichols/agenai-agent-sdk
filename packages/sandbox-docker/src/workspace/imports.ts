// ------------------------------------------------------------------------------------------------
//                imports.ts - Logical trees into private workspace storage - Streaming owned tar PUT
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxInputTreeEntry, SandboxTransferSummary } from '@agen-ai/sandbox';
import type { SandboxDriverTransferOptions } from '@agen-ai/sandbox/backend';
import { DOCKER_API } from '../policy/config.js';
import type { DockerApi } from '../resources/api.js';
import type { TarInputEntry } from './tar/contracts.js';
import { writeTar } from './tar/encode.js';
import { requireEmptyWorkspace } from './empty.js';

export async function importWorkspace(api: DockerApi, containerId: string, entries: AsyncIterable<SandboxInputTreeEntry>,
  user: Readonly<{ uid: number; gid: number }>, options: SandboxDriverTransferOptions, privateWorkspace = false): Promise<SandboxTransferSummary> {
  let files = 0n;
  let directories = 0n;
  let symlinks = 0n;
  let payloadBytes = 0n;
  if (options.symlinks === 'preserve_internal') await requireEmptyWorkspace(api, containerId, options);
  const source = async function* (signal: AbortSignal): AsyncGenerator<TarInputEntry> {
    const directory = (path: string): TarInputEntry => ({ ...user, path, kind: 'directory', size: 0, mode: 0o700 });
    const prefix = privateWorkspace ? '' : 'work/';
    if (!privateWorkspace) yield directory('work');
    let links = false;
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (entry.kind === 'symlink') links = true;
      else if (links) throw new SandboxOperationError('driver_failure', 'Import must deliver validated symbolic links after all regular content.');
      const parts = entry.path.split('/');
      const parentCount = entry.kind === 'directory' ? parts.length : parts.length - 1;
      for (let count = 1; count <= parentCount; count += 1) yield directory(`${prefix}${parts.slice(0, count).join('/')}`);
      if (entry.kind === 'directory') { directories += 1n; continue; }
      if (entry.kind === 'symlink') {
        symlinks += 1n;
        yield { ...user, path: `${prefix}${entry.path}`, kind: 'symlink', target: entry.target, size: 0, mode: 0o777 };
        continue;
      }
      files += 1n;
      payloadBytes += BigInt(entry.byteLength);
      const body = async function* () { yield* entry.open({ signal }); };
      yield { ...user, path: `${prefix}${entry.path}`, kind: 'file', size: entry.byteLength, mode: entry.executable ? 0o700 : 0o600, body: body() };
    }
  };
  const root = privateWorkspace ? '/workspace/work' : '/workspace';
  const result = await api.stream('PUT', `${DOCKER_API}/containers/${containerId}/archive?path=${encodeURIComponent(root)}&noOverwriteDirNonDir=true`, {
    signal: options.signal, chunkBytes: options.buffers.chunkBytes, contentType: 'application/x-tar',
    body: (signal) => writeTar(source(signal), { signal, chunkBytes: options.buffers.chunkBytes,
      limitCode: 'input_limit', maxArchiveBytes: options.quotas.maxArchiveBytes, symlinks: options.symlinks }),
  }, async ({ body }) => {
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new SandboxOperationError('driver_failure', 'Docker archive acknowledgement exceeds its control-response bound.');
    }
  });
  return Object.freeze({ files, directories, symlinks, payloadBytes, archiveBytes: result.uploadedBytes });
}
