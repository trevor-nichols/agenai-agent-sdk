import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDesktopActiveGraph, captureDesktopRetainedState, captureDesktopRetainedTransition,
  projectDesktopEngineExternal, projectDesktopExternal, validateDesktopProjectionCandidate } from '../src/network/desktop/coordinator/projection.js';
import type { DesktopMemberProjection } from '../src/network/desktop/coordinator/projection.js';
import { releaseDesktopRetainedTransition, validateDesktopRetainedTransition,
  validateDesktopRetiringEndpoint } from '../src/network/desktop/coordinator/projection/retained.js';
import type { DesktopEngineNetwork } from '../src/network/desktop/observation/engine.js';
import type { DesktopVmInterface, DesktopVmObservation, DesktopVmRoute, DesktopVmSnapshot } from '../src/network/desktop/observation/vm.js';
import { composeProjection, coordinatorProjectionMember, projectionBaseline, projectionBaseEngine, vmObservation } from './fixtures/desktopCoordinatorProjection.js';

test('staged registered startup preserves the immutable external graph and fixed active sibling', () => {
  const a = coordinatorProjectionMember(0); const b = coordinatorProjectionMember(1);
  const live = { fixture: a, projection: a.active, vm: a.endpointVm, endpoint: true };
  for (const phase of [
    { projection: b.empty, vm: b.emptyVm, endpoint: false },
    { projection: b.starting, vm: b.endpointVm, endpoint: true },
    { projection: b.active, vm: b.endpointVm, endpoint: true },
  ]) {
    const observation = composeProjection([live, { fixture: b, ...phase }]);
    const result = validateDesktopProjectionCandidate({ engine: observation.engine, vmBefore: observation.vm, vmAfter: observation.vm },
      [a.active, phase.projection], projectionBaseline);
    assert.deepEqual(result.external, projectionBaseline);
    assert.equal(result.settled, true);
    assert.equal(result.members[0].graph?.fingerprint, a.active.bridge.kind === 'active' ? a.active.bridge.graph.fingerprint : undefined);
  }
});

test('exact engine-only observer bootstrap does not grant an arbitrary host or none exemption', () => {
  const a = coordinatorProjectionMember(0);
  const observer: DesktopMemberProjection = { ...a.empty, bridge: { kind: 'absent' } };
  assert.equal(observer.observer.kind, 'present');
  if (observer.observer.kind !== 'present') throw new Error('Expected fixture observer membership.');
  const host = { ...projectionBaseEngine.networks[0], Containers: { [a.observerId]: {
    Name: 'observer-0', EndpointID: observer.observer.endpointId, MacAddress: '', IPv4Address: '', IPv6Address: '',
  } } };
  const engine = { ...projectionBaseEngine, networks: [host, projectionBaseEngine.networks[1]] };
  assert.deepEqual(projectDesktopEngineExternal(engine, [observer]), projectionBaseline.engine);
  assert.throws(() => projectDesktopEngineExternal({ ...engine, networks: [
    { ...host, Containers: {} }, { ...projectionBaseEngine.networks[1], Containers: host.Containers },
  ] }, [observer]), /exact builtin-network membership/u);
  assert.throws(() => projectDesktopEngineExternal({ ...engine, networks: [
    { ...host, Containers: { [a.observerId]: { ...host.Containers[a.observerId], Name: 'renamed-observer' } } }, projectionBaseEngine.networks[1],
  ] }, [observer]), /exact builtin-network membership/u);
  for (const EndpointID of ['', 'f'.repeat(64)]) assert.throws(() => projectDesktopEngineExternal({ ...engine, networks: [
    { ...host, Containers: { [a.observerId]: { ...host.Containers[a.observerId], EndpointID } } }, projectionBaseEngine.networks[1],
  ] }, [observer]), /exact builtin-network membership/u);
});

test('a retiring producer may be listed by its own detached endpoint and by nothing else', () => {
  const a = coordinatorProjectionMember(0);
  assert(a.empty.observer.kind === 'present');
  const { endpointId, name } = a.empty.observer;
  const entry = { Name: name, EndpointID: endpointId, MacAddress: '', IPv4Address: '', IPv6Address: '' };
  const engine = (Containers: DesktopEngineNetwork['Containers']) => ({ ...projectionBaseEngine,
    networks: [{ ...projectionBaseEngine.networks[0], Containers }, projectionBaseEngine.networks[1]] });
  for (const kind of ['present', 'releasing'] as const) {
    const member: DesktopMemberProjection = { ...a.empty, bridge: { kind: 'absent' }, observer: { ...a.empty.observer, kind } };
    assert.deepEqual(projectDesktopEngineExternal(engine({ [`ep-${endpointId}`]: entry }), [member]), projectionBaseline.engine, kind);
    for (const [problem, Containers] of [
      ['listed twice', { [a.observerId]: entry, [`ep-${endpointId}`]: entry }],
      ['renamed detached endpoint', { [`ep-${endpointId}`]: { ...entry, Name: 'renamed-observer' } }],
      ['detached endpoint with another identity', { [`ep-${endpointId}`]: { ...entry, EndpointID: 'f'.repeat(64) } }],
    ] as const) assert.throws(() => projectDesktopEngineExternal(engine(Containers), [member]), /exact builtin-network membership/u, `${kind}: ${problem}`);
  }
  const foreign = engine({ [`ep-${'f'.repeat(64)}`]: { ...entry, EndpointID: 'f'.repeat(64) } });
  assert.throws(() => projectDesktopEngineExternal(foreign, [{ ...a.empty, bridge: { kind: 'absent' } }]), /registered Desktop producer disappeared/u);
  assert.notDeepEqual(projectDesktopEngineExternal(foreign, [{ ...a.empty, bridge: { kind: 'absent' },
    observer: { ...a.empty.observer, kind: 'releasing' } }]), projectionBaseline.engine);
});

