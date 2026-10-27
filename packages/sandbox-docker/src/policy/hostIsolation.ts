// ------------------------------------------------------------------------------------------------
//                hostIsolation.ts - Fixed container resource and privilege policy across owned roles
// ------------------------------------------------------------------------------------------------

import type { SandboxResources } from '@agen-ai/sandbox';

export function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function empty(actual: unknown): boolean {
  return actual === null || actual === undefined || (Array.isArray(actual) ? actual.length === 0 : typeof actual === 'object' && Object.keys(actual).length === 0);
}

export function isolatedHostPolicy(resources: SandboxResources) {
  return {
    ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'],
    Privileged: false, PublishAllPorts: false, PortBindings: {}, Devices: [], DeviceRequests: [],
    Binds: [], PidMode: '', IpcMode: 'private', CgroupnsMode: 'private', UsernsMode: '',
    NanoCpus: resources.cpus * 1_000_000_000, Memory: resources.memoryBytes,
    MemorySwap: resources.memoryBytes, PidsLimit: resources.pids,
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
  };
}

export function matchesHostIsolation(host: Readonly<Record<string, unknown>>, resources: SandboxResources): boolean {
  const restart = host.RestartPolicy;
  return host.ReadonlyRootfs === true && host.Privileged === false && sameStrings(host.CapDrop, ['ALL']) && empty(host.CapAdd)
    && sameStrings(host.SecurityOpt, ['no-new-privileges:true']) && host.PublishAllPorts === false && empty(host.PortBindings)
    && empty(host.Devices) && empty(host.DeviceRequests) && empty(host.Binds)
    && host.PidMode === '' && host.IpcMode === 'private' && host.CgroupnsMode === 'private' && host.UsernsMode === ''
    && host.NanoCpus === resources.cpus * 1_000_000_000 && host.Memory === resources.memoryBytes
    && host.MemorySwap === resources.memoryBytes && host.PidsLimit === resources.pids
    && host.OomKillDisable !== true && typeof restart === 'object' && restart !== null
    && Reflect.get(restart, 'Name') === 'no' && Reflect.get(restart, 'MaximumRetryCount') === 0 && host.AutoRemove === false;
}
