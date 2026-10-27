// ------------------------------------------------------------------------------------------------
//                exports.ts - Explicit workspace, subtree or file streaming - Quiescent private storage
// ------------------------------------------------------------------------------------------------

import type { SandboxExportConsumer, SandboxInputTreeSelection, SandboxTransferSummary } from '@agen-ai/sandbox';
import type { SandboxDriverTransferOptions } from '@agen-ai/sandbox/backend';
import { DOCKER_API } from '../policy/config.js';
import type { DockerApi } from '../resources/api.js';
import { ARCHIVE_ROOT, ARCHIVE_WORK, unsafeArchive, workspaceName } from './paths.js';
import { pathStat, requireStat } from './stat.js';
import { exportSelectedPath } from './selected.js';
import { readTar } from './tar/decode.js';

async function workspace(api: DockerApi, containerId: string, consume: SandboxExportConsumer,
  options: SandboxDriverTransferOptions, privateWorkspace: boolean): Promise<SandboxTransferSummary> {
  let root = privateWorkspace;
  let work = false;
  const archivePath = privateWorkspace ? '/workspace/work' : '/workspace';
  const result = await api.stream('GET', `${DOCKER_API}/containers/${containerId}/archive?path=${encodeURIComponent(archivePath)}`,
    { signal: options.signal, chunkBytes: options.buffers.chunkBytes }, async (response) => {
    requireStat(pathStat(response), archivePath, 'directory');
    const summary = await readTar(response.body, async (entry) => {
      const path = workspaceName(privateWorkspace ? `${ARCHIVE_ROOT}/${entry.path}` : entry.path, entry.kind === 'directory');
      if (path === ARCHIVE_ROOT) {
        if (root) unsafeArchive('duplicate workspace root.');
        root = true;
      } else if (path === ARCHIVE_WORK) {
        if (work) unsafeArchive('duplicate work root.');
        work = true;
      } else {
        const relative = path.slice(ARCHIVE_WORK.length + 1);
        await consume(entry.kind === 'directory' ? { kind: 'directory', path: relative }
          : entry.kind === 'symlink' ? { kind: 'symlink', path: relative, target: entry.target }
          : { kind: 'file', path: relative, byteLength: entry.size, executable: (entry.mode & 0o111) !== 0, bytes: entry.body }, { signal: options.signal });
      }
    }, { signal: options.signal, chunkBytes: options.buffers.chunkBytes, limitCode: 'output_limit', maxArchiveBytes: options.quotas.maxArchiveBytes, symlinks: options.symlinks });
    if (!root || !work) unsafeArchive('both fixed workspace directory records are required.');
    return { ...summary, directories: summary.directories - (privateWorkspace ? 1n : 2n) };
  });
  return result.value;
}

export async function exportWorkspace(api: DockerApi, containerId: string, selection: SandboxInputTreeSelection,
  consume: SandboxExportConsumer, options: SandboxDriverTransferOptions, privateWorkspace = false): Promise<SandboxTransferSummary> {
  if (selection.kind === 'workspace') return workspace(api, containerId, consume, options, privateWorkspace);
  if (selection.kind === 'subtree') return exportSelectedPath(api, containerId, selection.path, 'directory', consume, options, options.quotas.maxArchiveBytes);
  let files = 0n;
  let payloadBytes = 0n;
  let archiveBytes = 0n;
  for await (const path of selection.paths) {
    options.signal.throwIfAborted();
    const remaining = options.quotas.maxArchiveBytes === undefined ? undefined : options.quotas.maxArchiveBytes - archiveBytes;
    const result = await exportSelectedPath(api, containerId, path, 'file', consume, options, remaining);
    files += result.files;
    payloadBytes += result.payloadBytes;
    archiveBytes += result.archiveBytes;
  }
  return Object.freeze({ files, directories: 0n, symlinks: 0n, payloadBytes, archiveBytes });
}
