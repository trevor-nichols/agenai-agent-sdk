// ------------------------------------------------------------------------------------------------
//                routeAuthority.ts - Opaque route observer registration without host authority
// ------------------------------------------------------------------------------------------------

import { SandboxValidationError } from '@agen-ai/sandbox';
import type { DockerDesktopRouteAuthorityIdentity, DockerDesktopRouteAuthorityProfile } from './desktopAuthority.js';
import type { DesktopHostAuthorityObservation } from './desktop/observation/host.js';

const authorityBrand = Symbol('DockerLinuxRouteAuthority');
const desktopAuthorityBrand = Symbol('DockerDesktopRouteAuthority');

export interface DockerLinuxRouteAuthorityIdentity {
  readonly kind: 'local_linux_same_host';
  readonly stability: 'caller_owned_quiescence';
  readonly ipExecutable: Readonly<{ path: string; sha256: string }>;
  readonly pollIntervalMs: number;
  readonly commandTimeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface DockerLinuxRouteAuthority {
  readonly [authorityBrand]: true;
  readonly kind: 'local_linux_same_host';
  readonly stability: 'caller_owned_quiescence';
}

export interface DockerDesktopRouteAuthority {
  readonly [desktopAuthorityBrand]: true;
  readonly kind: 'local_docker_desktop';
  readonly profile: DockerDesktopRouteAuthorityProfile;
  readonly stability: 'caller_owned_quiescence';
}

export type DockerRouteAuthority = DockerLinuxRouteAuthority | DockerDesktopRouteAuthority;
export type DockerRouteAuthorityIdentity = DockerLinuxRouteAuthorityIdentity | DockerDesktopRouteAuthorityIdentity;

export interface DockerLinuxRouteCensus {
  readonly excludedCidrs: readonly string[];
  readonly hostname: string;
  readonly kernel: string;
}

export interface DockerLinuxRouteAuthorityBinding {
  readonly kind: 'local_linux_same_host';
  readonly identity: DockerLinuxRouteAuthorityIdentity;
  observe(signal?: AbortSignal): Promise<DockerLinuxRouteCensus>;
}

export interface DockerDesktopRouteAuthorityBinding {
  readonly kind: 'local_docker_desktop';
  readonly identity: DockerDesktopRouteAuthorityIdentity;
  observeHost(signal?: AbortSignal): Promise<DesktopHostAuthorityObservation>;
  observeEngineSocket(signal?: AbortSignal): Promise<DockerDesktopEngineSocketIdentity>;
}

export interface DockerDesktopEngineSocketIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
}

export type DockerRouteAuthorityBinding = DockerLinuxRouteAuthorityBinding | DockerDesktopRouteAuthorityBinding;

const authorities = new WeakMap<object, DockerRouteAuthorityBinding>();

export function registerDockerLinuxRouteAuthority(binding: Omit<DockerLinuxRouteAuthorityBinding, 'kind'>): DockerLinuxRouteAuthority {
  const authority = Object.freeze({ [authorityBrand]: true as const, kind: 'local_linux_same_host' as const, stability: 'caller_owned_quiescence' as const });
  authorities.set(authority, Object.freeze({ ...binding, kind: 'local_linux_same_host' }));
  return authority;
}

export function registerDockerDesktopRouteAuthority(binding: Omit<DockerDesktopRouteAuthorityBinding, 'kind'>): DockerDesktopRouteAuthority {
  const { identity } = binding;
  const authority = Object.freeze({ [desktopAuthorityBrand]: true as const, kind: 'local_docker_desktop' as const,
    profile: identity.profile, stability: 'caller_owned_quiescence' as const });
  authorities.set(authority, Object.freeze({ ...binding, kind: 'local_docker_desktop' }));
  return authority;
}

export function captureDockerRouteAuthority(input: unknown): DockerRouteAuthorityBinding {
  const binding = input !== null && typeof input === 'object' ? authorities.get(input) : undefined;
  if (!binding) throw new SandboxValidationError([{ code: 'invalid_input', path: ['egress', 'routeAuthority'],
    message: 'Restricted egress requires an original explicit Linux or Desktop route authority handle' }]);
  return binding;
}

export function captureDockerLinuxRouteAuthority(input: unknown): DockerLinuxRouteAuthorityBinding {
  const binding = captureDockerRouteAuthority(input);
  if (binding.kind !== 'local_linux_same_host') throw new SandboxValidationError([{ code: 'invalid_input', path: ['egress', 'routeAuthority'],
    message: 'Restricted Linux egress requires an original explicit Linux route authority handle' }]);
  return binding;
}
