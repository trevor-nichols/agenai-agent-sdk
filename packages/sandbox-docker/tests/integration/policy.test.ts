// ------------------------------------------------------------------------------------------------
//                policy.test.ts - Real guest file boundaries and explicit network behavior
// ------------------------------------------------------------------------------------------------

import { importFixtures, exportFixtures } from '../fixtures/trees.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { SandboxOperationError, SandboxValidationError, parseSandboxRelativePath } from '@agen-ai/sandbox';
import type { Sandbox, SandboxReservation } from '@agen-ai/sandbox';
import { atomicJson, collectBytes, engineGet, failureSummary, inspectAbsent, openSuite, reservePersisted,
  resourceId, sandboxRequest, type ResourceObservation } from './support/common.js';
import { desktopHostRoute, linuxBridgeRoute, withPolicyHostListener } from './support/policy-network.js';

test('real guest files and network follow explicit sandbox policy', { timeout: 300_000 }, async (context) => {
  const suite = await openSuite('policy');
  const peer = await readFile(new URL('./fixtures/policy-peer.mjs', import.meta.url));
  assert(peer.byteLength < 8192);
  const rows: unknown[] = [];
  const run = async (name: string, body: (owners: SandboxReservation[], checkpoints: ResourceObservation[], facts: unknown[]) => Promise<void>) => {
    const owners: SandboxReservation[] = [];
    const checkpoints: ResourceObservation[] = [];
    const facts: unknown[] = [];
    const failures: unknown[] = [];
    let primary: { error: unknown } | undefined;
    try { await body(owners, checkpoints, facts); }
    catch (error) { primary = { error }; }
    finally {
      for (const owner of owners) {
        try { await owner.destroy(); }
        catch (error) { failures.push(error); }
        try { await inspectAbsent(suite.endpoint, owner.recoveryRecord, 'finally-destroy', checkpoints); }
        catch (error) { failures.push(error); }
      }
      rows.push({ name, verdict: primary || failures.length ? 'failed' : 'passed', facts, checkpoints,
        records: owners.map((owner) => owner.recoveryRecord), primaryFailure: primary ? failureSummary(primary.error) : null,
        cleanupFailures: failures.map((error) => failureSummary(error)) });
      await atomicJson(path.join(suite.directory, 'report.json'), { format: 'agenai.sandbox-docker-policy-evidence.v1',
        namespace: suite.namespace, imageDigest: suite.imageDigest, node: process.version, rows, modelCalls: 0, credentialReads: 0 });
    }
    if (primary || failures.length) throw new AggregateError([...(primary ? [primary.error] : []), ...failures], `Policy case ${name} failed; original evidence retained.`);
  };
  const reserve = (owners: SandboxReservation[], label: string, overrides: Parameters<typeof sandboxRequest>[0] = {}) => {
    const owner = reservePersisted(suite.backend, sandboxRequest(overrides), suite.directory, label);
    owners.push(owner);
    return owner;
  };
  const execute = async (sandbox: Sandbox, args: string[]): Promise<Record<string, unknown>> => {
    const streams = await sandbox.reserveProcess({ executable: '/usr/local/bin/node',
      args: [`${sandbox.workspace}/policy-peer.mjs`, ...args], cwd: sandbox.workspace, env: {} }).start();
    const [stdout, stderr, exit] = await Promise.all([collectBytes(streams.stdout), collectBytes(streams.stderr), streams.exit]);
    assert.deepEqual(stderr, Buffer.alloc(0));
    assert.deepEqual(exit, { kind: 'exited', code: 0 });
    return JSON.parse(stdout.toString('utf8'));
  };

  await context.test('host paths and readonly root remain outside the private workspace', async () => run('filesystem', async (owners, checkpoints, facts) => {
    const sentinel = path.join(suite.directory, 'host-sentinel.txt');
    await writeFile(sentinel, 'host remains unchanged\n', { mode: 0o600 });
    const sandbox = await reserve(owners, 'filesystem').start();
    await importFixtures(sandbox, [{ path: 'policy-peer.mjs', bytes: peer, executable: false },
      { path: 'input.txt', bytes: Buffer.from('original input\n'), executable: false }]);
    for (const target of [sentinel, '../input.txt', 'nested/../../input.txt']) {
      assert.throws(() => parseSandboxRelativePath(target), SandboxValidationError);
    }
    const rejectedImport = await reserve(owners, 'invalid-import').start();
    await assert.rejects(importFixtures(rejectedImport, [{ path: sentinel, bytes: Buffer.from('forbidden'), executable: false }]), SandboxValidationError);
    await rejectedImport.stop();
    await inspectAbsent(suite.endpoint, rejectedImport.recoveryRecord, 'invalid-import-fenced-compute', checkpoints, ['compute']);
    const observed = await execute(sandbox, ['filesystem', sentinel]);
    assert.equal(observed.uid, suite.user.uid);
    assert.deepEqual(observed.denied, { 'host-sentinel': 'ENOENT', 'docker-socket': 'ENOENT', 'readonly-root': 'EROFS' });
    assert.equal(await readFile(sentinel, 'utf8'), 'host remains unchanged\n');
    await sandbox.stop();
    await inspectAbsent(suite.endpoint, sandbox.recoveryRecord, 'sdk-stop-before-export', checkpoints, ['compute']);
    const files = await exportFixtures(sandbox, ['artifact.json']);
    assert.deepEqual(JSON.parse(Buffer.from(files[0].bytes).toString('utf8')), observed);
    await assert.rejects(async () => exportFixtures(sandbox, ['../private-home']), SandboxValidationError);
    facts.push({ observed, prevalidatedImportPaths: 3, rejectedStreamingImport: true, rejectedImportComputeAbsent: true,
      hostSentinelPreserved: true, guestSocketAbsent: true });
  }));

  for (const mode of ['fifo', 'symlink', 'oversized']) {
    await context.test(`complete archive rejects unselected ${mode} content`, async () => run(mode, async (owners, checkpoints, facts) => {
      const sandbox = await reserve(owners, mode).start();
      await importFixtures(sandbox, [{ path: 'policy-peer.mjs', bytes: peer, executable: false }]);
      assert.equal((await execute(sandbox, [mode])).created, true);
      await sandbox.stop();
      await inspectAbsent(suite.endpoint, sandbox.recoveryRecord, 'sdk-stop-before-export', checkpoints, ['compute']);
      let rejection: unknown;
      assert.deepEqual(await exportFixtures(sandbox, ['safe.txt']), [{ path: 'safe.txt', executable: false, bytes: Buffer.from('selected safe file\n') }]);
      await assert.rejects(async () => sandbox.exportTree({ kind: 'workspace' }, async (entry) => {
        if (entry.kind === 'file') for await (const _chunk of entry.bytes) { /* Keep bytes provisional through complete validation. */ }
      }, { quotas: { maxFileBytes: 8192, maxTotalBytes: 32768, maxArchiveBytes: 65536 } }), (error: unknown) => {
        assert(error instanceof SandboxOperationError);
        assert.equal(error.code, mode === 'oversized' ? 'output_limit' : 'driver_failure');
        assert.match(error.message, mode === 'oversized' ? /quota|limit/iu : /archive.*(?:regular|link)/iu);
        rejection = error;
        return true;
      });
      facts.push({ unselectedContent: mode, selectedPath: 'safe.txt', exactSafeExportAccepted: true, wholeWorkspaceRejected: failureSummary(rejection),
        transferLimitsAreNotDiskQuota: true });
    }));
  }

  await context.test('isolated cannot reach a task-owned host listener while explicit outbound can', async () => run('network', async (owners, checkpoints, facts) => {
    type ProbeRole = 'discovery' | 'outbound-before' | 'isolated' | 'outbound-after';
    const peerOwners: unknown[] = [];
    facts.push({ peerOwners });
    const startPeer = async (role: ProbeRole) => {
      const network = role === 'isolated' ? 'isolated' : 'outbound';
      const owner = reserve(owners, `network-${role}`, { network });
      const { sandboxId, operationId } = owner.recoveryRecord;
      peerOwners.push({ role, network, sandboxId, operationId });
      const sandbox = await owner.start();
      await importFixtures(sandbox, [{ path: 'policy-peer.mjs', bytes: peer, executable: false }]);
      return { role, sandboxId, sandbox };
    };
    const stopPeer = async (peer: Awaited<ReturnType<typeof startPeer>>) => {
      await peer.sandbox.stop();
      await inspectAbsent(suite.endpoint, peer.sandbox.recoveryRecord, `${peer.role}-stop`, checkpoints, ['compute']);
    };
    const destroyPeer = async (peer: Awaited<ReturnType<typeof startPeer>>) => {
      await peer.sandbox.destroy();
      await inspectAbsent(suite.endpoint, peer.sandbox.recoveryRecord, `${peer.role}-destroy`, checkpoints);
    };
    const bridgeRoute = async (sandbox: Sandbox) => {
      const network = await engineGet(suite.endpoint, `/networks/${resourceId(sandbox.recoveryRecord, 'network')}`);
      assert.equal(network.status, 200);
      return linuxBridgeRoute(network.body);
    };
    let desktopRoute: ReturnType<typeof desktopHostRoute> | undefined;
    if (process.platform === 'darwin') {
      const discoveryPeer = await startPeer('discovery');
      const discovery = await execute(discoveryPeer.sandbox, ['resolve-host']);
      facts.push({ desktopHostDiscovery: discovery });
      desktopRoute = desktopHostRoute(discovery);
      await stopPeer(discoveryPeer);
      await destroyPeer(discoveryPeer);
    } else {
      assert.equal(process.platform, 'linux', 'The host listener fixture requires Linux or Darwin.');
    }
    const outboundBefore = await startPeer('outbound-before');
    const route = desktopRoute ?? await bridgeRoute(outboundBefore.sandbox);
    facts.push({ hostRoute: route });
    await withPolicyHostListener(route.bindAddress, async (listener) => {
      const target = `http://${route.targetAddress}:${listener.port}${listener.path}`;
      const probes: unknown[] = [];
      facts.push({ target, listener: { bindAddress: listener.bindAddress, port: listener.port,
        temporaryWildcard: listener.bindAddress === '0.0.0.0', method: 'GET', path: listener.path, marker: listener.marker,
        requests: listener.requests, census: listener.census, cleanup: listener.cleanup }, probes,
        internetRequests: 0, outboundHostReachabilityExplicit: true });
      const allowed = await execute(outboundBefore.sandbox, ['network', target]);
      probes.push({ phase: 'outbound-before-denial', sandboxId: outboundBefore.sandboxId, observed: allowed });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.body, listener.marker);
      assert.deepEqual(listener.requests, [{ method: 'GET', path: listener.path, matched: true }]);
      assert.equal(listener.census.total, 1);
      await stopPeer(outboundBefore);
      const isolated = await startPeer('isolated');
      const denied = await execute(isolated.sandbox, ['network', target]);
      probes.push({ phase: 'isolated', sandboxId: isolated.sandboxId, observed: denied });
      assert.equal(denied.error, 'ENETUNREACH');
      assert.deepEqual(listener.requests, [{ method: 'GET', path: listener.path, matched: true }]);
      assert.equal(listener.census.total, 1);
      await stopPeer(isolated);
      await destroyPeer(isolated);
      const outboundAfter = await startPeer('outbound-after');
      const confirmed = await execute(outboundAfter.sandbox, ['network', target]);
      probes.push({ phase: 'outbound-after-denial', sandboxId: outboundAfter.sandboxId, observed: confirmed });
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.body, listener.marker);
      assert.deepEqual(listener.requests, [
        { method: 'GET', path: listener.path, matched: true },
        { method: 'GET', path: listener.path, matched: true },
      ]);
      assert.equal(listener.census.total, 2);
      await stopPeer(outboundAfter);
      await destroyPeer(outboundAfter);
    });
    await destroyPeer(outboundBefore);
  }));
});
