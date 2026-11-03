import assert from 'node:assert/strict';
import { networkSelection } from './selection.mjs';
export { networkCaseNames } from './selection.mjs';

export function networkScenarioBudget(manifest) {
  const egress = manifest.network.egress.configuration;
  const roles = [
    { role: 'daemon_observer', count: 1, cpus: 1, memoryBytes: 256 * 1024 ** 2, pids: 32 },
    { role: 'compute', count: 1, ...manifest.workload.resources },
    { role: 'egress_broker', count: 1, ...egress.broker.resources },
    { role: 'egress_relay', count: 1, ...egress.relay.resources },
    { role: 'route_observer', count: 1, ...manifest.network.routeAuthority.vmObserver.resources },
    { role: 'qualification_fixture', count: 3, cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 32 },
  ];
  const nanoCpus = roles.reduce((sum, role) => sum + role.count * role.cpus * 1_000_000_000, 0);
  const memoryBytes = roles.reduce((sum, role) => sum + role.count * role.memoryBytes, 0);
  assert(nanoCpus <= 4_000_000_000 && memoryBytes <= 4 * 1024 ** 3,
    'Restricted scenarios exceed four CPUs or four GiB.');
  // Two baseline owners start one container each; all other owners can start four.
  const selection = networkSelection(manifest.network.selection);
  const maximumScopes = selection.cases.reduce((total, name) => total
    + (name === 'baseline-isolated-no-helper' || name === 'baseline-outbound-marker-controls' ? 1 : 4), 3);
  return Object.freeze({ nanoCpus, memoryBytes, maximumCases: selection.cases.length, maximumScopes,
    maximumConcurrentOwners: 1, maximumConcurrentFixtures: 3, observerCapacity: 128,
    roles: Object.freeze(roles.map(Object.freeze)) });
}