test('registered IDs and transitions never conceal foreign topology or changed owned IPAM', () => {
  const a = coordinatorProjectionMember(0);
  const observation = composeProjection([{ fixture: a, projection: a.active, vm: a.endpointVm, endpoint: true }]);
  const extra = 'f'.repeat(64);
  assert.throws(() => projectDesktopExternal({ ...observation, engine: { ...observation.engine,
    networks: observation.engine.networks.map((network) => network.Id !== a.network.Id ? network : { ...network,
      Containers: { ...network.Containers, [extra]: { Name: 'foreign', EndpointID: extra, MacAddress: '02:00:00:00:00:fe', IPv4Address: '10.240.0.3/28', IPv6Address: '' } } }) } }, [a.active]), /sole exact Engine endpoint/u);
  const b = coordinatorProjectionMember(1);
  const lookalike = { ...b.network, Labels: a.network.Labels };
  assert.throws(() => validateDesktopProjectionCandidate({ engine: { ...observation.engine, networks: [...observation.engine.networks, lookalike] },
    vmBefore: observation.vm, vmAfter: observation.vm }, [a.active], projectionBaseline), /External Desktop topology changed/u);
  const route = observation.vm.snapshot.routes.find((entry) => entry.interfaceIndex === a.owned.device.index);
  assert(route);
  const foreignRoute = { ...route, destination: '11.7.0.0', prefix: 16 };
  assert.throws(() => projectDesktopExternal({ ...observation, vm: vmObservation({ ...observation.vm.snapshot,
    routes: [...observation.vm.snapshot.routes, foreignRoute] }) }, [a.active]), /Owned native route exceeds/u);
  const changed = vmObservation({ ...observation.vm.snapshot, interfaces: observation.vm.snapshot.interfaces.map((device) =>
    device.masterIndex === a.owned.device.index ? { ...device, name: 'changed-veth' } : device) });
  assert.throws(() => projectDesktopExternal({ ...observation, vm: changed }, [a.active]), /Sealed Desktop member VM graph changed/u);
  assert.throws(() => projectDesktopExternal(observation, [a.active, { ...a.empty, memberId: 'alias-member' }]), /alias an original resource or subnet slot/u);
  const foreignNetwork = { ...coordinatorProjectionMember(2).network, Labels: a.network.Labels };
  const live = { fixture: a, projection: a.active, vm: a.endpointVm, endpoint: true };
  for (const phase of [
    { name: 'registered empty bridge', projection: b.empty, endpoint: false, before: b.emptyVm, after: b.emptyVm, settled: true },
    { name: 'endpoint acquisition before attachment', projection: b.starting, endpoint: false, before: b.emptyVm, after: b.emptyVm, settled: false },
    { name: 'endpoint acquisition during attachment', projection: b.starting, endpoint: true, before: b.emptyVm, after: b.endpointVm, settled: false },
    { name: 'sealed active peer', projection: b.active, endpoint: true, before: b.endpointVm, after: b.endpointVm, settled: true },
  ]) {
    const before = composeProjection([live, { fixture: b, projection: phase.projection, vm: phase.before, endpoint: phase.endpoint }]);
    const after = composeProjection([live, { fixture: b, projection: phase.projection, vm: phase.after, endpoint: phase.endpoint }]);
    const candidate = { engine: after.engine, vmBefore: before.vm, vmAfter: after.vm };
    const members = [a.active, phase.projection];
    const healthy = validateDesktopProjectionCandidate(candidate, members, projectionBaseline);
    assert.deepEqual(healthy.external, projectionBaseline, phase.name);
    assert.equal(healthy.settled, phase.settled, phase.name);
    assert.throws(() => validateDesktopProjectionCandidate({ ...candidate, engine: { ...candidate.engine,
      networks: candidate.engine.networks.map((network) => network.Id !== b.network.Id ? network : { ...network,
        IPAM: { ...network.IPAM, Config: [{ Subnet: '11.7.0.0/16', Gateway: '11.7.0.1' }] } }) } }, members, projectionBaseline),
    { name: 'SandboxOperationError', code: 'driver_failure', message: phase.endpoint
      ? /Owned network configuration changed/u : /Empty Desktop network differs from its original exact receipt/u }, phase.name);
    assert.throws(() => validateDesktopProjectionCandidate({ ...candidate, engine: { ...candidate.engine,
      networks: [...candidate.engine.networks, foreignNetwork] } }, members, projectionBaseline),
    { name: 'SandboxOperationError', code: 'driver_failure', message: /External Desktop topology changed before/u }, phase.name);
    for (const bracket of ['vmBefore', 'vmAfter'] as const) {
      const original = candidate[bracket];
      const externalRoute = original.snapshot.routes.find((entry) => entry.interfaceIndex === 7);
      assert(externalRoute);
      const changedVm = vmObservation({ ...original.snapshot,
        routes: [...original.snapshot.routes, { ...externalRoute, destination: '11.7.0.0', prefix: 16 }] });
      assert.throws(() => validateDesktopProjectionCandidate({ ...candidate, [bracket]: changedVm }, members, projectionBaseline),
        { name: 'SandboxOperationError', code: 'driver_failure', message: bracket === 'vmBefore'
          ? /External Desktop topology changed before/u : /External Desktop topology changed during/u }, `${phase.name}: ${bracket}`);
    }
  }
});

