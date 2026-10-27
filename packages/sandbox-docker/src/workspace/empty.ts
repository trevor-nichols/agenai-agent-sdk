// ------------------------------------------------------------------------------------------------
//                empty.ts - Actual empty-workspace admission before symbolic-link-preserving imports
// ------------------------------------------------------------------------------------------------

import { SandboxStateError } from '@agen-ai/sandbox';
import type { SandboxDriverTransferOptions } from '@agen-ai/sandbox/backend';
import { DOCKER_API } from '../policy/config.js';
import type { DockerApi } from '../resources/api.js';
import { unsafeArchive } from './paths.js';
import { pathStat, requireStat, sameStat, statPath } from './stat.js';
import { readTar } from './tar/decode.js';

export async function requireEmptyWorkspace(api: DockerApi, containerId: string, options: SandboxDriverTransferOptions): Promise<void> {
  requireStat(await statPath(api, containerId, '/workspace', options.signal, options.buffers.chunkBytes), '/workspace', 'directory');
  const expected = await statPath(api, containerId, '/workspace/work', options.signal, options.buffers.chunkBytes);
  requireStat(expected, '/workspace/work', 'directory');
  await api.stream('GET', `${DOCKER_API}/containers/${containerId}/archive?path=%2Fworkspace%2Fwork`,
    { signal: options.signal, chunkBytes: options.buffers.chunkBytes }, async (response) => {
      sameStat(pathStat(response), expected);
      let root = false;
      await readTar(response.body, async (entry) => {
        if (entry.path !== 'work' || entry.kind !== 'directory' || root) {
          throw new SandboxStateError('Symbolic-link-preserving imports require an actually empty workspace.');
        }
        root = true;
      }, { signal: options.signal, chunkBytes: options.buffers.chunkBytes, limitCode: 'input_limit', symlinks: 'preserve_internal' });
      if (!root) unsafeArchive('empty-workspace admission requires its directory record.');
    });
}
