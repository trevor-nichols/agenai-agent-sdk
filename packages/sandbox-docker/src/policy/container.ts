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
    Entrypoint: ['/bin/sh'], Cmd: KEEPER, Env: DOCKER_ENVIRONMENT, Tty: false, OpenStdin: false,
    AttachStdin: false, AttachStdout: false, AttachStderr: false, NetworkDisabled: role === 'export',
    Healthcheck: { Test: ['NONE'] },
    Labels: resourceLabels(record, role),
    HostConfig: {
      ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'],
      Privileged: false, PublishAllPorts: false, PortBindings: {}, Devices: [], DeviceRequests: [],
      Binds: [], PidMode: '', IpcMode: 'private', CgroupnsMode: 'private', UsernsMode: '',
      NetworkMode: role === 'export' || policy.network.kind === 'isolated' ? 'none' : networkId,
      NanoCpus: policy.resources.cpus * 1_000_000_000, Memory: policy.resources.memoryBytes,
      MemorySwap: policy.resources.memoryBytes, PidsLimit: policy.resources.pids,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
      Tmpfs: tmpfs(policy, config),
      Mounts: containerMounts(config.datasets, role, storageId),
    },
  };
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function empty(actual: unknown): boolean {
  return actual === null || actual === undefined || (Array.isArray(actual) ? actual.length === 0 : typeof actual === 'object' && Object.keys(actual).length === 0);
}

export function verifyContainer(container: ContainerInspection, config: DockerSandboxConfig, policy: SandboxPolicy,
  role: 'compute' | 'export', storageId: string, networkId: string | undefined, started: boolean): void {
  const host = container.HostConfig;
  const expectedNetwork = role === 'export' || policy.network.kind === 'isolated' ? 'none' : networkId;
  verifyContainerMounts(container, config.datasets, role, storageId);
  const expectedTmpfs = tmpfs(policy, config);
  const actualTmpfs = host.Tmpfs;
  const configuration = container.Config;
  const healthcheck = configuration.Healthcheck;
  const restart = host.RestartPolicy;
  const networkNames = Object.keys(container.NetworkSettings.Networks);
  const attachment = Object.values(container.NetworkSettings.Networks)[0];
  if (configuration.User !== `${config.user.uid}:${config.user.gid}` || configuration.WorkingDir !== '/workspace/work'
    || !sameStrings(configuration.Entrypoint, ['/bin/sh']) || !sameStrings(configuration.Cmd, KEEPER)
    || !sameStrings(configuration.Env, DOCKER_ENVIRONMENT) || configuration.Tty || configuration.OpenStdin || !empty(configuration.Volumes)
    || typeof healthcheck !== 'object' || healthcheck === null || !sameStrings(Reflect.get(healthcheck, 'Test'), ['NONE'])
    || host.ReadonlyRootfs !== true || host.Privileged !== false || !sameStrings(host.CapDrop, ['ALL']) || !empty(host.CapAdd)
    || !sameStrings(host.SecurityOpt, ['no-new-privileges:true']) || host.PublishAllPorts !== false || !empty(host.PortBindings)
    || !empty(host.Devices) || !empty(host.DeviceRequests) || !empty(host.Binds)
    || host.PidMode !== '' || host.IpcMode !== 'private' || host.CgroupnsMode !== 'private' || host.UsernsMode !== ''
    || host.NetworkMode !== expectedNetwork || host.NanoCpus !== policy.resources.cpus * 1_000_000_000
    || host.Memory !== policy.resources.memoryBytes || host.MemorySwap !== policy.resources.memoryBytes || host.PidsLimit !== policy.resources.pids
    || host.OomKillDisable === true || typeof restart !== 'object' || restart === null
    || Reflect.get(restart, 'Name') !== 'no' || Reflect.get(restart, 'MaximumRetryCount') !== 0
    || host.AutoRemove !== false
    || typeof actualTmpfs !== 'object' || actualTmpfs === null || Object.keys(actualTmpfs).length !== 2
    || Object.entries(expectedTmpfs).some(([path, value]) => Reflect.get(actualTmpfs, path) !== value)
    || (started && (!container.State.Running || container.AppArmorProfile !== dockerProfile(config.profile).appArmorProfile))
    || (started && (networkNames.length !== 1 || !empty(container.NetworkSettings.Ports)
      || (expectedNetwork === 'none' ? networkNames[0] !== 'none' : attachment.NetworkID !== networkId)))
    || (role === 'export' && (container.State.Running || container.State.Status !== 'created'))) {
    throw new SandboxUnsupportedError('Docker resource readback does not match the exact requested workload isolation and resource policy.');
  }
}
