import assert from 'node:assert/strict';

export const combinedFaults = Object.freeze([
  'resource-create-acknowledgement', 'filesystem-initialization', 'network-ready',
  'entered-live-write', 'process-active', 'stop-entered', 'cleanup-entered',
]);

export function combinedCaseNames(manifest) {
  return Object.freeze([
    ...manifest.transfers.hostRoots.flatMap(({ role }) => [`${role}-normal`, `${role}-cancelled`]),
    'simultaneous-sibling-isolation', ...combinedFaults.map((name) => `crash-${name}`),
    'cleanup-acknowledgement-retry',
  ]);
}

export function combinedScenarioBudget(manifest) {
  const roles = [
    { role: 'daemon_observer', count: 1, cpus: 1, memoryBytes: 256 * 1024 ** 2, pids: 32 },
    { role: 'compute', count: 2, ...manifest.workload.resources },
    { role: 'filesystem', count: 2, ...manifest.filesystem.configuration.resources },
    { role: 'egress_broker', count: 2, ...manifest.network.egress.configuration.broker.resources },
    { role: 'egress_relay', count: 2, ...manifest.network.egress.configuration.relay.resources },
    ...(manifest.profile === 'linux-x64' ? [] : [{ role: 'route_observer', count: 2, ...manifest.network.routeAuthority.vmObserver.resources }]),
    { role: 'qualification_fixture', count: 2, cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 32 },
  ];
  const nanoCpus = roles.reduce((sum, role) => sum + role.count * role.cpus * 1_000_000_000, 0);
  const memoryBytes = roles.reduce((sum, role) => sum + role.count * role.memoryBytes, 0);
  assert(nanoCpus <= 4_000_000_000 && memoryBytes <= 4 * 1024 ** 3,
    'Combined scenarios require two simultaneous owners and all helpers within four CPUs/four GiB.');
  const maximumCases = combinedCaseNames(manifest).length;
  const containersPerOwner = manifest.profile === 'linux-x64' ? 5 : 6;
  return Object.freeze({ nanoCpus, memoryBytes, maximumCases,
    maximumScopes: (maximumCases + 1) * containersPerOwner + 2,
    maximumConcurrentOwners: 2, maximumConcurrentFixtures: 2, observerCapacity: 128,
    roles: Object.freeze(roles.map(Object.freeze)) });
}
