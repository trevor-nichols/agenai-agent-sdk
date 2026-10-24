// ------------------------------------------------------------------------------------------------
//                index.ts - Explicit inert Docker sandbox construction - Public root entrypoint
// ------------------------------------------------------------------------------------------------

import type { SandboxBackend } from '@agen-ai/sandbox';
import { createSandboxBackend } from '@agen-ai/sandbox/backend';
import { DockerEngine } from './engine/client.js';
import { parseDockerConfig, DOCKER_BACKEND_ID } from './policy/config.js';
import { dockerBackendRevision } from './policy/profiles.js';
import type { DockerSandboxBackendOptions } from './policy/config.js';
import { DockerApi } from './resources/api.js';
import { DockerResourceOwner } from './resources/owner.js';
import { reconcileDocker } from './recovery/reconcile.js';

export type { DockerSandboxBackendOptions } from './policy/config.js';
export type { DockerSandboxProfile } from './policy/profiles.js';
export type { DockerSandboxDataset } from './datasets/types.js';

export function createDockerSandboxBackend(options: DockerSandboxBackendOptions): SandboxBackend {
  const config = parseDockerConfig(options);
  const api = new DockerApi(new DockerEngine(config.endpoint.slice(7)), 30_000);
  return createSandboxBackend({
    support: { backendId: DOCKER_BACKEND_ID, backendRevision: dockerBackendRevision(config.profile),
      networkModes: ['isolated', 'outbound'], workspaceDiskQuota: false, networkAllowlist: false, independentProcessTermination: false },
    reserve(request) { return new DockerResourceOwner(api, config, request); },
    reconcile(record, operation) { return reconcileDocker(api, config, record, operation); },
  });
}