test('endpoint acquisition accepts only its finite forward graph and refuses premature active capture', () => {
  const a = coordinatorProjectionMember(0);
  const empty = composeProjection([{ fixture: a, projection: a.starting, vm: a.emptyVm, endpoint: false }]);
  const active = composeProjection([{ fixture: a, projection: a.starting, vm: a.endpointVm, endpoint: true }]);
  assert.equal(validateDesktopProjectionCandidate({ engine: active.engine, vmBefore: empty.vm, vmAfter: active.vm },
    [a.starting], projectionBaseline).settled, false);
  assert.equal(validateDesktopProjectionCandidate({ engine: empty.engine, vmBefore: active.vm, vmAfter: active.vm },
    [a.starting], projectionBaseline).settled, false, 'VM readiness cannot replace the missing Engine endpoint.');
  assert.throws(() => validateDesktopProjectionCandidate({ engine: active.engine, vmBefore: active.vm, vmAfter: empty.vm },
    [a.starting], projectionBaseline), /moved backwards/u);
  const tentative = vmObservation({ ...a.endpointVm.snapshot, interfaces: a.endpointVm.snapshot.interfaces.map((device) => ({ ...device,
    addresses: device.addresses.map((address) => address.family === 6 ? { ...address, flags: 0xc0 } : address) })) });
  assert.throws(() => captureDesktopActiveGraph(a.owned, tentative), /requires settled link-local/u);
});

