// ------------------------------------------------------------------------------------------------
//                desktopRouteAuthority.ts - Explicit inert Desktop route authority construction
// ------------------------------------------------------------------------------------------------

import { parseDockerDesktopRouteAuthority } from '../network/desktopAuthority.js';
import type { DockerDesktopRouteAuthorityIdentity } from '../network/desktopAuthority.js';
import { registerDockerDesktopRouteAuthority } from '../network/routeAuthority.js';
import type { DockerDesktopRouteAuthority } from '../network/routeAuthority.js';
import { readDesktopHostObservation } from './desktopHostObservation.js';
import { inspectDesktopEngineSocket } from './desktopEngineSocket.js';

export type DockerDesktopRouteAuthorityOptions = DockerDesktopRouteAuthorityIdentity;

export function createDockerDesktopRouteAuthority(options: DockerDesktopRouteAuthorityOptions): DockerDesktopRouteAuthority {
  const identity = parseDockerDesktopRouteAuthority(options);
  return registerDockerDesktopRouteAuthority({ identity, observeHost: (signal) => readDesktopHostObservation(identity, signal),
    observeEngineSocket: (signal) => inspectDesktopEngineSocket(identity.engine.endpoint, signal) });
}
