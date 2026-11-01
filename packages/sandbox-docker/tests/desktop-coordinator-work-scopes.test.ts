import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerDesktopCoordinatorError } from '../src/network/desktop/coordinator/contracts.js';
import { parseCoordinatorSnapshot } from '../src/network/desktop/coordinator/journal/schema.js';
import { parseCoordinatedDockerConfig } from '../src/policy/config.js';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
import { DockerResourceOwner } from '../src/resources/owner.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
import { imageDigest, sandboxRequest } from './fixtures/engine.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

for (const state of ['owned', 'joined'] as const) for (const stage of ['before_rename', 'after_rename'] as const) {
  test(`original cleanup settles initialization after ${state} publication fails ${stage}`, { timeout: 15_000 }, async () => {
    let acquisitionAttempts = 0;
    const fixture = await desktopCoordinatorLifecycleFixture('normal', { async handleRequest({ path, response }) {
      if (path !== `/v1.52/images/${imageDigest}/json`) return false;
      acquisitionAttempts += 1;
      // End acquisition before any resource effect, exercising the initialization finally path.
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Workload image is absent.' }));
      return true;
    } });
    const coordinator = fixture.createOwner();
    let owner: DockerResourceOwner | undefined;
    try {
      const capability = await coordinator.activate();
      const options = fixture.options(); assert(options.egress);
      const config = parseCoordinatedDockerConfig({ ...options, coordinator: capability,
        egress: { ...options.egress, control: { heartbeatMs: 1_000, leaseTimeoutMs: 60_000 } } });
      owner = new DockerResourceOwner(new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 2_000), config,
        sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }));
      await fixture.failWorkPublication('initialization', state, stage);
      await assert.rejects(owner.start({ async checkpoint() {}, onInfrastructureFailure() {} }), (error: unknown) => {
        assert(error instanceof DockerDesktopCoordinatorError);
        assert.deepEqual(error.failure, { kind: 'persistence_failed', boundary: 'member' });
        return true;
      });
      assert.equal((await fixture.events()).filter((entry) => entry.command === 'WORK_PUBLICATION_FAILURE').length, 1);
      assert.equal(acquisitionAttempts, state === 'owned' ? 0 : 1);
      await owner.destroy();
      await owner.destroy();
      assert.equal(owner.recoveryRecord.phase, 'destroyed');
      await coordinator.close();
      assert.deepEqual(coordinator.state, { kind: 'closed', result: 'clean', generation: capability.generation });
      const snapshot = parseCoordinatorSnapshot(JSON.stringify(await fixture.current()));
      assert.equal(snapshot.generation.kind, 'clean');
      assert.deepEqual(fixture.effects, [], 'Cleanup must not replay acquisition or invent a resource deletion.');
      assert.equal(acquisitionAttempts, state === 'owned' ? 0 : 1);
    } finally {
      await owner?.destroy().catch(() => {});
      await coordinator.close({ timeoutMs: 100 }).catch(() => {});
      if (coordinator.state.kind !== 'closed') await fixture.terminateHolder();
      await fixture.close();
    }
  });
}
