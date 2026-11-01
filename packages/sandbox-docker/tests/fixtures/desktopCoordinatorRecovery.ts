import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { DockerEngine } from '../../src/engine/client.js';
import { DockerApi } from '../../src/resources/api.js';
import { inspectResource } from '../../src/resources/inspect.js';
import { parseCoordinatedDockerCleanupConfig, parseDockerConfig } from '../../src/policy/config.js';
import { desktopObserverContainerBody } from '../../src/policy/desktopObserver.js';
import { desktopSharedAuthorityDigest } from '../../src/policy/coordination.js';
import { newRecoveryRecord } from '../../src/recovery/identity.js';
import { beginCoordinatorGeneration, createInitialCoordinatorSnapshot, planCoordinatorTransition } from '../../src/network/desktop/coordinator/journal/plans.js';
import type { CoordinatorEvent, CoordinatorPlan } from '../../src/network/desktop/coordinator/journal/plans.js';
import { coordinatorEngineKey } from '../../src/network/desktop/coordinator/journal/schema.js';
import type { CoordinatorSnapshot } from '../../src/network/desktop/coordinator/journal/schema.js';
import { createDesktopCoordinatorRecoveryMembers } from '../../src/network/desktop/coordinator/recovery/members.js';
import { DesktopCoordinatorSequence } from '../../src/network/desktop/coordinator/sequence.js';
import { desktopResourcesFixture } from './desktopResources.js';
import { gate, sandboxRequest } from './engine.js';

const digest = `sha256:${'a'.repeat(64)}`;
export const returnedId = 'b'.repeat(64);
type Cut = 'unknown_absent' | 'returned_absent' | 'not_dispatched' | 'lost_create_ack' | 'late_create' | 'lost_start_ack' | 'lost_delete_ack' | 'created';

function accepted(plan: CoordinatorPlan): CoordinatorSnapshot {
  if (plan.kind === 'rejected') throw new Error(plan.reason);
  return plan.snapshot;
}

