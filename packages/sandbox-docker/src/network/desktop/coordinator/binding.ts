import { createDesktopCoordinatorAuthority } from './contracts.js';
import type { DockerDesktopCoordinatorAuthority } from './contracts.js';
import type { GenerationIdentity } from './journal/schema.js';
import type { DesktopCoordinatorMember, DesktopCoordinatorMemberOwner } from './member.js';

export interface DesktopCoordinatorBinding {
  readonly generation: string;
  readonly endpoint: string;
  readonly configurationDigest: string;
  readonly identity: Readonly<{
    protocol: 'agenai.desktop-coordinator.v1';
    authorityId: string;
    engineKey: string;
    daemonId: string;
    generation: GenerationIdentity;
  }>;
  assertAdmission(): void;
  enroll(owner: DesktopCoordinatorMemberOwner, signal?: AbortSignal): Promise<DesktopCoordinatorMember>;
}

const authorities = new WeakMap<object, DesktopCoordinatorBinding>();

export function registerDesktopCoordinatorAuthority(binding: DesktopCoordinatorBinding): DockerDesktopCoordinatorAuthority {
  const authority = createDesktopCoordinatorAuthority(binding.generation);
  authorities.set(authority, binding);
  return authority;
}

export function captureDesktopCoordinatorAuthority(value: unknown): DesktopCoordinatorBinding {
  const binding = value !== null && typeof value === 'object' ? authorities.get(value) : undefined;
  if (!binding) throw new TypeError('Coordinated Desktop backends require an original active coordinator capability.');
  binding.assertAdmission();
  return binding;
}