test('a retiring endpoint may lose carrier before its veth is deleted and nothing else may change', () => {
  const a = coordinatorProjectionMember(0);
  const transition = captureDesktopRetainedTransition(a.owned, a.endpointVm);
  const removing: DesktopMemberProjection = { ...a.starting, bridge: { kind: 'removing_endpoint', owned: a.owned,
    started: a.started, brokerName: 'broker-0', transition } };
  const bridgeIndex = a.owned.device.index;
  const portIndex = transition.endpoint.index;
  const linkdown = (route: DesktopVmRoute) => route.family === 6 && (route.type === 1 || route.type === 5)
    || route.family === 4 && (route.type === 1 || route.type === 3);
  // Native nn14r10s1: the exited broker's veth loses carrier and its bridge port is disabled before Engine deletes it.
  const retiring = (bridgeDown: boolean, edit: (snapshot: DesktopVmSnapshot) => DesktopVmSnapshot = (snapshot) => snapshot) => {
    const snapshot = a.endpointVm.snapshot;
    return vmObservation(edit({ ...snapshot,
      interfaces: snapshot.interfaces.map((device) => device.index === bridgeIndex
        ? { ...device, flags: device.flags & ~(bridgeDown ? 0x10040 : 0x10000), operationalState: bridgeDown ? 2 : 6, carrier: 0 }
        : device.index === portIndex ? { ...device, flags: device.flags & ~0x10040, operationalState: 2, carrier: 0,
          attributes: device.attributes.map((entry) => entry.replace('"slave":["1:0:03"]', '"slave":["1:0:00"]')) } : device),
      routes: snapshot.routes.map((route) => linkdown(route)
        && (route.interfaceIndex === portIndex || bridgeDown && route.interfaceIndex === bridgeIndex) ? { ...route, flags: 0x10 } : route) }));
  };
  const project = (vm: DesktopVmObservation, endpoint: boolean) => {
    const observation = composeProjection([{ fixture: a, projection: removing, vm, endpoint }]);
    return validateDesktopProjectionCandidate({ engine: observation.engine, vmBefore: observation.vm, vmAfter: observation.vm },
      [removing], projectionBaseline);
  };
  assert(a.endpointVm.snapshot.interfaces.find((device) => device.index === portIndex)?.attributes.some((entry) => entry.includes('"slave":["1:0:03"]')));
  const portEdit = (edit: (device: DesktopVmInterface) => DesktopVmInterface) => (snapshot: DesktopVmSnapshot) => ({ ...snapshot,
    interfaces: snapshot.interfaces.map((device) => device.index === portIndex ? edit(device) : device) });
  const forwarding = portEdit((device) => ({ ...device, attributes: device.attributes.map((entry) => entry.replace('"slave":["1:0:00"]', '"slave":["1:0:03"]')) }));
  const lowerLayerDown = portEdit((device) => ({ ...device, operationalState: 3 }));
  for (const vm of [a.endpointVm, retiring(false), retiring(true), retiring(true, forwarding), retiring(false, lowerLayerDown),
    retiring(true, (snapshot) => forwarding(lowerLayerDown(snapshot)))]) for (const endpoint of [true, false]) {
    const result = project(vm, endpoint);
    assert.deepEqual(result.external, projectionBaseline);
    assert.equal(result.settled, false);
    assert.equal(result.members[0].kind, 'endpoint');
  }
  const changed = /Retiring Desktop endpoint changed before its exact removal/u;
  const port = (snapshot: DesktopVmSnapshot, edit: (device: DesktopVmInterface) => DesktopVmInterface) => ({ ...snapshot,
    interfaces: snapshot.interfaces.map((device) => device.index === portIndex ? edit(device) : device) });
  const portRoute = a.endpointVm.snapshot.routes.find((route) => route.interfaceIndex === portIndex && route.family === 6 && route.type === 1);
  const bridgeRoute = a.endpointVm.snapshot.routes.find((route) => route.interfaceIndex === bridgeIndex && route.family === 4 && route.type === 1);
  assert(portRoute && bridgeRoute);
  for (const [name, edit] of [
    ['linkdown bridge local route', (snapshot) => ({ ...snapshot, routes: snapshot.routes.map((route) =>
      route.interfaceIndex === bridgeIndex && route.type === 2 ? { ...route, flags: 0x10 } : route) })],
    ['added bridge route', (snapshot) => ({ ...snapshot, routes: [...snapshot.routes, { ...bridgeRoute, destination: '11.7.0.0', prefix: 16 }] })],
    ['renamed veth', (snapshot) => port(snapshot, (device) => ({ ...device, name: 'changed-veth' }))],
    ['learning bridge port', (snapshot) => port(snapshot, (device) => ({ ...device,
      attributes: device.attributes.map((entry) => entry.replace('"slave":["1:0:00"]', '"slave":["1:0:02"]')) }))],
    ['disabled port with carrier', (snapshot) => port(snapshot, (device) => ({ ...device, flags: device.flags | 0x10040, operationalState: 6, carrier: 1 }))],
    ['port disabled before linkwatch', (snapshot) => port(snapshot, (device) => ({ ...device, flags: device.flags | 0x40, operationalState: 6 }))],
    ['dormant veth', (snapshot) => port(snapshot, (device) => ({ ...device, operationalState: 5 }))],
    ['acquired veth address', (snapshot) => port(snapshot, (device) => ({ ...device, addresses: [...device.addresses,
      { ...device.addresses[0], address: 'fe80:0:0:0:0:0:0:99' }] }))],
    ['changed bridge TSO', (snapshot) => ({ ...snapshot, interfaces: snapshot.interfaces.map((device) => device.index === bridgeIndex
      ? { ...device, tsoMaxSize: 65536 } : device) })],
    ['second bridge port', (snapshot) => ({ ...snapshot, interfaces: [...snapshot.interfaces,
      { ...snapshot.interfaces.find((device) => device.index === portIndex)!, index: 99, name: 'second-veth' }] })],
    ['linkdown local address route', (snapshot) => ({ ...snapshot, routes: snapshot.routes.map((route) =>
      route.interfaceIndex === portIndex && route.type === 2 ? { ...route, flags: 0x10 } : route) })],
    ['foreign linkdown flag', (snapshot) => ({ ...snapshot, routes: snapshot.routes.map((route) =>
      route.interfaceIndex === portIndex && route.flags === 0x10 ? { ...route, flags: 0x11 } : route) })],
    ['added veth route', (snapshot) => ({ ...snapshot, routes: [...snapshot.routes, { ...portRoute, destination: 'fd00:0:0:0:0:0:0:0' }] })],
    ['removed veth route', (snapshot) => ({ ...snapshot, routes: snapshot.routes.filter((route) =>
      !(route.interfaceIndex === portIndex && route.family === 6 && route.type === 5)) })],
  ] as const satisfies readonly (readonly [string, (snapshot: DesktopVmSnapshot) => DesktopVmSnapshot])[]) {
    for (const bridgeDown of [false, true]) assert.throws(() => project(retiring(bridgeDown, edit), true),
      { name: 'SandboxOperationError', code: 'driver_failure', message: changed }, `${name}: bridge down ${bridgeDown}`);
  }
});

