import assert from 'node:assert/strict';

export const networkCaseNames = Object.freeze([
  'baseline-isolated-no-helper', 'baseline-outbound-marker-controls', 'verified-tls-exact-body',
  'restricted-process-isolation', 'connect-unlisted-and-canonical-forms',
  'host-and-special-host-reachable-denials', 'vm-gateway-reachable-denials',
  'public-numbered-sibling-reachable-denials', 'allowed-dns-public-local-denied',
  'direct-no-proxy-tcp-udp', 'ipv6-unsupported-no-bypass',
  'broker-loss-active-tunnel', 'relay-loss-active-tunnel',
  'broker-control-eof-active-tunnel', 'relay-control-eof-active-tunnel',
  'route-observer-loss-active-tunnel', 'route-observer-control-eof-active-tunnel',
  'host-observer-unavailable', 'authority-loss-during-resource-create',
  'authority-loss-before-process-admission', 'observed-owned-route-addition',
  'foreign-member-authority-fence', 'authority-loss-during-stop',
  'paused-controller-native-lease', 'original-checkpoint-fresh-cleanup-only',
  'withheld-native-control-acknowledgement',
]);

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
  const maximumScopes = 2 + (networkCaseNames.length - 2) * 4 + 3;
  assert.equal(maximumScopes, 101);
  return Object.freeze({ nanoCpus, memoryBytes, maximumCases: networkCaseNames.length, maximumScopes,
    maximumConcurrentOwners: 1, maximumConcurrentFixtures: 3, observerCapacity: 128,
    roles: Object.freeze(roles.map(Object.freeze)) });
}
