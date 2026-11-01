import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityManifest, platformManifest } from '../test-fixtures.mjs';
import { parseCapabilityManifest } from '../manifest.mjs';
import { admitConcurrencyTopology, concurrencyScenarioBudget } from './budget.mjs';

function fixture(composition = 'native-rosetta') {
  const platform = platformManifest('desktop-apple-virtualization-native-arm64');
  const input = capabilityManifest('combined', 'a'.repeat(64), platform);
  delete input.transfers; input.row = 'desktop-concurrency';
  for (const resources of [input.filesystem.configuration.resources, input.network.egress.configuration.broker.resources,
    input.network.egress.configuration.relay.resources, input.network.routeAuthority.vmObserver.resources]) resources.cpus = 0.1;
  input.concurrency = { composition, caseId: 'joint-ab', members: [
    { label: 'a', profile: platform.profile, imageDigest: platform.sourceImage, positive: input.network.positive },
    { label: 'b', profile: 'desktop-apple-virtualization-rosetta-amd64', imageDigest: `sha256:${'3'.repeat(64)}`,
      positive: { ...input.network.positive, hostname: 'other.example' } },
  ], helper: { protocol: 'agenai.desktop-coordinator.v1', executable: { path: '/unopened/coordinator', sha256: '4'.repeat(64) },
    sourceDigest: `sha256:${'5'.repeat(64)}` }, vmPreparation: { path: '/unopened/preparation.json', sha256: '6'.repeat(64) },
  evidence: { maxAttemptBytes: 4 * 1024 ** 3, maxResponseBytes: 65_536, maxEngineNetworks: 8 }, machine: { minimumAvailableMemoryBytes: 512 * 1024 ** 2, maximumLoadAverage: 8 } };
  return { input, options: { row: 'desktop-concurrency', platform, platformInput: { sha256: 'a'.repeat(64) }, consumer: '/unopened/consumer', output: '/unopened/output' } };
}

test('concurrency admission retains the exact mixed pair and accounts for simultaneous helpers, bootstrap and observer', () => {
  const { input, options } = fixture();
  const parsed = parseCapabilityManifest(input, options);
  assert.deepEqual(parsed.concurrency.members.map(({ label, profile, imageDigest, positive }) => ({ label, profile, imageDigest, hostname: positive.hostname })), [
    { label: 'a', profile: 'desktop-apple-virtualization-native-arm64', imageDigest: `sha256:${'1'.repeat(64)}`, hostname: 'fixture.example' },
    { label: 'b', profile: 'desktop-apple-virtualization-rosetta-amd64', imageDigest: `sha256:${'3'.repeat(64)}`, hostname: 'other.example' },
  ]);
  const budget = concurrencyScenarioBudget(parsed);
  assert.equal(budget.nanoCpus, 2_800_000_000); assert.equal(budget.memoryBytes, 1024 ** 3); assert.equal(budget.pids, 256);
  assert.equal(budget.maximumScopes, 25); assert.equal(budget.maximumConcurrentMembers, 2);
  input.concurrency.members[0].positive.hostname = 'mutated.example';
  assert.equal(parsed.concurrency.members[0].positive.hostname, 'fixture.example');
});

test('concurrency admission rejects unsupported cases, policy union, missing native authority and insufficient complete evidence before effects', () => {
  for (const [mutate, message] of [
    [(input) => { input.concurrency.caseId = 'maybe-success'; }, /Unknown desktop-concurrency case/u],
    [(input) => { input.concurrency.members[1].positive.hostname = input.concurrency.members[0].positive.hostname; }, /Separate positive destinations/u],
    [(input) => { delete input.concurrency.helper; }, /Unknown or missing/u],
    [(input) => { input.concurrency.members[1].profile = 'linux-x64'; }, /Expected values/u],
    [(input) => { input.workload.resources.cpus = 2; }, /four CPUs\/four GiB/u],
    [(input) => { input.concurrency.evidence.maxAttemptBytes = 64 * 1024 ** 2; }, /calculated full observer lifetime/u],
    [(input) => { input.concurrency.vmPreparation.recreate = true; }, /Unknown or missing/u],
  ]) {
    const { input, options } = fixture(); mutate(input);
    assert.throws(() => parseCapabilityManifest(input, options), message);
  }
});

test('only cases whose public workflow reaches the replacement member admit its observer and scopes', () => {
  const budgetFor = (caseId) => {
    const { input, options } = fixture(); input.concurrency.caseId = caseId;
    return concurrencyScenarioBudget(parseCapabilityManifest(input, options));
  };
  const census = (budget) => [budget.maximumOriginalMembers, budget.maximumObserverAttachments, budget.maximumScopes];
  assert.deepEqual(census(budgetFor('joint-ab')), [3, 4, 25]);
  assert.deepEqual(census(budgetFor('persist-destroyed')), [3, 4, 25]);
  for (const caseId of ['persist-running', 'interrupt-identified', 'crash-cleanup-entered']) assert.deepEqual(census(budgetFor(caseId)), [2, 3, 19]);
});

test('one-MiB full-lifetime capture admits ninety-six GiB and rejects an undersized allocation', () => {
  const { input, options } = fixture();
  input.limits = { ...input.limits, startupMs: 60_000, cleanupMs: 30_000, scenarioMs: 600_000, maxOutputBytes: 1024 ** 2 };
  input.network.routeAuthority.maxOutputBytes = 1024 ** 2;
  input.concurrency.evidence.maxResponseBytes = 1024 ** 2;
  input.concurrency.evidence.maxAttemptBytes = 96 * 1024 ** 3;
  const parsed = parseCapabilityManifest(input, options), budget = concurrencyScenarioBudget(parsed);
  assert.equal(parsed.network.routeAuthority.maxOutputBytes, 1_048_576);
  assert(budget.minimumEvidenceBytes > 64 * 1024 ** 3 && budget.minimumEvidenceBytes < 96 * 1024 ** 3);
  assert.equal(budget.maximumPhases, 177); assert.equal(budget.maximumMessages, 939);
  input.concurrency.evidence.maxAttemptBytes = 64 * 1024 ** 3;
  assert.throws(() => parseCapabilityManifest(input, options), /calculated full observer lifetime/u);
});

test('captured baseline identities and all future owned networks must fit the explicit topology allocation before effects', () => {
  const { input, options } = fixture(), budget = concurrencyScenarioBudget(parseCapabilityManifest(input, options));
  const networks = Array.from({ length: 6 }, (_, index) => String(index).repeat(64));
  assert.deepEqual(admitConcurrencyTopology(budget, { networks: networks.slice(0, 4) }), {
    baselineNetworks: networks.slice(0, 4), requiredNetworks: 7, maximumNetworks: 8,
  });
  assert.throws(() => admitConcurrencyTopology(budget, { networks }), /baseline plus required concurrent topology/u);
  assert.throws(() => admitConcurrencyTopology(budget, { networks: [networks[0], networks[0]] }), /distinct Engine network identities/u);
});
