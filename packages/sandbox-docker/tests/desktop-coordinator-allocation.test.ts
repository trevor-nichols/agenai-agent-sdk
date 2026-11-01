import assert from 'node:assert/strict';
import test from 'node:test';
import { requireDesktopAllocationReadback, selectDesktopAllocation } from '../src/network/desktop/coordinator/allocation.js';
import { parseDesktopHostObservation } from '../src/network/desktop/observation/host.js';
import { desktopHostDocument } from './fixtures/desktopObservation.js';
import { projectionBaseEngine, projectionBaseVm, vmObservation } from './fixtures/desktopCoordinatorProjection.js';

const host = parseDesktopHostObservation(desktopHostDocument());
const input = { host, engine: projectionBaseEngine, vm: projectionBaseVm, occupiedSlots: [], liveBrokerExclusions: [[]] };

test('private allocation ignores forwarding defaults and policy-normalized private exclusions, retaining occupied slots', () => {
  assert.deepEqual(selectDesktopAllocation({ ...input, engine: { ...input.engine, excludedCidrs: ['10.0.0.0/8'] } }),
    { slot: 0, subnet: '10.240.0.0/28', gateway: '10.240.0.1' });
  assert.deepEqual(selectDesktopAllocation({ ...input, occupiedSlots: [0, 1] }),
    { slot: 2, subnet: '10.240.0.32/28', gateway: '10.240.0.33' });
  assert.throws(() => selectDesktopAllocation({ ...input, occupiedSlots: Array.from({ length: 16 }, (_, slot) => slot) }), /capacity is exhausted/u);
});

test('decoded host, VM source routes, gateways and Engine allocations prevent colliding /28 selection', () => {
  const document = desktopHostDocument();
  const occupiedHost = parseDesktopHostObservation({ ...document, interfaces: document.interfaces.map((device) => ({ ...device,
    addresses: [{ ...device.addresses[0], address: '10.240.0.5', netmask: '255.255.255.240', broadcast: { address: '10.240.0.15', scopeId: 0 } }] })) });
  const external = { ...projectionBaseEngine.networks[0], Id: 'e'.repeat(64), Name: 'external', Driver: 'bridge',
    IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: '10.240.0.32/28', Gateway: '10.240.0.33' }] } };
  const defaultRoute = projectionBaseVm.snapshot.routes[0];
  const vm = vmObservation({ ...projectionBaseVm.snapshot, routes: [
    { ...defaultRoute, source: '10.240.0.16', sourcePrefix: 28, gateways: ['10.240.0.49'] },
  ] });
  assert.deepEqual(selectDesktopAllocation({ ...input, host: occupiedHost, vm,
    engine: { ...projectionBaseEngine, networks: [...projectionBaseEngine.networks, external] } }),
  { slot: 4, subnet: '10.240.0.64/28', gateway: '10.240.0.65' });
  const all = { ...external, IPAM: { ...external.IPAM, Config: [{ Subnet: '10.240.0.0/24', Gateway: '10.240.0.1' }] } };
  assert.throws(() => selectDesktopAllocation({ ...input, engine: { ...projectionBaseEngine, networks: [all] } }), /capacity is exhausted/u);
});

test('readback cannot substitute another private subnet, gateway, prefix or slot', () => {
  const expected = selectDesktopAllocation(input);
  requireDesktopAllocationReadback(expected, { subnet: '10.240.0.0/28', gateway: '10.240.0.1' });
  for (const actual of [
    { subnet: '10.240.0.16/28', gateway: '10.240.0.17' }, { subnet: '10.240.0.0/28', gateway: '10.240.0.2' },
    { subnet: '11.240.0.0/28', gateway: '11.240.0.1' }, { subnet: '10.240.0.0/24', gateway: '10.240.0.1' },
  ]) assert.throws(() => requireDesktopAllocationReadback(expected, actual), /original reserved subnet/u);
  assert.throws(() => requireDesktopAllocationReadback({ ...expected, slot: 1 }, expected), /original reserved subnet/u);
});
