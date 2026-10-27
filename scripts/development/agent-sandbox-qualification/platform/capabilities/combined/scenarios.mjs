import assert from 'node:assert/strict';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { until } from '../../../engine.mjs';
import { guest } from '../live/installed.mjs';
import { census, identified } from '../network/resources.mjs';
import { sha } from '../network/fixtures.mjs';
import { acquireCaseHost } from '../preserve/host-roots.mjs';
import { loadExample, workflow } from './installed.mjs';

async function settledCounters(context) {
  return until(async () => {
    const counters = await context.fixtures.census();
    return Object.values(counters).every(({ active }) => active === 0) ? counters : false;
  }, context.config.capabilities.limits.requestMs, 'Owned marker controls remain entered.');
}

export async function observeWorkflow(run, context, observation, entry) {
  if (observation.phase === 'started') {
    const target = context.fixtures.targets().host;
    const reachable = await context.fixtures.probeBroker(run, entry, { kind: 'tcp', ...target, reply: true });
    assert.equal(reachable.bytes, target.marker, 'Independent broker control did not retrieve this exact forbidden marker.');
    entry.markerBefore = await settledCounters(context);
    await run.observe({ kind: 'combined-same-target-reachable-control', namespace: entry.namespace, target, reachable,
      counters: entry.markerBefore, census: await census(context.engine, entry.owner.recoveryRecord, 'combined-ready') });
  }
  if (observation.phase === 'network_verified') {
    const after = await settledCounters(context);
    assert.deepEqual(after, entry.markerBefore, 'The forbidden listener observed traffic from the public combined program.');
    await run.observe({ kind: 'combined-forbidden-zero-listener-delta', namespace: entry.namespace,
      before: entry.markerBefore, after, ownerState: entry.owner.state });
    assert.equal(entry.owner.state.kind, 'ready', 'Infrastructure fencing cannot substitute for a policy denial.');
  }
  if (observation.phase === 'stopped') {
    const actual = await census(context.engine, entry.owner.recoveryRecord, 'combined-stopped-before-export');
    for (const role of ['compute', 'filesystem', 'egress_broker', 'egress_relay',
      ...(context.config.profile === 'linux-x64' ? [] : ['route_observer'])]) {
      assert.equal(actual.find((value) => value.role === role).status, 404, 'Final export requires every writer and tunnel producer absent.');
    }
    await run.observe({ kind: 'combined-writer-absence-before-publication', namespace: entry.namespace, census: actual });
  }
}

async function publication(run, result) {
  const files = [];
  for (const name of (await readdir(result.directory)).sort()) {
    const path = join(result.directory, name); const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const raw = await readlink(path, { encoding: 'buffer' });
      files.push({ name, kind: 'symlink', rawTargetBase64: raw.toString('base64'), targetSha256: sha(raw) });
    } else {
      assert(metadata.isFile()); const bytes = await readFile(path);
      files.push({ name, kind: 'file', byteLength: bytes.length, sha256: sha(bytes), permissions: metadata.mode & 0o777 });
    }
  }
  assert.deepEqual(files.map(({ name }) => name), ['live.txt', 'program.mjs', 'result.txt', 'source-link.txt', 'source.txt', 'tool.sh']);
  assert.equal(files.find(({ name }) => name === 'tool.sh').permissions, 0o700);
  assert.equal(files.find(({ name }) => name === 'source-link.txt').rawTargetBase64, Buffer.from('source.txt').toString('base64'));
  await run.observe({ kind: 'combined-independent-host-publication', directory: result.directory, files,
    summary: result.exported, processExit: result.processExit, cancellation: result.cancellation ?? null });
}

export function workflowCases(context) {
  return context.hostRoots.flatMap((hostRoot) => ['normal', 'cancelled'].map((mode) => [
    `${hostRoot.role}-${mode}`, async (run) => {
      await acquireCaseHost(run, { hostRoot, layout: 'private' });
      const opened = await workflow(run, context, { mode: mode === 'cancelled' ? 'cancel' : 'normal',
        onObservation: (observation, entry) => observeWorkflow(run, context, observation, entry) });
      await publication(run, opened.result);
    },
  ]));
}