/** Original canonical arms plus an independent Unix HTTP daemon; no observer or native namespace. */
export async function desktopCoordinatorRecoveryFixture(cut: Cut) {
  const createEntered = gate(); const createRelease = gate();
  const fixture = await desktopResourcesFixture('desktop-apple-virtualization-native-arm64', async (input) => {
    if (cut === 'late_create' && input.method === 'POST' && input.path === '/v1.52/containers/create') {
      input.response.destroy(); createEntered.resolve(); await createRelease.promise;
    }
    const id = input.path.match(/^\/v1\.52\/containers\/([a-f0-9]{64})(?:\/start)?$/u)?.[1];
    if (id && cut === 'lost_start_ack' && input.method === 'POST' && input.path.endsWith('/start')) {
      const container = fixture.containers.get(id);
      if (!container) throw new Error('Original start lost its created container.');
      container.State = { Running: true, Status: 'running' };
      input.response.destroy(); return true;
    }
    if (id && cut === 'lost_delete_ack' && input.method === 'DELETE') {
      fixture.containers.delete(id); input.response.destroy(); return true;
    }
    return false;
  }, cut === 'lost_create_ack' ? { loseContainerReplyForRole: 'route_observer' } : {});
  const options = fixture.options(); assert(options.egress);
  const configuration = { ...options, egress: { ...options.egress, control: { heartbeatMs: 1000, leaseTimeoutMs: 60_000 } } };
  const parsed = parseDockerConfig(configuration);
  assert(parsed.egressAuthority?.kind === 'local_docker_desktop');
  const generation = { generationId: '00000000-0000-4000-8000-000000000002', ordinal: 1,
    coordinationRevision: 'desktop-coordination-v1' as const, coordinationPolicyDigest: digest,
    engineBindingDigest: digest, endpointBindingDigest: digest, hostPreparationDigest: digest, nativeAssetDigest: digest };
  const authorityId = '00000000-0000-4000-8000-000000000001';
  const daemonId = fixture.descriptor.engine.id;
  let snapshot = accepted(beginCoordinatorGeneration(createInitialCoordinatorSnapshot({ authorityId, daemonId }), {
    identity: generation, basis: { kind: 'host_engine_only', hostDigest: digest, engineDigest: digest, exclusionDigest: digest, atSequence: 1 },
  }));
  const config = parseCoordinatedDockerCleanupConfig(configuration, { endpoint: fixture.endpoint,
    configurationDigest: desktopSharedAuthorityDigest(parsed.egressAuthority.identity),
    identity: { protocol: 'agenai.desktop-coordinator.v1', authorityId, engineKey: coordinatorEngineKey(daemonId), daemonId, generation } });
  const record = newRecoveryRecord(config, sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }));
  let failure: { matches(event: CoordinatorEvent): boolean; afterCommit: boolean } | undefined;
  const publicationError = new Error('Canonical snapshot publication failed.');
  let publicationBlocked = false;
  const apply = async (event: CoordinatorEvent) => {
    if (publicationBlocked) throw publicationError;
    const next = accepted(planCoordinatorTransition(snapshot, event));
    if (failure?.matches(event)) {
      const lost = failure; failure = undefined; publicationBlocked = true;
      if (lost.afterCommit) snapshot = next;
      throw publicationError;
    }
    snapshot = next;
  };
  await apply({ kind: 'register', record, slot: 0, binding: { profile: 'desktop-apple-virtualization-native-arm64',
    backendRevision: 'engine-1.52-v7-desktop-apple-virtualization-native-arm64', configurationIdentityDigest: record.configurationDigest } });
  const creating = parseSandboxRecoveryRecord({ ...record, phase: 'starting', authority: { kind: 'verified', backendIdentity: daemonId },
    resources: record.resources.map((resource) => resource.role === 'route_observer' ? { ...resource, identity: { kind: 'creating' } } : resource) });
  await apply({ kind: 'checkpoint', memberId: record.operationId, record: creating, mode: 'caller_persisted' });
  await apply({ kind: 'queue', memberId: record.operationId, role: 'route_observer', action: 'create' });
  await apply({ kind: 'arm', effectSequence: 1, expectedBeforeDigest: digest, expectedInputDigest: digest });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 2000);
  const resource = creating.resources.find((entry) => entry.role === 'route_observer'); assert(resource);
  if (cut === 'returned_absent') await apply({ kind: 'returned', effectSequence: 1, id: returnedId });
  if (cut === 'not_dispatched') await apply({ kind: 'settle', effectSequence: 1, outcome: 'not_dispatched',
    presence: { kind: 'not_entered', provedAtSequence: snapshot.sequence + 1 }, receiptDigest: digest });
  const create = () => api.request('POST', `/v1.52/containers/create?name=${encodeURIComponent(resource.name)}`,
    { body: Buffer.from(JSON.stringify(desktopObserverContainerBody(config, creating))), contentType: 'application/json' });
  if (cut === 'late_create') {
    const actual = create(); void actual.catch(() => {});
    await createEntered.promise;
    await assert.rejects(actual, { code: 'driver_failure' });
  } else if (cut === 'lost_create_ack') await assert.rejects(create(), { code: 'driver_failure' });
  else if (cut === 'created' || cut === 'lost_start_ack' || cut === 'lost_delete_ack') {
    await create();
    const inspection = await inspectResource(api, config, creating, resource, resource.name); assert(inspection);
    await apply({ kind: 'returned', effectSequence: 1, id: inspection.id });
    const identified = parseSandboxRecoveryRecord({ ...creating, resources: creating.resources.map((entry) => entry.role === resource.role
      ? { ...entry, identity: { kind: 'identified', id: inspection.id, fingerprint: inspection.fingerprint } } : entry) });
    await apply({ kind: 'settle', effectSequence: 1, outcome: 'present', record: identified,
      presence: { kind: 'present', id: inspection.id, fingerprint: inspection.fingerprint, inspectionDigest: digest, runtime: 'created' }, receiptDigest: digest });
    if (cut !== 'created') {
      const action = cut === 'lost_start_ack' ? 'start' : 'delete';
      await apply({ kind: 'queue', memberId: record.operationId, role: 'route_observer', action });
      await apply({ kind: 'arm', effectSequence: 2, expectedBeforeDigest: digest, expectedInputDigest: digest });
      await assert.rejects(api.request(action === 'start' ? 'POST' : 'DELETE', `/v1.52/containers/${inspection.id}${action === 'start' ? '/start' : ''}`), { code: 'driver_failure' });
    }
  }
  await apply({ kind: 'reopen_cleanup' });
  const sequence = new DesktopCoordinatorSequence();
  const recovery = createDesktopCoordinatorRecoveryMembers({ api, snapshot: () => snapshot, apply,
    async assertAuthority() { assert.equal(snapshot.daemonId, daemonId); }, run: (perform) => sequence.run('cleanup', perform) });
  return { fixture, config, recovery, publicationError, snapshot: () => snapshot,
    occupyOriginalName: create,
    failPublication(matches: (event: CoordinatorEvent) => boolean, afterCommit = false) { failure = { matches, afterCommit }; },
    clearPublicationFailure() { publicationBlocked = false; failure = undefined; },
    async releaseLateCreate() {
      createRelease.resolve();
      const deadline = Date.now() + 2000;
      while (fixture.containers.size === 0) {
        if (Date.now() >= deadline) throw new Error('The original delayed HTTP create did not settle.');
        await delay(5);
      }
    },
    async close() { createRelease.resolve(); await sequence.settle(); await fixture.close(); },
  };
}
