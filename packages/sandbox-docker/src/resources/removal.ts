// ------------------------------------------------------------------------------------------------
//                removal.ts - Exact inspected-resource deletion and independent absence readback
// ------------------------------------------------------------------------------------------------

import { SandboxStateError } from '@agen-ai/sandbox';
import { DOCKER_API } from '../policy/config.js';
import type { ResourceRole } from '../recovery/identity.js';
import type { DockerApi } from './api.js';
import { resourceKind } from './inspect.js';
import type { ResourceInspection } from './inspect.js';

export async function removeInspectedDockerResource(api: DockerApi, role: ResourceRole, inspection: ResourceInspection,
  inspect: () => Promise<ResourceInspection | undefined>): Promise<void> {
  const id = encodeURIComponent(inspection.id);
  const kind = resourceKind(role);
  const path = kind === 'container' ? `${DOCKER_API}/containers/${id}?force=true&v=false`
    : kind === 'volume' ? `${DOCKER_API}/volumes/${id}` : `${DOCKER_API}/networks/${id}`;
  await api.request('DELETE', path, { statuses: [204, 404] });
  if (await inspect()) throw new SandboxStateError('Docker acknowledged removal but the exact resource remains present.');
}