async function bytes(files, path) {
  const chunks = []; const receipt = await files.readFile(path, async ({ chunks: source }) => {
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
  });
  assert.equal(receipt.kind, 'completed'); return Buffer.concat(chunks);
}

export function siblingCase(context) {
  return ['simultaneous-sibling-isolation', async (run) => {
    await acquireCaseHost(run, { hostRoot: context.hostRoots[0], layout: 'private' });
    // A restricted Desktop owner seals complete external topology. The isolated sibling is fully established first
    // and keeps its original membership unchanged until the restricted owner has stopped and been destroyed.
    const sibling = await guest(run, context, { directory: join(run.hostDirectory, 'isolated-sibling') });
    assert.deepEqual(sibling.sandbox.effective.network, { kind: 'isolated' });
    assert(!sibling.owner.recoveryRecord.resources.some(({ role }) => role === 'network' || role.startsWith('egress_') || role === 'route_observer'));
    const siblingCreated = await sibling.files.writeFile('live.txt', [Buffer.from('owner-B-private\n')], { mode: 'create' });
    assert.equal(siblingCreated.kind, 'completed');
    const siblingResources = structuredClone(sibling.owner.recoveryRecord.resources);
    const opened = await workflow(run, context, { mode: 'normal',
      async onObservation(observation, entry) {
        await observeWorkflow(run, context, observation, entry);
        if (observation.phase !== 'program_verified') return;
        for (const role of ['storage', 'compute', 'filesystem']) {
          assert.notEqual(identified(entry.owner.recoveryRecord, role).identity.id,
            identified(sibling.owner.recoveryRecord, role).identity.id, 'Independent owners must not share resources.');
        }
        assert.equal(entry.sandbox.effective.network.kind, 'restricted_https');
        assert.equal(sibling.owner.state.kind, 'ready');
        const payload = Buffer.from('owner-A-private\n');
        const write = await entry.sandbox.files.writeFile('live.txt', [payload], { mode: 'replace' });
        assert.equal(write.kind, 'completed');
        assert.deepEqual(await bytes(entry.sandbox.files, 'live.txt'), payload);
        assert.deepEqual(await bytes(sibling.files, 'live.txt'), Buffer.from('owner-B-private\n'));
        const brokerPolicy = await context.fixtures.brokerPolicy(entry);
        assert.deepEqual(brokerPolicy.configuration.destinations,
          [{ hostname: context.config.capabilities.network.positive.hostname, port: 443 }]);
        await run.observe({ kind: 'combined-simultaneous-owners-private-same-path',
          namespaces: [entry.namespace, sibling.entry.namespace], payloadSha256: [sha(payload), sha(Buffer.from('owner-B-private\n'))],
          policies: [entry.sandbox.effective.network, sibling.sandbox.effective.network], brokerPolicy,
          composition: 'Isolated sibling ready before restricted acquisition; sibling membership remains stable through restricted destruction.',
          census: await Promise.all([census(context.engine, entry.owner.recoveryRecord, 'restricted-with-stable-isolated-sibling'),
            census(context.engine, sibling.owner.recoveryRecord, 'isolated-sibling-with-active-restricted-owner')]) });
        const example = await loadExample(context.config);
        const restored = await entry.sandbox.files.writeFile('live.txt', [Buffer.from(example.COMBINED_FILES.replacementLive)], { mode: 'replace' });
        assert.equal(restored.kind, 'completed');
      } });
    await publication(run, opened.result);
    assert.equal(opened.entry.owner.state.kind, 'destroyed');
    assert.equal(sibling.owner.state.kind, 'ready');
    assert.deepEqual(sibling.owner.recoveryRecord.resources, siblingResources);
    assert.deepEqual(await bytes(sibling.files, 'live.txt'), Buffer.from('owner-B-private\n'));
    await run.observe({ kind: 'isolated-sibling-survives-restricted-owner-destruction', namespace: sibling.entry.namespace,
      resources: siblingResources, payloadSha256: sha(Buffer.from('owner-B-private\n')) });
  }];
}
