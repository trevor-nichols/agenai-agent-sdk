// ------------------------------------------------------------------------------------------------
//                container.ts - Fixed workload and archive-accessor policy - Docker readback
// ------------------------------------------------------------------------------------------------

import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { SandboxPolicy, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from './config.js';
import { dockerProfile } from './profiles.js';
import { resourceLabels } from '../recovery/identity.js';
import type { ContainerInspection } from '../resources/inspect.js';
import { containerMounts, verifyContainerMounts } from '../datasets/mounts.js';
import { empty, isolatedHostPolicy, matchesHostIsolation, sameStrings } from './hostIsolation.js';

export const KEEPER = ['-c', 'while :; do sleep 3600; done'];
export const DOCKER_ENVIRONMENT = Object.freeze(['HOME=/home/sandbox', 'TMPDIR=/tmp', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']);

export function tmpfs(policy: SandboxPolicy, config: DockerSandboxConfig): Readonly<Record<string, string>> {
  const options = (size: number) => `rw,nosuid,nodev,noexec,size=${size},mode=0700,uid=${config.user.uid},gid=${config.user.gid}`;
  return { '/home/sandbox': options(policy.temporaryStorage.homeBytes), '/tmp': options(policy.temporaryStorage.tempBytes) };
}

export function containerBody(config: DockerSandboxConfig, record: SandboxRecoveryRecord,
  policy: SandboxPolicy, role: 'compute' | 'export', storageId: string, networkId: string | undefined) {
  return {
    Image: config.imageDigest, User: `${config.user.uid}:${config.user.gid}`, WorkingDir: '/workspace/work',
    Entrypoint: ['/bin/sh'], Cmd: KEEPER, Env: DOCKER_ENVIRONMENT, Tty: false, OpenStdin: false, StdinOnce: false,
    AttachStdin: false, AttachStdout: false, AttachStderr: false, NetworkDisabled: role === 'export',
    Healthcheck: { Test: ['NONE'] },
    Labels: resourceLabels(record, role),
    HostConfig: {
      ...isolatedHostPolicy(policy.resources),
      NetworkMode: role === 'compute' && policy.network.kind === 'outbound' ? networkId : 'none',
      Tmpfs: tmpfs(policy, config),
      Mounts: containerMounts(config.datasets, role, storageId, record.resources.some((resource) => resource.role === 'filesystem')),
    },
  };
}

export function verifyContainer(container: ContainerInspection, config: DockerSandboxConfig, policy: SandboxPolicy,
  role: 'compute' | 'export', storageId: string, networkId: string | undefined, started: boolean, privateWorkspace = false): void {
  const host = container.HostConfig;
  const expectedNetwork = role === 'compute' && policy.network.kind === 'outbound' ? networkId : 'none';
  verifyContainerMounts(container, config.datasets, role, storageId, privateWorkspace);
  const expectedTmpfs = tmpfs(policy, config);
  const actualTmpfs = host.Tmpfs;
  const configuration = container.Config;
  const healthcheck = configuration.Healthcheck;
  const networkNames = Object.keys(container.NetworkSettings.Networks);
  const attachment = Object.values(container.NetworkSettings.Networks)[0];
  if (configuration.User !== `${config.user.uid}:${config.user.gid}` || configuration.WorkingDir !== '/workspace/work'
    || !sameStrings(configuration.Entrypoint, ['/bin/sh']) || !sameStrings(configuration.Cmd, KEEPER)
    || !sameStrings(configuration.Env, DOCKER_ENVIRONMENT) || configuration.Tty || configuration.OpenStdin || configuration.StdinOnce !== false || !empty(configuration.Volumes)
    || typeof healthcheck !== 'object' || healthcheck === null || !sameStrings(Reflect.get(healthcheck, 'Test'), ['NONE'])
    || !matchesHostIsolation(host, policy.resources) || host.NetworkMode !== expectedNetwork
    || typeof actualTmpfs !== 'object' || actualTmpfs === null || Object.keys(actualTmpfs).length !== 2
    || Object.entries(expectedTmpfs).some(([path, value]) => Reflect.get(actualTmpfs, path) !== value)
    || (started && (!container.State.Running || container.AppArmorProfile !== dockerProfile(config.profile).appArmorProfile))
    || (started && (networkNames.length !== 1 || !empty(container.NetworkSettings.Ports)
      || (expectedNetwork === 'none' ? networkNames[0] !== 'none' : attachment.NetworkID !== networkId)))
    || (role === 'export' && (container.State.Running || container.State.Status !== 'created'))) {
    throw new SandboxUnsupportedError('Docker resource readback does not match the exact requested workload isolation and resource policy.');
  }
}
