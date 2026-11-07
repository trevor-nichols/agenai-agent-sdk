import assert from 'node:assert/strict';

export const isDefaultBridge = (network) => network.Name === 'bridge' && network.Driver === 'bridge'
  && network.Options?.['com.docker.network.bridge.default_bridge'] === 'true';

export const networkIds = (networks) => networks.map(({ Id }) => Id).sort();

/** An unprepared row may start on a stopped Resource Saver VM, whose boot recreates the default bridge. */
export function assertNetworkCensusReturned(initial, final, { coldStart }) {
  const before = initial.find(isDefaultBridge), after = final.find(isDefaultBridge);
  const replacement = coldStart && before && after && before.Id !== after.Id ? { before: before.Id, after: after.Id } : null;
  const ids = (networks, replaced) => networkIds(networks).filter((id) => id !== replaced);
  assert.deepEqual(ids(final, replacement?.after), ids(initial, replacement?.before),
    'Original Engine network census did not return to its initial identities.');
  return replacement;
}
