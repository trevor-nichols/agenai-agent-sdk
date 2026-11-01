import type { DockerDesktopRouteAuthorityIdentity } from '../network/desktopAuthority.js';
import { coordinatorDigest } from '../network/desktop/coordinator/journal/schema.js';

export function desktopSharedAuthorityDigest(identity: DockerDesktopRouteAuthorityIdentity): string {
  const { profile: _profile, ...shared } = identity;
  return coordinatorDigest('agenai.desktop-coordinator.shared-authority.v1', JSON.stringify(shared));
}
