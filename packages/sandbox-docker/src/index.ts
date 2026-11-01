// ------------------------------------------------------------------------------------------------
//                index.ts - Explicit inert Docker sandbox construction - Public root entrypoint
// ------------------------------------------------------------------------------------------------

import type { SandboxBackend } from '@agen-ai/sandbox';
import { createSandboxBackend } from '@agen-ai/sandbox/backend';
import { DockerEngine } from './engine/client.js';
import { parseDockerConfig, parseCoordinatedDockerConfig, DOCKER_BACKEND_ID } from './policy/config.js';
import { dockerBackendRevision } from './policy/profiles.js';
import type { DockerSandboxBackendOptions, DockerCoordinatedSandboxBackendOptions } from './policy/options.js';
import { DockerApi } from './resources/api.js';
import { DockerResourceOwner } from './resources/owner.js';
import { reconcileDocker } from './recovery/reconcile.js';
import { configurationBackendRevision } from './recovery/identity.js';

export type { DockerSandboxBackendOptions, DockerSandboxEgressOptions, DockerSandboxFilesystemOptions,
  DockerCoordinatedSandboxBackendOptions, DockerDesktopCoordinatorMemberConfiguration } from './policy/options.js';
export type { DockerSandboxProfile, DockerDesktopSandboxProfile } from './policy/profiles.js';
export type { DockerSandboxDataset } from './datasets/types.js';
export type { DockerLinuxRouteAuthority, DockerDesktopRouteAuthority, DockerRouteAuthority } from './network/routeAuthority.js';
export { DockerDesktopCoordinatorError } from './network/desktop/coordinator/contracts.js';
export type {
  DockerDesktopCoordinator, DockerDesktopCoordinatorAuthority, DockerDesktopCoordinatorFailure,
  DockerDesktopCoordinatorGenerationState, DockerDesktopCoordinatorMemberState,
  DockerDesktopCoordinatorOperationOptions, DockerDesktopCoordinatorState,
  DockerDesktopCoordinatorRecovery, DockerDesktopCoordinatorCleanupOpen,
} from './network/desktop/coordinator/contracts.js';

export function createDockerSandboxBackend(options: DockerSandboxBackendOptions): SandboxBackend {
  const config = parseDockerConfig(options);
  const api = new DockerApi(new DockerEngine(config.endpoint.slice(7)), 30_000);
  const restrictedHttps = config.egress !== undefined;
  return createSandboxBackend({
    support: { backendId: DOCKER_BACKEND_ID, backendRevision: dockerBackendRevision(config.profile),
      networkModes: restrictedHttps ? ['isolated', 'outbound', 'restricted_https'] : ['isolated', 'outbound'], workspaceDiskQuota: false,
      networkAllowlist: restrictedHttps ? { kind: 'https_connect', maxDestinations: 128 } : false, independentProcessTermination: false,
      files: config.filesystem !== undefined ? { read: true, write: true } : false,
      transferSymlinks: { kind: 'preserve_internal', import: 'empty_workspace' } },
    reserve(request) { return new DockerResourceOwner(api, config, request); },
    reconcile(record, operation) { return reconcileDocker(api, config, record, operation); },
  });
}

export function createCoordinatedDockerSandboxBackend(options: DockerCoordinatedSandboxBackendOptions): SandboxBackend {
  const config = parseCoordinatedDockerConfig(options);
  const api = new DockerApi(new DockerEngine(config.endpoint.slice(7)), 30_000);
  return createSandboxBackend({
    support: { backendId: DOCKER_BACKEND_ID, backendRevision: configurationBackendRevision(config),
      networkModes: ['restricted_https'], workspaceDiskQuota: false,
      networkAllowlist: { kind: 'https_connect', maxDestinations: 128 }, independentProcessTermination: false,
      files: config.filesystem !== undefined ? { read: true, write: true } : false,
      transferSymlinks: { kind: 'preserve_internal', import: 'empty_workspace' } },
    reserve(request) {
      config.coordinator.assertAdmission();
      return new DockerResourceOwner(api, config, request);
    },
    async reconcile() {
      return Object.freeze({ kind: 'conflict', reason: 'Coordinated Desktop recovery requires the original coordinator cleanup authority.' });
    },
  });
}