test('a retiring endpoint may return its admin-down broker peer before Engine deletes the pair', () => {
  const a = coordinatorProjectionMember(0);
  const transition = captureDesktopRetainedTransition(a.owned, a.endpointVm);
  const removing: DesktopMemberProjection = { ...a.starting, bridge: { kind: 'removing_endpoint', owned: a.owned,
    started: a.started, brokerName: 'broker-0', transition } };
  const portIndex = transition.endpoint.index; const peerIndex = 12;
  const project = (vm: DesktopVmObservation, endpoint = true) => {
    const observation = composeProjection([{ fixture: a, projection: removing, vm, endpoint }]);
    return validateDesktopProjectionCandidate({ engine: observation.engine, vmBefore: observation.vm, vmAfter: observation.vm },
      [removing], projectionBaseline);
  };
  for (const endpoint of [true, false]) {
    const result = project(a.returnedVm, endpoint);
    assert.deepEqual(result.external, projectionBaseline);
    assert.equal(result.settled, false);
    assert.deepEqual(result.members[0].graph?.devices.map((device) => device.index), [a.owned.device.index, portIndex, peerIndex]);
  }
  const edit = (change: (snapshot: DesktopVmSnapshot) => DesktopVmSnapshot) => vmObservation(change(a.returnedVm.snapshot));
  const device = (index: number, change: (device: DesktopVmInterface) => DesktopVmInterface) => edit((snapshot) => ({ ...snapshot,
    interfaces: snapshot.interfaces.map((entry) => entry.index === index ? change(entry) : entry) }));
  const enabledPort = (port: DesktopVmInterface) => ({ ...port, attributes: port.attributes.map((entry) => entry.replace('"slave":["1:0:00"', '"slave":["1:0:03"')) });
  const linkwatchPending = (port: DesktopVmInterface) => ({ ...port, flags: port.flags | 0x40, operationalState: 6 });
  const lowerLayerDown = (port: DesktopVmInterface) => ({ ...port, operationalState: 3 });
  for (const [name, vm] of [
    ['returned before linkwatch', device(portIndex, (port) => enabledPort(linkwatchPending(port)))],
    ['returned after linkwatch before its port is disabled', device(portIndex, enabledPort)],
    ['returned with its lower layer down', device(portIndex, lowerLayerDown)],
    ['returned with its lower layer down before its port is disabled', device(portIndex, (port) => enabledPort(lowerLayerDown(port)))],
  ] as const) {
    assert.notDeepEqual(vm.snapshot, a.returnedVm.snapshot, name);
    assert.deepEqual(project(vm).members[0].graph?.devices.map((entry) => entry.index), [a.owned.device.index, portIndex, peerIndex], name);
  }
  const localRoute = a.returnedVm.snapshot.routes.find((route) => route.interfaceIndex === portIndex && route.type === 2);
  assert(localRoute);
  const peerAttribute = (from: string, to: string) => device(peerIndex, (peer) => {
    assert(peer.attributes.includes(from), from);
    return { ...peer, attributes: peer.attributes.map((entry) => entry === from ? to : entry) };
  });
  for (const [name, vm] of [
    ['administratively up peer', device(peerIndex, (peer) => ({ ...peer, flags: peer.flags | 0x1 }))],
    ['promiscuous peer', device(peerIndex, (peer) => ({ ...peer, flags: peer.flags | 0x100 }))],
    ['peer with a queueing discipline', device(peerIndex, (peer) => ({ ...peer,
      attributes: peer.attributes.map((entry) => entry.startsWith('6:') ? `6:0:${Buffer.from('noqueue\0').toString('hex')}` : entry) }))],
    ['peer with an XDP program', peerAttribute('43:0:0500020000000000', '43:0:0500020001000000')],
    ['peer with another MTU', peerAttribute('4:0:dc050000', '4:0:78050000')],
    ['peer with a promiscuous user', peerAttribute('30:0:00000000', '30:0:01000000')],
    ['peer with an allmulti user', peerAttribute('61:0:00000000', '61:0:01000000')],
    ['peer with its own IPv6 configuration', device(peerIndex, (peer) => ({ ...peer,
      attributes: peer.attributes.map((entry) => entry.startsWith('26:') ? '26:0:[]' : entry) }))],
    ['peer with a transmit queue', device(peerIndex, (peer) => ({ ...peer, attributes: [...peer.attributes, '13:0:e8030000'] }))],
    ['peer still a bridge port', device(peerIndex, (peer) => ({ ...peer, attributes: peer.attributes.map((entry) => entry.startsWith('18:')
      ? transition.endpoint.attributes.find((original) => original.startsWith('18:'))! : entry) }))],
    ['peer with another TSO limit', device(peerIndex, (peer) => ({ ...peer, tsoMaxSize: 65536 }))],
    ['IPv6-ready peer', device(peerIndex, (peer) => ({ ...peer, ipv6Flags: 0x80000000 }))],
    ['returned port before linkwatch without its carrier loss', device(portIndex, (port) => ({ ...linkwatchPending(port), flags: port.flags | 0x10040 }))],
    ['returned port disabled before linkwatch', device(portIndex, linkwatchPending)],
    ['returned port dormant', device(portIndex, (port) => ({ ...port, operationalState: 5 }))],
    ['peer with carrier', device(peerIndex, (peer) => ({ ...peer, carrier: 1 }))],
    ['foreign peer MAC', device(peerIndex, (peer) => ({ ...peer, macAddress: '02:00:00:00:00:fe' }))],
    ['renamed peer', device(peerIndex, (peer) => ({ ...peer, name: 'eth0' }))],
    ['peer of another device', device(peerIndex, (peer) => ({ ...peer, linkIndex: 7 }))],
    ['peer in another namespace', device(peerIndex, (peer) => ({ ...peer, networkNamespaceId: 0 }))],
    ['non-veth peer', device(peerIndex, (peer) => ({ ...peer, kind: 'macvlan' }))],
    ['addressed peer', device(peerIndex, (peer) => ({ ...peer, addresses: transition.endpoint.addresses }))],
    ['routed peer', edit((snapshot) => ({ ...snapshot, routes: [...snapshot.routes, { ...localRoute, interfaceIndex: peerIndex }] }))],
    ['returned port with carrier', device(portIndex, (port) => ({ ...port, flags: port.flags | 0x10040, operationalState: 6, carrier: 1 }))],
    ['returned port keeps its peer namespace', device(portIndex, (port) => ({ ...port, networkNamespaceId: 0 }))],
    ['returned port without its link-local address', device(portIndex, (port) => ({ ...port, addresses: [] }))],
    ['missing returned peer', edit((snapshot) => ({ ...snapshot, interfaces: snapshot.interfaces.filter((entry) => entry.index !== peerIndex) }))],
  ] as const) assert.throws(() => project(vm), { name: 'SandboxOperationError', code: 'driver_failure',
    message: /Retiring Desktop endpoint changed before its exact removal/u }, name);
  const peer = a.returnedVm.snapshot.interfaces.find((entry) => entry.index === peerIndex);
  assert(peer);
  assert.throws(() => project(vmObservation({ ...a.endpointVm.snapshot, interfaces: [...a.endpointVm.snapshot.interfaces, peer] })),
    { name: 'SandboxOperationError', code: 'driver_failure', message: /External Desktop topology changed/u },
    'A veth whose port still links into the broker namespace is foreign.');
});

