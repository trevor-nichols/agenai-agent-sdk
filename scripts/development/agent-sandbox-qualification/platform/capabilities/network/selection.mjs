import assert from 'node:assert/strict';

const connectivity = Object.freeze([
  'baseline-isolated-no-helper', 'baseline-outbound-marker-controls', 'verified-tls-exact-body',
  'restricted-process-isolation', 'connect-unlisted-and-canonical-forms',
  'host-and-special-host-reachable-denials', 'vm-gateway-reachable-denials',
  'public-numbered-sibling-reachable-denials', 'allowed-dns-public-local-denied',
  'direct-no-proxy-tcp-udp', 'ipv6-unsupported-no-bypass',
]);
const faults = Object.freeze([
  'broker-loss-active-tunnel', 'relay-loss-active-tunnel',
  'broker-control-eof-active-tunnel', 'relay-control-eof-active-tunnel',
  'route-observer-loss-active-tunnel', 'route-observer-control-eof-active-tunnel',
  'host-observer-unavailable', 'authority-loss-during-resource-create',
  'authority-loss-before-process-admission', 'observed-owned-route-addition',
  'foreign-member-authority-fence', 'authority-loss-during-stop',
  'paused-controller-native-lease', 'original-checkpoint-fresh-cleanup-only',
  'withheld-native-control-acknowledgement',
]);
export const compatibilityCaseNames = Object.freeze([
  'captured-native-connect-header', 'connect-user-agent-clients-and-tls', 'connect-user-agent-denials-and-bounds',
]);
export const networkCaseNames = Object.freeze([...connectivity, ...faults]);
export const publicNetworkCaseNames = Object.freeze(connectivity.slice(4));
const connectivityRequirements = Object.freeze({
  D11: ['verified-tls-exact-body', 'connect-unlisted-and-canonical-forms', 'direct-no-proxy-tcp-udp'],
  D12: ['host-and-special-host-reachable-denials', 'vm-gateway-reachable-denials', 'public-numbered-sibling-reachable-denials', 'allowed-dns-public-local-denied'],
  D13: ['connect-unlisted-and-canonical-forms', 'allowed-dns-public-local-denied', 'ipv6-unsupported-no-bypass'],
});

export function networkSelection(kind = 'full') {
  assert(['full', 'connect-compatibility', 'legacy-connect-baseline'].includes(kind), 'Unknown restricted HTTPS selection.');
  const cases = kind === 'full' ? networkCaseNames : kind === 'connect-compatibility'
    ? [...connectivity, ...compatibilityCaseNames] : [compatibilityCaseNames[0]];
  const requirements = kind === 'full' ? { ...connectivityRequirements, D14: faults }
    : kind === 'connect-compatibility' ? { ...connectivityRequirements,
      C01: [compatibilityCaseNames[0]], C02: [compatibilityCaseNames[1]], C03: [compatibilityCaseNames[2]] }
      : { C01_OLD_HELPER_REJECTION: [compatibilityCaseNames[0]] };
  return Object.freeze({ kind, cases: Object.freeze([...cases]),
    omittedCases: Object.freeze([...networkCaseNames, ...compatibilityCaseNames].filter((name) => !cases.includes(name))),
    capturedConnectStatus: kind === 'legacy-connect-baseline' ? 403 : kind === 'connect-compatibility' ? 200 : null,
    requirements: Object.freeze(Object.fromEntries(Object.entries(requirements).map(([name, selected]) => [name, Object.freeze([...selected])]))),
    unexercisedRequirements: Object.freeze(kind === 'full' ? ['C01', 'C02', 'C03'] : kind === 'connect-compatibility' ? ['D14'] : ['D11', 'D12', 'D13', 'D14', 'C01', 'C02', 'C03']),
  });
}
