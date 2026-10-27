import assert from 'node:assert/strict';

export function liveScenarioBudget(manifest) {
  const workload = manifest.workload.resources;
  const filesystem = manifest.filesystem.configuration.resources;
  const roles = [
    { role: 'daemon_observer', count: 1, cpus: 1, memoryBytes: 256 * 1024 ** 2 },
    { role: 'workload', count: 2, ...workload },
    { role: 'filesystem', count: 2, ...filesystem },
    { role: 'qualification_sentinel', count: 1, cpus: 0.25, memoryBytes: 64 * 1024 ** 2 },
  ];
  const nanoCpus = roles.reduce((total, role) => total + role.count * role.cpus * 1_000_000_000, 0);
  const memoryBytes = roles.reduce((total, role) => total + role.count * role.memoryBytes, 0);
  assert(nanoCpus <= 4_000_000_000 && memoryBytes <= 4 * 1024 ** 3,
    'Live scenarios require two workspaces and helpers, one sentinel and the daemon observer within four CPUs/four GiB.');
  return Object.freeze({ nanoCpus, memoryBytes, roles: Object.freeze(roles.map(Object.freeze)) });
}