test('a retiring endpoint cannot reappear after its veth was gone within one observation', () => {
  const a = coordinatorProjectionMember(0);
  const transition = captureDesktopRetainedTransition(a.owned, a.endpointVm);
  const removing: DesktopMemberProjection = { ...a.starting, bridge: { kind: 'removing_endpoint', owned: a.owned,
    started: a.started, brokerName: 'broker-0', transition } };
  const gone = composeProjection([{ fixture: a, projection: removing, endpoint: false, vm: vmObservation({ ...a.endpointVm.snapshot,
    interfaces: [{ ...transition.bridge, flags: transition.bridge.flags & ~0x10000, carrier: 0 }], routes: transition.routes }) }]);
  for (const vm of [a.endpointVm, a.returnedVm]) {
    const present = composeProjection([{ fixture: a, projection: removing, vm, endpoint: false }]);
    assert.equal(validateDesktopProjectionCandidate({ engine: gone.engine, vmBefore: present.vm, vmAfter: gone.vm },
      [removing], projectionBaseline).settled, false);
    assert.throws(() => validateDesktopProjectionCandidate({ engine: gone.engine, vmBefore: gone.vm, vmAfter: present.vm },
      [removing], projectionBaseline), { name: 'SandboxOperationError', code: 'driver_failure', message: /moved backwards/u });
  }
});

