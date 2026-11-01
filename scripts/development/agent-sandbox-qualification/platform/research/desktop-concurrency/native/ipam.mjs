// Research composition: run with `node --import tsx ipam.mjs input.json fresh-output`.
// No public SDK admission, broker tunnel, crash-durability or concurrency claim follows from this probe.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine, until } from '../../../../engine.mjs';
import { captureHost } from './host-capture.mjs';
import { parseDesktopHostObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/host.ts';
import { selectAllocation, overlaps } from '../transitions/allocation.ts';
import { captureDesktopRetainedTransition, validateDesktopRetainedTransition,
  captureDesktopRetainedState, validateDesktopRetainedState } from '../transitions/retained.ts';
import { readDesktopEngineNetworks, observationFingerprint } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.ts';
import { parseDesktopVmObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.ts';
import { externalEngineAuthority, externalVmAuthority, identifyDesktopOwnedBridge, validateDesktopOwnedVm,
  validateDesktopBrokerReceipt, validateDesktopBridgeEvolution, desktopOwnedLinkLocalSettled } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.ts';
import { deniedCoverage, addressAdmission } from '../../../../../../../packages/ai/sandbox-docker/src/network/policy.ts';
import { nativeAddressNumber, prefixMask, formatNumericAddress } from '../../../../../../../packages/ai/sandbox-docker/src/network/address.ts';
import { readDesktopHostObservation } from '../../../../../../../packages/ai/sandbox-docker/src/node/desktopHostObservation.ts';
import { isolatedHostPolicy, matchesHostIsolation } from '../../../../../../../packages/ai/sandbox-docker/src/policy/hostIsolation.ts';

const [inputPath, output] = process.argv.slice(2);
assert.equal(process.argv.length, 4, 'Usage: node --import tsx ipam.mjs input.json fresh-output');
assert(isAbsolute(output)); assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const inputBytes = await readFile(inputPath), input = JSON.parse(inputBytes.toString());
const { platform, capabilities } = input, authority = capabilities.network.routeAuthority;
const limits = Object.freeze({ commandMs: 5000, observationMs: 10000 });
const observationAuthority = Object.freeze({ ...authority, commandTimeoutMs: Math.min(authority.commandTimeoutMs, limits.commandMs) });
for (const control of [authority.vmObserver.control, capabilities.network.egress.configuration.control, capabilities.filesystem.configuration.control]) {
  assert.equal(control.leaseTimeoutMs, 60000, 'Research observation must not extend the existing helper lease.');
}
assert.equal(authority.engine.endpoint, platform.engine); assert.equal(platform.profile, 'desktop-apple-virtualization-native-arm64');
assert.equal(authority.vmObserver.executable, '/usr/local/bin/agenai-sandbox-desktop-route');
assert.equal(process.version, `v${platform.expected.controller.nodeVersion}`);
await mkdir(output, { mode: 0o700 }); assert.equal(await realpath(output), output);
const engine = new Engine(platform.engine.slice(7), '1.52', { requestMs: limits.commandMs, outputBytes: 4 * 1024 ** 2, frameBytes: 4 * 1024 ** 2 });
const token = randomUUID(), resources = [], members = [], snapshots = [], imageLabels = new Map();
const report = { format: 'agenai.desktop-private-ipam-research.v1', status: 'running', token,
  inputSha256: createHash('sha256').update(inputBytes).digest('hex'), selectedObservationLimits: { ...limits, hostCommandMs: observationAuthority.commandTimeoutMs, helperLeaseMs: 60000 }, effects: [], resources, snapshots, cleanup: [],
  scope: 'Source-composed native mechanism only; no broker/denial listener, public SDK lifecycle, mixed profile, exclusion or crash qualification.' };
let ordinal = 0, bytes = 0, observer, baseline, initialEngine, hostBaseline, cleaning = false;
const signal = AbortSignal.timeout(180000);
const hash = (value) => observationFingerprint(value);
const failure = (error) => ({ name: error.name, message: String(error.message).slice(0, 2048) });
const persist = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
async function retain(kind, value, raw = false) {
  const buffer = raw ? Buffer.from(value) : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  assert(++ordinal <= (cleaning ? 4096 : 3840) && buffer.length <= 4 * 1024 ** 2
    && (bytes += buffer.length) <= (cleaning ? 128 : 112) * 1024 ** 2, 'Capture budget exhausted; cleanup capacity remains reserved.');
  const path = join(output, `${String(ordinal).padStart(4, '0')}-${kind}`);
  await writeFile(path, buffer, { mode: 0o600, flag: 'wx' });
  return { path, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}
async function verifyEngine(operationSignal) {
  operationSignal?.throwIfAborted();
  assert.equal((await engine.request('GET', '/info', undefined, { signal: operationSignal })).data.ID, authority.engine.id);
}
async function effect(method, path, body, dispatch, operationSignal = signal, kind = 'topology') {
  if (!cleaning) operationSignal.throwIfAborted();
  await verifyEngine(cleaning ? undefined : operationSignal); assert(report.effects.length < 512);
  const entry = { sequence: report.effects.length + 1, method, path, body, kind, state: 'intent' };
  report.effects.push(entry); await retain('intent.json', entry); await persist();
  entry.state = 'entered';
  try { const result = await (dispatch ? dispatch() : engine.request(method, path, body, { signal: cleaning ? undefined : operationSignal })); entry.state = 'acknowledged'; await persist(); return result; }
  catch (error) { entry.state = 'unknown'; entry.failure = failure(error); await persist(); throw error; }
}
const api = { async json(method, path, schema, options = {}) {
  const response = await engine.request(method, path.replace(/^\/v1\.52/u, ''), undefined, { signal: options.signal });
  await retain('engine.json', { method, path, status: response.status, data: response.data });
  return schema.parse(response.data);
} };
const census = (operationSignal = signal) => readDesktopEngineNetworks(api, operationSignal);
const stableBridge = ({ flags: _f, operationalState: _o, carrier: _c, ipv6Flags: _i,
  addresses: _a, tsoMaxSize: _t, ...rest }) => rest;
const ipv4 = (cidrs) => cidrs.filter((cidr) => !cidr.includes(':')).map((cidr) => {
  const [address, bits] = cidr.split('/');
  return `${formatNumericAddress(nativeAddressNumber(address, 4) & prefixMask(4, Number(bits)), 4)}/${bits}`;
});
async function executeVm(operationSignal = signal) {
  const began = performance.now(), deadline = began + limits.commandMs;
  const commandSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(limits.commandMs)]);
  const created = await effect('POST', `/containers/${observer.id}/exec`, { AttachStdout: true, AttachStderr: true,
    Tty: false, User: observer.body.User, Cmd: [authority.vmObserver.executable] }, undefined, commandSignal, 'observation');
  assert.match(created.data.Id, /^[a-f0-9]{64}$/u);
  commandSignal.throwIfAborted();
  const target = `/exec/${created.data.Id}/start`, body = { Detach: false, Tty: false };
  const stream = await effect('POST', target, body, () => engine.hijack(target, body), commandSignal, 'observation');
  const abort = () => { void stream.close().catch(() => {}); };
  commandSignal.addEventListener('abort', abort, { once: true });
  if (commandSignal.aborted) abort();
  try {
    await until(() => { commandSignal.throwIfAborted(); return stream.closed; }, Math.max(1, deadline - performance.now()), 'Native VM observation did not settle.');
    if (stream.failure) throw stream.failure;
    const stdout = await retain('vm-raw.json', stream.stdout, true);
    await retain('vm-stderr.txt', stream.stderr, true);
    const exited = (await engine.request('GET', `/exec/${created.data.Id}/json`, undefined, { signal: commandSignal })).data;
    await retain('exec.json', exited); assert.equal(exited.Running, false); assert.equal(exited.ExitCode, 0);
    assert.equal(stream.stderr.length, 0); assert.equal(stream.pending.length, 0);
    commandSignal.throwIfAborted(); assert(performance.now() <= deadline, 'VM command exceeded selected command deadline.');
    return { raw: stdout, parsed: parseDesktopVmObservation(JSON.parse(stream.stdout.toString('utf8'))) };
  } finally {
    commandSignal.removeEventListener('abort', abort);
    await stream.close();
  }
}
async function observeHost(phase, operationSignal) {
  operationSignal.throwIfAborted();
  const raw = await captureHost(observationAuthority, output, phase);
  assert(++ordinal <= 3840 && (bytes += raw.bytes) <= 112 * 1024 ** 2, 'Raw host capture exhausted scenario evidence capacity.');
  operationSignal.throwIfAborted();
  return { raw, parsed: parseDesktopHostObservation(JSON.parse(await readFile(raw.path, 'utf8'))) };
}
async function projectMembers(vm, engineState, endpoint, operationSignal) {
  const indexes = [], states = [];
  for (const member of members) {
    const actual = engineState.networks.find(({ Id }) => Id === member.id); assert(actual, 'Owned network absent.');
    assert.deepEqual(actual.IPAM.Config, [{ Subnet: member.subnet, Gateway: member.gateway, IPRange: '' }]);
    let state;
    const devices = member.retainedState ? validateDesktopRetainedState(member.retainedState, vm)
      : member.retainedTransition ? (state = validateDesktopRetainedTransition(member.retainedTransition, vm)).devices
        : validateDesktopOwnedVm(vm, member.owned, member === endpoint);
    assert.equal(hash(stableBridge(devices[0])), hash(stableBridge(member.owned.device)), 'Bridge stable identity changed.');
    if (member === endpoint) {
      const container = (await engine.request('GET', `/containers/${member.endpoint.id}/json`, undefined, { signal: operationSignal })).data;
      await retain('endpoint-readback.json', container);
      const attachment = container.NetworkSettings.Networks[member.name];
      validateDesktopBrokerReceipt(member.owned, engineState, { broker: { id: member.endpoint.id, networkId: attachment.NetworkID,
        endpointId: attachment.EndpointID, macAddress: attachment.MacAddress, address: attachment.IPAddress,
        prefixLength: attachment.IPPrefixLen, gateway: attachment.Gateway }, members: { compute: { kind: 'absent' }, filesystem: { kind: 'absent' } } });
      validateDesktopBridgeEvolution(member.owned.device, devices[0], devices[1]);
    } else {
      assert.equal(Object.keys(actual.Containers).length, 0);
      const status = actual.Status.IPAM.Subnets[member.subnet]; assert.equal(status.IPsInUse, 3); assert.equal(status.DynamicIPsAvailable, 13);
      assert.equal(hash(actual), hash(member.owned.network), 'Empty network immutable configuration changed.');
    }
    indexes.push(...devices.map(({ index }) => index));
    states.push({ networkId: member.id, bridgeIndex: devices[0].index,
      phase: member.retainedState ? 'fixed_retained' : state?.kind ?? (member === endpoint ? 'endpoint' : 'empty') });
  }
  return { engine: externalEngineAuthority({ ...engineState,
    networks: engineState.networks.filter(({ Id }) => !members.some(({ id }) => id === Id)) }, observer.id,
  { compute: { kind: 'absent' }, filesystem: { kind: 'absent' } }), vm: externalVmAuthority(vm, indexes), states };
}
async function sample(phase, endpoint = null) {
  signal.throwIfAborted(); assert(snapshots.length < 96);
  const began = performance.now(), operationSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.observationMs)]);
  const observation = { phase, startedAt: new Date().toISOString(), limits, status: 'entered' };
  snapshots.push(observation); await persist();
  try {
    await verifyEngine(operationSignal);
    const hostBefore = await observeHost(`bracket-${snapshots.length}-before`, operationSignal);
    const vmBefore = await executeVm(operationSignal), engineState = await census(operationSignal), vmAfter = await executeVm(operationSignal);
    const hostAfter = await observeHost(`bracket-${snapshots.length}-after`, operationSignal);
    observation.raw = vmAfter.raw;
    observation.bracket = { hostBefore: hostBefore.raw, vmBefore: vmBefore.raw, vmAfter: vmAfter.raw, hostAfter: hostAfter.raw };
    observation.parsed = await retain('parsed.json', { phase, host: hostAfter.parsed, engine: engineState, vm: vmAfter.parsed,
      bracket: { hostBefore: hostBefore.parsed, vmBefore: vmBefore.parsed, hostAfter: hostAfter.parsed } });
    await persist();
    assert.equal(hostBefore.parsed.fingerprint, hostBaseline.fingerprint, 'Host authority changed before complete observation.');
    assert.equal(hostAfter.parsed.fingerprint, hostBefore.parsed.fingerprint, 'Host authority changed across complete observation.');
    assert.deepEqual(hostAfter.raw.executable, hostBefore.raw.executable, 'Pinned host executable identity changed across complete observation.');
    const before = await projectMembers(vmBefore.parsed, engineState, endpoint, operationSignal);
    const after = await projectMembers(vmAfter.parsed, engineState, endpoint, operationSignal);
    assert.equal(hash(before.engine), hash(after.engine), 'External Engine projection changed across complete observation.');
    assert.equal(hash(before.vm), hash(after.vm), 'External VM projection changed across complete observation.');
    const external = { engine: after.engine, vm: after.vm };
    if (baseline) assert.equal(hash(external), hash(baseline), 'Unregistered external Engine/VM topology changed.');
    else baseline = external;
    observation.membersBefore = before.states; observation.membersAfter = after.states;
    operationSignal.throwIfAborted();
    observation.elapsedMs = performance.now() - began;
    assert(observation.elapsedMs <= limits.observationMs, 'Complete observation exceeded its selected deadline.');
    observation.status = 'validated'; await persist();
    return { engine: engineState, vm: vmAfter.parsed };
  } catch (error) {
    observation.status = 'rejected'; observation.failure = failure(error); observation.elapsedMs = performance.now() - began;
    await persist(); throw error;
  }
}
async function createContainer(role, image, network, networkId) {
  assert(imageLabels.has(image), 'Fixture image metadata must be read before reservation.');
  const name = `sdkc-ipam-${token}-${role}`, labels = { ...imageLabels.get(image), 'ai.agen.research.ipam': token, role };
  const body = { Image: image, User: '1000:1000', WorkingDir: '/', Env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
    Entrypoint: ['/usr/local/bin/node'], Cmd: ['-e', 'setInterval(()=>{},1000)'], Tty: false, OpenStdin: false,
    Healthcheck: { Test: ['NONE'] }, Labels: labels, HostConfig: { ...isolatedHostPolicy(capabilities.workload.resources),
      NetworkMode: network, Mounts: [], Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=4194304,uid=1000,gid=1000,mode=0700' } },
    ...(networkId ? { NetworkingConfig: { EndpointsConfig: { [network]: { NetworkID: networkId } } } } : {}) };
  const item = { kind: 'container', name, labels, body, id: null, acknowledged: false }; resources.push(item); await persist();
  const created = await effect('POST', `/containers/create?name=${name}&platform=linux%2Farm64`, body);
  item.id = created.data.Id; item.acknowledged = true; assert.match(item.id, /^[a-f0-9]{64}$/u);
  assert(!created.data.Warnings?.length);
  await effect('POST', `/containers/${item.id}/start`);
  const actual = (await engine.request('GET', `/containers/${item.id}/json`)).data;
  await retain('container.json', actual);
  assert.equal(actual.Config.User, body.User); assert.equal(actual.Image, image); assert.equal(actual.State.Running, true);
  assert.equal(actual.Name, `/${name}`); assert.deepEqual(actual.Config.Labels, labels);
  assert(matchesHostIsolation(actual.HostConfig, capabilities.workload.resources)); assert.equal(actual.HostConfig.NetworkMode, network);
  assert.deepEqual(Object.keys(actual.NetworkSettings.Networks), [network]);
  assert.equal(actual.Mounts.length, 0); assert.equal(Object.keys(actual.NetworkSettings.Ports ?? {}).length, 0);
  return item;
}
async function remove(item) {
  const reference = item.id ?? item.name, path = item.kind === 'network' ? `/networks/${reference}` : `/containers/${reference}/json`;
  await verifyEngine(); const inspected = await engine.request('GET', path, undefined, { allowed: [200, 404] });
  if (inspected.status === 200) {
    const actual = inspected.data;
    assert.equal(actual.Name, item.kind === 'network' ? item.name : `/${item.name}`);
    assert.deepEqual(actual.Config?.Labels ?? actual.Labels, item.labels);
    if (item.id) assert.equal(actual.Id, item.id);
    const target = item.kind === 'network' ? `/networks/${actual.Id}` : `/containers/${actual.Id}?force=true&v=false`;
    await effect('DELETE', target, undefined, () => engine.request('DELETE', target, undefined, { allowed: [204, 404] }));
  }
  const absence = await engine.request('GET', path, undefined, { allowed: [404] });
  report.cleanup.push({ name: item.name, id: item.id, kind: item.kind, status: absence.status, creationAcknowledged: item.acknowledged });
  item.removed = item.acknowledged; await persist();
}
async function createNetwork(label, allocation) {
  const name = `sdkc-ipam-${token}-${label}`, bridgeName = `ai${token.replaceAll('-', '').slice(0, 10)}${label}`;
  const labels = { 'ai.agen.research.ipam': token, role: label };
  const item = { kind: 'network', name, bridgeName, labels, ...allocation, id: null, acknowledged: false };
  resources.push(item); await persist();
  const body = { Name: name, Driver: 'bridge', Scope: 'local', Internal: false, Attachable: false,
    Ingress: false, EnableIPv6: false, CheckDuplicate: true, Labels: labels,
    Options: { 'com.docker.network.bridge.name': bridgeName }, IPAM: { Driver: 'default', Config: [{ Subnet: item.subnet, Gateway: item.gateway }] } };
  const created = await effect('POST', '/networks/create', body);
  item.id = created.data.Id; item.acknowledged = true; assert.match(item.id, /^[a-f0-9]{64}$/u); assert(!created.data.Warning);
  const vm = await executeVm(), engineState = await census();
  item.owned = identifyDesktopOwnedBridge({ networkId: item.id, name, bridgeName, labels }, engineState, vm.parsed);
  assert.equal(item.owned.subnet, item.subnet); assert.equal(item.owned.gateway, item.gateway);
  await retain('empty-bridge.json', { raw: vm.raw, engine: engineState, vm: vm.parsed, owned: item.owned });
  members.push(item); await sample(`${label}-empty`); return item;
}
async function rejectLookalike(reference, occupancy, exclusions) {
  const allocation = selectAllocation(occupancy, members.map(({ subnet }) => subnet), [exclusions]);
  const item = { kind: 'network', name: `sdkc-ipam-${token}-lookalike`, bridgeName: `ai${token.replaceAll('-', '').slice(0, 10)}f`,
    labels: { ...reference.labels }, ...allocation, id: null, acknowledged: false, authority: 'unregistered-lookalike-control' };
  resources.push(item); await persist();
  const body = { Name: item.name, Driver: 'bridge', Scope: 'local', Internal: false, Attachable: false,
    Ingress: false, EnableIPv6: false, CheckDuplicate: true, Labels: item.labels,
    Options: { 'com.docker.network.bridge.name': item.bridgeName }, IPAM: { Driver: 'default', Config: [{ Subnet: item.subnet, Gateway: item.gateway }] } };
  const created = await effect('POST', '/networks/create', body);
  item.id = created.data.Id; item.acknowledged = true;
  assert.match(item.id, /^[a-f0-9]{64}$/u); assert(!created.data.Warning);
  assert(!members.some(({ id }) => id === item.id));
  const topologySequence = report.effects.filter(({ kind }) => kind === 'topology').map(({ sequence }) => sequence);
  await assert.rejects(() => sample('unregistered-lookalike-present'), (error) => error instanceof assert.AssertionError
    && /^Unregistered external Engine\/VM topology changed\.(?:\n|$)/u.test(error.message));
  assert.deepEqual(report.effects.filter(({ kind }) => kind === 'topology').map(({ sequence }) => sequence), topologySequence,
    'Another member topology effect entered before foreign drift rejection.');
  report.foreignDrift = { id: item.id, name: item.name, subnet: item.subnet, labelsEqualToNetwork: reference.id,
    rejectedBeforeFurtherMemberEffect: true, rejectionSnapshot: snapshots.at(-1).parsed, topologySequence };
  await remove(item);
  await sample('lookalike-exactly-removed-baseline-restored');
  report.foreignDrift.exactCleanupAndBaselineRestored = true; await persist();
}
async function cycle(member) {
  member.endpoint = await createContainer(`endpoint-${member.labels.role}`, platform.sourceImage, member.name, member.id);
  let settled;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const snapshot = await sample(`${member.labels.role}-endpoint-${attempt}`, member);
    const devices = validateDesktopOwnedVm(snapshot.vm, member.owned, true);
    if (desktopOwnedLinkLocalSettled(devices)) { settled = snapshot; break; }
    await delay(250, undefined, { signal });
  }
  assert(settled, 'Endpoint link-local settlement exceeded bounded observation attempts.');
  member.retainedTransition = captureDesktopRetainedTransition(member.owned, settled.vm);
  await remove(member.endpoint); member.endpoint = null;
  let previous;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const retained = await sample(`${member.labels.role}-retained-${attempt}`);
    const state = validateDesktopRetainedTransition(member.retainedTransition, retained.vm);
    if (state.kind === 'settled' && state.fingerprint === previous) {
      member.retainedState = captureDesktopRetainedState(member.retainedTransition, retained.vm); break;
    }
    previous = state.kind === 'settled' ? state.fingerprint : undefined;
    await delay(250, undefined, { signal });
  }
  assert(member.retainedState, 'Retained bridge deactivation did not reach two equal settled observations.');
  await retain('retained-bridge.json', { role: member.labels.role, state: member.retainedState });
}
try {
  await verifyEngine(); hostBaseline = await readDesktopHostObservation(observationAuthority, signal); initialEngine = await census();
  for (const image of [authority.vmObserver.imageDigest, platform.sourceImage]) {
    const actual = (await engine.request('GET', `/images/${image}/json`)).data;
    await retain('image.json', actual); assert.equal(actual.Id, image); assert.equal(actual.Architecture, 'arm64'); assert.equal(actual.Os, 'linux');
    imageLabels.set(image, Object.freeze({ ...actual.Config.Labels }));
  }
  assert(!initialEngine.networks.some(({ Labels }) => Object.keys(Labels).some((key) => key.startsWith('ai.agen.sandbox.'))), 'Drain original SDK owners before this fixture.');
  observer = await createContainer('observer', authority.vmObserver.imageDigest, 'host');
  const initial = await sample('observer-only');
  assert.equal(hash(baseline.engine), hash({ id: initialEngine.id, hostname: initialEngine.hostname,
    kernel: initialEngine.kernel, networks: initialEngine.networks }), 'Observer changed external Engine configuration.');
  const occupancy = ipv4([...hostBaseline.excludedCidrs, ...initial.vm.excludedCidrs,
    ...initial.engine.networks.flatMap(({ IPAM }) => (IPAM.Config ?? []).flatMap(({ Subnet }) => Subnet ? [Subnet] : []))]);
  const exclusions = [...hostBaseline.excludedCidrs, ...initial.vm.excludedCidrs];
  const first = selectAllocation(occupancy, [], [exclusions]), second = selectAllocation(occupancy, [first.subnet], [exclusions]);
  assert(!overlaps(first.subnet, second.subnet));
  assert.deepEqual(deniedCoverage([...exclusions, first.subnet, second.subnet]), deniedCoverage(exclusions));
  const allowed = addressAdmission(exclusions); assert.equal(allowed(first.gateway), false); assert.equal(allowed(second.gateway), false);
  assert.throws(() => selectAllocation([...occupancy, '10.240.0.0/24'], [], [exclusions]), /capacity exhausted/u);
  report.allocations = { first, second, overlapRejectedBeforeDispatch: true, coverage: deniedCoverage(exclusions) }; await persist();
  const a = await createNetwork('a', first); await cycle(a);
  await remove(observer);
  const zeroObserver = await census();
  assert.equal(Object.keys(zeroObserver.networks.find(({ Name }) => Name === 'host').Containers).length, 0);
  assert(zeroObserver.networks.some(({ Id }) => Id === a.id));
  await retain('zero-observer-retained.json', { engine: zeroObserver, retained: a.retainedState });
  observer = await createContainer('replacement-observer', authority.vmObserver.imageDigest, 'host');
  await sample('replacement-observer-retained-reentry');
  report.zeroObserverReentry = { previousObserverAbsent: true, retainedNetworkId: a.id, newOriginalObserverId: observer.id };
  const b = await createNetwork('b', second); await rejectLookalike(b, occupancy, exclusions); await cycle(b);
  await remove(b); members.splice(members.indexOf(b), 1); await sample('b-removed-a-retained');
  await remove(a); members.splice(members.indexOf(a), 1); await sample('all-networks-removed');
  const reused = selectAllocation(occupancy, [], [exclusions]); assert.equal(reused.subnet, first.subnet);
  const c = await createNetwork('c', reused); await remove(c); members.splice(members.indexOf(c), 1);
  await sample('reused-subnet-network-removed'); report.mechanism = 'passed';
} catch (error) { report.failure = failure(error); }
finally {
  cleaning = true;
  for (const item of [...resources].reverse()) if (!item.removed) {
    try { await remove(item); } catch (error) { report.cleanup.push({ name: item.name, failure: failure(error) }); }
  }
  try {
    await verifyEngine(); const final = await readDesktopEngineNetworks(api);
    await retain('final-engine.json', final);
    if (initialEngine) assert.equal(hash(final), hash(initialEngine), 'Final Engine census differs from initial exact census.');
    const finalHost = await readDesktopHostObservation(observationAuthority); await retain('final-host.json', finalHost);
    if (hostBaseline) assert.equal(finalHost.fingerprint, hostBaseline.fingerprint, 'Final Host authority changed.');
    const exactAbsence = [];
    for (const item of resources) for (const reference of [...new Set([item.name, item.id].filter(Boolean))]) {
      const path = item.kind === 'network' ? `/networks/${reference}` : `/containers/${reference}/json`;
      exactAbsence.push({ kind: item.kind, name: item.name, reference,
        status: (await engine.request('GET', path, undefined, { allowed: [404] })).status });
    }
    report.finalExactAbsence = await retain('final-exact-absence.json', exactAbsence);
  } catch (error) { report.finalObservationFailure = failure(error); }
  report.status = report.mechanism === 'passed' && resources.every(({ removed }) => removed)
    && !report.finalObservationFailure ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString(); await persist();
}
process.stdout.write(`${JSON.stringify({ status: report.status, output, effects: report.effects.length, snapshots: snapshots.length })}\n`);
if (report.status !== 'passed') process.exitCode = 1;
