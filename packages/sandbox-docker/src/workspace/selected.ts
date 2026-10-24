// ------------------------------------------------------------------------------------------------
//                selected.ts - Targeted regular-file or subtree archives - Checked stable ancestors
// ------------------------------------------------------------------------------------------------

import type { SandboxExportConsumer, SandboxTransferSummary } from '@agen-ai/sandbox';
import type { SandboxDriverTransferOptions } from '@agen-ai/sandbox/backend';
import { DOCKER_API } from '../policy/config.js';
import type { DockerApi } from '../resources/api.js';
import { unsafeArchive } from './paths.js';
import { pathStat, sameStat, selectedPathStat } from './stat.js';
import { readTar } from './tar/decode.js';

export async function exportSelectedPath(api: DockerApi, containerId: string, path: string, kind: 'file' | 'directory',
  consume: SandboxExportConsumer, options: SandboxDriverTransferOptions, maxArchiveBytes: bigint | undefined): Promise<SandboxTransferSummary> {
  const stat = await selectedPathStat(api, containerId, path, kind, options.signal, options.buffers.chunkBytes);
  const result = await api.stream('GET', `${DOCKER_API}/containers/${containerId}/archive?path=${encodeURIComponent(`/workspace/work/${path}`)}`,
    { signal: options.signal, chunkBytes: options.buffers.chunkBytes }, async (response) => {
      sameStat(pathStat(response), stat);
      let observedRoot = false;
      const summary = await readTar(response.body, async (entry) => {
        let relative: string;
        if (entry.path === stat.name) {
          if (observedRoot || entry.kind !== kind || (entry.mode & 0o777) !== (stat.mode & 0o777)
            || (kind === 'file' && entry.size !== stat.size)) unsafeArchive('selected archive requires one matching root entry.');
          observedRoot = true;
          relative = path;
        } else {
          if (kind !== 'directory' || !entry.path.startsWith(`${stat.name}/`)) unsafeArchive('archive entry is outside the selected root.');
          relative = `${path}${entry.path.slice(stat.name.length)}`;
        }
        await consume(entry.kind === 'directory' ? { kind: 'directory', path: relative }
          : { kind: 'file', path: relative, byteLength: entry.size, executable: (entry.mode & 0o111) !== 0, bytes: entry.body }, { signal: options.signal });
      }, { signal: options.signal, chunkBytes: options.buffers.chunkBytes, limitCode: 'output_limit', maxArchiveBytes });
      if (!observedRoot) unsafeArchive('selected root is missing from its archive.');
      return summary;
    });
  return result.value;
}
