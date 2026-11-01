import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import { parseSandboxRecoveryRecord, SandboxOperationError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { captureDesktopCoordinatorAuthority } from '../../src/network/desktop/coordinator/binding.js';
import type { DockerDesktopCoordinator, DockerDesktopCoordinatorAuthority } from '../../src/network/desktop/coordinator/contracts.js';
import type { DesktopCoordinatorMemberOwner } from '../../src/network/desktop/coordinator/member.js';
import { parseCoordinatorSnapshot } from '../../src/network/desktop/coordinator/journal/schema.js';
import { parseCoordinatedDockerConfig } from '../../src/policy/config.js';
import { desktopObserverContainerBody, verifyDesktopObserverContainer } from '../../src/policy/desktopObserver.js';
import { newRecoveryRecord } from '../../src/recovery/identity.js';
import { DockerApi } from '../../src/resources/api.js';
import { DockerEngine } from '../../src/engine/client.js';
import { inspectResource } from '../../src/resources/inspect.js';
import { desktopCoordinatorLifecycleFixture } from './desktopCoordinatorLifecycle.js';
import { sandboxRequest } from './engine.js';

const createdSchema = z.strictObject({ Id: z.string().regex(/^[a-f0-9]{64}$/u), Warnings: z.array(z.string()) });
type Persistence = (record: SandboxRecoveryRecord) => Promise<void>;
interface MemberGroup {
  readonly fixture: Awaited<ReturnType<typeof desktopCoordinatorLifecycleFixture>>;
  readonly coordinator: DockerDesktopCoordinator;
  readonly capability: DockerDesktopCoordinatorAuthority;
}

export async function prepareMember(persist: Persistence = async () => {}, group?: MemberGroup) {
  const fixture = group?.fixture ?? await desktopCoordinatorLifecycleFixture();
  const coordinator = group?.coordinator ?? fixture.createOwner();
  const capability = group?.capability ?? await coordinator.activate();
  const options = fixture.options();
  assert(options.egress);
  const config = parseCoordinatedDockerConfig({ ...options, coordinator: capability,
    egress: { ...options.egress, control: { heartbeatMs: 1000, leaseTimeoutMs: 60_000 } } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 2000);
  const request = sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] });
  let current = newRecoveryRecord(config, request);
  const callbacks: SandboxRecoveryRecord[] = [];
  const returned = new Map<string, string>();
  const failures: SandboxOperationError[] = [];
  const source: DesktopCoordinatorMemberOwner = {
    api, config, policy: request.policy, record: () => current, retain: (record) => { current = record; },
    async persist(record) { callbacks.push(record); await persist(record); },
    returned: (role, id) => { returned.set(role, id); }, creating() {}, enrolled() {},
    async remove(role) {
      const resource = current.resources.find((entry) => entry.role === role); assert(resource);
      if (resource.identity.kind !== 'identified') return;
      const inspection = await inspectResource(api, config, current, resource, resource.identity.id);
      if (!inspection) return;
      await api.request('DELETE', `/v1.52/containers/${inspection.id}?force=true&v=false`, { statuses: [204, 404] });
      assert.equal(await inspectResource(api, config, current, resource, inspection.id), undefined);
    },
    failed: (error) => failures.push(error),
  };
  const member = await captureDesktopCoordinatorAuthority(capability).enroll(source);
  await member.checkpoint({ ...current, phase: 'starting', authority: { kind: 'verified', backendIdentity: fixture.descriptor.engine.id } });
  const create = (signal?: AbortSignal, afterCreate?: (id: string) => void) => {
    const input = desktopObserverContainerBody(config, current);
    return member.create('route_observer', signal, { input,
      async dispatch(resource) {
        const result = await api.json('POST', `/v1.52/containers/create?name=${encodeURIComponent(resource.name)}&platform=linux%2Farm64`,
          createdSchema, { body: input });
        afterCreate?.(result.Id);
        return { id: result.Id, warning: result.Warnings.length > 0 };
      },
      validate(inspection) { assert(inspection.container); verifyDesktopObserverContainer(inspection.container, config, false); },
    });
  };
  const finish = async (closeCoordinator = true) => {
    await member.beginStop();
    await member.delete('route_observer');
    const terminal = parseSandboxRecoveryRecord({ ...current, phase: 'destroyed' });
    await member.checkpoint(terminal).catch((cause: unknown) => {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'persistence_failure')) throw cause;
    });
    await member.retire(terminal);
    if (closeCoordinator) await coordinator.close();
  };
  return { fixture, coordinator, capability, config, api, member, create, finish, callbacks, returned, failures, record: () => current,
    async canonical() { return parseCoordinatorSnapshot(JSON.stringify(await fixture.current())); },
    async close() {
      await coordinator.close({ timeoutMs: 100 }).catch(() => {});
      if (coordinator.state.kind !== 'closed') await fixture.terminateHolder();
      await fixture.close();
    },
  };
}
