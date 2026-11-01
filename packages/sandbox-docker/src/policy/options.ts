import type { SandboxResources } from '@agen-ai/sandbox';
import type { DockerDesktopSandboxProfile, DockerSandboxProfile } from './profiles.js';
import type { DockerSandboxDataset } from '../datasets/types.js';
import type { DockerDesktopRouteAuthority, DockerRouteAuthority } from '../network/routeAuthority.js';
import type { DockerDesktopCoordinatorAuthority } from '../network/desktop/coordinator/contracts.js';

export interface DockerSandboxEgressOptions {
  readonly imageDigest: string;
  readonly protocol: 'agenai.sandbox.egress-connect.v1';
  readonly user: Readonly<{ uid: number; gid: number }>;
  readonly broker: Readonly<{ resources: SandboxResources; temporaryBytes: number }>;
  readonly relay: Readonly<{ resources: SandboxResources; temporaryBytes: number }>;
  readonly routeAuthority: DockerRouteAuthority;
  readonly control: Readonly<{ heartbeatMs: number; leaseTimeoutMs: number }>;
}

export interface DockerSandboxFilesystemOptions {
  readonly imageDigest: string;
  readonly protocol: 'agenai.sandbox.filesystem.v1';
  readonly executable: '/usr/local/bin/agenai-sandbox-files';
  readonly layout: 'agenai.sandbox.workspace.v1';
  readonly user: Readonly<{ uid: number; gid: number }>;
  readonly resources: SandboxResources;
  readonly temporaryBytes: number;
  readonly control: Readonly<{ heartbeatMs: number; leaseTimeoutMs: number }>;
}

export interface DockerSandboxBackendOptions {
  readonly profile?: DockerSandboxProfile;
  readonly endpoint: string;
  readonly namespace: string;
  readonly imageDigest: string;
  readonly spillDirectory: string;
  readonly user: Readonly<{ uid: number; gid: number }>;
  readonly datasets?: readonly DockerSandboxDataset[];
  readonly egress?: DockerSandboxEgressOptions;
  readonly filesystem?: DockerSandboxFilesystemOptions;
}

export type DockerCoordinatedSandboxBackendOptions =
  Omit<DockerSandboxBackendOptions, 'profile' | 'egress'> & Readonly<{
    profile: DockerDesktopSandboxProfile;
    egress: DockerSandboxEgressOptions & Readonly<{ routeAuthority: DockerDesktopRouteAuthority }>;
    coordinator: DockerDesktopCoordinatorAuthority;
  }>;

export type DockerDesktopCoordinatorMemberConfiguration = Omit<DockerCoordinatedSandboxBackendOptions, 'coordinator'>;
