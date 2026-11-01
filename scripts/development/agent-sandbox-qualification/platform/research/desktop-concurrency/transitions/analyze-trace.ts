import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { observationFingerprint } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.js';
import { externalEngineAuthority, externalVmAuthority, identifyDesktopOwnedBridge, validateDesktopOwnedVm,
  validateDesktopBridgeEvolution, validateDesktopBrokerReceipt, desktopOwnedLinkLocalSettled } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';
import type { DesktopOwnedBridge, DesktopStartedTopologyReceipt } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';
import type { DesktopVmInterface, DesktopVmRoute } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import { desktopBridgeName, resourceLabels, assertLabels } from '../../../../../../../packages/ai/sandbox-docker/src/recovery/identity.js';
import { nativeAddressNumber, prefixMask, formatNumericAddress } from '../../../../../../../packages/ai/sandbox-docker/src/network/address.js';
import { PRIVATE_POOL, overlaps } from './allocation.js';
import { decodeCensuses, readTrace } from './trace-input.js';

const containerSchema = z.object({ Id: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()), NetworkDisabled: z.boolean().optional() }),
  State: z.object({ Running: z.boolean(), Status: z.string() }), HostConfig: z.object({ NetworkMode: z.string() }),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ NetworkID: z.string(), EndpointID: z.string(),
    MacAddress: z.string(), IPAddress: z.string(), IPPrefixLen: z.int(), Gateway: z.string() })) }) });
