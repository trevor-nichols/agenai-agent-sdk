import assert from 'node:assert/strict';

const entry = (id, kind, requirements, options = {}) => Object.freeze({ id, kind,
  requirements: Object.freeze(requirements), ...options });
const pair = (mode, order) => entry(`${mode}-${order}`, 'workflow', [mode === 'joint' ? 'L01' : 'L02', 'L03', 'L04', 'L05', 'D01', 'D02', 'D03', 'F08'],
  { startMode: mode === 'joint' ? 'prepare_both' : 'staged_addition', removalOrder: Object.freeze(order.split('')) });

// Native cuts are selected from the actual member ledger. The full effect census below also
// records source-only boundaries; an unexecuted boundary never inherits a native result.
export const concurrencyCases = Object.freeze([
  pair('joint', 'ab'), pair('joint', 'ba'), pair('staged', 'ab'), pair('staged', 'ba'),
  ...['reserved', 'creating', 'identified'].map((boundary) => entry(`interrupt-${boundary}`, 'interrupt', ['F01', 'F08'], { boundary })),
  ...['creating', 'identified', 'running', 'destroyed'].map((boundary) => entry(`persist-${boundary}`, 'persistence', ['F03', 'F08'], { boundary })),
  ...['filesystem', 'route_observer', 'egress_broker', 'egress_relay'].map((role) =>
    entry(`control-loss-${role}`, 'control_loss', ['D05', 'F04', 'F08'], { role, expectedDomain: 'member_local' })),
  entry('foreign-endpoint', 'foreign_endpoint', ['D04', 'F04', 'F08']),
  entry('foreign-network-sdk-labels', 'foreign_network', ['D04', 'F04', 'F08']),
  ...['create', 'start', 'delete'].flatMap((operation) => [
    entry(`lost-ack-${operation}`, 'lost_ack', ['F02', 'F06', 'F08'], { operation, role: 'compute' }),
    entry(`crash-${operation}`, 'crash', ['F02', 'F05', 'F06', 'F08'], { operation, role: 'compute' }),
  ]),
  ...['two-active', 'stop-entered', 'cleanup-entered'].map((boundary) =>
    entry(`crash-${boundary}`, 'crash', ['F05', 'F06', 'F08'], { boundary })),
  entry('lease-expiry-two-active', 'lease_expiry', ['D05', 'F05', 'F06', 'F08'], { boundary: 'two-active' }),
]);

export const concurrencyEffects = Object.freeze([
  ...['network', 'storage', 'egress_socket', 'route_observer', 'egress_broker', 'egress_relay', 'filesystem', 'compute', 'export']
    .map((role) => Object.freeze({ role, action: 'create', persistence: Object.freeze(['caller-creating', 'queue', 'arm', 'returned', 'caller-identified', 'settle']),
      nativeCases: Object.freeze(role === 'compute' ? ['lost-ack-create', 'crash-create'] : []) })),
  ...['route_observer', 'egress_broker', 'egress_relay', 'filesystem', 'compute', 'export']
    .map((role) => Object.freeze({ role, action: 'start', persistence: Object.freeze(['queue', 'arm', 'settle']),
      nativeCases: Object.freeze(role === 'compute' ? ['lost-ack-start', 'crash-start'] : []) })),
  ...['route_observer', 'egress_broker', 'egress_relay', 'filesystem'].map((role) => Object.freeze({ role,
    action: 'control_close', persistence: Object.freeze(['queue', 'arm', 'settle']), nativeCases: Object.freeze([`control-loss-${role}`]) })),
  ...['network', 'storage', 'egress_socket', 'route_observer', 'egress_broker', 'egress_relay', 'filesystem', 'compute', 'export']
    .map((role) => Object.freeze({ role, action: 'delete', persistence: Object.freeze(['queue', 'arm', 'settle']),
      nativeCases: Object.freeze(role === 'compute' ? ['lost-ack-delete', 'crash-delete'] : []) })),
  Object.freeze({ role: 'member', action: 'member_retire', persistence: Object.freeze(['caller-destroyed', 'retire']), nativeCases: Object.freeze(['persist-destroyed']) }),
]);

export const concurrencyCompositions = Object.freeze({
  'native-native': Object.freeze(['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-native-arm64']),
  'rosetta-rosetta': Object.freeze(['desktop-apple-virtualization-rosetta-amd64', 'desktop-apple-virtualization-rosetta-amd64']),
  'native-rosetta': Object.freeze(['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64']),
  'rosetta-native': Object.freeze(['desktop-apple-virtualization-rosetta-amd64', 'desktop-apple-virtualization-native-arm64']),
});

export function concurrencyCase(id) {
  const selected = concurrencyCases.find((candidate) => candidate.id === id);
  assert(selected, 'Unknown desktop-concurrency case; omitted cases cannot become passing qualification.');
  return selected;
}

export function requiredConcurrencyPhases(selected) {
  if (selected.kind !== 'workflow') return Object.freeze(['attempt-admitted', 'coordinator-active', 'fault-entered', 'original-cleanup', 'exact-absence']);
  return Object.freeze(['attempt-admitted', 'coordinator-active', 'prepared:a', 'prepared:b', 'dispatched:a', 'dispatched:b',
    ...selected.removalOrder.flatMap((label) => [`cancelled:${label}`, `stopped:${label}`, `exported:${label}`, `destroyed:${label}`]),
    'replacement_ready:c', 'completed', 'original-cleanup', 'exact-absence']);
}
