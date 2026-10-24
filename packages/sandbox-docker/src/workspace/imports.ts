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

export async function importWorkspace(api: DockerApi, containerId: string, entries: AsyncIterable<SandboxInputTreeEntry>,
  user: Readonly<{ uid: number; gid: number }>, options: SandboxDriverTransferOptions): Promise<SandboxTransferSummary> {
  let files = 0n;
  let directories = 0n;
  let payloadBytes = 0n;
  const source = async function* (signal: AbortSignal): AsyncGenerator<TarInputEntry> {
    const directory = (path: string): TarInputEntry => ({ ...user, path, kind: 'directory', size: 0, mode: 0o700 });
    yield directory('work');
    for await (const entry of entries) {
      signal.throwIfAborted();
      const parts = entry.path.split('/');
      const parentCount = entry.kind === 'directory' ? parts.length : parts.length - 1;
      for (let count = 1; count <= parentCount; count += 1) yield directory(`work/${parts.slice(0, count).join('/')}`);
      if (entry.kind === 'directory') { directories += 1n; continue; }
      files += 1n;
      payloadBytes += BigInt(entry.byteLength);
      const body = async function* () { yield* entry.open({ signal }); };
      yield { ...user, path: `work/${entry.path}`, kind: 'file', size: entry.byteLength, mode: entry.executable ? 0o700 : 0o600, body: body() };
    }
  };
  const result = await api.stream('PUT', `${DOCKER_API}/containers/${containerId}/archive?path=%2Fworkspace&noOverwriteDirNonDir=true`, {
    signal: options.signal, chunkBytes: options.buffers.chunkBytes, contentType: 'application/x-tar',
    body: (signal) => writeTar(source(signal), { signal, chunkBytes: options.buffers.chunkBytes,
      limitCode: 'input_limit', maxArchiveBytes: options.quotas.maxArchiveBytes }),
  }, async ({ body }) => {
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new SandboxOperationError('driver_failure', 'Docker archive acknowledgement exceeds its control-response bound.');
    }
  });
  return Object.freeze({ files, directories, payloadBytes, archiveBytes: result.uploadedBytes });
}
