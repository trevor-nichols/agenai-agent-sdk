import { observationFingerprint } from '../observation/engine.js';
import type { DesktopEngineNetworkCensus } from '../observation/engine.js';
import type { DesktopHostAuthorityObservation } from '../observation/host.js';
import type { DesktopVmObservation } from '../observation/vm.js';
import type { DesktopExternalProjection, DesktopMemberProjection, DesktopMemberGraphReceipt } from './projection.js';
import { projectionDigest } from './journal/schema.js';
import type { AuthorityBasis, MemberProjection } from './journal/schema.js';

const digest = (value: unknown) => `sha256:${observationFingerprint(value)}`;

export function desktopFullBasis(input: Readonly<{ atSequence: number; exclusionDigest: string; host: DesktopHostAuthorityObservation;
  engine: DesktopEngineNetworkCensus; vm: DesktopVmObservation; external: DesktopExternalProjection;
  projections: readonly DesktopMemberProjection[] }>): Extract<AuthorityBasis, { kind: 'full' }> {
  return Object.freeze({ kind: 'full', atSequence: input.atSequence, exclusionDigest: input.exclusionDigest,
    hostDigest: `sha256:${input.host.fingerprint}`, engineDigest: digest(input.engine), vmDigest: `sha256:${input.vm.fingerprint}`,
    externalEngineDigest: digest(input.external.engine), externalVmDigest: digest(input.external.vm), projectionDigest: digest(input.projections) });
}

export function desktopJournalProjection(member: DesktopMemberProjection, graph: DesktopMemberGraphReceipt | undefined,
  engine: DesktopEngineNetworkCensus, stopped: boolean, brokerCreated: boolean, started: boolean): MemberProjection {
  const bridge = member.bridge;
  const owned = bridge.kind === 'absent' ? null : bridge.owned;
  const broker = bridge.kind === 'active' || bridge.kind === 'starting_endpoint' ? bridge.started.broker : null;
  const phase: Extract<MemberProjection, { kind: 'registered' }>['phase'] = stopped ? 'retained_empty' : bridge.kind === 'removing_endpoint' || bridge.kind === 'removing_bridge' ? 'retiring'
    : started ? 'started' : broker !== null ? brokerCreated ? 'broker_created' : 'broker_active' : owned ? 'bridge_empty' : 'observer_only';
  const facts: Extract<MemberProjection, { kind: 'registered' }>['facts'] = {
    network: owned === null ? null : { id: owned.receipt.networkId, name: owned.receipt.name, bridgeName: owned.receipt.bridgeName,
      subnet: owned.subnet, gateway: owned.gateway, identityDigest: digest(owned.network) },
    observerId: member.observer.kind !== 'absent' ? member.observer.id : null,
    computeNoneId: member.none.compute.kind === 'present' ? member.none.compute.id : null,
    filesystemNoneId: member.none.filesystem.kind === 'present' ? member.none.filesystem.id : null,
    broker: broker === null ? null : { id: broker.id, endpointId: broker.endpointId, mac: broker.macAddress,
      address: broker.address, prefixLength: 28, gateway: broker.gateway },
    vmLinks: (graph?.graph?.devices ?? []).map((device) => ({ index: device.index, name: device.name, mac: device.macAddress ?? '',
      identityDigest: digest(device), stateDigest: digest(device) })).sort((left, right) => left.index - right.index),
    engineDigest: digest(engine), vmDigest: digest(graph?.graph ?? null),
  };
  const projection = { kind: 'registered' as const, recipe: 'desktop-member-projection-v1' as const, phase, facts, digest: '' };
  return Object.freeze({ ...projection, digest: projectionDigest(projection) });
}