test('a retiring broker holds its address through stored Engine retirement and settles only on its exact empty receipt', () => {
  const a = coordinatorProjectionMember(0);
  const transition = captureDesktopRetainedTransition(a.owned, a.endpointVm);
  const removing: DesktopMemberProjection = { ...a.starting, bridge: { kind: 'removing_endpoint', owned: a.owned,
    started: a.started, brokerName: 'broker-0', transition } };
  const terminal = vmObservation({ ...a.endpointVm.snapshot,
    interfaces: [{ ...transition.bridge, flags: transition.bridge.flags & ~0x10040, operationalState: 2, carrier: 0 }],
    routes: transition.routes.map((route) => ({ ...route, flags: route.family === 4 && (route.type === 1 || route.type === 3)
      || route.family === 6 && (route.type === 1 || route.type === 5) ? 0x10 : route.flags })) });
  const project = (vm: DesktopVmObservation, network: DesktopEngineNetwork, projection = removing) => {
    const observation = composeProjection([{ fixture: a, projection, vm, endpoint: false }]);
    const engine = { ...observation.engine, networks: observation.engine.networks.map((entry) => entry.Id === network.Id ? network : entry) };
    return validateDesktopProjectionCandidate({ engine, vmBefore: observation.vm, vmAfter: observation.vm }, [projection], projectionBaseline);
  };
  const endpoint = a.endpointNetwork.Containers[a.brokerId];
  const detachedKey = `ep-${a.started.broker.endpointId}`;
  const counted = (IPsInUse: number, DynamicIPsAvailable: number) => ({ IPAM: { Subnets: { [a.owned.subnet]: { IPsInUse, DynamicIPsAvailable } } } });
  const detached: DesktopEngineNetwork = { ...a.network, Status: counted(4, 12), Containers: { [detachedKey]: endpoint } };
  // Native rr14r15s1: Docker 29.1.2 had unlisted the exited broker's endpoint but not yet released its address.
  const releasing: DesktopEngineNetwork = { ...a.network, Status: counted(4, 12) };
  for (const [name, network] of [['attached', a.endpointNetwork], ['detached', detached], ['releasing', releasing]] as const) {
    for (const vm of [a.endpointVm, a.returnedVm, terminal]) {
      const result = project(vm, network);
      assert.deepEqual(result.external, projectionBaseline, name);
      assert.equal(result.settled, false, `${name}: an address held by the retiring broker is not its retained receipt`);
    }
  }
  for (const vm of [a.endpointVm, a.returnedVm]) {
    assert.equal(project(vm, a.network).settled, false, 'An exact empty Engine receipt does not settle while the VM keeps the endpoint.');
  }
  assert.equal(project(terminal, a.network).settled, true);
  for (const [name, network, message] of [
    ['address counted twice', { ...releasing, Status: counted(5, 11) }, /IPAM allocation accounting differs/u],
    ['inconsistent availability', { ...releasing, Status: counted(4, 13) }, /IPAM allocation accounting differs/u],
    ['relabelled releasing network', { ...releasing, Labels: { 'ai.agen.synthetic.owner': 'other' } }, /Owned network configuration changed/u],
    ['relabelled empty network', { ...a.network, Labels: { 'ai.agen.synthetic.owner': 'other' } }, /Empty Desktop network differs/u],
    ['foreign detached endpoint', { ...detached, Containers: { [`ep-${'f'.repeat(64)}`]: endpoint } }, /sole exact Engine endpoint/u],
    ['detached endpoint with another address', { ...detached, Containers: { [detachedKey]: { ...endpoint, IPv4Address: '10.240.0.3/28' } } },
      /independently read-back container attachment/u],
    ['renamed detached endpoint', { ...detached, Containers: { [detachedKey]: { ...endpoint, Name: 'foreign' } } }, /endpoint name differs/u],
    ['attached and detached endpoints', { ...detached, Containers: { ...a.endpointNetwork.Containers, [detachedKey]: endpoint } },
      /sole exact Engine endpoint/u],
  ] as const satisfies readonly (readonly [string, DesktopEngineNetwork, RegExp])[]) {
    assert.throws(() => project(terminal, network), { name: 'SandboxOperationError', code: 'driver_failure', message }, name);
  }
  const retained: DesktopMemberProjection = { ...removing, bridge: { kind: 'retained', owned: a.owned,
    state: captureDesktopRetainedState(transition, terminal) } };
  for (const [name, projection, vm] of [['retained', retained, terminal], ['empty', a.empty, a.emptyVm]] as const) {
    assert.throws(() => project(vm, releasing, projection), { name: 'SandboxOperationError', code: 'driver_failure',
      message: /Empty Desktop network differs from its original exact receipt/u }, name);
  }
});