const failure = (operation: () => unknown): string | null => { try { operation(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } };
const same = (left: unknown, right: unknown) => left === undefined || right === undefined ? left === right
  : observationFingerprint(left) === observationFingerprint(right);
const diff = <Item>(before: readonly Item[], after: readonly Item[]) => ({
  removed: before.filter((item) => !after.some((candidate) => same(item, candidate))),
  added: after.filter((item) => !before.some((candidate) => same(item, candidate))),
});
const interfaceSummary = (device: DesktopVmInterface) => ({ index: device.index, name: device.name, kind: device.kind,
  macAddress: device.macAddress, masterIndex: device.masterIndex, linkIndex: device.linkIndex, networkNamespaceId: device.networkNamespaceId,
  flags: device.flags, operationalState: device.operationalState, carrier: device.carrier, tsoMaxSize: device.tsoMaxSize,
  addresses: device.addresses.map(({ attributes: _attributes, ...address }) => address), fingerprint: observationFingerprint(device) });
const routeSummary = (route: DesktopVmRoute) => {
  const { attributes: _attributes, ...fields } = route; return { ...fields, fingerprint: observationFingerprint(route) };
};
const interfaceDelta = (before: readonly DesktopVmInterface[], after: readonly DesktopVmInterface[]) => {
  const delta = diff(before, after); return { removed: delta.removed.map(interfaceSummary), added: delta.added.map(interfaceSummary) };
};
const routeDelta = (before: readonly DesktopVmRoute[], after: readonly DesktopVmRoute[]) => {
  const delta = diff(before, after); return { removed: delta.removed.map(routeSummary), added: delta.added.map(routeSummary) };
};

export async function analyzeTrace(directory: string) {
  const input = await readTrace(directory); const censuses = await decodeCensuses(input);
  const containers = input.entries.filter(({ entry }) => entry.kind === 'engine' && entry.status === 200
    && /^\/v1\.52\/containers\/[a-f0-9]{64}\/json$/u.test(entry.target ?? '')).map((item) => ({ ...item, container: containerSchema.parse(item.value) }));
  const members = input.report.owners.map((owner) => {
    const record = owner.finalRecord;
    const resource = (role: string) => {
      const found = record.resources.find((entry) => entry.role === role); if (!found) throw new Error('Original record lacks a required role.'); return found;
    };
    const network = resource('network'); const observer = resource('route_observer');
    if (network.identity.kind !== 'identified' || observer.identity.kind !== 'identified') throw new Error('Native member identity is unresolved.');
    return { owner, record, resource, networkId: network.identity.id, observerId: observer.identity.id, bridgeName: desktopBridgeName(record) };
  });
  const owned = new Map<string, DesktopOwnedBridge>();
  for (const member of members) {
    const empty = censuses.find(({ census }) => census.networks.some((network) => network.Id === member.networkId && Object.keys(network.Containers).length === 0));
    if (!empty) throw new Error('Missing original empty bridge census.');
    owned.set(member.owner.label, identifyDesktopOwnedBridge({ networkId: member.networkId, name: member.resource('network').name,
      bridgeName: member.bridgeName, labels: resourceLabels(member.record, 'network') }, empty.census, empty.after.observation));
  }
  const ownership = new Map(members.flatMap((member) => member.record.resources.flatMap((resource) => resource.identity.kind === 'identified'
    ? [[resource.identity.id, `${member.owner.label}:${resource.role}`] as const] : [])));
  const labelFor = (id: string) => ownership.get(id) ?? `external:${id}`;
  const checkpoints = input.checkpoints.map(({ label, entry, record }, index, all) => {
    const previous = all.slice(0, index).findLast((checkpoint) => checkpoint.label === label)?.record;
    return { owner: label, at: entry.at, file: basename(entry.path), phase: record.phase,
      changedRoles: record.resources.filter((resource) => !same(resource.identity, previous?.resources.find((item) => item.role === resource.role)?.identity))
        .map((resource) => ({ role: resource.role, identity: resource.identity })) };
  });
  const censusAnalysis = censuses.map((capture, index) => {
    const member = members.find((candidate) => candidate.observerId === capture.before.entry.containerId);
    if (!member) throw new Error('Observer bracket has no original checkpoint owner.');
    const bridge = owned.get(member.owner.label); if (!bridge) throw new Error('Missing initial bridge identity.');
    const baseline = censuses.find((candidate) => candidate.before.entry.containerId === member.observerId);
    if (!baseline) throw new Error('Original observer baseline is missing.');
    const network = capture.census.networks.find((candidate) => candidate.Id === member.networkId);
    // Look up by the immutable resource identity, not labels or a fabricated endpoint.
    const brokerIdentity = member.resource('egress_broker').identity;
    const brokerReadback = brokerIdentity.kind === 'identified' ? containers.findLast((candidate) => candidate.container.Id === brokerIdentity.id
      && candidate.container.State.Running && candidate.entry.observedAt <= capture.close.entry.observedAt) : undefined;
    const endpoint = network !== undefined && Object.keys(network.Containers).length > 0;
    let started: DesktopStartedTopologyReceipt | undefined;
    if (brokerReadback) {
      assertLabels(brokerReadback.container.Config.Labels, member.record, 'egress_broker');
      const attachments = Object.values(brokerReadback.container.NetworkSettings.Networks);
      if (attachments.length !== 1) throw new Error('Independent broker container attachment is not singular.');
      const attachment = attachments[0];
      started = { broker: { id: brokerReadback.container.Id, networkId: attachment.NetworkID, endpointId: attachment.EndpointID,
        macAddress: attachment.MacAddress, address: attachment.IPAddress, prefixLength: attachment.IPPrefixLen, gateway: attachment.Gateway },
      members: { compute: { kind: 'absent' }, filesystem: { kind: 'absent' } } };
    }
    const currentCheckpoint = input.checkpoints.filter((checkpoint) => checkpoint.label === member.owner.label
      && checkpoint.entry.at <= capture.before.entry.observedAt).at(-1);
    const noneMembers = (checkpoint: typeof currentCheckpoint) => {
      const producer = (role: string): Readonly<{ kind: 'present'; id: string }> | Readonly<{ kind: 'absent' }> => {
        const identity = checkpoint?.record.resources.find((resource) => resource.role === role)?.identity;
        return identity?.kind === 'identified' ? { kind: 'present', id: identity.id } : { kind: 'absent' };
      };
      return { compute: producer('compute'), filesystem: producer('filesystem') };
    };
    let devices: ReturnType<typeof validateDesktopOwnedVm> | undefined;
    const memberVmError = network ? failure(() => { devices = validateDesktopOwnedVm(capture.after.observation, bridge, endpoint);
      if (endpoint && devices) validateDesktopBridgeEvolution(bridge.device, devices[0], devices[1]); }) : null;
    const indexes = devices?.map((device) => device.index) ?? [];
    const baselineExternalEngine = externalEngineAuthority(baseline.census, member.observerId, { compute: { kind: 'absent' }, filesystem: { kind: 'absent' } });
    const externalEngineError = network ? failure(() => {
      if (!same(externalEngineAuthority(capture.census, member.observerId, noneMembers(currentCheckpoint), member.networkId), baselineExternalEngine)) {
        throw new Error('External Desktop Engine network configuration or membership changed.');
      }
    }) : null;
    const externalVm = externalVmAuthority(capture.after.observation, indexes);
    const baselineVm = externalVmAuthority(baseline.after.observation, []);
    const previous = censuses.slice(0, index).findLast((candidate) => candidate.before.entry.containerId === member.observerId);
    return { owner: member.owner.label, observerBefore: basename(capture.before.entry.path), observerAfter: basename(capture.after.entry.path),
      open: basename(capture.open.entry.path), close: basename(capture.close.entry.path), info: capture.info ? basename(capture.info.entry.path) : null,
      start: capture.before.entry.observedAt, end: capture.after.entry.observedAt,
      checkpoint: currentCheckpoint ? basename(currentCheckpoint.entry.path) : null,
      vmBracketEqual: same(capture.before.observation.snapshot, capture.after.observation.snapshot),
      vmBracketDelta: { interfaces: interfaceDelta(capture.before.observation.snapshot.interfaces, capture.after.observation.snapshot.interfaces),
        routes: routeDelta(capture.before.observation.snapshot.routes, capture.after.observation.snapshot.routes) },
      vmFingerprint: capture.after.observation.fingerprint,
      networkMembers: capture.census.networks.map((entry) => ({ id: entry.Id, owner: labelFor(entry.Id), name: entry.Name,
        members: Object.keys(entry.Containers).map(labelFor), allocation: entry.IPAM.Config, status: entry.Status })),
      memberVmError, independentBrokerReadback: brokerReadback ? basename(brokerReadback.entry.path) : null,
      brokerValidationError: endpoint && started ? failure(() => validateDesktopBrokerReceipt(bridge, capture.census, started)) : endpoint ? 'No preceding independent running container readback.' : null,
      linkLocalSettled: devices && endpoint ? desktopOwnedLinkLocalSettled(devices) : null,
      externalEngineError, externalVmEqualsOriginalBaseline: same(externalVm, baselineVm),
      externalVmDeltaFromBaseline: network ? interfaceDelta(baseline.after.observation.snapshot.interfaces,
        capture.after.observation.snapshot.interfaces.filter((device) => !indexes.includes(device.index))) : null,
      vmDeltaFromPrevious: previous ? { interfaces: interfaceDelta(previous.after.observation.snapshot.interfaces, capture.after.observation.snapshot.interfaces),
        routes: routeDelta(previous.after.observation.snapshot.routes, capture.after.observation.snapshot.routes) } : null };
  });
  const engineOccupancy = [...new Set(censuses.flatMap(({ census }) => census.networks.flatMap((network) => (network.IPAM.Config ?? [])
    .flatMap((allocation) => allocation.Subnet ? [allocation.Subnet] : []))))];
  const vmOccupancy = new Set<string>();
  for (const { observation } of input.vm) {
    for (const device of observation.snapshot.interfaces) for (const address of device.addresses) {
      if (address.family === 4) vmOccupancy.add(`${formatNumericAddress(nativeAddressNumber(address.address, 4) & prefixMask(4, address.prefix), 4)}/${address.prefix}`);
    }
    for (const route of observation.snapshot.routes) {
      if (route.family === 4 && route.prefix > 0) vmOccupancy.add(`${formatNumericAddress(nativeAddressNumber(route.destination, 4) & prefixMask(4, route.prefix), 4)}/${route.prefix}`);
      for (const gateway of route.gateways) if (!gateway.includes(':')) vmOccupancy.add(`${gateway}/32`);
    }
  }
  const poolConflicts = PRIVATE_POOL.flatMap((candidate) => [...engineOccupancy, ...vmOccupancy].filter((occupied) => overlaps(candidate, occupied))
    .map((occupied) => ({ candidate, occupied })));
  const hostOccupancy = [...new Set(input.host.flatMap(({ observation }) => observation.excludedCidrs).filter((cidr) => !cidr.includes(':')))];
  const hostConflicts = PRIVATE_POOL.flatMap((candidate) => hostOccupancy.filter((occupied) => overlaps(candidate, occupied)).map((occupied) => ({ candidate, occupied })));
  return { format: 'agenai.desktop-concurrency-trace-analysis.v1', input: input.root, identity: input.hashes,
    scope: `Read-only analysis through current source decoders/validators; no capture modified. ${censuses.filter((capture) => !capture.info).length} censuses require explicit report metadata fallback for unretained /info. Host files, when present, are separate phase samples rather than complete per-VM host brackets.`,
    reportStatus: input.report.status, packages: input.report.packages, captureEntriesVerified: input.entries.length,
    checkpointsVerified: input.checkpoints.length, vmObservationsDecoded: input.vm.length, completeNetworkCensusesDecoded: censuses.length,
    hostObservations: input.host.map(({ entry, observation }) => ({ phase: entry.phase, file: basename(entry.path), sha256: entry.sha256,
      fingerprint: observation.fingerprint })),
    members: members.map((member) => ({ label: member.owner.label, namespace: member.record.namespace, bridgeName: member.bridgeName,
      resources: member.record.resources, start: member.owner.start, failure: member.owner.failure,
      finalState: member.owner.finalState, finalCensus: member.owner.finalCensus })),
    checkpoints, censuses: censusAnalysis,
    containerTopology: containers.filter((item, index) => {
      const previous = containers.slice(0, index).findLast((candidate) => candidate.container.Id === item.container.Id);
      return !previous || !same(previous.container, item.container);
    }).map(({ entry, container }) => ({ file: basename(entry.path), at: entry.observedAt,
      identity: labelFor(container.Id), running: container.State.Running, state: container.State.Status,
      configuredMode: container.HostConfig.NetworkMode, networkDisabled: container.Config.NetworkDisabled,
      attachments: container.NetworkSettings.Networks })),
    effects: input.trace.filter((entry) => entry.method !== 'GET').map((entry) => ({ ...entry,
      owner: members.find((member) => member.record.resources.some((resource) => entry.target.includes(resource.name)
        || resource.identity.kind === 'identified' && entry.target.includes(resource.identity.id)))?.owner.label ?? null })),
    pool: { candidate: '10.240.0.0/24', subnets: PRIVATE_POOL, engineOccupancy, vmOccupancy: [...vmOccupancy].sort(), conflicts: poolConflicts,
      engineAndVmNonoverlapObserved: poolConflicts.length === 0, hostOccupancy, hostConflicts,
      hostNonoverlap: input.host.length ? hostConflicts.length === 0 : 'unproven: no Darwin host stdout retained by this capture',
      reservationOrLiveBrokerProof: 'not performed by the frozen reproduction' },
    cleanup: { failures: input.report.cleanupFailures.length,
      exactIdentifiedAbsence: input.report.owners.every((owner) => owner.finalCensus.every((entry) => entry.status === 404)),
      enteredResources: members.reduce((count, member) => count + member.record.resources.filter((resource) => resource.identity.kind === 'identified').length, 0),
      finalVmObservationAfterNetworkRemoval: false,
      limitation: 'Final exact resource absence is retained in report.json; no final VM observer remains to prove the entire final VM topology.' } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, output] = process.argv.slice(2);
  if (!directory || !output || process.argv.length !== 4) throw new Error('Usage: pnpm exec tsx analyze-trace.ts <original-capture-directory> <new-output.json>');
  const ownedRoot = dirname(fileURLToPath(import.meta.url));
  if (dirname(resolve(output)) !== ownedRoot) throw new Error('Analysis output must stay in the research transitions directory.');
  const result = await analyzeTrace(directory);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, verified: result.captureEntriesVerified, checkpoints: result.checkpointsVerified,
    vm: result.vmObservationsDecoded, censuses: result.completeNetworkCensusesDecoded, poolConflicts: result.pool.conflicts,
    exactAbsence: result.cleanup.exactIdentifiedAbsence })}\n`);
}
