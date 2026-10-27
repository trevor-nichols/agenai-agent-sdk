// ------------------------------------------------------------------------------------------------
//                fingerprint.ts - Immutable container configuration identity - Explicit Engine fields
// ------------------------------------------------------------------------------------------------

import { digest } from '../recovery/identity.js';
import type { ContainerInspection } from './inspect.js';

const CONFIGURATION_FIELDS = [
  'Image', 'User', 'WorkingDir', 'Entrypoint', 'Cmd', 'Env', 'Labels', 'Tty', 'OpenStdin', 'StdinOnce',
  'AttachStdin', 'AttachStdout', 'AttachStderr', 'NetworkDisabled', 'Healthcheck', 'Volumes', 'ExposedPorts', 'StopSignal', 'StopTimeout',
] as const;

const HOST_POLICY_FIELDS = [
  'ReadonlyRootfs', 'Privileged', 'CapDrop', 'CapAdd', 'SecurityOpt',
  'PidMode', 'IpcMode', 'CgroupnsMode', 'UsernsMode', 'UTSMode', 'CgroupParent',
  'NetworkMode', 'PublishAllPorts', 'PortBindings', 'ExtraHosts', 'Links', 'Dns', 'DnsOptions', 'DnsSearch',
  'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'Binds', 'Mounts', 'Tmpfs', 'VolumesFrom',
  'NanoCpus', 'Memory', 'MemorySwap', 'MemoryReservation', 'MemorySwappiness', 'PidsLimit',
  'CpuShares', 'CpuPeriod', 'CpuQuota', 'CpuRealtimePeriod', 'CpuRealtimeRuntime', 'CpusetCpus', 'CpusetMems',
  'RestartPolicy', 'AutoRemove', 'Runtime', 'Init', 'StorageOpt', 'Ulimits',
] as const;

function selected(value: Readonly<Record<string, unknown>>, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

export function containerFingerprint(container: ContainerInspection): string {
  return digest({ Id: container.Id, Name: container.Name, Image: container.Image,
    Config: selected(container.Config, CONFIGURATION_FIELDS), HostConfig: selected(container.HostConfig, HOST_POLICY_FIELDS),
    // Moby clears an unsupported false OOM switch to null when starting on cgroup v2.
    OomKillDisabled: container.HostConfig.OomKillDisable === true,
    Mounts: [...container.Mounts].sort((left, right) => left.Destination < right.Destination ? -1 : left.Destination > right.Destination ? 1 : 0)
      .map((mount) => ({ Type: mount.Type, Name: mount.Name, Source: mount.Source,
      Destination: mount.Destination, RW: mount.RW, Driver: mount.Driver, Propagation: mount.Propagation })),
  });
}