test('route deactivation is one-to-one, so aliased captured routes cannot admit a foreign route', () => {
  const a = coordinatorProjectionMember(0);
  assert(a.active.bridge.kind === 'active');
  const graph = a.active.bridge.graph;
  const bridgeIndex = a.owned.device.index;
  const subnet = (route: DesktopVmRoute) => route.interfaceIndex === bridgeIndex && route.family === 4 && route.type === 1 && route.flags === 0;
  const captured = graph.routes.find(subnet);
  assert(captured);
  const honest = releaseDesktopRetainedTransition(a.owned, graph);
  const aliased = releaseDesktopRetainedTransition(a.owned, { devices: graph.devices, routes: [...graph.routes, { ...captured, flags: 0x10 }] });
  const linkdown = (routes: readonly DesktopVmRoute[]) => routes.map((route) => subnet(route) ? { ...route, flags: 0x10 } : route);
  const foreign = { ...captured, destination: '11.7.0.0', prefix: 16 };
  const endpoint = (routes: readonly DesktopVmRoute[]) => vmObservation({ ...a.endpointVm.snapshot, routes });
  const bridgeOnly = (routes: readonly DesktopVmRoute[]) => vmObservation({ ...a.endpointVm.snapshot,
    interfaces: [{ ...honest.bridge, flags: honest.bridge.flags & ~0x10000, carrier: 0 }], routes });
  assert.equal(validateDesktopRetiringEndpoint(honest, endpoint(linkdown(a.endpointVm.snapshot.routes)), a.started.broker.macAddress).length, 2);
  assert.equal(validateDesktopRetainedTransition(honest, bridgeOnly(linkdown(honest.routes))).kind, 'settling');
  assert.throws(() => validateDesktopRetiringEndpoint(aliased, endpoint([...linkdown(a.endpointVm.snapshot.routes), foreign]),
    a.started.broker.macAddress), /Retiring Desktop endpoint changed before its exact removal/u);
  assert.throws(() => validateDesktopRetainedTransition(aliased, bridgeOnly([...linkdown(honest.routes), foreign])),
    /Retained Desktop route exceeds its original deactivation alternatives/u);
});

test('retained bridge freezes only after terminal deactivation and releases only the retired endpoint index', () => {
  const a = coordinatorProjectionMember(0);
  const transition = captureDesktopRetainedTransition(a.owned, a.endpointVm);
  const retained = (terminal: boolean) => vmObservation({ ...a.endpointVm.snapshot,
    interfaces: [{ ...transition.bridge, flags: transition.bridge.flags & ~(terminal ? 0x10040 : 0x10000),
      operationalState: terminal ? 2 : 6, carrier: 0 }],
    routes: transition.routes.map((route) => ({ ...route, flags: terminal && (route.family === 4 && (route.type === 1 || route.type === 3)
      || route.family === 6 && (route.type === 1 || route.type === 5)) ? 0x10 : route.flags })) });
  const settling = retained(false); const terminal = retained(true);
  assert.throws(() => captureDesktopRetainedState(transition, settling), /before terminal deactivation/u);
  const removing: DesktopMemberProjection = { ...a.starting, bridge: { kind: 'removing_endpoint', owned: a.owned,
    started: a.started, brokerName: 'broker-0', transition } };
  const observation = composeProjection([{ fixture: a, projection: removing, vm: terminal, endpoint: false }]);
  assert.equal(validateDesktopProjectionCandidate({ engine: observation.engine, vmBefore: observation.vm, vmAfter: observation.vm },
    [removing], projectionBaseline).settled, true);
  const fixed: DesktopMemberProjection = { ...removing, bridge: { kind: 'retained', owned: a.owned,
    state: captureDesktopRetainedState(transition, terminal) } };
  assert.deepEqual(projectDesktopExternal(observation, [fixed]).external, projectionBaseline);
  const reused = vmObservation({ ...observation.vm.snapshot, interfaces: [...observation.vm.snapshot.interfaces,
    { ...transition.endpoint, masterIndex: null, name: 'foreign-reused-index' }] });
  assert.throws(() => projectDesktopExternal({ ...observation, vm: reused }, [removing]), /index was reused/u);
  const projected = projectDesktopExternal({ ...observation, vm: reused }, [fixed]);
  assert.notDeepEqual(projected.external.vm, projectionBaseline.vm);
  assert(Object.isFrozen(projected.external));
  const removingBridge: DesktopMemberProjection = { ...fixed, bridge: { kind: 'removing_bridge', owned: a.owned,
    state: captureDesktopRetainedState(transition, terminal) } };
  const noNetwork = { ...observation.engine, networks: observation.engine.networks.filter((network) => network.Id !== a.network.Id) };
  assert.equal(validateDesktopProjectionCandidate({ engine: noNetwork, vmBefore: observation.vm, vmAfter: observation.vm },
    [removingBridge], projectionBaseline).settled, false, 'Engine deletion cannot replace native bridge absence.');
  const absentVm = vmObservation({ ...observation.vm.snapshot,
    interfaces: observation.vm.snapshot.interfaces.filter((device) => device.index !== a.owned.device.index),
    routes: observation.vm.snapshot.routes.filter((route) => route.interfaceIndex !== a.owned.device.index) });
  assert.equal(validateDesktopProjectionCandidate({ engine: noNetwork, vmBefore: absentVm, vmAfter: absentVm },
    [removingBridge], projectionBaseline).settled, true);
});
