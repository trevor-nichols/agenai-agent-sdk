import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesktopVmObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import { memberFixture } from './fixtures.js';
import { captureDesktopRetainedState, captureDesktopRetainedTransition, validateDesktopRetainedState, validateDesktopRetainedTransition } from './retained.js';

// Owning research boundary: catches broad flags normalization, stale index adoption and false
// deactivation settlement. Existing source intentionally rejects the newly observed retained IPv6 flags.
test('retained deactivation accepts only exact original routes/device alternatives and identifies settlement', () => {
  const member = memberFixture(0); const bridge = member.active.bridge;
  if (!bridge || bridge.phase !== 'endpoint') throw new Error('Fixture lacks its original settled graph.');
  const context = captureDesktopRetainedTransition(bridge.owned, member.endpointVm);
  const previous = context.bridge;
  const retained = (settled: boolean, restoreTso = false): DesktopVmObservation => ({ ...member.endpointVm,
    snapshot: { ...member.endpointVm.snapshot, interfaces: [{ ...previous, carrier: 0,
      flags: previous.flags & ~(settled ? 0x10040 : 0x10000), operationalState: settled ? 2 : 6,
      tsoMaxSize: restoreTso ? context.owned.device.tsoMaxSize : previous.tsoMaxSize }],
    routes: context.routes.map((route) => ({ ...route,
      flags: settled && (route.family === 4 && [1, 3].includes(route.type) || route.family === 6 && [1, 5].includes(route.type)) ? 0x10 : route.flags })) } });
  const down = retained(true);
  assert.equal(validateDesktopRetainedTransition(context, retained(false)).kind, 'settling');
  assert.equal(validateDesktopRetainedTransition(context, down).kind, 'settled');
  assert.equal(validateDesktopRetainedTransition(context, retained(true, true)).kind, 'settled');
  assert.throws(() => captureDesktopRetainedState(context, retained(false)), /terminal deactivation/u);
  const fixed = captureDesktopRetainedState(context, down);
  assert.equal(validateDesktopRetainedState(fixed, down).length, 1);
  const changedDevice = (change: Partial<typeof previous>) => ({ ...down, snapshot: { ...down.snapshot,
    interfaces: [{ ...down.snapshot.interfaces[0], ...change }] } });
  const localRoute = context.routes.find((route) => route.family === 6 && route.type === 2);
  if (!localRoute) throw new Error('Fixture lacks original local IPv6 route.');
  const negatives: ReadonlyArray<readonly [string, DesktopVmObservation]> = [
    ['foreign route', { ...down, snapshot: { ...down.snapshot, routes: [...down.snapshot.routes, { ...localRoute, destination: '2001:db8::1', flags: 16 }] } }],
    ['flags on local route', { ...down, snapshot: { ...down.snapshot, routes: down.snapshot.routes.map((route) => route.type === 2 ? { ...route, flags: 16 } : route) } }],
    ['unknown flags', { ...down, snapshot: { ...down.snapshot, routes: down.snapshot.routes.map((route) => ({ ...route, flags: 32 })) } }],
    ['foreign gateway', { ...down, snapshot: { ...down.snapshot, routes: down.snapshot.routes.map((route) => ({ ...route, gateways: ['11.1.1.1'] })) } }],
    ['index reuse', changedDevice({ name: 'replacement', macAddress: '02:00:00:00:00:77' })],
    ['stale index', changedDevice({ index: previous.index + 99 })],
    ['unknown TSO', changedDevice({ tsoMaxSize: 77777 })],
    ['address drift', changedDevice({ addresses: previous.addresses.slice(0, 1) })],
    ['retired endpoint index reused', { ...down, snapshot: { ...down.snapshot, interfaces: [...down.snapshot.interfaces, member.endpointVm.snapshot.interfaces[1]] } }],
  ];
  for (const [label, observation] of negatives) assert.throws(() => validateDesktopRetainedTransition(context, observation), Error, label);
  assert.throws(() => validateDesktopRetainedState(fixed, changedDevice({ name: 'replacement' })), /authority changed/u);
  assert.throws(() => validateDesktopRetainedState(fixed, retained(true, true)), /authority changed/u);
  const newMemberInterface = { ...member.endpointVm.snapshot.interfaces[1], name: 'registered-peer', masterIndex: 99 };
  assert.equal(validateDesktopRetainedState(fixed, { ...down, snapshot: { ...down.snapshot,
    interfaces: [...down.snapshot.interfaces, newMemberInterface] } }).length, 1);
});
